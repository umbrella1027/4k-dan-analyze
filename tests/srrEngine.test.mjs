import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runAzusaEstimatorFromText } from "../src/azusa/azusaEstimator.js";
import { runDanielEstimatorFromText } from "../src/azusa/danielEstimator.js";
import { runMixedEstimatorFromText } from "../src/azusa/mixedEstimator.js";
import { runRoxyEstimatorFromText } from "../src/azusa/roxyEstimator.js";
import { runSunnyEstimatorFromText } from "../src/azusa/sunnyEstimator.js";
import { analyseSrrFromOsuText, annotateRows } from "../src/srrEngine.js";

function osu(hitObjects, options = {}) {
  const mode = options.mode ?? 3;
  const circleSize = options.circleSize ?? 4;

  return `osu file format v14

[General]
Mode:${mode}

[Metadata]
Title:${options.title ?? "Synthetic Test"}
Artist:${options.artist ?? "SRR"}
Creator:${options.creator ?? "Codex"}
Version:${options.version ?? "Unit"}

[Difficulty]
CircleSize:${circleSize}

[HitObjects]
${hitObjects.join("\n")}`;
}

function note(x, time, type = 1, params = "0:0:0:0:") {
  return `${x},192,${time},${type},0,${params}`;
}

function stream(nps, count) {
  const columns = [64, 192, 320, 448];
  return Array.from({ length: count }, (_, index) => (
    note(columns[index % columns.length], Math.round((index * 1000) / nps))
  ));
}

function quadRows(rowCount, intervalMs) {
  const columns = [64, 192, 320, 448];
  const hitObjects = [];

  for (let row = 0; row < rowCount; row++) {
    for (const x of columns) {
      hitObjects.push(note(x, row * intervalMs));
    }
  }

  return hitObjects;
}

function streamTimingRows(rowPatterns, rowCount = 80, intervalMs = 100) {
  const columns = [64, 192, 320, 448];
  const hitObjects = [];

  for (let row = 0; row < rowCount; row++) {
    for (const column of rowPatterns[row % rowPatterns.length]) {
      hitObjects.push(note(columns[column], row * intervalMs));
    }
  }

  return hitObjects;
}

function irregularStreamTimingRows(rowPatterns, rowCount = 80) {
  const columns = [64, 192, 320, 448];
  const intervals = [50, 220, 50, 220, 50, 220, 50, 220];
  const hitObjects = [];
  let time = 0;

  for (let row = 0; row < rowCount; row++) {
    for (const column of rowPatterns[row % rowPatterns.length]) {
      hitObjects.push(note(columns[column], time));
    }
    time += intervals[row % intervals.length];
  }

  return hitObjects;
}

function jackTimingRows(rowPatterns, repeats = 24, intervalMs = 100, gapMs = 420) {
  const columns = [64, 192, 320, 448];
  const hitObjects = [];
  let time = 0;

  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const rowPattern of rowPatterns) {
      for (const column of rowPattern) {
        hitObjects.push(note(columns[column], time));
      }
      time += intervalMs;
    }
    time += gapMs;
  }

  return hitObjects;
}

function dominantStreamKey(hitObjects) {
  const result = analyseSrrFromOsuText(osu(hitObjects));
  assert.equal(result.ok, true);
  return result.stats.typeClassification.dominantStream?.key;
}

function dominantJackKey(hitObjects) {
  const result = analyseSrrFromOsuText(osu(hitObjects));
  assert.equal(result.ok, true);
  return result.stats.typeClassification.dominantJack?.key;
}

const rows = annotateRows([
  { t: 0, c: 0 },
  { t: 1, c: 1 },
  { t: 5, c: 2 }
]);

assert.equal(rows[0].rowSize, 2);
assert.equal(rows[1].rowSize, 2);
assert.equal(rows[2].rowSize, 1);

const mixed = analyseSrrFromOsuText(osu([
  ...stream(12, 120),
  note(64, 10100, 128, "10500:0:0:0:0:")
]));

