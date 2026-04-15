// EBA filter dropdown for Material's search drawer.
//
// Two-part strategy to keep filtered results inside Material's top-N window:
//
//   1. Each clause page has a hidden compound-word token (ebafilter<slug>)
//      injected by overrides/main.html. When a filter is active we append
//      that token to the search input so Material biases the ranker toward
//      pages of that EBA. Without this, rare-in-filter queries ("classification"
//      with Allied Health selected) return nothing because the matching pages
//      never make it into the rendered top ~10.
//
//   2. A lightweight post-hoc DOM filter then hides any results whose URL is
//      outside /ebas/<slug>/, which removes the small number of false
//      positives that still sneak in.
//
// Design goals:
//  - No inline scripts or styles (CSP-safe).
//  - Cheap to run: the observer is scoped to the search-result list only,
//    and applyFilter is debounced.
//  - No feedback loops: input rewriting uses a guard flag.

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

  function tokenFor(slug) {
    return slug ? "ebafilter" + slug.replace(/-/g, "") : "";
  }

  // Matches any ebafilter token so we can strip old ones on filter change.
  var TOKEN_RE = /\s*ebafilter[a-z]+\s*/gi;

  function needle() {
    return currentSlug ? "/ebas/" + currentSlug + "/" : "";
  }

  function slugLabel(slug) {
    for (var i = 0; i < EBAS.length; i++) {
      if (EBAS[i].slug === slug) return EBAS[i].label;
    }
    return slug;
  }

  function buildSelect() {
    var wrap = document.createElement("div");
    wrap.className = "eba-filter";

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
      syncInput();
      scheduleApply();
    });

    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
  }

  // Rewrite the search input so Material's ranker sees the hidden
  // per-EBA token as part of the query. Uses a guard flag to avoid
  // feedback when we dispatch our own input event.
  function syncInput() {
    var input = document.querySelector(".md-search__input");
    if (!input) return;
    var suffix = tokenFor(currentSlug);
    // Strip any previously-added token.
    var base = (input.value || "").replace(TOKEN_RE, " ").trim();
    var next = suffix ? (base + " " + suffix).trim() : base;
    if (input.value === next) return;
    syncing = true;
    input.value = next;
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {
      // Older browsers: fall back to a plain Event.
      var evt = document.createEvent("Event");
      evt.initEvent("input", true, true);
      input.dispatchEvent(evt);
    }
    syncing = false;
  }

  function attachInputHook() {
    var input = document.querySelector(".md-search__input");
    if (!input || input.__ebaHooked) return !!input;
    input.__ebaHooked = true;
    input.addEventListener("input", function () {
      if (syncing) return;
      if (!currentSlug) return;
      // User typed: re-append the token if they removed it.
      var suffix = tokenFor(currentSlug);
      if (input.value.indexOf(suffix) !== -1) return;
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
    return true;
  }

  function attachListObserver() {
    if (listObserver) return true;
    var list = document.querySelector(".md-search-result__list");
    if (!list) return false;
    listObserver = new MutationObserver(scheduleApply);
    listObserver.observe(list, { childList: true });
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
        // If there's a persisted filter, push the token into the input now
        // so a page-reload-with-query state still biases correctly.
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
