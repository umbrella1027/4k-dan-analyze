import { clamp } from "./srrMath.js";

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

    if (current) {
      sections[current].push(line);
    }
  }

  return sections;
}

function parseKeyValue(lines = []) {
  const result = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    result[key] = value;
  }
  return result;
}

function isHoldNote(typeValue) {
  return (typeValue & 128) > 0;
}

export function parseOsuText(osuText) {
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

  const hitObjectLines = sections.HitObjects || [];
  const notes = [];

  for (const line of hitObjectLines) {
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
    const isLN = isHoldNote(type);

    notes.push({
      x,
      t: time,
      type,
      objectParams,
      c: column,
      hand: column <= 1 ? 0 : 1,
      rowSize: 1,
      isLN
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
