export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function safeDiv(a, b, fallback = 0) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback;
  return a / b;
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((value) => Math.pow(value - m, 2)));
  return Math.sqrt(variance);
}

export function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;

  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }

  return sorted[base];
}

export function topPercentMean(values, percent = 0.04) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const take = Math.max(1, Math.ceil(sorted.length * percent));
  return mean(sorted.slice(0, take));
}

export function powerMean(values, p = 2) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) return 0;
  return Math.pow(mean(clean.map((value) => Math.pow(value, p))), 1 / p);
}

export function formatSeconds(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
