// EBA filter dropdown for Material's search drawer.
//
// Strategy:
//
//   1. Each clause page carries a hidden compound-word token (ebafilter<slug>)
//      injected into its markdown by scripts/hooks.py. The token survives the
//      search plugin's tokenizer as a single term and is indexed as ordinary
//      page text.
//
//   2. eba-worker-patch.js (loaded in <head> before Material's bundle)
//      monkey-patches Worker.postMessage. When Material dispatches a lunr
//      query to its search worker, the patch transparently appends the
//      selected EBA's token so Material's ranker biases results toward
//      that EBA. The visible search input is never modified. This script
//      only has to set window.__ebaFilter.currentSlug for the patch to
//      pick up.
//
//   3. A lightweight post-hoc DOM filter hides any residual results whose
//      URL is outside /ebas/<slug>/.
//
// Design goals:
//  - No inline scripts or styles (CSP-safe).
//  - Cheap to run: observer scoped to the search output, debounced.
//  - Visible search input stays clean, no token pollution.

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

  // Shared state with eba-worker-patch.js. That file initialises the
  // object in <head> before bundle.js; we just read/write currentSlug here.
  var state = window.__ebaFilter = window.__ebaFilter || {
    currentSlug: "",
    patched: false,
    lastOriginal: null,
    lastRewritten: null
  };

  var STORAGE_KEY = "eba-wiki.search-filter";
  try {
    var saved = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
    if (saved) state.currentSlug = saved;
  } catch (err) { /* ignore */ }

  var listObserver = null;
  var pending = null;

  function needle() {
    return state.currentSlug ? "/ebas/" + state.currentSlug + "/" : "";
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
    if (state.currentSlug) {
      helper.textContent =
        "Results biased toward " + slugLabel(state.currentSlug) +
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
      if (EBAS[i].slug === state.currentSlug) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener("change", function () {
      state.currentSlug = select.value;
      try {
        if (window.localStorage) {
          window.localStorage.setItem(STORAGE_KEY, state.currentSlug);
        }
      } catch (err) { /* ignore */ }
      updateHelperText();
      // Retrigger Material's search so the worker receives a fresh
      // postMessage that the patched postMessage will augment.
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

    // Open any collapsed "more results" so the filter can reach them.
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
        " under " + (slugLabel(state.currentSlug) || "selected EBA");
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
      if (mounted && attached) {
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
