// EBA filter: Worker interceptor.
//
// Loaded from <head> (via overrides/main.html extrahead block) so it runs
// BEFORE Material's bundle.js creates its search Worker.
//
// Strategy (resend-setup approach instead of query rewriting):
//   When the EBA filter changes, eba-filter.js calls window.__ebaFilter.
//   reindexWorker(slug). That function sends a fresh type-0 setup message
//   to the Worker with docs filtered to the selected EBA. The Worker
//   rebuilds its lunr index with only those docs, so normal queries
//   automatically return results from that EBA without any token tricks.
//
// State on window.__ebaFilter is shared with eba-filter.js:
//   .workerInstance    - the Worker created by Material
//   .fullSetupData     - captured copy of the original setup payload
//   .nativePostMessage - bound original postMessage (bypass our override)
//   .wrapperCalled     - true if our constructor wrapper was invoked
//   .interceptCount    - how many postMessage calls we have seen
//   .patched           - true once this script has finished installing

(function () {
  "use strict";

  if (typeof Worker === "undefined") return;
  if (window.__ebaFilter && window.__ebaFilter.patched) return;

  var state = window.__ebaFilter = window.__ebaFilter || {
    currentSlug:      "",
    patched:          false,
    wrapperCalled:    false,
    interceptCount:   0,
    workerInstance:   null,
    fullSetupData:    null,
    nativePostMessage: null
  };

  // Constructor wrapper. Intercepts new Worker(...) calls so we capture
  // the instance and its native postMessage the moment it is created.
  try {
    var Native = window.Worker;

    function EbaWorkerWrapper(url, opts) {
      var w = new Native(url, opts);
      state.wrapperCalled  = true;
      state.workerInstance = w;
      // Capture native postMessage BEFORE overriding so eba-filter.js can
      // call it directly to resend filtered setup without going through our
      // intercept a second time.
      state.nativePostMessage = w.postMessage.bind(w);

      w.postMessage = function (msg) {
        state.interceptCount++;
        // Capture the full setup payload so we can filter and replay it.
        if (msg && msg.type === 0 && msg.data && msg.data.docs) {
          state.fullSetupData = msg.data;
        }
        // Pass every message through unchanged. Filtering is done by
        // resending a modified type-0 from eba-filter.js on dropdown change.
        return state.nativePostMessage(msg);
      };

      return w;
    }

    EbaWorkerWrapper.prototype = Native.prototype;
    try { Object.setPrototypeOf(EbaWorkerWrapper, Native); } catch (e) {}
    window.Worker = EbaWorkerWrapper;
  } catch (err) { /* ignore */ }

  state.patched = true;
})();
