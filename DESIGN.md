# Site design (v3)

Paper file: **StatCan data site — v2**, page **v3**:
https://app.paper.design/file/01M3TVE47E7BRK0HRR0B6B3W9E/p-6-0

The Paper frames and this file must agree. If they disagree, fix one of them before building.

Older pages in the same file (v2, v2.1, the "Radical command" pages) are superseded. Do not build from them.

## Direction

The site is a data terminal. It is a serious tool, not a marketing site.

- The home page is only a search input.
- Search results are a grid of cards. Each card is one series with a small chart.
- A card opens a chart that fills the screen. Controls sit inside the chart.
- Every value on screen is a published value or a simple change computed from published values.

## Rules for every frame

1. **No notes on mockups.** Every word in a frame is text a real user would read on the real site. Design notes go in this file, never on the canvas.
2. **Grids fit the viewport.** Desktop frames are 1440 × 900. Every card, cell and label fits inside its box at that size. Nothing is cut off. Long titles wrap inside a fixed title area; they do not push other rows out of line.
3. **Real data only.** Every number, title, member, note and ID comes from a build on the SSD (`v0` / `n3` for WDS tables, `census-full-1` for Census tables). Never invent a value.
4. **Not official.** The site must not look like a Government of Canada service. No maple leaf, no FIP bar, no government colours or wordmark. Every page with a footer says "Independent. Not affiliated with Statistics Canada." Statistics Canada is named only as the source of the data.
5. **Check before hand-off.** Take a screenshot of each frame at 1x and 2x, and look for clipped text, overlaps and lines that do not align.
6. **Desktop only.** There are no mobile frames in v3.

## Visual rules

### Colour

| Name | Value | Use |
|---|---|---|
| Paper | `#FFFFFF` | page background, cells |
| Ink | `#0E0F11` | text, sparklines, active tab underline, input underline, primary button |
| Secondary | `#5A5F66` | secondary text, links in the top bar |
| Tertiary | `#9AA0A6` | IDs, footers, axis labels, placeholder text |
| Rule | `#E6E7E9` | lines between cells and sections |
| Grid | `#EDEEF0` | chart gridlines |
| Border | `#C9CBCE` | chart baseline, key caps, toggle borders |
| Red | `#D80621` | **only** the main chart line and its latest-value tag, the active state (the `›` prompt in an input, the "TOP MATCH" label, the selected row marker), and the stroke in the logo |

Red is never a background fill for large areas. There are no other accent colours. Comparison lines are ink or grey.

### Type

- **Geist** for titles, labels and values. Weights 400, 500 and 600.
- **Geist Mono** for codes, IDs, dates on axes, keyboard hints, the search query and small changes like `+3.0% 1Y`.
- All numbers use `font-variant-numeric: tabular-nums`.
- No Figtree, no Instrument Sans, no JetBrains Mono.

| Use | Font | Size / line | Weight |
|---|---|---|---|
| Home input | Geist | 40 / 48 | 500 |
| Chart title | Geist | 44 / 48 | 600 |
| Big value (top match) | Geist | 44 / 48 | 600 |
| Section or card title | Geist | 17 / 22 | 600 |
| Card value | Geist | 22 / 28 | 600 |
| Body, controls | Geist | 14 / 18 | 400–500 |
| Sub line | Geist | 13 / 16 | 400 |
| Codes, IDs, changes | Geist Mono | 11–13 / 16–18 | 400–500 |
| Footer | Geist Mono | 12 / 16 | 400 |

### Shape

- Square corners everywhere. No border radius.
- No shadows. No gradients.
- Lines are 1 px `Rule`. The only 2 px lines are the home input underline and the active tab underline. A 1 px `Ink` rule sits over a stats row.
- Cells in a grid are separated by 1 px gaps on a `Rule` background, not by borders on each card.
- Spacing steps: 4, 8, 12, 16, 20, 24, 32, 48.
- Page side padding: 48 px left, 24 px right (the right side holds the top bar links).

### Charts

- One line in red is the main series. Up to 5 compare lines in ink or grey.
- Line width 1.5 px for sparklines, 2 px for full charts. The latest point is a dot.
- Gridlines are horizontal only, `Grid` colour. The baseline is `Border`.
- Y labels sit on the right edge in Geist Mono 11 px tertiary. X labels are years.
- The latest value has a red tag on the y axis. The hover point has an ink date tag on the x axis and a readout box.
- A blank value is a gap. A published zero is zero.

## Components

