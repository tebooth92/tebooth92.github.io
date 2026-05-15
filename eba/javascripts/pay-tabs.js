/**
 * Pay table tab switching.
 *
 * Uses event delegation on document.body so it works with Material's
 * instant loading (XHR page transitions) without needing to re-bind
 * after each navigation.
 */
document.body.addEventListener("click", function (e) {
  var tab = e.target.closest(".pay-tab");
  if (!tab) return;

  var container = tab.closest(".pay-tabbed");
  if (!container) return;

  var col = parseInt(tab.getAttribute("data-col"), 10);
  var tabs = container.querySelectorAll(".pay-tab");
  var ncols = tabs.length;

  tabs.forEach(function (t) {
    t.classList.remove("active");
  });
  tab.classList.add("active");

  for (var i = 0; i < ncols; i++) {
    var cells = container.querySelectorAll(".pay-col-" + i);
    cells.forEach(function (cell) {
      cell.style.display = i === col ? "" : "none";
    });
  }
});
