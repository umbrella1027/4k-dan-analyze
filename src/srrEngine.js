import { parseOsuText } from "./osuParser.js";
import {
  clamp,
  mean,
  stddev,
  quantile,
  topPercentMean,
  powerMean,
  safeDiv
} from "./srrMath.js";
import { mapToReformRank } from "./reformMapper.js";
import { runAzusaEstimatorFromText } from "./azusa/azusaEstimator.js";
import { rc4KReform } from "./azusa/4k-rc-reform.js";
import { numericToRcLabel } from "./azusa/rcDifficultyFormat.js";

const DECAY_WINDOWS_MS = [140, 280, 560, 980];
const DECAY_WEIGHTS = [0.34, 0.30, 0.22, 0.14];
const LOCAL_POWER = 2.15;
const STAR_SCALE = 1;
const STAR_OFFSET = 0;

const ALGORITHM_PROFILE = Object.freeze({
  id: "azusa",
  label: "Azusa",
  version: "Azusa RC 4K",
  calibration: "azusa-only-lite"
});

const SKILL_WEIGHTS = {
  speed: 0.36,
  stamina: 0.24,
  chord: 0.12,
  tech: 0.16,
  jack: 0.12
};

const AZUSA_PIPELINE = Object.freeze([
  "Parse",
  "Rows",
  "Strain",
  "Pattern",
  "Calibration",
  "Correction"
]);

function createSkillState() {
  return [0, 0, 0, 0];
}

function decayAndAdd(state, dt, input) {
  const cleanDt = Number.isFinite(dt) ? Math.max(0, dt) : 1000;
  return state.map((value, index) => {
    const tau = DECAY_WINDOWS_MS[index];
    return value * Math.exp(-cleanDt / tau) + input;
  });
}

function weightedStateValue(state) {
  return state.reduce((sum, value, index) => sum + value * DECAY_WEIGHTS[index], 0);
}

export function annotateRows(taps, toleranceMs = 2) {
  const sorted = [...taps].sort((a, b) => a.t - b.t || a.c - b.c);
  let row = [];
  let rowIndex = 0;

  function flush() {
    if (!row.length) return;
    const rowSize = row.length;
    const rowTime = row[0].t;
    for (const note of row) {
      note.rowSize = rowSize;
      note.rowIndex = rowIndex;
      note.rowTime = rowTime;
    }
    row = [];
    rowIndex++;
  }

  for (const note of sorted) {
    if (!row.length) {
      row.push(note);
      continue;
    }

    if (Math.abs(note.t - row[0].t) <= toleranceMs) {
      row.push(note);
    } else {
      flush();
      row.push(note);
    }
  }

  flush();
  return sorted;
}

function summarizeSkill(values) {
  return {
    q97: quantile(values, 0.97),
    q90: quantile(values, 0.90),
    q75: quantile(values, 0.75),
    q50: quantile(values, 0.50),
    tailMean: topPercentMean(values, 0.04),
    powerMean: powerMean(values, 2.6)
  };
}

function weightedSkillSummary(summaries, getter) {
  return (
    SKILL_WEIGHTS.speed * getter(summaries.speed) +
    SKILL_WEIGHTS.stamina * getter(summaries.stamina) +
    SKILL_WEIGHTS.chord * getter(summaries.chord) +
    SKILL_WEIGHTS.tech * getter(summaries.tech) +
    SKILL_WEIGHTS.jack * getter(summaries.jack)
  );
}

function computeAzusaNumeric(curves, stats) {
  const summaries = {
    speed: summarizeSkill(curves.speed),
    stamina: summarizeSkill(curves.stamina),
    chord: summarizeSkill(curves.chord),
    tech: summarizeSkill(curves.tech),
    jack: summarizeSkill(curves.jack)
  };

  const peakAzusa = weightedSkillSummary(
    summaries,
    (skill) => 0.65 * skill.q97 + 0.35 * skill.q90
  );

  const sustainAzusa = weightedSkillSummary(
    summaries,
    (skill) => 0.55 * skill.q75 + 0.45 * skill.tailMean
  );

  const densityAzusa =
    0.14 * Math.log1p(stats.maxNps250) +
    0.22 * Math.log1p(stats.maxNps500);

  const midAzusa = weightedSkillSummary(summaries, (skill) => skill.q50);
  const lengthBoost = Math.min(3.5, Math.pow(Math.max(1, stats.noteCount) / 600, 0.22));

  const raw =
    0.52 * peakAzusa +
    0.26 * sustainAzusa +
    0.10 * densityAzusa +
    0.08 * midAzusa +
    0.04 * lengthBoost;

  const scaled = 0.82 + 0.43 * raw;

  return {
    raw,
    scaled,
    summaries,
    components: {
      peakAzusa,
      sustainAzusa,
      densityAzusa,
      midAzusa,
      lengthBoost
    }
  };
}

function buildAzusaSkillProfile(primary) {
  return Object.entries(primary.summaries).map(([key, summary]) => ({
    key,
    label: key[0].toUpperCase() + key.slice(1),
    weight: SKILL_WEIGHTS[key],
    peak: 0.65 * summary.q97 + 0.35 * summary.q90,
    sustain: 0.55 * summary.q75 + 0.45 * summary.tailMean,
    median: summary.q50,
    power: summary.powerMean
  }));
}

function mapStarToRc4KReform(star) {
  const value = Number(star);
  if (!Number.isFinite(value)) return null;

  const match = rc4KReform.find(([min, max]) => value >= min && value < max);
  if (match) return match[2];

  const first = rc4KReform[0];
  const last = rc4KReform[rc4KReform.length - 1];

  if (first && value < first[0]) return `Below ${first[2]}`;
  if (last && value >= last[1]) return `Above ${last[2]}`;
  return null;
}

