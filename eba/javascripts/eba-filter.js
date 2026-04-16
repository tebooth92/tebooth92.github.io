// EBA filter dropdown for Material's search drawer.
//
// Strategy:
//
//   1. Each clause page carries a hidden compound-word token (ebafilter<slug>)
//      injected into its markdown by scripts/hooks.py. The token survives the
//      search plugin's tokenizer as a single term and is indexed as ordinary
//      page text.
//
//   2. We patch Worker.prototype.postMessage. When Material dispatches a
//      type=2 message (lunr query) to its search worker, we transparently
//      append the selected EBA's token to the query string. Material's
//      ranker then heavily favours pages of that EBA, so matching results
//      stay inside the rendered top-N window. The user's visible input
//      text is never touched.
//
//   3. A lightweight post-hoc DOM filter hides any residual results whose
//      URL is outside /ebas/<slug>/.
//
// Design goals:
//  - No inline scripts or styles (CSP-safe).
//  - Cheap to run: observer scoped to the search output, debounced.
//  - Visible search input stays clean — no token pollution.

(function () {
  "use strict";

  var EBAS = [
    { slug: "",                     label: "All EBAs" },
    { slug: "mental-health",        label: "Mental Health Services 2024-2028" },
    { slug: "nurses-midwives",      label: "Nurses and Midwives 2024-2028" },
    { slug: "has-managers-admin",   label: "Health Allied & Managers Admin 2021-2025" },
    { slug: "mspp",                 label: "Medical Scientists, Pharm & Psych 2021-2025" },
    { slug: "doctors-in-training",  label: "Doctors in Training 2022-2026" },
    { slug: "medical-specialists",  label: "Medical Specialists 2022-2026" },
    { slug: "allied-health",        label: "Allied Health Professionals 2021-2026" },
    { slug: "biomedical-engineers", label: "Biomedical Engineers 2025-2028" },
    { slug: "childrens-services",   label: "Children's Services Award 2010" }
  ];

  var STORAGE_KEY = "eba-wiki.search-filter";
  var currentSlug = "";
  try {
    var saved = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
    if (saved) currentSlug = saved;
  } catch (err) { /* ignore */ }

  var listObserver = null;
  var pending = null;
  var syncing = false;
  var TOKEN_RE = /\s*ebafilter[a-z]+\s*/gi;

  function tokenFor(slug) {
    return slug ? "ebafilter" + slug.replace(/-/g, "") : "";
  }

  function needle() {
    return currentSlug ? "/ebas/" + currentSlug + "/" : "";
  }

  function slugLabel(slug) {
    for (var i = 0; i < EBAS.length; i++) {
      if (EBAS[i].slug === slug) return EBAS[i].label;
    }
    return slug;
  }

  function updateHelperText() {
    var helper = document.querySelector(".eba-filter__hint");
    if (!helper) return;
    if (currentSlug) {
      helper.textContent =
        "Results biased toward " + slugLabel(currentSlug) +
        ". Other EBAs hidden.";
      helper.style.display = "";
    } else {
      helper.textContent = "";
      helper.style.display = "none";
    }
  }

  function buildSelect() {
    var wrap = document.createElement("div");
    wrap.className = "eba-filter";

    var row = document.createElement("div");
    row.className = "eba-filter__row";

    var label = document.createElement("label");
    label.className = "eba-filter__label";
    label.setAttribute("for", "eba-filter-select");
    label.textContent = "Filter by EBA:";

    var select = document.createElement("select");
    select.id = "eba-filter-select";
    select.className = "eba-filter__select";

    for (var i = 0; i < EBAS.length; i++) {
      var opt = document.createElement("option");
      opt.value = EBAS[i].slug;
      opt.textContent = EBAS[i].label;
      if (EBAS[i].slug === currentSlug) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener("change", function () {
      currentSlug = select.value;
      try {
        if (window.localStorage) {
          window.localStorage.setItem(STORAGE_KEY, currentSlug);
        }
      } catch (err) { /* ignore */ }
      updateHelperText();
      // Retrigger Material's search so the worker receives a fresh
      // postMessage that our patched postMessage will augment.
      retriggerSearch();
      scheduleApply();
    });

    row.appendChild(label);
    row.appendChild(select);

    var hint = document.createElement("div");
    hint.className = "eba-filter__hint";

    wrap.appendChild(row);
    wrap.appendChild(hint);
    return wrap;
  }

  // Rewrite the search input so Material sees the token appended to the
  // user's query. Fires a fresh input event so Material's observable
  // re-reads the input value and re-runs the search.
  // Retrigger Material's search pipeline without touching the visible
  // input value. Our Worker.postMessage patch adds the token at dispatch
  // time, so we just need Material to send a fresh query to the worker.
  function retriggerSearch() {
    var input = document.querySelector(".md-search__input");
    if (!input) return;
    fireKeyLikeEvents(input);
  }

  function fireKeyLikeEvents(input) {
    function fire(name, EvtCtor) {
      try {
        input.dispatchEvent(new EvtCtor(name, { bubbles: true }));
      } catch (err) {
        var evt = document.createEvent("Event");
        evt.initEvent(name, true, true);
        input.dispatchEvent(evt);
      }
    }
    fire("input", Event);
    var KbdCtor = (typeof KeyboardEvent !== "undefined") ? KeyboardEvent : Event;
    fire("keydown", KbdCtor);
    fire("keyup", KbdCtor);
    fire("change", Event);
  }

  // Diagnostic: record the last message seen so we can confirm the patch
  // is actually intercepting Material's query dispatch.
  var lastPatched = { original: null, rewritten: null };

  function rewriteMsg(msg) {
    if (!currentSlug) return msg;
    if (!msg || typeof msg !== "object") return msg;
    // Material sends {type: 2, data: "<query>"} for search queries.
    // Be permissive: if data is a string, augment it.
    var data = msg.data;
    if (typeof data !== "string") return msg;
    var suffix = tokenFor(currentSlug);
    if (!suffix) return msg;
    var q = data.replace(TOKEN_RE, " ").trim();
    if (!q) return msg;
    lastPatched.original = data;
    lastPatched.rewritten = q + " " + suffix;
    return { type: msg.type, data: lastPatched.rewritten };
  }

  // Intercept Material's query dispatch at two layers:
  //   a) Worker.prototype.postMessage — catches already-constructed workers.
  //   b) window.Worker constructor wrapper — also overrides postMessage on
  //      each new instance, belt-and-braces in case a) is bypassed (some
  //      browsers treat prototype methods on host objects differently).
  function patchWorkerPostMessage() {
    if (window.__ebaWorkerPatched) return;
    if (typeof Worker === "undefined") return;

    // Layer a): prototype
    try {
      var protoOrig = Worker.prototype.postMessage;
      if (protoOrig) {
        Worker.prototype.postMessage = function (msg) {
          try { arguments[0] = rewriteMsg(msg); } catch (err) {}
          return protoOrig.apply(this, arguments);
        };
      }
    } catch (err) { /* ignore */ }

    // Layer b): constructor wrapper
    try {
      var Native = window.Worker;
      var Wrapper = function (url, opts) {
        var w = new Native(url, opts);
        var instOrig = w.postMessage.bind(w);
        w.postMessage = function (msg) {
          try { msg = rewriteMsg(msg); } catch (err) {}
          return instOrig(msg);
        };
        return w;
      };
      Wrapper.prototype = Native.prototype;
      try { Object.setPrototypeOf(Wrapper, Native); } catch (e) {}
      window.Worker = Wrapper;
    } catch (err) { /* ignore */ }

    window.__ebaWorkerPatched = true;
  }
  patchWorkerPostMessage();

  function attachInputHook() {
    // No-op: the Worker.postMessage patch augments the query at dispatch
    // time, so we don't need to touch the input element's value.
    return !!document.querySelector(".md-search__input");
  }

  function linkMatches(link) {
    if (!link) return true;
    var url = link.href || link.getAttribute("href") || "";
    var n = needle();
    if (!n) return true;
    return url.indexOf(n) !== -1;
  }

  function applyFilter() {
    pending = null;
    var list = document.querySelector(".md-search-result__list");
    if (!list) return;
    var items = list.querySelectorAll(".md-search-result__item");
    if (!items.length) return;
    var n = needle();
    var shown = 0;

    // Open any collapsed "more results" so our filter can reach them.
    if (n) {
      var dets = list.querySelectorAll("details.md-search-result__more");
      for (var k = 0; k < dets.length; k++) {
        if (!dets[k].open) dets[k].open = true;
      }
    }

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!n) {
        if (item.style.display !== "") item.style.display = "";
        shown++;
        continue;
      }
      var links = item.getElementsByClassName("md-search-result__link");
      var match = false;
      for (var j = 0; j < links.length; j++) {
        if (linkMatches(links[j])) { match = true; break; }
      }
      var target = match ? "" : "none";
      if (item.style.display !== target) item.style.display = target;
      if (match) shown++;
    }

    var meta = document.querySelector(".md-search-result__meta");
    if (meta && n) {
      meta.textContent =
        shown + " of " + items.length + " match" +
        (shown === 1 ? "" : "es") +
        " under " + (slugLabel(currentSlug) || "selected EBA");
    }

    // Debug: expose last sample of URLs we checked so we can diagnose
    // when shown=0 but items were returned.
    var hint = document.querySelector(".eba-filter__hint");
    if (hint && n && items.length > 0 && shown === 0) {
      var sample = "";
      var firstItem = items[0];
      var firstLink = firstItem.querySelector(".md-search-result__link");
      if (firstLink) sample = firstLink.href || firstLink.getAttribute("href") || "";
      var patchState = lastPatched.rewritten
        ? "patched: " + lastPatched.rewritten.slice(0, 80)
        : "patch NEVER fired";
      hint.textContent =
        "0 of " + items.length + " shown | " + patchState +
        " | URL: " + sample.slice(0, 80);
    }
  }

  function scheduleApply() {
    if (pending) return;
    pending = window.setTimeout(applyFilter, 80);
  }

  function mountFilter() {
    if (document.querySelector(".eba-filter")) return true;
    var host =
      document.querySelector(".md-search__output") ||
      document.querySelector(".md-search__form");
    if (!host) return false;
    host.insertBefore(buildSelect(), host.firstChild);
    updateHelperText();
    return true;
  }

  function attachListObserver() {
    if (listObserver) return true;
    // Observe the whole search output (not just the list), with subtree,
    // so we catch the case where Material replaces the list element on a
    // new search. scheduleApply debounces bursts so this is cheap.
    var root =
      document.querySelector(".md-search__output") ||
      document.querySelector(".md-search__inner") ||
      document.querySelector(".md-search-result");
    if (!root) return false;
    listObserver = new MutationObserver(scheduleApply);
    listObserver.observe(root, { childList: true, subtree: true });
    scheduleApply();
    return true;
  }

  function init() {
    var tries = 0;
    function tick() {
      var mounted = mountFilter();
      var attached = attachListObserver();
      var hooked = attachInputHook();
      if (mounted && attached && hooked) {
        return;
      }
      if (++tries > 80) return;
      setTimeout(tick, 100);
    }
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