assert.equal(mixed.ok, true);
assert.equal(mixed.algorithm.id, "azusa");
assert.equal(mixed.debug.algorithm.id, "azusa");
assert.deepEqual(mixed.pipeline, ["Parse", "Rows", "Strain", "Pattern", "Calibration", "Correction"]);
assert.equal(mixed.stats.noteCount, 121);
assert.equal(mixed.stats.lnCount, 1);
assert.equal(mixed.stats.rowCount, 121);
assert.equal(mixed.stats.keyPatternCounts.single, 121);
assert.equal(mixed.stats.typeClassification.source, "VSRG Pattern Glossary · Stream/Jack timing windows");
assert.ok(mixed.stats.typeClassification.categories.length >= 7);
assert.equal(mixed.curves.times.length, mixed.stats.noteCount);
assert.equal(mixed.curves.nps250.length, mixed.stats.noteCount);
assert.ok(Number.isFinite(mixed.difficulty.star));
assert.ok(mixed.difficulty.star > 0);
assert.equal(mixed.difficulty.skillProfile.length, 5);
assert.ok(mixed.difficulty.skillProfile.every((skill) => Number.isFinite(skill.peak)));
assert.equal(dominantStreamKey(streamTimingRows([[0], [1], [2], [3]])), "singleStream");
assert.equal(dominantStreamKey(streamTimingRows([[0], [1, 2], [3], [0], [2], [1]])), "lightJumpstream");
assert.equal(dominantStreamKey(streamTimingRows([[0, 1], [1, 2], [2, 3], [0, 3]])), "denseJumpstream");
assert.equal(dominantStreamKey(streamTimingRows([[0, 1], [1, 2, 3], [2], [0, 3], [1, 2]])), "lightHandstream");
assert.equal(dominantStreamKey(streamTimingRows([[0, 1, 2], [1, 2, 3], [0, 2, 3]])), "denseHandstream");
assert.equal(dominantStreamKey(streamTimingRows([[0, 1, 2, 3]])), "quadStream");
assert.equal(dominantStreamKey(irregularStreamTimingRows([[0], [2], [1], [3]])), "brokenStream");
assert.equal(dominantJackKey(jackTimingRows([[1], [1]], 60)), "minijack");
assert.equal(dominantJackKey(jackTimingRows([[1], [1], [1], [1], [1]], 16)), "longjack");
assert.equal(dominantJackKey(jackTimingRows([[0, 1], [1], [1, 2], [2]])), "jumpjack");
assert.equal(dominantJackKey(jackTimingRows([[0, 1, 2], [1, 2, 3], [0, 2, 3]])), "chordjack");

const non4k = analyseSrrFromOsuText(osu([note(64, 0)], { circleSize: 5 }));
assert.equal(non4k.ok, false);
assert.equal(non4k.errorCode, "UNSUPPORTED_KEY_COUNT");

const wrongMode = analyseSrrFromOsuText(osu([note(64, 0)], { mode: 0 }));
assert.equal(wrongMode.ok, false);
assert.equal(wrongMode.errorCode, "UNSUPPORTED_GAME_MODE");

const highLn = analyseSrrFromOsuText(osu(Array.from({ length: 100 }, (_, index) => (
  note([64, 192, 320, 448][index % 4], index * 120, index < 24 ? 128 : 1)
))));

assert.equal(highLn.ok, true);
assert.ok(highLn.warnings.includes("此譜面 LN 比例偏高，SRR RC 模型可能不準確。"));

const stream12 = analyseSrrFromOsuText(osu(stream(12, 900)));
const reform7Course = analyseSrrFromOsuText(osu(stream(12, 900), {
  title: "Dan ~ REFORM ~ 2nd Pack",
  artist: "Various Artists",
  creator: "Thaumiel",
  version: "~ 7th ~ (Marathon)"
}));
const quad250 = analyseSrrFromOsuText(osu(quadRows(300, 250)));
const quad125 = analyseSrrFromOsuText(osu(quadRows(300, 125)));
const streamBreakdown = Object.fromEntries(
  stream12.stats.patternBreakdown.map((pattern) => [pattern.key, pattern])
);
const chordBreakdown = Object.fromEntries(
  quad250.stats.patternBreakdown.map((pattern) => [pattern.key, pattern])
);
const jackBreakdown = Object.fromEntries(
  quad125.stats.patternBreakdown.map((pattern) => [pattern.key, pattern])
);

assert.equal(stream12.ok, true);
assert.equal(reform7Course.ok, true);
assert.equal(quad250.ok, true);
assert.equal(quad125.ok, true);
assert.equal(stream12.stats.keyPatternRates.single, 1);
assert.equal(quad250.stats.keyPatternRates.quad, 1);
assert.ok(streamBreakdown.stream.rate > 0.95);
assert.ok(chordBreakdown.chordstream.rate > 0.95);
assert.ok(jackBreakdown.jacks.rate > 0.95);
assert.equal(stream12.stats.dominantPattern.key, "stream");
assert.equal(quad250.stats.dominantPattern.key, "chordstream");
assert.ok(stream12.difficulty.star < quad250.difficulty.star);
assert.ok(quad250.difficulty.star < quad125.difficulty.star);
assert.equal(stream12.difficulty.azusaRcLabel, "Reform 3 low");
assert.equal(reform7Course.difficulty.courseCalibration.active, true);
assert.equal(reform7Course.difficulty.courseCalibration.target.rank, 7);
assert.ok(reform7Course.difficulty.rc4KReformLabel.startsWith("Reform 7"));
assert.equal(quad250.difficulty.azusaRcLabel, "Reform 6 mid");
assert.equal(quad125.difficulty.azusaRcLabel, "Alpha low");
assert.ok(quad250.difficulty.rc4KReformLabel.startsWith("Reform 7"));
assert.ok(quad125.difficulty.rc4KReformLabel.startsWith("Gamma"));

