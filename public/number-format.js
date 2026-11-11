(function (root) {
  "use strict";
  function number(value, digits) {
    var n = value == null || value === "" ? NaN : Number(value);
    if (!Number.isFinite(n)) return "—";
    var places = Number.isInteger(digits) ? Math.max(0, Math.min(8, digits)) : 2;
    return new Intl.NumberFormat("fi-FI", {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
      useGrouping: true
    }).format(n).replace(/-/g, "−");
  }
  function price(value) {
    var n = value == null || value === "" ? NaN : Number(value);
    if (!Number.isFinite(n)) return "—";
    return number(n, n < 0.01 ? 6 : n < 1 ? 5 : 2);
  }
  function money(value) { return number(value, 2) + " USDT"; }
  root.RahasampoFormat = Object.freeze({ number: number, price: price, money: money });
})(window);
