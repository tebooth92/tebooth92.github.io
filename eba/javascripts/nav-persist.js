(function () {
  var STATE_KEY = 'eba-wiki-nav-state';
  var SCROLL_KEY = 'eba-wiki-nav-scroll';

  function getScrollContainer() {
    return document.querySelector(
      '.md-sidebar--primary .md-sidebar__scrollwrap'
    );
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function applyState() {
    var state = loadState();
    var toggles = document.querySelectorAll(
      '.md-sidebar--primary .md-nav__toggle.md-toggle'
    );
    toggles.forEach(function (input) {
      if (!input.id) return;
      if (state.hasOwnProperty(input.id)) {
        input.checked = state[input.id];
      }
    });
  }

  function attachListeners() {
    var toggles = document.querySelectorAll(
      '.md-sidebar--primary .md-nav__toggle.md-toggle'
    );
    toggles.forEach(function (input) {
      if (input.dataset.navPersistAttached) return;
      input.dataset.navPersistAttached = '1';
      input.addEventListener('change', function () {
        if (!input.id) return;
        var state = loadState();
        state[input.id] = input.checked;
        saveState(state);
      });
    });
  }

  function saveScroll() {
    var sb = getScrollContainer();
    if (!sb) return;
    try {
      localStorage.setItem(SCROLL_KEY, String(sb.scrollTop));
    } catch (e) {}
  }

  function doRestoreScroll() {
    var sb = getScrollContainer();
    if (!sb) return;
    try {
      var raw = localStorage.getItem(SCROLL_KEY);
      if (raw == null) return;
      var n = parseInt(raw, 10);
      if (!isNaN(n) && n > 0) sb.scrollTop = n;
    } catch (e) {}
  }

  // Delay slightly so Material's own auto-scroll on instant-nav runs first
  // and ours wins. Without the delay the active item near the bottom of
  // the previous scroll position can get yanked into view.
  function restoreScroll() {
    setTimeout(doRestoreScroll, 50);
    setTimeout(doRestoreScroll, 200);
  }

  function attachScrollSavers() {
    document.querySelectorAll('.md-sidebar--primary a').forEach(function (a) {
      if (a.dataset.scrollSaveAttached) return;
      a.dataset.scrollSaveAttached = '1';
      a.addEventListener('click', saveScroll);
    });
  }

  function init() {
    applyState();
    attachListeners();
    attachScrollSavers();
    restoreScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', saveScroll);
  window.addEventListener('pagehide', saveScroll);

  var observer = new MutationObserver(function () {
    applyState();
    attachListeners();
    attachScrollSavers();
    restoreScroll();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