| Component | Spec |
|---|---|
| **Top bar** | 56 px high, padding 0 24 0 48, gap 32. Logo in a 132 px slot. Search field 440 × 36 with 1 px rule border, red `›`, query in Geist Mono 14, `/` key cap. Links "API" and "About" at the right, Geist 14 500 secondary, gap 28. 1 px rule under the bar (not on Home). On a data screen the links are replaced by actions: Download, Cite, API (Geist 14 500 ink with a 14 px line icon) and a Share button (ink fill, white text). |
| **Logo** | 22 × 22 SVG: four 2 px ink bars and a 2.5 px red diagonal stroke. Then "tally" in Geist 19/22 600, letter-spacing −0.03em. |
| **Tabs** | 56 px high. Label Geist 15 500 plus a mono count. Active tab is ink with a 2 px ink underline. Others are secondary. |
| **Series card (small)** | 341 px wide, padding 20, gap 12. Title area is a fixed 64 px: title Geist 17/22 600 (up to 2 lines), then a 13 px sub line. Sparkline fills the middle. Value row 28 px: value, change in mono, spacer, vector ID in mono 11 tertiary. |
| **Series card (top match)** | Two columns wide. Red "TOP MATCH" label in mono 11. Title Geist 28 600, sub line with the table title and place. Big value at the top right (44 px) with "Aug 2026 · +3.0% 1Y" in mono under it. Full-history red chart with gridlines. Footer row in mono 11 tertiary: table number, vector, span, and an `open ↵` hint at the right. |
| **Control rail** | 60 px band along the bottom of the chart screen, 1 px rule on top, padding 0 24 0 48, gap 24. Left: range toggle and the date span in mono 12, a 1 × 24 divider, a "+ Compare" button, a "Notes 8" button. Right: source line in mono 12 tertiary, then a Chart / Table toggle. |
| **Segmented toggle** | 30 px high, 1 px `Border` outline, 1 px `Rule` between segments. Range segments are mono 12, 40 px wide. The active segment is an ink fill with white text. The others are secondary text on white. |
| **Button** | 30 px high, 1 px `Border` outline, padding 0 10, Geist 14 500 ink. An optional 12 px icon or a mono count follows the label. |
| **Stats row** | Under a 1 px ink rule. Cells 150 px wide with a 1 px rule between them. Mono 11 uppercase labels (`AUG 2026`, `1 MONTH`, `1 YEAR`), letter-spacing 0.06em, over Geist 28/32 600 values. |
| **Readout** | 170 px white box, 1 px ink border, padding 10 12 12. Mono 11 date, Geist 24 600 value, mono 12 change line ("+8.2% on Jun 2021"). |
| **Footer** | Geist Mono 12 tertiary. Left: "Independent. Not affiliated with Statistics Canada." Right: source line for what is on screen. |

## Screens

Each screen lists the API data it needs. Endpoints are in `api/README.md`.

### 01 Home

Frame `01 Home`.

- Top bar with logo, API and About only. No search in the bar.
- One input, 880 px wide, centred a little above the middle. Red `›`, an ink caret, placeholder "Search 8,271 Statistics Canada tables", a `↵` key cap, a 2 px ink underline.
- One row of example queries in Geist Mono 13: `cpi canada`, `population ontario`, `farms by province`, `18-10-0006-01`. Each one runs that search.
- Footer with the independence line and "Source: Statistics Canada".

Data: the 8,271 count is `GET /api/v1/coverage` (inventory count). Do not hard-code it.

### 02 Results

Frame `02 Results — cpi canada`.

- Top bar with the query in the search field.
- Tabs: "Series 11" (active) and "Tables 23".
- Grid: 4 columns × 341 px, 1 px gaps, starting at x 48. Row 1 is 312 px (top match over 2 columns + 2 small cards). Rows 2 and 3 are 216 px (4 small cards each).
- Small cards show the last 10 years. The top match shows the full history.
- Footer: independence line on the left; "Values as published by Statistics Canada · <table> · released <date>" on the right.

Data:

- Series tab: `GET /api/v1/series?q=…`. Card value is the latest `value`; the change is computed from the point 12 periods earlier, labelled `1Y`.
- Sparklines: `GET /api/v1/series/{pid}/{vector}` points.
- Tables tab: `GET /api/v1/tables?q=…`.
- If a query matches more cards than fit, the grid pages. It never scrolls past the footer inside the 900 px frame.

### 03 Chart

Frame `03 Chart — All-items`.

- Top bar with the query, and Download, Cite, API and Share at the right.
- The chart fills the space between the top bar and the control rail.
- Title block in the top-left, on a white panel over the chart: mono 12 line "18-10-0006-01 · Consumer Price Index", title "All-items" Geist 44/48 600, sub line "Canada · Index, 2002=100 · Monthly, seasonally adjusted" in Geist 15, then the stats row (latest, 1 month, 1 year).
- Chart: plot from x 48 to x 1360, gridlines every 20 index points, y labels at x 1372, year labels under the baseline. Latest value 169.3 in a red tag on the y axis.
- The chart screen has no footer. The chart uses the full height.
- Hover readout near the pointer: date, value, change on the same month a year earlier.
- Control rail: Range `1Y 5Y 10Y 20Y Max` (Max active), "Jan 1992 – Aug 2026", "+ Compare", "Notes 8". Right side: "Statistics Canada · 18-10-0006-01 · v41690914 · released 14 Sep 2026", then Chart | Table.
- Table mode replaces the chart with a dense table of every point. It never shows both.

Data: `GET /api/v1/series/{pid}/{vector}` for points, labels, unit and citation. `GET /api/v1/tables/{pid}` for notes and release time. Cite copies the `citation` string.

### 04 Table page — planned

Example 18-10-0006-01. Dimensions with members, notes, every series as a dense row, downloads.

### 05 Place page — planned

Example Ontario, `2021A000235`: 55 tables in 14 subjects.

### 06 Census table — planned

Example 98-10-0222-01. Census tables are one 2021 snapshot with no vectors, so the page is a cross-tab, not a line chart.

### 07 Developers — planned

REST, MCP, downloads, and citing build IDs.

## Data and hand-off

- Design only with fields that exist. Check `SCHEMA.md` or the files on the SSD first.
- If a screen needs a field that does not exist, ask the data thread. Do not draw the field until it exists.
- When a screen is final, send its Paper link to the API thread. The API thread builds from the frame and this file.
- Build IDs (`v0`, `n3`, capture `baseline`) on mockups are the real IDs at the time of drawing. The site reads them from `/api/v1/build`.

## Open questions

1. **Stable view URLs.** Series URLs are stable (`/series/18100006/v41690914`). Full table views need a URL form for member filters.
2. **Hosted MCP.** The design shows the local stdio setup. A hosted endpoint does not exist yet.
