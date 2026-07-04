# Star Rating Rebirth 4K Analyzer

SRR 4K Analyzer 是一個純前端 osu!mania 4K 譜面智能分析工具，評分路徑只使用 Azusa。

使用者可直接貼上 `.osu` 譜面內容，系統會解析 HitObjects，透過 Azusa pipeline 建立 NPS 密度、疲勞衰減曲線、鍵型族群與技能 profile，並輸出 SRR 修正星數與 Reform 段位。

## Features

- osu!mania 4K `.osu` parser
- Azusa-only Strain Decay Model
- Speed / Stamina / Jack / Chord / Tech 分項曲線
- Azusa Pattern Mix：Chordstream / Stream / Jacks / Tech
- Azusa Skill Profile
- NPS 250ms / 500ms 密度圖
- Reform 六段至十段映射
- LN ratio 警告
- 純前端，無後端依賴

## How to Run

直接用瀏覽器開啟：

```text
index.html
```

或使用簡單 local server：

```bash
python3 -m http.server 8080
```

然後開啟：

```text
http://localhost:8080
```

## Test

可用 Node.js 執行純邏輯測試：

```bash
node tests/srrEngine.test.mjs
```

## File Structure

```text
/
├── index.html
├── README.md
├── CODEX_TASK.md
├── tests/
│   └── srrEngine.test.mjs
├── src/
│   ├── azusa/
│   │   ├── 4k-rc-reform.js
│   │   ├── azusaEstimator.js
│   │   ├── companellaEstimator.js
│   │   ├── danielEstimator.js
│   │   ├── intervals/
│   │   │   └── index.js
│   │   ├── mixedEstimator.js
│   │   ├── rcDifficultyFormat.js
│   │   ├── reworkEstimatorUtils.js
│   │   ├── roxyEstimator.js
│   │   ├── roxyMetaModel.generated.js
│   │   └── sunnyEstimator.js
│   ├── parser/
│   │   └── osuFileParser.js
│   ├── rework/
│   │   ├── danielAlgorithm.js
│   │   ├── simpleReworkModel.js
│   │   └── sunnyAlgorithm.js
│   ├── app.js
│   ├── osuParser.js
│   ├── srrEngine.js
│   ├── srrMath.js
│   ├── reformMapper.js
│   ├── chartRenderer.js
│   └── srrStandalone.js
└── styles/
    └── main.css
```

## Known Limitations

- 目前僅支援 4K
- 目前使用 Azusa-only lite calibration，尚未導入完整 Azusa calibration table
- LN-heavy map 會分析但會提示不準確
- 不包含 tosu overlay / WebSocket 即時串接
