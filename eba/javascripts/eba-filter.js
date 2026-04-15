// EBA filter dropdown for Material's search drawer.
//
// Adds a <select> inside the search output that hides any result whose
// resolved URL does not contain /ebas/<slug>/. "All EBAs" clears it.
//
// Design goals:
//  - No inline scripts or styles (CSP-safe).
//  - Cheap to run: the observer is scoped to the search-result list only,
//    and applyFilter is debounced so a burst of mutations from a single
//    keystroke coalesces into one pass.

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
      scheduleApply();
    });

    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
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
    // childList only, no subtree: results are appended as children of
    // the list. Much cheaper than watching the whole body.
    listObserver.observe(list, { childList: true });
    scheduleApply();
    return true;
  }

  function init() {
    var tries = 0;
    function tick() {
      var mounted = mountFilter();
      var attached = attachListObserver();
      if (mounted && attached) return;
      if (++tries > 80) return; // give up after ~8s
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
