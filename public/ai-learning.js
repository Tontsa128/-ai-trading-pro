(function () {
  "use strict";

  const AI_MODEL_URL = "./learner-model.json";
  const AI_DEFAULT = {
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

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setClass(id, className) {
    const el = document.getElementById(id);
    if (el) el.className = className;
  }

  async function loadModel() {
    try {
      const res = await fetch(AI_MODEL_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return AI_DEFAULT;
      const json = await res.json();
      return json && typeof json === "object" ? json : AI_DEFAULT;
    } catch (e) {
      return AI_DEFAULT;
    }
  }

  function render(model) {
    const samples = Number(model.samples || 0);
    const winRate = Number(model.winRate || 0);
    const strength = Number(model.adaptiveStrength || 50);
    const status = model.status || "waiting-for-data";

    if (samples > 0) {
      setText("aiSamples", String(samples));
      setText("aiWinRate", winRate.toFixed(1) + "%");
      setText("aiStrength", strength.toFixed(1) + "%");
      setText("aiStatus", status);
      setText("aiLearningSummary",
        status === "improving" ? "Oppiminen vahvistuu" :
        status === "stable" ? "Tasapainoinen" :
        "Opetellaan jatkuvasti"
      );
      setClass("aiSummaryBadge", "pill good");
      setText("aiSummaryBadge", "AI LEARNING");
    } else {
      setText("aiSamples", "—");
      setText("aiWinRate", "—");
      setText("aiStrength", "—");
      setText("aiStatus", "odottaa dataa");
      setText("aiLearningSummary", "Ei vielä opetettuja esimerkkejä");
      setClass("aiSummaryBadge", "pill neutral");
      setText("aiSummaryBadge", "WAITING");
    }
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
