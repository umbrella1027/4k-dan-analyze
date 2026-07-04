# CODEX TASK：Star Rating Rebirth（SRR）4K 譜面智能分析引擎

## 1. 專案主題

Star Rating Rebirth（SRR）4K 譜面智能分析引擎

這是一個基於物理肌肉疲勞衰減模型（Strain Decay Model）的 VSRG（垂直滾動節奏遊戲）難度評估與 Reform 段位檢測系統。

本專案目標是建立一個純前端網頁分析工具，讓使用者貼上 osu!mania 4K `.osu` 譜面內容後，即時計算 SRR 修正後星數，並映射到 Reform 六段至十段。

---

## 2. 任務目標

請實作一個高效、可維護、純前端的 SRR 4K 譜面分析器。

核心目的：

1. 解析 `.osu` 檔案中的 `[Metadata]`、`[Difficulty]`、`[HitObjects]`。
2. 僅針對 osu!mania 4K 譜面進行分析。
3. 根據 Strain Decay Model 計算疲勞累積與衰減。
4. 對 mini-jack、jack、chord、anchor、不對稱配置進行權重補正。
5. 輸出 SRR 星數，保留兩位小數。
6. 將 SRR 星數映射為 Reform 六段至十段。
7. 使用 Chart.js 視覺化 NPS 密度圖與疲勞累積曲線。

---

## 3. 技術堆疊

請使用：

- HTML5
- Tailwind CSS CDN
- JavaScript ES6 Module
- Chart.js CDN

限制：

- 不使用後端。
- 不使用資料庫。
- 不使用 build tool。
- 不需要 Node.js。
- 可直接用瀏覽器開啟 `index.html`。
- 所有分析邏輯都在瀏覽器端完成。

---

## 4. 參考演算法方向

參考：

- Estimator Algorithm
- Azusa Algorithm
- Azusa：面向 4K RC 的融合算法

分析流程應採用：

1. Parse
2. Difficulty Curve
3. Primary Numeric
4. Blend
5. Calibration
6. Correction

本任務先實作 SRR Lite 版本，但程式結構需保留未來導入完整 Azusa calibration table / Daniel / Sunny estimator 的擴充空間。

---

## 5. 輸入需求

畫面需要提供一個大型 textarea，讓使用者貼上 `.osu` 檔案完整內容。

按下 `Analyze SRR` 後執行分析。

---

## 6. `.osu` 解析規格

### 6.1 Metadata

需解析：

- `Title`
- `Artist`
- `Creator`
- `Version`

顯示於結果儀表板。

### 6.2 Difficulty

需解析：

- `CircleSize`

要求：

- 目前僅支援 4K。
- 若 `CircleSize !== 4`，顯示錯誤：`目前 SRR 僅支援 osu!mania 4K 譜面。`

### 6.3 HitObjects

需解析 `[HitObjects]`。

行格式：

```text
x,y,time,type,hitSound,objectParams,hitSample
```

需要取得：

- `x`
- `time`
- `type`
- `objectParams`
- 是否為 LN
- column

Column 計算：

```js
column = Math.floor(x * 4 / 512)
column = clamp(column, 0, 3)
```

Hand 規則：

```js
columns 0,1 => left hand
columns 2,3 => right hand
```

Tap note 結構：

```js
{
  t: number,
  c: number,
  hand: number,
  rowSize: number,
  isLN: boolean
}
```

---

## 7. SRR Public API

請在 `src/srrEngine.js` 實作：

```js
export function analyseSrrFromOsuText(osuText) {
  return {
    ok: true,
    metadata: {
      title,
      artist,
      creator,
      version
    },
    stats: {
      noteCount,
      lnCount,
      lnRatio,
      durationMs,
      avgNps,
      maxNps250,
      maxNps500,
      chordRate,
      jackRate,
      miniJackRate,
      anchorImbalance
    },
    difficulty: {
      rawNumeric,
      correctedNumeric,
      star,
      reformRank,
      reformLabel
    },
    curves: {
      times,
      nps250,
      nps500,
      fatigue,
      speed,
      stamina,
      jack,
      chord,
      tech
    },
    warnings: [],
    debug: {}
  }
}
```

