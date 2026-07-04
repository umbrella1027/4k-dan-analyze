(() => {
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

  let npsChart = null;
  let fatigueChart = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function safeDiv(a, b, fallback = 0) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback;
    return a / b;
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function stddev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(mean(values.map((value) => Math.pow(value - m, 2))));
  }

  function quantile(values, q) {
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

  function topPercentMean(values, percent = 0.04) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => b - a);
    const take = Math.max(1, Math.ceil(sorted.length * percent));
    return mean(sorted.slice(0, take));
  }

  function powerMean(values, p = 2) {
    const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
    if (!clean.length) return 0;
    return Math.pow(mean(clean.map((value) => Math.pow(value, p))), 1 / p);
  }

  function formatSeconds(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseSections(osuText) {
    const sections = {};
    let current = null;

    for (const rawLine of osuText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;

      const sectionMatch = line.match(/^\[(.+)]$/);
      if (sectionMatch) {
        current = sectionMatch[1];
        sections[current] = [];
        continue;
      }

      if (current) sections[current].push(line);
    }

    return sections;
  }

  function parseKeyValue(lines = []) {
    const result = {};
    for (const line of lines) {
      const index = line.indexOf(":");
      if (index === -1) continue;
      result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return result;
  }

  function isHoldNote(typeValue) {
    return (typeValue & 128) > 0;
  }

  function parseOsuText(osuText) {
    if (!osuText || !osuText.trim()) {
      return {
        ok: false,
        errorCode: "EMPTY_INPUT",
        message: "請貼上 .osu 譜面內容。"
      };
    }

    const sections = parseSections(osuText);
    const generalRaw = parseKeyValue(sections.General);
    const metadataRaw = parseKeyValue(sections.Metadata);
    const difficultyRaw = parseKeyValue(sections.Difficulty);
    const mode = Number(generalRaw.Mode);
    const circleSize = Number(difficultyRaw.CircleSize);

    if (Number.isFinite(mode) && mode !== 3) {
      return {
        ok: false,
        errorCode: "UNSUPPORTED_GAME_MODE",
        message: "目前 SRR 僅支援 osu!mania 4K 譜面。"
      };
    }

    if (!Number.isFinite(circleSize)) {
      return {
        ok: false,
        errorCode: "MISSING_CIRCLE_SIZE",
        message: "找不到 Difficulty / CircleSize，無法判定是否為 4K 譜面。"
      };
    }

    if (circleSize !== 4) {
      return {
        ok: false,
        errorCode: "UNSUPPORTED_KEY_COUNT",
        message: "目前 SRR 僅支援 osu!mania 4K 譜面。"
      };
    }

    const notes = [];
    for (const line of sections.HitObjects || []) {
      const parts = line.split(",");
      if (parts.length < 5) continue;

      const x = Number(parts[0]);
      const time = Number(parts[2]);
      const type = Number(parts[3]);
      const objectParams = parts[5] || "";

      if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) {
        continue;
      }

      const column = clamp(Math.floor((x * 4) / 512), 0, 3);
      notes.push({
        x,
        t: time,
        type,
        objectParams,
        c: column,
        hand: column <= 1 ? 0 : 1,
        rowSize: 1,
        isLN: isHoldNote(type)
      });
    }

    notes.sort((a, b) => a.t - b.t || a.c - b.c);

    return {
      ok: true,
      metadata: {
        title: metadataRaw.Title || "Unknown Title",
        artist: metadataRaw.Artist || "Unknown Artist",
        creator: metadataRaw.Creator || "Unknown Mapper",
        version: metadataRaw.Version || "Unknown Difficulty"
      },
      difficulty: {
        circleSize
      },
      notes
    };
  }

  function mapToReformRank(value) {
    if (value < 6) return "低於 Reform 六段";
    if (value < 7) return "Reform 六段";
    if (value < 8) return "Reform 七段";
    if (value < 9) return "Reform 八段";
    if (value < 10) return "Reform 九段";
    if (value < 11) return "Reform 十段";
    return "高於 Reform 十段";
  }

  function reformRankNumber(value) {
    if (value < 6) return null;
    if (value >= 11) return 11;
    return Math.floor(value);
  }

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

  function annotateRows(taps, toleranceMs = 2) {
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

      if (Math.abs(note.t - row[0].t) <= toleranceMs) row.push(note);
      else {
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
    const peakAzusa = weightedSkillSummary(summaries, (skill) => 0.65 * skill.q97 + 0.35 * skill.q90);
    const sustainAzusa = weightedSkillSummary(summaries, (skill) => 0.55 * skill.q75 + 0.45 * skill.tailMean);
    const densityAzusa = 0.14 * Math.log1p(stats.maxNps250) + 0.22 * Math.log1p(stats.maxNps500);
    const midAzusa = weightedSkillSummary(summaries, (skill) => skill.q50);
    const lengthBoost = Math.min(3.5, Math.pow(Math.max(1, stats.noteCount) / 600, 0.22));
    const raw = 0.52 * peakAzusa + 0.26 * sustainAzusa + 0.10 * densityAzusa + 0.08 * midAzusa + 0.04 * lengthBoost;
    return {
      raw,
      scaled: 0.82 + 0.43 * raw,
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

  function applyAzusaStructuralCorrection(primary, stats, curves) {
    const jackQ95 = quantile(curves.jack, 0.95);
    const gChord = clamp((stats.chordRate - 0.40) * 3.5, 0, 1);
    const gJack = clamp((jackQ95 - 1.25) * 2.8, 0, 1);
    const gAnchor = clamp(1 - stats.anchorImbalance * 8, 0, 1);
    const chordjackBoost = clamp(2.5 * gChord * gJack * gAnchor, 0, 2.2);
    const midSpeedBonus =
      clamp((stats.avgNps - 9) * 0.04, 0, 0.35) *
      clamp((19 - stats.avgNps) * 0.25, 0, 1);

    return {
      corrected: primary.scaled + chordjackBoost + midSpeedBonus,
      chordjackBoost,
      midSpeedBonus,
      jackQ95
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

  function buildRows(notes) {
    const rows = [];
    let currentRow = null;

    for (const note of notes) {
      if (!currentRow || currentRow.index !== note.rowIndex) {
        currentRow = {
          index: note.rowIndex,
          t: note.rowTime ?? note.t,
          rowSize: note.rowSize,
          columns: []
        };
        rows.push(currentRow);
      }

      currentRow.columns.push(note.c);
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
        const dtSame = preRowColumnTimes[current.c] !== null ? Math.max(1, rowTime - preRowColumnTimes[current.c]) : 1000;
        const dtHand = preRowHandTimes[current.hand] !== null ? Math.max(1, rowTime - preRowHandTimes[current.hand]) : 1000;
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
    for (const note of notes) columnCounts[note.c]++;
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
      patternBreakdown,
      dominantPattern,
      chordRate: safeDiv(chordRows, rows.length, 0),
      jackRate: safeDiv(jackCount, noteCount, 0),
      miniJackRate: safeDiv(miniJackCount, noteCount, 0),
      anchorImbalance,
      columnCounts
    };
  }

  function analyseSrrFromOsuText(osuText) {
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
    const correctedNumeric = correction.corrected;
    const star = correctedNumeric * STAR_SCALE + STAR_OFFSET;
    const warnings = [];
    if (stats.lnRatio > 0.18) warnings.push("此譜面 LN 比例偏高，SRR RC 模型可能不準確。");

    return {
      ok: true,
      algorithm: ALGORITHM_PROFILE,
      metadata: parsed.metadata,
      stats,
      difficulty: {
        rawNumeric: primary.scaled,
        correctedNumeric,
        star,
        reformRank: reformRankNumber(star),
        reformLabel: mapToReformRank(star),
        azusaComponents: primary.components,
        skillProfile
      },
      pipeline: AZUSA_PIPELINE,
      curves,
      warnings,
      debug: {
        algorithm: ALGORITHM_PROFILE,
        primary,
        correction
      }
    };
  }

  function destroyChart(chart) {
    if (chart) chart.destroy();
  }

  function clearCharts() {
    destroyChart(npsChart);
    destroyChart(fatigueChart);
    npsChart = null;
    fatigueChart = null;
  }

  function renderNpsChart(canvas, curves) {
    destroyChart(npsChart);
    npsChart = new Chart(canvas, {
      type: "line",
      data: {
        labels: curves.times,
        datasets: [
          { label: "NPS 250ms", data: curves.nps250, borderWidth: 1, pointRadius: 0, tension: 0.15 },
          { label: "NPS 500ms", data: curves.nps500, borderWidth: 1, pointRadius: 0, tension: 0.15 }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8 }, title: { display: true, text: "Time (s)" } },
          y: { beginAtZero: true, title: { display: true, text: "NPS" } }
        }
      }
    });
  }

  function renderFatigueChart(canvas, curves) {
    destroyChart(fatigueChart);
    fatigueChart = new Chart(canvas, {
      type: "line",
      data: {
        labels: curves.times,
        datasets: [
          { label: "Fatigue", data: curves.fatigue, borderWidth: 2, pointRadius: 0, tension: 0.15 },
          { label: "Speed", data: curves.speed, borderWidth: 1, pointRadius: 0, hidden: true, tension: 0.15 },
          { label: "Stamina", data: curves.stamina, borderWidth: 1, pointRadius: 0, hidden: true, tension: 0.15 },
          { label: "Jack", data: curves.jack, borderWidth: 1, pointRadius: 0, hidden: true, tension: 0.15 },
          { label: "Chord", data: curves.chord, borderWidth: 1, pointRadius: 0, hidden: true, tension: 0.15 },
          { label: "Tech", data: curves.tech, borderWidth: 1, pointRadius: 0, hidden: true, tension: 0.15 }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8 }, title: { display: true, text: "Time (s)" } },
          y: { beginAtZero: true, title: { display: true, text: "Strain" } }
        }
      }
    });
  }

  function setMessage(type, messages) {
    const messagePanel = document.getElementById("messagePanel");
    const list = Array.isArray(messages) ? messages : [messages];

    if (!list.length || !list[0]) {
      messagePanel.className = "hidden";
      messagePanel.innerHTML = "";
      return;
    }

    const typeClass = type === "error"
      ? "bg-rose-500/10 border-rose-500/30 text-rose-100"
      : "bg-amber-500/10 border-amber-500/30 text-amber-100";

    messagePanel.className = `rounded-lg border p-4 ${typeClass}`;
    messagePanel.innerHTML = list.map((message) => `<div>${escapeHtml(message)}</div>`).join("");
  }

  function metric(label, value) {
    return `
      <div class="metric-card">
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-value">${escapeHtml(value)}</div>
      </div>
    `;
  }

  function percent(value) {
    return `${(value * 100).toFixed(2)}%`;
  }

  function maxSkillPeak(skillProfile) {
    return Math.max(0.001, ...skillProfile.map((skill) => skill.peak));
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

  function renderPipeline(pipeline) {
    return `
      <div class="pipeline">
        ${pipeline.map((stage) => `<span>${escapeHtml(stage)}</span>`).join("")}
      </div>
    `;
  }

  function renderResult(result) {
    const { algorithm, metadata, difficulty, pipeline, stats } = result;
    const resultPanel = document.getElementById("resultPanel");
    const statsPanel = document.getElementById("statsPanel");

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
          <div class="dominant-label">Dominant pattern</div>
          <div class="dominant-value">${escapeHtml(stats.dominantPattern.label)}</div>
          <div class="dominant-rate">${percent(stats.dominantPattern.rate)}</div>
        </div>
      </div>
      ${renderPipeline(pipeline)}
      ${renderKeyPatternBreakdown(stats)}
      <div class="map-meta">
        <div class="text-lg font-bold text-slate-100">${escapeHtml(metadata.title)}</div>
        <div class="text-slate-400">${escapeHtml(metadata.artist)}</div>
        <div class="text-slate-300">[${escapeHtml(metadata.version)}]</div>
        <div class="text-slate-500 text-sm">Mapped by ${escapeHtml(metadata.creator)}</div>
        <div class="text-cyan-200 text-sm font-bold">Algorithm: ${escapeHtml(algorithm.label)}</div>
      </div>
    `;

    statsPanel.innerHTML = [
      metric("Algorithm", algorithm.label),
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
      metric("Anchor Imbalance", percent(stats.anchorImbalance)),
      metric("Raw Numeric", difficulty.rawNumeric.toFixed(3)),
      metric("Corrected Numeric", difficulty.correctedNumeric.toFixed(3))
    ].join("");
  }

  function renderSkillProfile(result) {
    const skillPanel = document.getElementById("skillPanel");
    if (!skillPanel) return;

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
    const osuInput = document.getElementById("osuInput");
    const resultPanel = document.getElementById("resultPanel");
    const skillPanel = document.getElementById("skillPanel");
    const statsPanel = document.getElementById("statsPanel");
    const result = analyseSrrFromOsuText(osuInput.value);

    if (!result.ok) {
      setMessage("error", result.message);
      resultPanel.innerHTML = "Paste a 4K .osu file and click Analyze Azusa.";
      if (skillPanel) skillPanel.innerHTML = "No analysis yet.";
      statsPanel.innerHTML = "";
      clearCharts();
      return;
    }

    setMessage("warning", result.warnings);
    renderResult(result);
    renderSkillProfile(result);
    renderNpsChart(document.getElementById("npsChart"), result.curves);
    renderFatigueChart(document.getElementById("fatigueChart"), result.curves);
  }

  document.getElementById("analyzeBtn").addEventListener("click", analyze);
  document.getElementById("clearBtn").addEventListener("click", () => {
    document.getElementById("osuInput").value = "";
    document.getElementById("resultPanel").innerHTML = "Paste a 4K .osu file and click Analyze Azusa.";
    const skillPanel = document.getElementById("skillPanel");
    if (skillPanel) skillPanel.innerHTML = "No analysis yet.";
    document.getElementById("statsPanel").innerHTML = "";
    setMessage(null, "");
    clearCharts();
  });

  window.SRR = {
    analyseSrrFromOsuText
  };
})();
