"use strict";

/**
 * Thin, deterministic module boundary around the canonical TradingEngine.
 * This file does not fetch network data or submit exchange orders.
 */
function createStrategyModules(engine) {
  if (!engine || typeof engine.analyzeSeries !== "function" ||
      typeof engine.detectPatterns !== "function" ||
      typeof engine.calculateTradePlan !== "function") {
    throw new Error("Canonical TradingEngine API is required.");
  }

  const allowedSources = new Set(["binance-spot-rest", "binance-spot-websocket"]);

  class DataFetcher {
    static validate(payload, now = Date.now(), maxAgeMs = 300000) {
      if (!payload || !allowedSources.has(payload.source)) {
        return { ok: false, status: "DATA FAIL", reason: "Tuntematon tai vahvistamaton datalähde." };
      }
      if (!Array.isArray(payload.bars) || payload.bars.length < 220) {
        return { ok: false, status: "DATA FAIL", reason: "Vähintään 220 sulkeutunutta kynttilää vaaditaan." };
      }
      const bars = payload.bars;
      const last = bars[bars.length - 1];
      const valid = bars.every((b, i) => {
        const values = [b.time, b.closeTime, b.open, b.high, b.low, b.close, b.volume];
        return values.every(Number.isFinite) && b.time < b.closeTime &&
          b.open > 0 && b.high >= Math.max(b.open, b.close, b.low) &&
          b.low <= Math.min(b.open, b.close, b.high) && b.volume >= 0 &&
          (i === 0 || b.time > bars[i - 1].time);
      });
      if (!valid) return { ok: false, status: "DATA FAIL", reason: "Kynttilädata on virheellistä tai aikajärjestys ei täsmää." };
      const age = now - last.closeTime;
      if (age < -30000 || age > maxAgeMs) {
        return { ok: false, status: "DATA STALE", reason: "Viimeisin sulkeutunut kynttilä on liian vanha tai sen aika on tulevaisuudessa.", ageMs: age };
      }
      return { ok: true, status: "LIVE DATA", source: payload.source, bars: bars, latestCloseTime: last.closeTime, ageMs: age };
    }
  }

  class SupportResistanceAnalyzer {
    static analyze(enrichedBars, lookback = 30) {
      if (!Array.isArray(enrichedBars) || enrichedBars.length < 3) {
        return { support: null, resistance: null, pivots: { highs: [], lows: [] } };
      }
      const window = enrichedBars.slice(-Math.max(3, Math.min(200, lookback)));
      const patterns = engine.detectPatterns(window);
      const last = window[window.length - 1];
      const lows = patterns.pivots.lows.filter(p => p.price < last.close);
      const highs = patterns.pivots.highs.filter(p => p.price > last.close);
      return {
        support: lows.length ? Math.max(...lows.map(p => p.price)) : Math.min(...window.slice(0, -1).map(b => b.low)),
        resistance: highs.length ? Math.min(...highs.map(p => p.price)) : Math.max(...window.slice(0, -1).map(b => b.high)),
        pivots: patterns.pivots
      };
    }
  }

  class PatternRecognizer {
    static analyze(enrichedBars) {
      return engine.detectPatterns(enrichedBars);
    }
  }

  class TargetAndRiskCalculator {
    static calculate(direction, entry, atr, patterns, options, spreadPct) {
      return engine.calculateTradePlan(direction, entry, atr, patterns, options, spreadPct);
    }
  }

  class OrderExecutor {
    // Deliberately paper-only. No exchange client, API key, or network side effect exists here.
    static preparePaperIntent(signal, portfolio) {
      if (!signal || !["BUY", "SELL", "WAIT"].includes(signal.direction)) {
        return { accepted: false, mode: "PAPER_ONLY", reason: "Virheellinen signaali." };
      }
      if (signal.direction === "WAIT") {
        return { accepted: false, mode: "PAPER_ONLY", direction: "WAIT", reason: "ODOTA-signaalia ei toteuteta." };
      }
      if (signal.direction === "SELL") {
        const holdings = portfolio && portfolio.holdings;
        const available = holdings && Number(holdings[signal.symbol]);
        if (!Number.isFinite(available) || available <= 0) {
          return { accepted: false, mode: "PAPER_ONLY", direction: "SELL", reason: "Spot-myyntiin ei ole vahvistettua omistusta." };
        }
        return { accepted: true, mode: "PAPER_ONLY", direction: "SELL", symbol: signal.symbol, quantity: available };
      }
      const plan = signal.riskPlan;
      if (!plan || plan.tradable !== true || !(plan.qty > 0) || !(plan.entry > 0)) {
        return { accepted: false, mode: "PAPER_ONLY", direction: "BUY", reason: "Riskisuunnitelma ei täytä toteutusehtoja." };
      }
      return { accepted: true, mode: "PAPER_ONLY", direction: "BUY", symbol: signal.symbol, quantity: plan.qty, limitReference: plan.entry, stop: plan.stop, target: plan.target };
    }
  }

  return { DataFetcher, SupportResistanceAnalyzer, PatternRecognizer, TargetAndRiskCalculator, OrderExecutor };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createStrategyModules };