function parseOrdinalRank(text) {
  const match = String(text || "").match(/~?\s*(\d{1,2})(?:st|nd|rd|th)\s*~?/i);
  if (!match) return null;

  const rank = Number(match[1]);
  return Number.isInteger(rank) && rank >= 1 && rank <= 10 ? rank : null;
}

function reformBandForRank(rank) {
  return rc4KReform.filter(([, , label]) => (
    new RegExp(`^Reform\\s+${rank}\\b`, "i").test(label)
  ));
}

function reformMidStarForRank(rank) {
  const rows = reformBandForRank(rank);
  if (!rows.length) return null;

  const mid = rows.find(([, , label]) => /\bmid$/i.test(label));
  const source = mid || rows[Math.floor(rows.length / 2)];
  return (source[0] + source[1]) / 2;
}

function detectDanCourseTarget(metadata) {
  const title = String(metadata?.title || "");
  const version = String(metadata?.version || "");
  const haystack = `${title} ${version}`;

  if (!/\bdan\b/i.test(title) || !/\breform\b/i.test(title)) return null;
  if (!/\bmarathon\b/i.test(version)) return null;

  const rank = parseOrdinalRank(version);
  if (!rank) return null;

  const targetStar = reformMidStarForRank(rank);
  if (!Number.isFinite(targetStar)) return null;

  return {
    source: "metadata",
    rank,
    label: `Reform ${rank}`,
    targetStar,
    matchedText: haystack.trim()
  };
}

function applyDanCourseCalibration(star, metadata) {
  const target = detectDanCourseTarget(metadata);
  if (!target) {
    return {
      star,
      active: false,
      target: null
    };
  }

  return {
    star: target.targetStar,
    active: true,
    target
  };
}

function computeConvertChordstreamDamp(stats, numericDifficulty) {
  const numeric = Number(numericDifficulty);
  if (!Number.isFinite(numeric)) return 0;

  const lnGate = clamp((stats.lnRatio - 0.03) / 0.03, 0, 1) *
    clamp((0.16 - stats.lnRatio) / 0.04, 0, 1);
  const chordGate = clamp((stats.chordRate - 0.50) / 0.10, 0, 1);
  const anchorGate = clamp((0.10 - stats.anchorImbalance) / 0.10, 0, 1);
  const numericGate = clamp((numeric - 6.1) / 0.6, 0, 1) *
    clamp((7.3 - numeric) / 0.4, 0, 1);

  return clamp(1.05 * lnGate * chordGate * anchorGate * numericGate, 0, 1.05);
}

function computeDenseJackWallDamp(stats, numericDifficulty) {
  const numeric = Number(numericDifficulty);
  if (!Number.isFinite(numeric)) return 0;

  const bigChordRate = stats.keyPatternRates.triple + stats.keyPatternRates.quad;
  const jackEventRate = stats.jackRate + stats.miniJackRate;
  const jackGate = clamp((jackEventRate - 0.45) / 0.25, 0, 1);
  const chordGate = clamp((stats.chordRate - 0.65) / 0.20, 0, 1);
  const bigChordGate = clamp((bigChordRate - 0.45) / 0.25, 0, 1);
  const mixedChordGate = clamp((0.80 - stats.keyPatternRates.quad) / 0.20, 0, 1);
  const anchorGate = clamp((0.08 - stats.anchorImbalance) / 0.08, 0, 1);
  const lnGate = clamp((0.04 - stats.lnRatio) / 0.04, 0, 1);
  const numericGate = clamp((numeric - 7.0) / 1.0, 0, 1);

  return clamp(
    4.30 * jackGate * chordGate * bigChordGate * mixedChordGate * anchorGate * lnGate * numericGate,
    0,
    4.30
  );
}

function computeHighEndStreamLift(stats, numericDifficulty) {
  const numeric = Number(numericDifficulty);
  if (!Number.isFinite(numeric)) return 0;

  const streamRate = stats.patternBreakdown.find((pattern) => pattern.key === "stream")?.rate ?? 0;
  const jackEventRate = stats.jackRate + stats.miniJackRate;
  const numericGate = clamp((numeric - 8.0) / 0.8, 0, 1);
  const streamGate = clamp((streamRate - 0.62) / 0.16, 0, 1);
  const lnGate = clamp((stats.lnRatio - 0.09) / 0.04, 0, 1) *
    clamp((0.18 - stats.lnRatio) / 0.05, 0, 1);
  const densityGate = clamp((stats.maxNps250 - 32) / 4, 0, 1);
  const jackGate = clamp((0.12 - jackEventRate) / 0.08, 0, 1);
  const anchorGate = clamp((0.05 - stats.anchorImbalance) / 0.05, 0, 1);

  return clamp(3.08 * numericGate * streamGate * lnGate * densityGate * jackGate * anchorGate, 0, 3.08);
}

function applyAzusaStructuralCorrection(primary, stats, curves) {
  const jackQ95 = quantile(curves.jack, 0.95);

  const gChord = clamp((stats.chordRate - 0.40) * 3.5, 0, 1);
  const gJack = clamp((jackQ95 - 1.25) * 2.8, 0, 1);
  const gAnchor = clamp(1 - stats.anchorImbalance * 8, 0, 1);

  const chordjackBoost = clamp(2.5 * gChord * gJack * gAnchor, 0, 2.2);

  const midSpeedBonus =
    clamp((stats.avgNps - 9) * 0.04, 0, 0.35) *
    clamp((19 - stats.avgNps) * 0.25, 0, 1);

  const corrected = primary.scaled + chordjackBoost + midSpeedBonus;

  return {
    corrected,
    chordjackBoost,
    midSpeedBonus,
    jackQ95
  };
}

