(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { instruments: [] };

  function setStatus(message, kind) {
    var node = $("etoroStatus");
    if (!node) return;
    node.className = "status" + (kind ? " " + kind : "");
    node.textContent = message;
    var lower = String(message || "").toLowerCase();
    $("etoroState").textContent = lower.indexOf("not configured") >= 0 ? "EI KONFIGUROITU" : kind === "ok" ? "READ-ONLY" : kind === "error" ? "EI KÄYTETTÄVISSÄ" : "ETORO";
  }

  function show(value) {
    $("etoroOutput").textContent = JSON.stringify(value, null, 2);
  }

  async function request(action, params) {
    var query = new URLSearchParams(Object.assign({ action: action }, params || {}));
    var response = await fetch("/api/etoro?" + query.toString(), {
      method: "GET", cache: "no-store", headers: { Accept: "application/json" }
    });
    var payload = await response.json();
    if (!response.ok) {
      if (payload && payload.configured === false) $("etoroState").textContent = "EI KONFIGUROITU";
      throw new Error(payload && payload.error || "eToro API request failed.");
    }
    return payload.data;
  }

  function busy(button, value) {
    if (button) button.disabled = value;
  }

  $("etoroSearchButton").addEventListener("click", async function () {
    var button = this;
    var query = $("etoroSearchQuery").value.trim();
    if (!query) return setStatus("Anna instrumentin symboli tai hakusana.", "error");
    busy(button, true);
    setStatus("Haetaan eToron instrumentteja…");
    try {
      var payload = await request("search", { q: query });
      var items = payload && Array.isArray(payload.items) ? payload.items : [];
      state.instruments = items;
      var select = $("etoroInstrumentSelect");
      select.textContent = "";
      items.forEach(function (item) {
        var option = document.createElement("option");
        option.value = String(item.instrumentId);
        option.textContent = String(item.displayname || item.internalSymbolFull || "Instrument") +
          " · ID " + item.instrumentId + (item.isCurrentlyTradable === false ? " · ei kaupankäyntiä" : "");
        select.appendChild(option);
      });
      if (!items.length) {
        var empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "Ei hakutuloksia";
        select.appendChild(empty);
      }
      setStatus("Instrumenttihaku valmis: " + items.length + " tulosta. Valitse kohde ja pyydä reaaliaikainen bid/ask.", "ok");
      show({ totalItems: payload.totalItems, items: items });
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      busy(button, false);
    }
  });

  $("etoroQuoteButton").addEventListener("click", async function () {
    var button = this, instrumentId = $("etoroInstrumentSelect").value;
    if (!instrumentId) return setStatus("Hae ja valitse ensin eToro-instrumentti.", "error");
    busy(button, true);
    setStatus("Tarkistetaan reaaliaikaista bid/ask-hintaa…");
    try {
      var quotes = await request("rates", { instrumentIds: instrumentId });
      show(quotes);
      if (!Array.isArray(quotes) || !quotes.length) {
        setStatus("eToro ei palauttanut kelvollista reaaliaikaista hintaa. Viivästettyä tai vanhaa hintaa ei hyväksytä.", "error");
      } else {
        setStatus("Reaaliaikainen eToro-hinta vahvistettu. Tämä tieto pysyy erillään Binance-signaalista.", "ok");
      }
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      busy(button, false);
    }
  });

  $("etoroFeedButton").addEventListener("click", async function () {
    var button = this, instrumentId = $("etoroInstrumentSelect").value;
    if (!instrumentId) return setStatus("Valitse ensin eToro-instrumentti.", "error");
    busy(button, true);
    setStatus("Haetaan instrumentin julkista sosiaalista syötettä…");
    try {
      var feed = await request("feed", { instrumentId: instrumentId, take: "20" });
      show(feed);
      setStatus("Julkinen eToro-markkinasyöte haettu. Sisältöä ei muuteta Binance-signaaliksi.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      busy(button, false);
    }
  });

  $("etoroInvestorButton").addEventListener("click", async function () {
    var button = this, username = $("etoroUsername").value.trim();
    if (!username) return setStatus("Anna julkinen eToro-käyttäjänimi.", "error");
    busy(button, true);
    setStatus("Haetaan julkista sijoittajaprofiilia ja CopyTrader-tilastoja…");
    try {
      var results = await Promise.all([
        request("profiles", { usernames: username }),
        request("copiers", { username: username })
      ]);
      show({ profiles: results[0], copierStats: results[1] });
      setStatus("Julkiset sijoittaja- ja kopioijatilastot haettu read-only-rajapinnoista.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      busy(button, false);
    }
  });

  $("etoroRankingButton").addEventListener("click", async function () {
    var button = this;
    busy(button, true);
    setStatus("Haetaan eToron julkista sijoittajarankingia…");
    try {
      var rankings = await request("rankings", { period: "CurrYear", sort: "-copiers", page: "1", pageSize: "10" });
      show(rankings);
      setStatus("Julkinen sijoittajaranking haettu. Ranking ei käynnistä kopiointia eikä toimeksiantoja.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      busy(button, false);
    }
  });

  setStatus("eToro on erillinen tietolähde. Lisää palvelinpuolen Read-only-avaimet ennen hakua.");
})();
