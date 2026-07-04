import { analyseSrrFromOsuText } from "./srrEngine.js";
import { clearCharts, renderNpsChart, renderFatigueChart } from "./chartRenderer.js";
import { formatSeconds } from "./srrMath.js";

const osuInput = document.getElementById("osuInput");
const osuFileInput = document.getElementById("osuFileInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const clearBtn = document.getElementById("clearBtn");
const fileNameLabel = document.getElementById("fileNameLabel");
const resultPanel = document.getElementById("resultPanel");
const skillPanel = document.getElementById("skillPanel");
const statsPanel = document.getElementById("statsPanel");
const messagePanel = document.getElementById("messagePanel");
const npsCanvas = document.getElementById("npsChart");
const fatigueCanvas = document.getElementById("fatigueChart");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setMessage(type, messages) {
  const list = Array.isArray(messages) ? messages : [messages];

  if (!list.length || !list[0]) {
    messagePanel.className = "hidden";
    messagePanel.innerHTML = "";
    return;
  }

  const typeClass = type === "error"
    ? "bg-rose-500/10 border-rose-500/30 text-rose-100"
    : type === "success"
      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-100"
    : "bg-amber-500/10 border-amber-500/30 text-amber-100";

  messagePanel.className = `rounded-lg border p-4 ${typeClass}`;
  messagePanel.innerHTML = list.map((message) => `<div>${escapeHtml(message)}</div>`).join("");
}

function resetFileSelection() {
  if (osuFileInput) osuFileInput.value = "";
  if (fileNameLabel) fileNameLabel.textContent = "No file selected";
}

function metric(label, value) {
  return `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function maxSkillPeak(skillProfile) {
  return Math.max(0.001, ...skillProfile.map((skill) => skill.peak));
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function renderKeyPatternBreakdown(stats) {
  return `
    <div class="mt-5 mb-5 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <div class="flex items-center justify-between gap-3 mb-3">
        <div class="text-sm font-bold text-slate-200">Azusa Pattern Mix</div>
        <div class="text-xs text-slate-500">${stats.rowCount} rows</div>
      </div>
      <div class="space-y-3">
        ${stats.patternBreakdown.map((pattern) => `
          <div class="pattern-row">
            <div class="pattern-meta">
              <span>${escapeHtml(pattern.label)}</span>
              <span>${percent(pattern.rate)}</span>
            </div>
            <div class="pattern-track">
              <div class="pattern-fill" style="width: ${pattern.rate > 0 ? Math.max(1, pattern.rate * 100).toFixed(2) : 0}%"></div>
            </div>
            <div class="pattern-details">
              ${pattern.details
                .filter((detail) => detail.rate > 0)
                .map((detail) => `${escapeHtml(detail.label)} (${percent(detail.rate)})`)
                .join(", ") || "No strong subtype"}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderTypeClassification(stats) {
  const classification = stats.typeClassification;
  if (!classification?.categories?.length) return "";

  return `
    <div class="type-classification mt-5 mb-5">
      <div class="classification-head">
        <div>
          <div class="text-sm font-bold text-slate-200">Type Classification</div>
          <div class="text-xs text-slate-500">${escapeHtml(classification.source)}</div>
        </div>
        <div class="classification-tags">
          ${classification.dominantTerms.map((term) => `
            <span>${escapeHtml(term.label)} · ${percent(term.rate)}</span>
          `).join("")}
        </div>
      </div>
      <div class="classification-grid">
        ${classification.categories.map((group) => `
          <section class="classification-group">
            <h3>${escapeHtml(group.label)}</h3>
            <div class="classification-items">
              ${group.items.map((entry) => `
                <div class="classification-item">
                  <div class="classification-meta">
                    <span>${escapeHtml(entry.label)}</span>
                    <span>${percent(entry.rate)}</span>
                  </div>
                  <div class="classification-track">
                    <div class="classification-fill" style="width: ${entry.rate > 0 ? Math.max(1, entry.rate * 100).toFixed(2) : 0}%"></div>
                  </div>
                </div>
              `).join("")}
            </div>
          </section>
        `).join("")}
      </div>
    </div>
  `;
}

function renderPipeline(pipeline) {
  return `
    <div class="pipeline">
      ${pipeline.map((stage) => `<span>${escapeHtml(stage)}</span>`).join("")}
    </div>
  `;
}

function renderResult(result) {
  const { algorithm, metadata, difficulty, pipeline, stats } = result;
  const courseCalibrationLine = difficulty.courseCalibration.active
    ? `<div class="text-cyan-200 text-sm font-bold">Course Calibration: ${escapeHtml(difficulty.courseCalibration.target.label)}</div>`
    : "";
  const streamSubtype = stats.dominantPattern.key === "stream" && stats.typeClassification?.dominantStream
    ? ` · ${stats.typeClassification.dominantStream.label}`
    : "";
  const jackSubtype = stats.dominantPattern.key === "jacks" && stats.typeClassification?.dominantJack
    ? ` · ${stats.typeClassification.dominantJack.label}`
    : "";
  const patternSubtype = streamSubtype || jackSubtype;

  resultPanel.innerHTML = `
    <div class="azusa-hero">
      <div>
        <div class="eyebrow">${escapeHtml(algorithm.version)}</div>
        <div class="star-readout">
          ${difficulty.star.toFixed(2)}<span>★</span>
        </div>
        <div class="rank-readout">${escapeHtml(difficulty.reformLabel)}</div>
      </div>
      <div class="hero-side">
        <div class="dominant-label">Azusa RC</div>
        <div class="dominant-value">${escapeHtml(difficulty.azusaRcLabel)}</div>
        <div class="dominant-rate">${escapeHtml(stats.dominantPattern.label)} · ${percent(stats.dominantPattern.rate)}${escapeHtml(patternSubtype)}</div>
      </div>
    </div>

    ${renderPipeline(pipeline)}
    ${renderKeyPatternBreakdown(stats)}
    ${renderTypeClassification(stats)}

    <div class="map-meta">
      <div class="text-lg font-bold text-slate-100">${escapeHtml(metadata.title)}</div>
      <div class="text-slate-400">${escapeHtml(metadata.artist)}</div>
      <div class="text-slate-300">[${escapeHtml(metadata.version)}]</div>
      <div class="text-slate-500 text-sm">Mapped by ${escapeHtml(metadata.creator)}</div>
      <div class="text-cyan-200 text-sm font-bold">Algorithm: ${escapeHtml(algorithm.label)}</div>
      ${courseCalibrationLine}
    </div>
  `;

  statsPanel.innerHTML = [
    metric("Algorithm", algorithm.label),
    metric("Reference Mode", difficulty.referenceMode),
    metric("Course Calibration", difficulty.courseCalibration.active ? difficulty.courseCalibration.target.label : "off"),
    metric("Convert Damp", difficulty.convertChordstreamDamp.toFixed(3)),
    metric("Dense Jack Damp", difficulty.denseJackWallDamp.toFixed(3)),
    metric("High Stream Lift", difficulty.highEndStreamLift.toFixed(3)),
    metric("Azusa RC", difficulty.azusaRcLabel),
    metric("4K Reform Band", difficulty.rc4KReformLabel || difficulty.reformLabel),
    metric("Estimator Star", difficulty.estimatorStar.toFixed(2)),
    metric("Note Count", stats.noteCount),
    metric("Duration", formatSeconds(stats.durationMs)),
    metric("Avg NPS", stats.avgNps.toFixed(2)),
    metric("Max NPS 250ms", stats.maxNps250.toFixed(2)),
    metric("Max NPS 500ms", stats.maxNps500.toFixed(2)),
    metric("LN Ratio", percent(stats.lnRatio)),
    metric("Rows", stats.rowCount),
    metric("Chord Rate", percent(stats.chordRate)),
    metric("Jack Rate", percent(stats.jackRate)),
    metric("Mini-jack Rate", percent(stats.miniJackRate)),
    metric("Stream Timing", stats.typeClassification?.dominantStream?.label || "none"),
    metric("Jack Timing", stats.typeClassification?.dominantJack?.label || "none"),
    metric("Anchor Imbalance", percent(stats.anchorImbalance)),
    metric("Azusa Raw", difficulty.rawNumeric.toFixed(3)),
    metric("Azusa Numeric", difficulty.correctedNumeric.toFixed(3))
  ].join("");
}

function renderSkillProfile(result) {
  const skills = result.difficulty.skillProfile;
  const maxPeak = maxSkillPeak(skills);

  skillPanel.innerHTML = `
    <div class="space-y-3">
      ${skills.map((skill) => `
        <div class="skill-row">
          <div class="skill-head">
            <span>${escapeHtml(skill.label)}</span>
            <span>weight ${(skill.weight * 100).toFixed(0)}%</span>
          </div>
          <div class="skill-track">
            <div class="skill-fill" style="width: ${Math.max(2, (skill.peak / maxPeak) * 100).toFixed(2)}%"></div>
          </div>
          <div class="skill-foot">
            <span>Peak ${skill.peak.toFixed(2)}</span>
            <span>Sustain ${skill.sustain.toFixed(2)}</span>
            <span>Median ${skill.median.toFixed(2)}</span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function analyze() {
  const result = analyseSrrFromOsuText(osuInput.value);

  if (!result.ok) {
    setMessage("error", result.message);
    resultPanel.innerHTML = "Load a 4K .osu chart and run Azusa.";
    skillPanel.innerHTML = "No analysis yet.";
    statsPanel.innerHTML = "";
    clearCharts();
    return;
  }

  setMessage("warning", result.warnings);
  renderResult(result);
  renderSkillProfile(result);
  renderNpsChart(npsCanvas, result.curves);
  renderFatigueChart(fatigueCanvas, result.curves);
}

analyzeBtn.addEventListener("click", analyze);

osuFileInput.addEventListener("change", async () => {
  const file = osuFileInput.files?.[0];
  if (!file) {
    resetFileSelection();
    return;
  }

  if (!file.name.toLowerCase().endsWith(".osu")) {
    resetFileSelection();
    setMessage("error", "Please select a .osu file.");
    return;
  }

  try {
    const text = await file.text();
    osuInput.value = text;
    fileNameLabel.textContent = file.name;
    setMessage("success", `Loaded ${file.name}. Click Analyze Azusa to run.`);
    osuInput.focus();
  } catch (error) {
    resetFileSelection();
    setMessage("error", `Could not read the selected file: ${error.message}`);
  }
});

clearBtn.addEventListener("click", () => {
  osuInput.value = "";
  resetFileSelection();
  resultPanel.innerHTML = "Load a 4K .osu chart and run Azusa.";
  skillPanel.innerHTML = "No analysis yet.";
  statsPanel.innerHTML = "";
  setMessage(null, "");
  clearCharts();
});