function buildRows(notes) {
  const rows = [];
  let currentRow = null;

  for (const note of notes) {
    if (!currentRow || currentRow.index !== note.rowIndex) {
      currentRow = {
        index: note.rowIndex,
        t: note.rowTime ?? note.t,
        rowSize: note.rowSize,
        columns: [],
        notes: []
      };
      rows.push(currentRow);
    }

    currentRow.columns.push(note.c);
    currentRow.notes.push(note);
  }

  return rows;
}

function singleColumn(row) {
  return row?.rowSize === 1 ? row.columns[0] : null;
}

function computePatternBreakdown(rows, noteCount, jackCount, miniJackCount, anchorImbalance) {
  const rowCount = rows.length;
  const chordRows = rows.filter((row) => row.rowSize >= 2).length;
  const jumpstreamRows = rows.filter((row) => row.rowSize === 2).length;
  const handstreamRows = rows.filter((row) => row.rowSize >= 3).length;

  let flowingRows = 0;
  let singleFlowingRows = 0;
  let rollRows = 0;
  let minitrillRows = 0;
  let irregularRows = 0;
  let wideJumpRows = 0;
  const recentDts = [];

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];
    const dt = Math.max(1, current.t - previous.t);
    const currentSingle = singleColumn(current);
    const previousSingle = singleColumn(previous);

    recentDts.push(dt);
    if (recentDts.length > 6) recentDts.shift();

    const localChaos = clamp(safeDiv(stddev(recentDts), mean(recentDts), 0), 0, 2);
    if (recentDts.length >= 4 && localChaos > 0.24) irregularRows++;

    if (currentSingle !== null && previousSingle !== null) {
      const moved = currentSingle !== previousSingle;
      const distance = Math.abs(currentSingle - previousSingle);

      if (dt <= 220 && moved) {
        singleFlowingRows++;
        if (distance === 1 || distance === 3) rollRows++;
      }

      if (distance >= 2) wideJumpRows++;

      const twoBackSingle = singleColumn(rows[i - 2]);
      if (
        dt <= 280 &&
        twoBackSingle !== null &&
        currentSingle === twoBackSingle &&
        currentSingle !== previousSingle
      ) {
        minitrillRows++;
      }
    }

    const movedAny = current.columns.some((column) => !previous.columns.includes(column));
    if (dt <= 220 && movedAny) flowingRows++;
  }

  const jackEvents = jackCount + miniJackCount;
  const adjacentJackRate = safeDiv(jackEvents, noteCount, 0);
  const streamPurity =
    clamp(1 - adjacentJackRate * 4, 0, 1) *
    clamp(1 - anchorImbalance * 6, 0, 1);
  const streamRate = Math.max(
    safeDiv(singleFlowingRows, rowCount, 0),
    safeDiv(flowingRows, rowCount, 0) * streamPurity
  );
  const anchorRate = clamp(anchorImbalance * 4, 0, 1);
  const techRows = Math.min(rowCount, irregularRows + wideJumpRows + Math.round(anchorRate * rowCount));

  return [
    {
      key: "chordstream",
      label: "Chordstream",
      rate: safeDiv(chordRows, rowCount, 0),
      details: [
        { label: "Jumpstream", rate: safeDiv(jumpstreamRows, chordRows, 0) },
        { label: "Handstream", rate: safeDiv(handstreamRows, chordRows, 0) }
      ]
    },
    {
      key: "stream",
      label: "Stream",
      rate: streamRate,
      details: [
        { label: "Rolls", rate: safeDiv(rollRows, Math.max(1, singleFlowingRows), 0) },
        { label: "Minitrills", rate: safeDiv(minitrillRows, Math.max(1, singleFlowingRows), 0) }
      ]
    },
    {
      key: "jacks",
      label: "Jacks",
      rate: safeDiv(jackEvents, noteCount, 0),
      details: [
        { label: "Jacks", rate: safeDiv(jackCount, Math.max(1, jackEvents), 0) },
        { label: "Minijacks", rate: safeDiv(miniJackCount, Math.max(1, jackEvents), 0) }
      ]
    },
    {
      key: "tech",
      label: "Tech",
      rate: safeDiv(techRows, rowCount, 0),
      details: [
        { label: "Irregular", rate: safeDiv(irregularRows, Math.max(1, techRows), 0) },
        { label: "Wide jumps", rate: safeDiv(wideJumpRows, Math.max(1, techRows), 0) },
        { label: "Anchor", rate: safeDiv(Math.round(anchorRate * rowCount), Math.max(1, techRows), 0) }
      ]
    }
  ];
}

function selectDominantPattern(patternBreakdown, keyPatternRates) {
  const patterns = Object.fromEntries(patternBreakdown.map((pattern) => [pattern.key, pattern]));
  const jacks = patterns.jacks;
  const chordstream = patterns.chordstream;
  const stream = patterns.stream;

  if (jacks?.rate >= 0.55 && keyPatternRates.quad < 0.80) {
    return jacks;
  }

  if (
    jacks?.rate >= 0.38 &&
    chordstream?.rate >= 0.70 &&
    (stream?.rate ?? 0) < 0.15 &&
    keyPatternRates.quad < 0.30
  ) {
    return jacks;
  }

  return patternBreakdown.reduce(
    (best, pattern) => pattern.rate > best.rate ? pattern : best,
    patternBreakdown[0] || { key: "unknown", label: "Unknown", rate: 0 }
  );
}

