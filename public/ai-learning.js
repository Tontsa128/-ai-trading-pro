(function () {
  "use strict";

  const MODEL_URL = "./learner-model.json";
  const DEFAULT_MODEL = {
    version: 1,
    samples: 0,
    winRate: 0,
    adaptiveStrength: 50,
    avgMomentum: 0,
    avgFastSlow: 0,
    avgSpreadPct: 0,
    lastUpdated: new Date().toISOString(),
    status: "waiting-for-data"
  };

  function setText(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function setClass(id, className) {
    const node = document.getElementById(id);
    if (node) node.className = className;
  }

  async function loadModel() {
    try {
      const response = await fetch(MODEL_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!response.ok) return DEFAULT_MODEL;
      const data = await response.json();
      return data && typeof data === "object" ? data : DEFAULT_MODEL;
    } catch (error) {
      return DEFAULT_MODEL;
    }
  }

  function render(model) {
    const samples = Number(model.samples || 0);
    const winRate = Number(model.winRate || 0);
    const strength = Number(model.adaptiveStrength || 50);
    const status = model.status || "waiting-for-data";

    setText("aiSamples", samples > 0 ? String(samples) : "—");
    setText("aiWinRate", samples > 0 ? winRate.toFixed(1) + "%" : "—");
    setText("aiStrength", samples > 0 ? strength.toFixed(1) + "%" : "—");
    setText("aiStatus", samples > 0 ? status : "odottaa dataa");

    const statusLabel = samples > 0 ? (
      status === "improving" ? "oppiminen vahvistuu" :
      status === "stable" ? "tasapainoinen" :
      "opetellaan"
    ) : "Ei vielä opetettuja esimerkkejä";

    setText("aiLearningSummary", statusLabel);
    setClass("aiSummaryBadge", "pill " + (samples > 0 ? "good" : "neutral"));
    setText("aiSummaryBadge", samples > 0 ? "AI LEARNING" : "WAITING");
  }

  async function boot() {
    const model = await loadModel();
    render(model);
    setInterval(async () => {
      const fresh = await loadModel();
      render(fresh);
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.AILearningDashboard = { loadModel, render };
})();
