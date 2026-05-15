/* Sticky top-of-page clause nav: fade in once the page H1 has scrolled past
   the site header. Works with Material's instant navigation by re-binding on
   document$ if available, otherwise on plain scroll. */
(function () {
  function bind() {
    var n = document.getElementById('scrollNav');
    if (!n) return;
    var h = document.querySelector('article h1, .md-content h1');
    function update() {
      var below = h
        ? (h.getBoundingClientRect().bottom < 48)
        : (window.scrollY > 200);
      n.classList.toggle('scroll-nav--visible', below);
    }
    // Avoid attaching duplicate listeners by tagging the node
    if (!n._cnBound) {
      document.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update, { passive: true });
      n._cnBound = true;
    }
    update();
  }
  // Material exposes document$ when navigation.instant is on
  if (typeof window !== 'undefined' && window.document$) {
    window.document$.subscribe(bind);
  } else {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  }
})();