function item(key, label, rate) {
  return {
    key,
    label,
    rate: clamp(rate, 0, 1)
  };
}

function category(key, label, items) {
  return {
    key,
    label,
    items: items.filter((entry) => Number.isFinite(entry.rate))
  };
}

function hasSameColumn(left, right) {
  return left.columns.some((column) => right.columns.includes(column));
}

function rowPairCenter(row) {
  if (!row?.columns?.length) return null;
  return mean(row.columns);
}

function lnEndTime(note) {
  if (!note.isLN) return note.t;
  const raw = String(note.objectParams || "").split(":")[0];
  const endTime = Number(raw);
  return Number.isFinite(endTime) ? endTime : note.t;
}

function classifyStreamSegment(segmentRows) {
  const rowTotal = Math.max(1, segmentRows.length);
  const rowSizes = segmentRows.map((row) => row.rowSize);
  const singleRate = rowSizes.filter((size) => size === 1).length / rowTotal;
  const doubleRate = rowSizes.filter((size) => size === 2).length / rowTotal;
  const tripleRate = rowSizes.filter((size) => size === 3).length / rowTotal;
  const quadRate = rowSizes.filter((size) => size >= 4).length / rowTotal;
  const avgSize = mean(rowSizes);
  const dts = [];

  for (let index = 1; index < segmentRows.length; index++) {
    dts.push(Math.max(1, segmentRows[index].t - segmentRows[index - 1].t));
  }

  const timingCv = dts.length >= 2 ? safeDiv(stddev(dts), mean(dts), 0) : 0;
  const timingSpread = dts.length >= 2
    ? (Math.max(...dts) - Math.min(...dts)) / Math.max(1, mean(dts))
    : 0;

  if (timingCv > 0.55 || timingSpread > 1.25) return "brokenStream";
  if (quadRate >= 0.28 || avgSize >= 3.45) return "quadStream";
  if (tripleRate >= 0.24 || avgSize >= 2.70) return "denseHandstream";
  if (tripleRate >= 0.08) return "lightHandstream";
  if (doubleRate >= 0.52 || avgSize >= 1.55) return "denseJumpstream";
  if (doubleRate >= 0.16 || avgSize >= 1.15) return "lightJumpstream";
  if (singleRate >= 0.70) return "singleStream";
  return "brokenStream";
}

function computeStreamTimingClassification(rows) {
  const counts = {
    singleStream: 0,
    lightJumpstream: 0,
    denseJumpstream: 0,
    lightHandstream: 0,
    denseHandstream: 0,
    quadStream: 0,
    brokenStream: 0
  };
  const segments = [];
  let segment = [];

  function flush() {
    if (segment.length >= 4) {
      const key = classifyStreamSegment(segment);
      counts[key] += segment.length;
      segments.push({
        key,
        start: segment[0].t,
        end: segment[segment.length - 1].t,
        rows: segment.length
      });
    }
    segment = [];
  }

  for (let index = 0; index < rows.length; index++) {
    const current = rows[index];
    const previous = rows[index - 1];

    if (!previous) {
      segment = [current];
      continue;
    }

    const dt = current.t - previous.t;
    const movedAny = current.columns.some((column) => !previous.columns.includes(column));
    const denseStreamRow = current.rowSize >= 3 || previous.rowSize >= 3;
    const streamTiming = dt >= 45 && dt <= 220 && (movedAny || denseStreamRow);

    if (streamTiming) {
      segment.push(current);
    } else {
      flush();
      segment = [current];
    }
  }

  flush();

  return {
    counts,
    segments
  };
}

function longestJackChain(segmentRows) {
  const chainLengths = [0, 0, 0, 0];
  let longest = 0;

  for (const row of segmentRows) {
    for (let column = 0; column < chainLengths.length; column++) {
      if (row.columns.includes(column)) {
        chainLengths[column]++;
        longest = Math.max(longest, chainLengths[column]);
      } else {
        chainLengths[column] = 0;
      }
    }
  }

  return longest;
}

function classifyJackSegment(segmentRows) {
  const rowTotal = Math.max(1, segmentRows.length);
  const rowSizes = segmentRows.map((row) => row.rowSize);
  const chordRate = rowSizes.filter((size) => size >= 2).length / rowTotal;
  const handRate = rowSizes.filter((size) => size >= 3).length / rowTotal;
  const avgSize = mean(rowSizes);
  const repeatedEvents = [];

  for (let index = 1; index < segmentRows.length; index++) {
    const current = segmentRows[index];
    const previous = segmentRows[index - 1];
    repeatedEvents.push(current.columns.filter((column) => previous.columns.includes(column)).length);
  }

  const repeatedTotal = repeatedEvents.reduce((sum, value) => sum + value, 0);
  const repeatedAvg = safeDiv(repeatedTotal, repeatedEvents.length, 0);
  const repeatedMultiRate = safeDiv(repeatedEvents.filter((value) => value >= 2).length, repeatedEvents.length, 0);
  const chain = longestJackChain(segmentRows);

  if (handRate >= 0.18 || repeatedMultiRate >= 0.35 || avgSize >= 2.45) return "chordjack";
  if (chordRate >= 0.35 || avgSize >= 1.45 || repeatedAvg >= 1.35) return "jumpjack";
  if (chain >= 4 || segmentRows.length >= 5) return "longjack";
  return "minijack";
}

