// EBA filter dropdown for Material's search drawer.
//
// Strategy (resend-setup approach):
//
//   1. eba-worker-patch.js (loaded in <head>) wraps the Worker constructor
//      and captures the search Worker instance plus the initial setup payload
//      (the full list of indexed docs sent as a type-0 message).
//
//   2. When the user picks an EBA from the dropdown, we resend a type-0
//      message to the Worker containing ONLY the docs under that EBA.
//      The Worker rebuilds its lunr index with just those docs, so any
//      subsequent query naturally returns only that EBA's pages.
//
//   3. When "All EBAs" is selected we resend the original full setup so the
//      Worker reverts to searching across every doc.
//
//   4. After reindexing we retrigger Material's search pipeline so new results
//      appear immediately without the user having to retype.
//
//   5. A lightweight post-hoc DOM filter hides any result items whose URL
//      falls outside /ebas/<slug>/ as a belt-and-braces guard.
//
// Design goals:
//  - No inline scripts or styles (CSP-safe).
//  - No query-string modification; search box stays clean.

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

  // Shared state object created by eba-worker-patch.js.  If the patch
  // script failed for any reason fall back to a local object.
  var state = window.__ebaFilter = window.__ebaFilter || {
    currentSlug:       "",
    patched:           false,
    wrapperCalled:     false,
    interceptCount:    0,
    workerInstance:    null,
    fullSetupData:     null,
    nativePostMessage: null
  };

  var STORAGE_KEY = "eba-wiki.search-filter";
  // Restore persisted filter selection.
  try {
    var saved = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
    if (saved) state.currentSlug = saved;
  } catch (err) { /* ignore */ }

  var listObserver = null;
  var pending       = null;
  var reindexTimer  = null;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function needle() {
    return state.currentSlug ? "/ebas/" + state.currentSlug + "/" : "";
  }

  function slugLabel(slug) {
    for (var i = 0; i < EBAS.length; i++) {
      if (EBAS[i].slug === slug) return EBAS[i].label;
    }
    return slug;
  }

  // -------------------------------------------------------------------------
  // Core: reindex the Worker with a filtered doc set
  // -------------------------------------------------------------------------

  function reindexWorker(slug) {
    if (!state.nativePostMessage || !state.fullSetupData) {
      // Worker not ready yet - hint text will show diagnostic.
      return;
    }

    var docs = state.fullSetupData.docs;

    if (slug) {
      var prefix = "ebas/" + slug;
      docs = docs.filter(function (d) {
        return d.location.indexOf(prefix) === 0;
      });
    }
    // else: pass through full doc list to restore "All EBAs" mode.

    // Send fresh setup to the Worker. The Worker rebuilds lunr synchronously
    // then replies with {type:1}. We wait a moment before retriggering so
    // the index is ready when the new query arrives.
    state.nativePostMessage({
      type: 0,
      data: {
        config:  state.fullSetupData.config,
        docs:    docs,
        options: state.fullSetupData.options || { suggest: false }
      }
    });

    // Give the Worker time to rebuild the index before firing the query.
    if (reindexTimer) clearTimeout(reindexTimer);
    reindexTimer = setTimeout(function () {
      reindexTimer = null;
      retriggerSearch();
    }, 300);
  }

  // -------------------------------------------------------------------------
  // Retrigger Material's search pipeline so it sends a fresh query
  // -------------------------------------------------------------------------

  function retriggerSearch() {
    var input = document.querySelector(".md-search__input");
    if (!input || !input.value) return;
    // Cycle the value so Material's distinctUntilChanged sees a change.
    var val = input.value;
    input.value = "";
    fireEvents(input);
    input.value = val;
    fireEvents(input);
  }

  function fireEvents(input) {
    function fire(name, Ctor) {
      try {
        input.dispatchEvent(new Ctor(name, { bubbles: true }));
      } catch (err) {
        var e = document.createEvent("Event");
        e.initEvent(name, true, true);
        input.dispatchEvent(e);
      }
    }
    fire("input",   Event);
    fire("keydown", typeof KeyboardEvent !== "undefined" ? KeyboardEvent : Event);
    fire("keyup",   typeof KeyboardEvent !== "undefined" ? KeyboardEvent : Event);
    fire("change",  Event);
  }

  // -------------------------------------------------------------------------
  // Hint text
  // -------------------------------------------------------------------------

  function updateHelperText() {
    var helper = document.querySelector(".eba-filter__hint");
    if (!helper) return;

    if (state.currentSlug) {
      // Build diagnostic suffix so we can see what state the patch is in.
      var diag = "";
      if (!state.wrapperCalled) {
        diag = " [patch: NOT active]";
      } else if (!state.fullSetupData) {
        diag = " [patch: active, index not yet captured]";
      } else {
        var count = (state.fullSetupData.docs || []).filter(function (d) {
          return d.location.indexOf("ebas/" + state.currentSlug) === 0;
        }).length;
        diag = " [" + count + " docs indexed]";
      }
      helper.textContent =
        "Results filtered to " + slugLabel(state.currentSlug) + "." + diag;
      helper.style.display = "";
    } else {
      helper.textContent = "";
      helper.style.display = "none";
    }
  }

  // -------------------------------------------------------------------------
  // Build the filter UI
  // -------------------------------------------------------------------------

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
    select.id    = "eba-filter-select";
    select.className = "eba-filter__select";

    for (var i = 0; i < EBAS.length; i++) {
      var opt = document.createElement("option");
      opt.value       = EBAS[i].slug;
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
      reindexWorker(state.currentSlug);
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

  // -------------------------------------------------------------------------
  // Post-hoc DOM filter (belt-and-braces: hides any stray non-EBA results)
  // -------------------------------------------------------------------------

  function linkMatches(link) {
    if (!link) return true;
    var url = link.href || link.getAttribute("href") || "";
    var n   = needle();
    if (!n) return true;
    return url.indexOf(n) !== -1;
  }

  function applyFilter() {
    pending = null;
    var list = document.querySelector(".md-search-result__list");
    if (!list) return;
    var items = list.querySelectorAll(".md-search-result__item");
    if (!items.length) return;
    var n     = needle();
    var shown = 0;

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

  // -------------------------------------------------------------------------
  // Mount filter UI and observe search results
  // -------------------------------------------------------------------------

  function mountFilter() {
    if (document.querySelector(".eba-filter")) return true;
    var host =
      document.querySelector(".md-search__output") ||
      document.querySelector(".md-search__form");
    if (!host) return false;
    host.insertBefore(buildSelect(), host.firstChild);
    updateHelperText();

    // If a filter was persisted from a previous session, reindex now that
    // the Worker has (hopefully) already received its setup message.
    if (state.currentSlug) {
      setTimeout(function () { reindexWorker(state.currentSlug); }, 200);
    }
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
      var mounted  = mountFilter();
      var attached = attachListObserver();
      if (mounted && attached) return;
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
