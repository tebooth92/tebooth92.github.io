// EBA filter dropdown for Material's search drawer.
//
// Strategy:
//
//   1. Each clause page carries a hidden compound-word token (ebafilter<slug>)
//      injected into its markdown by scripts/hooks.py. The token survives the
//      search plugin's tokenizer as a single term and is indexed as ordinary
//      page text.
//
//   2. When an EBA is selected in the dropdown, we append that token to the
//      search input's value and fire an input event. Material's ranker then
//      heavily favours pages of that EBA, which keeps matching results
//      inside the rendered top-N window. Without this, rare-in-filter
//      queries ("classification" with Allied Health selected) return
//      nothing because the matching pages never reach the render window.
//
//   3. A lightweight post-hoc DOM filter then hides any residual results
//      whose URL is outside /ebas/<slug>/.
//
// The appended token is visible in the search box. A small helper line
// below the filter dropdown tells the user what it is.
//
// Design goals:
//  - No inline scripts or styles (CSP-safe).
//  - Cheap to run: observer scoped to the result list only, debounced.
//  - No feedback loops: a guard flag prevents our own input events from
//    re-triggering the user-input handler.

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
        "Filter tag " + tokenFor(currentSlug) +
        " is appended to your search to bias results toward " +
        slugLabel(currentSlug) + ".";
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
      syncInput();
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
  function syncInput() {
    var input = document.querySelector(".md-search__input");
    if (!input) return;
    var suffix = tokenFor(currentSlug);
    var base = (input.value || "").replace(TOKEN_RE, " ").trim();
    var next = suffix ? (base ? base + " " + suffix : "") : base;
    if (input.value === next) return;
    syncing = true;
    input.value = next;
    // Keep the caret at the end of the base (user-typed) portion, so further
    // typing extends the query rather than tearing up the trailing token.
    if (suffix && base) {
      try {
        input.setSelectionRange(base.length, base.length);
      } catch (err) { /* older browsers */ }
    }
    // Material's search pipeline subscribes to 'keyup' (not 'input'), so
    // we must fire a keyup to make it re-read the augmented value. Fire
    // 'input' too in case other listeners depend on it.
    fireKeyLikeEvents(input);
    syncing = false;
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
    // KeyboardEvent is what 'keyup' listeners typically expect.
    var KbdCtor = (typeof KeyboardEvent !== "undefined") ? KeyboardEvent : Event;
    fire("keyup", KbdCtor);
  }

  function attachInputHook() {
    var input = document.querySelector(".md-search__input");
    if (!input || input.__ebaHooked) return !!input;
    input.__ebaHooked = true;
    input.addEventListener("input", function () {
      if (syncing) return;
      if (!currentSlug) return;
      if (!input.value.trim()) return;
      // Always normalise: strip any existing ebafilter* fragments (in case
      // the user typed into or next to a previous token) and re-append the
      // canonical token at the end. This guarantees Material sees a clean,
      // whole-word token regardless of where the caret is.
      syncInput();
    });
    return true;
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
        shown + " match" + (shown === 1 ? "" : "es") +
        " under " + (slugLabel(currentSlug) || "selected EBA");
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
        if (currentSlug) syncInput();
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