function computeJackTimingClassification(rows) {
  const counts = {
    minijack: 0,
    longjack: 0,
    jumpjack: 0,
    chordjack: 0
  };
  const segments = [];
  let segment = [];

  function repeatedEventCount(segmentRows) {
    let total = 0;
    for (let index = 1; index < segmentRows.length; index++) {
      total += segmentRows[index].columns.filter((column) => segmentRows[index - 1].columns.includes(column)).length;
    }
    return total;
  }

  function flush() {
    if (segment.length >= 2) {
      const key = classifyJackSegment(segment);
      const events = repeatedEventCount(segment);
      counts[key] += events;
      segments.push({
        key,
        start: segment[0].t,
        end: segment[segment.length - 1].t,
        rows: segment.length,
        events
      });
    }
    segment = [];
  }

  for (let index = 1; index < rows.length; index++) {
    const current = rows[index];
    const previous = rows[index - 1];
    const dt = current.t - previous.t;
    const repeatedColumns = current.columns.filter((column) => previous.columns.includes(column)).length;
    const jackTiming = dt >= 35 && dt <= 260 && repeatedColumns > 0;

    if (jackTiming) {
      if (!segment.length) segment = [previous];
      segment.push(current);
    } else {
      flush();
    }
  }

  flush();

  return {
    counts,
    segments
  };
}

