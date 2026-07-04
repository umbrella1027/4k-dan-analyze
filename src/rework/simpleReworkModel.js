import { OsuFileParser } from "../parser/osuFileParser.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function countInWindow(times, index, windowMs) {
  let count = 0;
  const t = times[index];
  for (let i = index; i >= 0; i--) {
    if (t - times[i] > windowMs) break;
    count++;
  }
  return count;
}

export function calculateSimpleRework(osuText, speedRate = 1, options = {}) {
  const parser = new OsuFileParser(osuText);
  parser.process();
  const parsed = parser.getParsedData();

  if (parsed.status === "Fail") return -1;
  if (parsed.status === "NotMania") return -2;

  const rate = Number.isFinite(Number(speedRate)) && Number(speedRate) > 0
    ? Number(speedRate)
    : 1;
  const starts = parsed.noteStarts.map((time) => Number(time) / rate).sort((a, b) => a - b);
  const columns = parsed.columns.map(Number);

  if (!starts.length) {
    return {
      star: 0,
      lnRatio: parsed.lnRatio,
      columnCount: parsed.columnCount,
      graph: options.withGraph ? { times: [], strain: [] } : null
    };
  }

  const durationSec = Math.max(1, (starts[starts.length - 1] - starts[0]) / 1000);
  const avgNps = starts.length / durationSec;
  let maxNps500 = 0;
  let sameColumnFast = 0;
  let chordNotes = 0;
  const lastByColumn = new Map();
  const rowCounts = new Map();

  for (let i = 0; i < starts.length; i++) {
    maxNps500 = Math.max(maxNps500, countInWindow(starts, i, 500) / 0.5);
    const column = columns[i];
    const last = lastByColumn.get(column);
    if (Number.isFinite(last) && starts[i] - last <= 260) sameColumnFast++;
    lastByColumn.set(column, starts[i]);
    const bucket = Math.round(starts[i] / 2) * 2;
    rowCounts.set(bucket, (rowCounts.get(bucket) || 0) + 1);
  }

  for (const count of rowCounts.values()) {
    if (count >= 2) chordNotes += count;
  }

  const chordRate = chordNotes / Math.max(1, starts.length);
  const jackRate = sameColumnFast / Math.max(1, starts.length);
  const density = Math.log1p(maxNps500) * 1.15 + Math.log1p(avgNps) * 0.85;
  const structure = 2.2 * chordRate + 1.35 * jackRate;
  const length = Math.min(1.4, Math.pow(starts.length / 900, 0.18));
  const star = clamp((density + structure + length) * (options.scale || 1), 0, 12);

  return {
    star: Number(star.toFixed(4)),
    lnRatio: parsed.lnRatio,
    columnCount: parsed.columnCount,
    graph: options.withGraph
      ? { times: starts.map((time) => time / 1000), strain: starts.map(() => star) }
      : null
  };
}
