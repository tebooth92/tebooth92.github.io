/**
 * Pay table tab switching.
 * Each .pay-tabbed container has .pay-tab buttons and .pay-col-N cells.
 * Clicking a tab shows only cells matching that column index.
 */
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".pay-tabbed").forEach(function (container) {
    var tabs = container.querySelectorAll(".pay-tab");
    var ncols = tabs.length;
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var col = parseInt(this.getAttribute("data-col"), 10);
        container.querySelectorAll(".pay-tab").forEach(function (t) {
          t.classList.remove("active");
        });
        this.classList.add("active");
        for (var i = 0; i < ncols; i++) {
          var cells = container.querySelectorAll(".pay-col-" + i);
          cells.forEach(function (cell) {
            cell.style.display = i === col ? "" : "none";
          });
        }
      });
    });
  });
});