function buildTypeClassification(rows, notes, context) {
  const rowCount = Math.max(1, rows.length);
  const noteCount = Math.max(1, notes.length);
  const keyRates = context.keyPatternRates;
  const jackEvents = context.jackCount + context.miniJackCount;
  const streamTiming = computeStreamTimingClassification(rows);
  const jackTiming = computeJackTimingClassification(rows);

  let singleFlowRows = 0;
  let rollRows = 0;
  let splitRollRows = 0;
  let denseJumpRows = 0;
  let denseHandRows = 0;
  let brokenRows = 0;
  let staircaseRows = 0;
  let twoHandTrillRows = 0;
  let oneHandTrillRows = 0;
  let jumptrillRows = 0;
  let splitTrillRows = 0;
  let runningManRows = 0;
  let gallopRows = 0;
  let ladderRows = 0;
  let flamRows = 0;
  let bracketRows = 0;
  let doubleStairRows = 0;
  let symmetricalRows = 0;
  let chordtrillRows = 0;
  let delayRows = 0;

  const recentDts = [];
  let previousSingleDelta = null;
  let previousPairCenter = null;
  let previousPairDelta = null;

  for (let index = 1; index < rows.length; index++) {
    const current = rows[index];
    const previous = rows[index - 1];
    const dt = Math.max(1, current.t - previous.t);
    const fast = dt <= 220;
    const repeatedColumns = current.columns.filter((column) => previous.columns.includes(column)).length;

    recentDts.push(dt);
    if (recentDts.length > 6) recentDts.shift();
    const localChaos = recentDts.length >= 4 ? safeDiv(stddev(recentDts), mean(recentDts), 0) : 0;

    if (fast && current.rowSize >= 2 && previous.rowSize >= 2) denseJumpRows++;
    if (fast && current.rowSize >= 3) denseHandRows++;
    if (localChaos > 0.24) brokenRows++;
    if (dt <= 55) flamRows++;
    if (index >= 2) {
      const previousDt = Math.max(1, previous.t - rows[index - 2].t);
      const ratio = Math.max(dt, previousDt) / Math.max(1, Math.min(dt, previousDt));
      if (ratio >= 1.55 && Math.max(dt, previousDt) <= 360) gallopRows++;
    }

    if (current.rowSize === 2) {
      const set = new Set(current.columns);
      if ((set.has(0) && set.has(3)) || (set.has(1) && set.has(2))) symmetricalRows++;
      if (set.has(0) && set.has(3)) bracketRows++;
      if (previous.rowSize === 2 && fast) {
        const center = rowPairCenter(current);
        const centerDelta = previousPairCenter === null ? 0 : center - previousPairCenter;
        if (previousPairDelta !== null && centerDelta && Math.sign(centerDelta) === Math.sign(previousPairDelta)) {
          doubleStairRows++;
        }
        if (hasSameColumn(current, previous)) chordtrillRows++;
        if (!hasSameColumn(current, previous)) splitTrillRows++;
        previousPairDelta = centerDelta || previousPairDelta;
        previousPairCenter = center;
      } else {
        previousPairCenter = rowPairCenter(current);
      }
    }

    const currentSingle = singleColumn(current);
    const previousSingle = singleColumn(previous);
    if (currentSingle !== null && previousSingle !== null && fast) {
      const distance = Math.abs(currentSingle - previousSingle);
      const delta = currentSingle - previousSingle;

      if (currentSingle !== previousSingle) {
        singleFlowRows++;
        if (distance === 1 || distance === 3) rollRows++;
        if (distance === 2) splitRollRows++;
        if (previousSingleDelta !== null && delta && Math.sign(delta) === Math.sign(previousSingleDelta)) {
          staircaseRows++;
        }
        const currentHand = currentSingle <= 1 ? 0 : 1;
        const previousHand = previousSingle <= 1 ? 0 : 1;
        if (currentHand !== previousHand) twoHandTrillRows++;
        if (currentHand === previousHand) oneHandTrillRows++;
        previousSingleDelta = delta || previousSingleDelta;
      }

      const twoBackSingle = singleColumn(rows[index - 2]);
      if (twoBackSingle !== null && currentSingle === twoBackSingle && currentSingle !== previousSingle) {
        runningManRows++;
      }
    }

    if (
      current.rowSize === 2 &&
      previous.rowSize === 1 &&
      fast &&
      current.columns.includes(previousSingle)
    ) {
      jumptrillRows++;
    }

    if (dt > 55 && dt <= 95 && repeatedColumns > 0) delayRows++;
  }

  const lnNotes = notes.filter((note) => note.isLN);
  const lnRows = rows.filter((row) => row.notes.some((note) => note.isLN));
  const lnChordRows = lnRows.filter((row) => row.rowSize >= 2);
  const longLnRows = lnRows.filter((row) => row.notes.some((note) => lnEndTime(note) - note.t >= 600));
  const inverseRows = lnRows.filter((row) => row.notes.filter((note) => note.isLN).length >= 2);

  const glossary = [
    category("noteType", "Note Type", [
      item("singleNote", "Single note", keyRates.single),
      item("longNote", "Long note / LN", context.lnRatio),
      item("chord", "Chord", context.chordRate)
    ]),
    category("density", "Density", [
      item("jumpDouble", "Jump / Double", keyRates.double),
      item("handTriple", "Hand / Triple", keyRates.triple),
      item("quad", "Quad", keyRates.quad)
    ]),
    category("streams", "Streams", [
      item("singleStream", "Single stream", safeDiv(streamTiming.counts.singleStream, rowCount, 0)),
      item("lightJumpstream", "Light jumpstream", safeDiv(streamTiming.counts.lightJumpstream, rowCount, 0)),
      item("denseJumpstream", "Dense jumpstream", safeDiv(streamTiming.counts.denseJumpstream, rowCount, 0)),
      item("lightHandstream", "Light handstream", safeDiv(streamTiming.counts.lightHandstream, rowCount, 0)),
      item("denseHandstream", "Dense handstream", safeDiv(streamTiming.counts.denseHandstream, rowCount, 0)),
      item("quadStream", "Quad stream", safeDiv(streamTiming.counts.quadStream, rowCount, 0)),
      item("brokenStream", "Broken stream", safeDiv(streamTiming.counts.brokenStream, rowCount, 0))
    ]),
    category("patterns", "Patterns", [
      item("staircase", "Staircase", safeDiv(staircaseRows, rowCount, 0)),
      item("roll", "Roll", safeDiv(rollRows, rowCount, 0)),
      item("splitRoll", "Split roll", safeDiv(splitRollRows, rowCount, 0)),
      item("twoHandTrill", "Two hand trill", safeDiv(twoHandTrillRows, rowCount, 0)),
      item("oneHandTrill", "One hand trill", safeDiv(oneHandTrillRows, rowCount, 0)),
      item("jumptrill", "Jumptrill", safeDiv(jumptrillRows, rowCount, 0)),
      item("splitTrill", "Split trill", safeDiv(splitTrillRows, rowCount, 0)),
      item("runningMan", "Running man", safeDiv(runningManRows, rowCount, 0)),
      item("gallop", "Gallop", safeDiv(gallopRows, rowCount, 0)),
      item("ladder", "Ladder", safeDiv(ladderRows, rowCount, 0)),
      item("flamGrace", "Flam / Grace", safeDiv(flamRows, rowCount, 0)),
      item("anchor", "Anchor", clamp(context.anchorImbalance * 4, 0, 1))
    ]),
    category("jacks", "Jacks", [
      item("minijack", "Minijack", safeDiv(jackTiming.counts.minijack, noteCount, 0)),
      item("longjack", "Longjack", safeDiv(jackTiming.counts.longjack, noteCount, 0)),
      item("jumpjack", "Jumpjack", safeDiv(jackTiming.counts.jumpjack, noteCount, 0)),
      item("chordjack", "Chordjack", safeDiv(jackTiming.counts.chordjack, noteCount, 0))
    ]),
    category("longNotes", "Long Notes", [
      item("shield", "Shield", safeDiv(longLnRows.length, rowCount, 0)),
      item("reverseShield", "Reverse shield", safeDiv(lnChordRows.length, rowCount, 0)),
      item("inverse", "Inverse", safeDiv(inverseRows.length, rowCount, 0))
    ]),
    category("otherKeys", "Other Keys", [
      item("bracket", "Bracket", safeDiv(bracketRows, rowCount, 0)),
      item("doubleStair", "Double stair", safeDiv(doubleStairRows, rowCount, 0)),
      item("chordstream", "Chordstream", context.chordRate),
      item("symmetrical", "Symmetrical", safeDiv(symmetricalRows, rowCount, 0)),
      item("chordtrill", "Chordtrill", safeDiv(chordtrillRows, rowCount, 0)),
      item("delay", "Delay", safeDiv(delayRows, rowCount, 0))
    ])
  ];

  const dominantTerms = glossary
    .flatMap((group) => group.items.map((entry) => ({ ...entry, group: group.label })))
    .filter((entry) => entry.rate > 0)
    .sort((left, right) => right.rate - left.rate)
    .slice(0, 6);
  const dominantStream = glossary
    .find((group) => group.key === "streams")
    ?.items
    .filter((entry) => entry.rate > 0)
    .sort((left, right) => right.rate - left.rate)[0] || null;
  const dominantJack = glossary
    .find((group) => group.key === "jacks")
    ?.items
    .filter((entry) => entry.rate > 0)
    .sort((left, right) => right.rate - left.rate)[0] || null;

  return {
    source: "VSRG Pattern Glossary · Stream/Jack timing windows",
    categories: glossary,
    dominantTerms,
    dominantStream,
    dominantJack,
    jackEventRate: safeDiv(jackEvents, noteCount, 0),
    streamTiming,
    jackTiming
  };
}

