(function () {
  var STORAGE_KEY = 'eba-wiki-nav-state';

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function applyState() {
    var state = loadState();
    var toggles = document.querySelectorAll('.md-sidebar--primary .md-nav__toggle.md-toggle');
    toggles.forEach(function (input) {
      if (!input.id) return;
      if (state.hasOwnProperty(input.id)) {
        input.checked = state[input.id];
      }
    });
  }

  function attachListeners() {
    var toggles = document.querySelectorAll('.md-sidebar--primary .md-nav__toggle.md-toggle');
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

  function init() {
    applyState();
    attachListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  var sidebar = document.querySelector('.md-sidebar--primary') || document.body;
  var observer = new MutationObserver(function () {
    applyState();
    attachListeners();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