錯誤時：

```js
return {
  ok: false,
  errorCode,
  message
}
```

---

## 8. Strain Decay Model

請使用下列參數：

```js
const DECAY_WINDOWS_MS = [140, 280, 560, 980]
const DECAY_WEIGHTS = [0.34, 0.30, 0.22, 0.14]
const LOCAL_POWER = 2.15
```

Skill 類型：

```js
speed
stamina
jack
chord
tech
```

每個 skill 有 4 個 decay states。

每顆 note 進入時：

```js
state[j] = state[j] * Math.exp(-dtGlobal / tau[j]) + input
```

即時 skill value：

```js
skillValue = sum(state[j] * DECAY_WEIGHTS[j])
```

Local fatigue：

```js
local = powerMean(
  [speed, stamina, jack, chord, tech],
  2.15
)
```

---

## 9. 每音符特徵

### 9.1 時間差

```js
dtGlobal = current.t - previousAny.t
dtSame   = current.t - previousSameColumn[current.c]
dtHand   = current.t - previousSameHand[current.hand]
```

需避免 NaN、Infinity。

### 9.2 NPS

Sliding window：

```js
d250 = notes in last 250ms / 0.25
d500 = notes in last 500ms / 0.5
```

### 9.3 Skill Input

請實作：

```js
stream = Math.pow(170 / (dtAny + 30), 1.07)
handStream = Math.pow(185 / (dtHand + 42), 1.08)
jackRaw = Math.pow(190 / (dtSame + 35), 1.16)

speedInput = 0.60 * stream + 0.30 * handStream + 0.10 * jackRaw
jackInput = jackRaw * (1 + 0.15 * chord)
staminaInput = 0.48 * (d500 / 11) + 0.27 * (d250 / 15) + 0.25 * stream
chordInput = chord * (1 + 0.10 * Math.min(1.5, stream))
techInput = 0.45 * rhythmChaos + 0.30 * movement + 0.25 * chordRowPenalty
```

其中：

```js
chord = rowSize >= 2 ? rowSize - 1 : 0
movement = current.c !== previousAny.c ? 1 : 0
chordRowPenalty = rowSize >= 3 ? 1 : rowSize === 2 ? 0.45 : 0
rhythmChaos = clamp(stddev(recentDts) / mean(recentDts), 0, 2)
```

---

## 10. Row / Chord 判定

請實作：

```js
annotateRows(taps, toleranceMs = 2)
```

規則：

- 時間差在 2ms 內視為同一 row。
- 同一 row 內 notes 數量即為 rowSize。
- rowSize >= 2 視為 chord。
- rowSize >= 3 視為高 chord 壓力。

---

## 11. Primary Numeric

對每個 skill series 計算：

- q97
- q90
- q75
- q50
- tailMean：top 4% 平均
- power mean，p = 2.6

Skill 權重：

```js
speed: 0.36
stamina: 0.24
chord: 0.12
tech: 0.16
jack: 0.12
```

計算：

```js
peakBlend = weighted q97/q90 skill summary
sustainBlend = weighted q75/tailMean skill summary
densityBlend = 0.14 * Math.log1p(maxNps250) + 0.22 * Math.log1p(maxNps500)
midBlend = weighted q50 skill summary
lengthBoost = Math.min(3.5, Math.pow(noteCount / 600, 0.22))

raw =
  0.52 * peakBlend +
  0.26 * sustainBlend +
  0.10 * densityBlend +
  0.08 * midBlend +
  0.04 * lengthBoost

scaled = 0.82 + 0.43 * raw
```

---

## 12. 結構修正

### 12.1 Chordjack 補正

