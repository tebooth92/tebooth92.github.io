// EBA filter: Worker.postMessage interceptor.
//
// Loaded from the document <head> (via overrides/main.html) so it runs
// BEFORE Material's bundle.js creates its search Worker. It patches both
// Worker.prototype.postMessage and window.Worker (constructor wrapper),
// so when Material dispatches a search query to its worker, we can
// transparently append the active EBA filter token before the worker
// runs lunr.
//
// State is exposed on window.__ebaFilter so the main eba-filter.js can
// read/write currentSlug and inspect whether the patch has fired.

(function () {
  "use strict";

  if (typeof Worker === "undefined") return;
  if (window.__ebaFilter && window.__ebaFilter.patched) return;

  var state = window.__ebaFilter = window.__ebaFilter || {
    currentSlug: "",
    patched: false,
    lastOriginal: null,
    lastRewritten: null
  };

  var TOKEN_RE = /\s*ebafilter[a-z]+\s*/gi;

  function tokenFor(slug) {
    return slug ? "ebafilter" + slug.replace(/-/g, "") : "";
  }

  function rewriteMsg(msg) {
    try {
      if (!state.currentSlug) return msg;
      if (!msg || typeof msg !== "object") return msg;
      var data = msg.data;
      if (typeof data !== "string") return msg;
      var suffix = tokenFor(state.currentSlug);
      if (!suffix) return msg;
      var q = data.replace(TOKEN_RE, " ").trim();
      if (!q) return msg;
      state.lastOriginal = data;
      state.lastRewritten = q + " " + suffix;
      return { type: msg.type, data: state.lastRewritten };
    } catch (err) {
      return msg;
    }
  }

  // Layer 1: prototype patch. Any Worker instance that looks up
  // postMessage through the prototype chain will hit our override.
  try {
    var protoOrig = Worker.prototype.postMessage;
    if (protoOrig) {
      Worker.prototype.postMessage = function (msg) {
        try { arguments[0] = rewriteMsg(msg); } catch (err) {}
        return protoOrig.apply(this, arguments);
      };
    }
  } catch (err) { /* ignore */ }

  // Layer 2: constructor wrapper. Overrides postMessage on each new
  // Worker instance as belt-and-braces, since some environments treat
  // host-object prototype methods specially.
  try {
    var Native = window.Worker;
    function Wrapper(url, opts) {
      var w = new Native(url, opts);
      var instOrig = w.postMessage.bind(w);
      w.postMessage = function (msg) {
        try { msg = rewriteMsg(msg); } catch (err) {}
        return instOrig(msg);
      };
      return w;
    }
    Wrapper.prototype = Native.prototype;
    try { Object.setPrototypeOf(Wrapper, Native); } catch (e) {}
    window.Worker = Wrapper;
  } catch (err) { /* ignore */ }

  state.patched = true;
})();