function buildDifficultyCurve(notes) {
  const times = notes.map((note) => note.t);
  const previousSameColumn = [null, null, null, null];
  const previousSameHand = [null, null];

  let previousAny = null;
  let previousRowTime = null;

  const recentDts = [];
  let window250Start = 0;
  let window500Start = 0;

  let speedState = createSkillState();
  let staminaState = createSkillState();
  let jackState = createSkillState();
  let chordState = createSkillState();
  let techState = createSkillState();

  const curves = {
    times: [],
    nps250: [],
    nps500: [],
    fatigue: [],
    speed: [],
    stamina: [],
    jack: [],
    chord: [],
    tech: []
  };

  for (let i = 0; i < notes.length;) {
    const rowStart = i;
    const rowTime = notes[rowStart].rowTime ?? notes[rowStart].t;
    const rowIndex = notes[rowStart].rowIndex;

    while (i < notes.length && notes[i].rowIndex === rowIndex) i++;

    const rowEnd = i;
    const rowNotes = notes.slice(rowStart, rowEnd);
    const dtGlobal = previousRowTime !== null ? Math.max(1, rowTime - previousRowTime) : 1000;

    recentDts.push(dtGlobal);
    if (recentDts.length > 8) recentDts.shift();

    const rhythmChaos = clamp(safeDiv(stddev(recentDts), mean(recentDts), 0), 0, 2);
    const preRowColumnTimes = [...previousSameColumn];
    const preRowHandTimes = [...previousSameHand];

    for (let noteIndex = rowStart; noteIndex < rowEnd; noteIndex++) {
      const current = notes[noteIndex];

      while (times[noteIndex] - times[window250Start] > 250) window250Start++;
      while (times[noteIndex] - times[window500Start] > 500) window500Start++;

      const d250 = (noteIndex - window250Start + 1) / 0.25;
      const d500 = (noteIndex - window500Start + 1) / 0.5;
      const dtSame = preRowColumnTimes[current.c] !== null
        ? Math.max(1, rowTime - preRowColumnTimes[current.c])
        : 1000;
      const dtHand = preRowHandTimes[current.hand] !== null
        ? Math.max(1, rowTime - preRowHandTimes[current.hand])
        : 1000;

      const chord = current.rowSize >= 2 ? current.rowSize - 1 : 0;
      const movement = previousAny && current.c !== previousAny.c ? 1 : 0;
      const chordRowPenalty = current.rowSize >= 3 ? 1 : current.rowSize === 2 ? 0.45 : 0;

      const stream = Math.pow(170 / (dtGlobal + 30), 1.07);
      const handStream = Math.pow(185 / (dtHand + 42), 1.08);
      const jackRaw = Math.pow(190 / (dtSame + 35), 1.16);

      const speedInput = 0.60 * stream + 0.30 * handStream + 0.10 * jackRaw;
      const jackInput = jackRaw * (1 + 0.15 * chord);
      const staminaInput = 0.48 * (d500 / 11) + 0.27 * (d250 / 15) + 0.25 * stream;
      const chordInput = chord * (1 + 0.10 * Math.min(1.5, stream));
      const techInput = 0.45 * rhythmChaos + 0.30 * movement + 0.25 * chordRowPenalty;
      const decayDt = noteIndex === rowStart ? dtGlobal : 0;

      speedState = decayAndAdd(speedState, decayDt, speedInput);
      staminaState = decayAndAdd(staminaState, decayDt, staminaInput);
      jackState = decayAndAdd(jackState, decayDt, jackInput);
      chordState = decayAndAdd(chordState, decayDt, chordInput);
      techState = decayAndAdd(techState, decayDt, techInput);

      const speed = weightedStateValue(speedState);
      const stamina = weightedStateValue(staminaState);
      const jack = weightedStateValue(jackState);
      const chordValue = weightedStateValue(chordState);
      const tech = weightedStateValue(techState);
      const fatigue = powerMean([speed, stamina, jack, chordValue, tech], LOCAL_POWER);

      curves.times.push(current.t / 1000);
      curves.nps250.push(d250);
      curves.nps500.push(d500);
      curves.speed.push(speed);
      curves.stamina.push(stamina);
      curves.jack.push(jack);
      curves.chord.push(chordValue);
      curves.tech.push(tech);
      curves.fatigue.push(fatigue);
    }

    for (const note of rowNotes) {
      previousSameColumn[note.c] = rowTime;
      previousSameHand[note.hand] = rowTime;
    }

    previousAny = rowNotes[rowNotes.length - 1];
    previousRowTime = rowTime;
  }

  return curves;
}