```js
gChord = clamp((chordRate - 0.40) * 3.5, 0, 1)
gJack = clamp((jackQ95 - 1.25) * 2.8, 0, 1)
gAnchor = clamp(1 - anchorImbalance * 8, 0, 1)

chordjackBoost = clamp(2.5 * gChord * gJack * gAnchor, 0, 2.2)
```

### 12.2 Mid Speed Bonus

```js
midSpeedBonus =
  clamp((avgNps - 9) * 0.04, 0, 0.35) *
  clamp((19 - avgNps) * 0.25, 0, 1)
```

### 12.3 Anchor Imbalance

```js
anchorImbalance = maxColumnRatio - 0.25
```

若某一 column 過度集中，需抑制 chordjackBoost。

---

## 13. SRR 星數映射

```js
star = correctedNumeric
```

保留可調整參數：

```js
STAR_SCALE = 1
STAR_OFFSET = 0
```

顯示格式：

```text
SRR 8.42★
```

---

## 14. Reform 段位映射

請實作：

```js
function mapToReformRank(value) {
  if (value < 6) return "低於 Reform 六段"
  if (value < 7) return "Reform 六段"
  if (value < 8) return "Reform 七段"
  if (value < 9) return "Reform 八段"
  if (value < 10) return "Reform 九段"
  if (value < 11) return "Reform 十段"
  return "高於 Reform 十段"
}
```

---

## 15. LN 處理

需計算：

```js
lnRatio = lnCount / totalNoteCount
```

若 `lnRatio > 0.18`：

顯示警告：

```text
此譜面 LN 比例偏高，SRR RC 模型可能不準確。
```

---

## 16. UI 規格

### 16.1 Header

標題：

```text
Star Rating Rebirth 4K Analyzer
```

副標：

```text
SRR difficulty engine for osu!mania 4K Reform-style rating
```

### 16.2 Input Panel

- textarea
- placeholder：`Paste your .osu file content here...`
- button：`Analyze SRR`

### 16.3 Result Dashboard

需顯示：

- Song Title
- Artist
- Difficulty Version
- Mapper
- Note Count
- Duration
- Avg NPS
- Max NPS 250ms
- Max NPS 500ms
- LN Ratio
- Chord Rate
- Jack Rate
- Mini-jack Rate
- Anchor Imbalance
- SRR Star Rating
- Reform Rank

SRR 星數需最醒目。

### 16.4 Chart.js

至少兩張圖：

1. NPS Density
   - x：time
   - y1：NPS 250ms
   - y2：NPS 500ms

2. Fatigue / Strain Curve
   - x：time
   - y：fatigue
   - 可選 speed / stamina / jack / chord / tech

---

## 17. 檔案結構

請依照下列結構實作：

```text
/
├── index.html
├── README.md
├── CODEX_TASK.md
├── src/
│   ├── app.js
│   ├── osuParser.js
│   ├── srrEngine.js
│   ├── srrMath.js
│   ├── reformMapper.js
│   └── chartRenderer.js
└── styles/
    └── main.css
```

---

## 18. 驗收條件

完成後需符合：

1. 可直接用瀏覽器開啟 `index.html`。
2. 使用者可貼上 `.osu` 內容並按下 Analyze。
3. 系統可解析 `[Metadata]`、`[Difficulty]`、`[HitObjects]`。
4. 僅支援 4K。
5. 可正確識別 note time 與 column。
6. 可產生 NPS 250ms / 500ms 曲線。
7. 可產生 fatigue / strain curve。
8. 可輸出 SRR 星數，保留兩位小數。
9. 可輸出 Reform 六段至十段。
10. 可顯示 mini-jack / jack / chord / anchor 相關統計。
11. 長譜面不應因單純 note count 被過度放大。
12. 若 LN ratio 偏高，需顯示警告。
13. 程式碼需模組化，方便未來替換完整 Azusa calibration table。

---

## 19. 已知限制

初版不需要：

- tosu 即時 overlay
- WebSocket
- osu!lazer 串接
- 6K / 7K
- LN 專用演算法
- 後端 API
- 帳號系統

但架構必須保留未來擴充能力。
