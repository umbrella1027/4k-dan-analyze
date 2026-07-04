function parseSections(osuText) {
  const sections = {};
  let current = null;

  for (const rawLine of String(osuText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    const section = line.match(/^\[(.+)]$/);
    if (section) {
      current = section[1];
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function holdEndTime(objectParams, fallback) {
  const end = Number(String(objectParams || "").split(":")[0]);
  return Number.isFinite(end) ? end : fallback;
}

export class OsuFileParser {
  constructor(osuText) {
    this.osuText = String(osuText || "");
    this.parsed = {
      status: "Fail",
      columns: [],
      noteStarts: [],
      noteEnds: [],
      noteTypes: [],
      lnRatio: 0,
      columnCount: 0,
      od: 8
    };
  }

  process() {
    if (!this.osuText.trim()) {
      this.parsed.status = "Fail";
      return;
    }

    const sections = parseSections(this.osuText);
    const general = parseKeyValue(sections.General);
    const difficulty = parseKeyValue(sections.Difficulty);
    const mode = Number(general.Mode);

    if (Number.isFinite(mode) && mode !== 3) {
      this.parsed.status = "NotMania";
      return;
    }

    const columnCount = Number(difficulty.CircleSize);
    if (!Number.isFinite(columnCount) || columnCount <= 0) {
      this.parsed.status = "Fail";
      return;
    }

    const columns = [];
    const noteStarts = [];
    const noteEnds = [];
    const noteTypes = [];
    let lnCount = 0;

    for (const line of sections.HitObjects || []) {
      const parts = line.split(",");
      if (parts.length < 5) continue;

      const x = Number(parts[0]);
      const start = Number(parts[2]);
      const type = Number(parts[3]);

      if (!Number.isFinite(x) || !Number.isFinite(start) || !Number.isFinite(type)) {
        continue;
      }

      const column = clamp(Math.floor((x * columnCount) / 512), 0, columnCount - 1);
      const isLN = (type & 128) > 0;
      if (isLN) lnCount++;

      columns.push(column);
      noteStarts.push(start);
      noteEnds.push(isLN ? holdEndTime(parts[5], start) : start);
      noteTypes.push(isLN ? "hold" : "tap");
    }

    this.parsed = {
      status: "Success",
      columns,
      noteStarts,
      noteEnds,
      noteTypes,
      lnRatio: columns.length ? lnCount / columns.length : 0,
      columnCount,
      od: Number.isFinite(Number(difficulty.OverallDifficulty))
        ? Number(difficulty.OverallDifficulty)
        : 8
    };
  }

  modHO() {
    this.parsed.noteTypes = this.parsed.noteTypes.map(() => "tap");
    this.parsed.noteEnds = [...this.parsed.noteStarts];
    this.parsed.lnRatio = 0;
  }

  modIN() {
    this.parsed.columns = this.parsed.columns.map((column) => (
      this.parsed.columnCount - 1 - column
    ));
  }

  getParsedData() {
    return this.parsed;
  }
}