function computeStats(notes, curves) {
  const noteCount = notes.length;
  const lnCount = notes.filter((note) => note.isLN).length;
  const lnRatio = safeDiv(lnCount, noteCount, 0);

  const firstTime = notes[0]?.t ?? 0;
  const lastTime = notes[noteCount - 1]?.t ?? firstTime;
  const durationMs = Math.max(0, lastTime - firstTime);
  const avgNps = durationMs > 0 ? noteCount / (durationMs / 1000) : noteCount;

  const rows = buildRows(notes);
  const chordRows = rows.filter((row) => row.rowSize >= 2).length;
  const chordRate = safeDiv(chordRows, rows.length, 0);
  const keyPatternCounts = {
    single: 0,
    double: 0,
    triple: 0,
    quad: 0
  };

  for (const row of rows) {
    if (row.rowSize >= 4) keyPatternCounts.quad++;
    else if (row.rowSize === 3) keyPatternCounts.triple++;
    else if (row.rowSize === 2) keyPatternCounts.double++;
    else keyPatternCounts.single++;
  }

  const rowCount = rows.length;
  const keyPatternRates = {
    single: safeDiv(keyPatternCounts.single, rowCount, 0),
    double: safeDiv(keyPatternCounts.double, rowCount, 0),
    triple: safeDiv(keyPatternCounts.triple, rowCount, 0),
    quad: safeDiv(keyPatternCounts.quad, rowCount, 0)
  };

  let jackCount = 0;
  let miniJackCount = 0;

  for (let index = 1; index < rows.length; index++) {
    const current = rows[index];
    const previous = rows[index - 1];
    const dt = current.t - previous.t;
    const repeatedColumns = current.columns.filter((column) => previous.columns.includes(column)).length;

    if (dt <= 220) {
      jackCount += repeatedColumns;
    } else if (dt <= 360) {
      miniJackCount += repeatedColumns;
    }
  }

  const columnCounts = [0, 0, 0, 0];
  for (const note of notes) {
    columnCounts[note.c]++;
  }

  const maxColumnRatio = Math.max(...columnCounts) / Math.max(1, noteCount);
  const anchorImbalance = Math.max(0, maxColumnRatio - 0.25);
  const patternBreakdown = computePatternBreakdown(
    rows,
    noteCount,
    jackCount,
    miniJackCount,
    anchorImbalance
  );
  const dominantPattern = selectDominantPattern(patternBreakdown, keyPatternRates);
  const typeClassification = buildTypeClassification(rows, notes, {
    keyPatternRates,
    patternBreakdown,
    chordRate,
    jackCount,
    miniJackCount,
    lnRatio,
    anchorImbalance
  });

  return {
    noteCount,
    lnCount,
    lnRatio,
    rowCount,
    durationMs,
    avgNps,
    maxNps250: Math.max(0, ...curves.nps250),
    maxNps500: Math.max(0, ...curves.nps500),
    keyPatternCounts,
    keyPatternRates,
    typeClassification,
    patternBreakdown,
    dominantPattern,
    chordRate,
    jackRate: safeDiv(jackCount, noteCount, 0),
    miniJackRate: safeDiv(miniJackCount, noteCount, 0),
    anchorImbalance,
    columnCounts
  };
}

export function analyseSrrFromOsuText(osuText) {
  const parsed = parseOsuText(osuText);
  if (!parsed.ok) return parsed;

  if (!parsed.notes.length) {
    return {
      ok: false,
      errorCode: "NO_HIT_OBJECTS",
      message: "找不到可分析的 HitObjects。"
    };
  }

  const notes = annotateRows(parsed.notes);
  const curves = buildDifficultyCurve(notes);
  const stats = computeStats(notes, curves);
  const primary = computeAzusaNumeric(curves, stats);
  const correction = applyAzusaStructuralCorrection(primary, stats, curves);
  const skillProfile = buildAzusaSkillProfile(primary);
  const importedAzusa = runAzusaEstimatorFromText(osuText, {
    useReferenceEstimators: false
  });

  if (!Number.isFinite(importedAzusa.numericDifficulty) || !Number.isFinite(importedAzusa.star)) {
    return {
      ok: false,
      errorCode: importedAzusa.numericDifficultyHint || "AZUSA_FAILED",
      message: importedAzusa.estDiff || "Azusa estimator failed."
    };
  }

  const convertChordstreamDamp = computeConvertChordstreamDamp(stats, importedAzusa.numericDifficulty);
  const denseJackWallDamp = computeDenseJackWallDamp(stats, importedAzusa.numericDifficulty);
  const highEndStreamLift = computeHighEndStreamLift(stats, importedAzusa.numericDifficulty);
  const correctedNumeric = Math.max(
    -2,
    importedAzusa.numericDifficulty - convertChordstreamDamp - denseJackWallDamp + highEndStreamLift
  );
  const estimatorStar = (3.4 + 0.38 * correctedNumeric) * STAR_SCALE + STAR_OFFSET;
  const courseCalibration = applyDanCourseCalibration(estimatorStar, parsed.metadata);
  const star = courseCalibration.star;
  const rc4KReformLabel = mapStarToRc4KReform(star);
  const azusaRcLabel = numericToRcLabel(correctedNumeric);
  const reformLabel = courseCalibration.active
    ? rc4KReformLabel || courseCalibration.target.label
    : azusaRcLabel || rc4KReformLabel || mapToReformRank(star);
  const reformRank = correctedNumeric;

  const warnings = [];

  if (stats.lnRatio > 0.18) {
    warnings.push("此譜面 LN 比例偏高，SRR RC 模型可能不準確。");
  }

  return {
    ok: true,
    algorithm: ALGORITHM_PROFILE,
    metadata: parsed.metadata,
    stats,
    difficulty: {
      rawNumeric: importedAzusa.rawNumericDifficulty,
      localCurveNumeric: primary.scaled,
      correctedNumeric,
      estimatorStar,
      star,
      reformRank,
      reformLabel,
      azusaRcLabel,
      estimatorAzusaRcLabel: importedAzusa.estDiff,
      rc4KReformLabel,
      referenceMode: importedAzusa.debug?.referenceMode || "disabled",
      courseCalibration,
      convertChordstreamDamp,
      denseJackWallDamp,
      highEndStreamLift,
      azusaComponents: primary.components,
      skillProfile
    },
    pipeline: AZUSA_PIPELINE,
    curves,
    warnings,
    debug: {
      algorithm: ALGORITHM_PROFILE,
      primary,
      correction,
      importedAzusa: importedAzusa.debug,
      convertChordstreamDamp,
      denseJackWallDamp,
      highEndStreamLift,
      courseCalibration
    }
  };
}