const shortMap = analyseSrrFromOsuText(osu(stream(12, 10)));
assert.equal(shortMap.ok, false);
assert.equal(shortMap.errorCode, "TooShort");

const estimatorText = osu(stream(12, 900));
for (const runEstimator of [
  runSunnyEstimatorFromText,
  runDanielEstimatorFromText,
  runAzusaEstimatorFromText,
  runRoxyEstimatorFromText,
  runMixedEstimatorFromText
]) {
  const result = runEstimator(estimatorText);
  assert.ok(Number.isFinite(result.star));
  assert.equal(Number(result.columnCount), 4);
  assert.ok(String(result.estDiff).length > 0);
}

const azusaReferenceOff = runAzusaEstimatorFromText(estimatorText, { useReferenceEstimators: false });
const azusaReferenceOn = runAzusaEstimatorFromText(estimatorText, { useReferenceEstimators: true });
assert.equal(azusaReferenceOff.debug.referenceMode, "disabled");
assert.equal(azusaReferenceOn.debug.referenceMode, "enabled");
assert.ok(azusaReferenceOff.numericDifficulty < azusaReferenceOn.numericDifficulty);

const icyworldPath = "/Users/leo/Downloads/DJ Noriken - Elektrick U-Phoria (zaclentaro) [Icyworld].osu";
if (existsSync(icyworldPath)) {
  const icyworld = analyseSrrFromOsuText(readFileSync(icyworldPath, "utf8"));
  assert.equal(icyworld.ok, true);
  assert.equal(icyworld.difficulty.azusaRcLabel, "Reform 6 mid");
  assert.equal(icyworld.difficulty.reformLabel, "Reform 6 mid");
}

const legendGravityPath = "/Users/leo/Downloads/Yooh - LegenD. (_FrEsH_ChICkEn_) [KK's GRAVITY].osu";
if (existsSync(legendGravityPath)) {
  const legendGravity = analyseSrrFromOsuText(readFileSync(legendGravityPath, "utf8"));
  assert.equal(legendGravity.ok, true);
  assert.equal(legendGravity.difficulty.azusaRcLabel, "Reform 6 mid");
  assert.equal(legendGravity.difficulty.reformLabel, "Reform 6 mid");
  assert.ok(legendGravity.difficulty.convertChordstreamDamp > 0);
}

const cyberInductancePath = "/Users/leo/Downloads/DJ Sharpnel - Cyber Inductance (Speed Up Ver.) (IcyWorld) [NB4].osu";
if (existsSync(cyberInductancePath)) {
  const cyberInductance = analyseSrrFromOsuText(readFileSync(cyberInductancePath, "utf8"));
  assert.equal(cyberInductance.ok, true);
  assert.equal(cyberInductance.stats.dominantPattern.key, "stream");
  assert.ok(cyberInductance.stats.jackRate < 0.05);
}

const burdenPath = "/Users/leo/Downloads/inoqx - BURDEN (frawog) [ALL I'LL EVER BE].osu";
if (existsSync(burdenPath)) {
  const burden = analyseSrrFromOsuText(readFileSync(burdenPath, "utf8"));
  assert.equal(burden.ok, true);
  assert.equal(burden.stats.dominantPattern.key, "jacks");
  assert.equal(burden.difficulty.azusaRcLabel, "Reform 5 low");
  assert.equal(burden.difficulty.reformLabel, "Reform 5 low");
  assert.ok(burden.difficulty.denseJackWallDamp > 0);
}

const finixeSummerPath = "/Users/leo/Downloads/Silentroom - Finixe (tailsdk) [Summer].osu";
if (existsSync(finixeSummerPath)) {
  const finixeSummer = analyseSrrFromOsuText(readFileSync(finixeSummerPath, "utf8"));
  assert.equal(finixeSummer.ok, true);
  assert.equal(finixeSummer.stats.dominantPattern.key, "stream");
  assert.equal(finixeSummer.difficulty.azusaRcLabel, "Reform 10 mid");
  assert.equal(finixeSummer.difficulty.reformLabel, "Reform 10 mid");
  assert.ok(finixeSummer.difficulty.highEndStreamLift > 0);
}

const chordjackChallengePath = "/Users/leo/Downloads/Various Artists - 4K Chordjack Challenge vol.2 (Onta_Bekasi) [Perfume - Daijobanai].osu";
if (existsSync(chordjackChallengePath)) {
  const chordjackChallenge = analyseSrrFromOsuText(readFileSync(chordjackChallengePath, "utf8"));
  assert.equal(chordjackChallenge.ok, true);
  assert.equal(chordjackChallenge.stats.dominantPattern.key, "jacks");
  assert.equal(chordjackChallenge.difficulty.reformLabel, "Reform 7 high");
}

console.log("srrEngine tests passed");
