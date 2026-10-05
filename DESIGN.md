# Site design (v4)

This file is the source of truth for site design. Keep it short and current.

## Direction

The site is a data terminal. It is a serious tool, not a marketing site.

- There is no search. The user types what they want to understand and lands on a chart at once. The planner (`GET /api/v1/plan`) picks the tables, members, period, transform and chart type.
- One app screen at `/`: the question box at the top, the chart under it, panels under the chart, and a chart builder in a right sidebar that is closed by default.
- The search results screen (v3 02 Results) and the single-series chart screen (v3 03 Chart) are removed. Their URLs redirect to the app screen.
- Charts show human-readable dates. Sources, notes, downloads and the API live in panels under the chart.
- Every value on screen is a published value or a simple, named transform of published values (% change, index, share, sum).

## Rules for every screen

1. **No design notes on pages.** Every word on a page is text a real user reads. Design notes go in this file.
2. **Grids fit the viewport.** Desktop screens are checked at 1440 × 900 and 1900 × 1040. Every card, cell and label fits inside its box. Nothing is cut off. Long titles wrap inside a fixed title area; they do not push other rows out of line.
   - **App screen** (`/`) is exactly one window high in every state and never scrolls, either way, at any size: head band, plot and rail fill the window, and the plot takes all the height left. Chart details (Table, Notes, Download, Cite, API) open as popovers over the plot, never as sections below it. With the builder open, only the builder scrolls, inside itself. Checked by script: `scrollHeight <= innerHeight` and `scrollWidth <= innerWidth` for the blank states at 390 × 700, 1024 × 700, 1440 × 900 and 2236 × 1266, and for results pages (with and without the builder) at 390 × 844, 1440 × 900 and 2236 × 1266. In code there is no max width and no fixed height: the plot grows with the window in both directions.
   - **Reference pages** (`/api`, `/mcp`) keep the same 56 px top bar and 48 px footer as the app. Their article scrolls between those fixed rows, so the footer has the same top and height at 1440 × 900 on home, chart and reference pages.
   - Rows in lists use a minimum height, not a fixed height, so a long title wraps and the row grows.
3. **Real data only.** Every number, title, member, note and ID comes from a build on the SSD (`v0` and its Normalized build `n4` for WDS tables, `census-full-1` for Census tables). Never invent a value.
4. **Not official.** The site must not look like a Government of Canada service. No maple leaf, no FIP bar, no government colours or wordmark. Every page with a footer says "Independent. Not affiliated with Statistics Canada." Statistics Canada is named only as the source of the data.
5. **Check before hand-off.** Screenshot changed screens at 1440 × 900 and 1900 × 1040. Look for clipped text, overlaps and lines that do not align.
6. **Desktop first.** The app screen also works on a phone: the head band stacks, the plot is 60 % of the viewport height, and the chart builder becomes a bottom sheet. Document pages are desktop only.

## Visual rules

### Colour

| Name | Value | Use |
|---|---|---|
| Background | `#FFFFFF` | page background, cells |
| Ink | `#0E0F11` | text, sparklines, active tab underline, input underline, primary button |
| Secondary | `#5A5F66` | secondary text, links in the top bar |
| Tertiary | `#9AA0A6` | IDs, footers, axis labels, placeholder text |
| Rule | `#E6E7E9` | lines between cells and sections |
| Grid | `#EDEEF0` | chart gridlines |
| Band | `#F4F5F6` | the faint band behind x categories that belong to a group that was not combined |
| Border | `#C9CBCE` | chart baseline, key caps, toggle borders |
| Red | `#D80621` | slot 0 of the chart palette (so a one-series chart is red), the `›` prompt, the warning marker `!`, the selected row marker, the active statistics segment underline, the selected cross-tab cell, the current vintage marker, the focus ring, and the stroke in the logo |

Red is never a background fill for large areas. Outside charts there are no other accent colours.

#### Chart palette

Ten categorical slots, CSS variables `--c0` … `--c9` in `api/public/app.css`. A spec stores slots, never hex (`chart.colors`, `ViewSeries.color`). Slots are assigned in series order, so the first series is always red.

| Slot | Value | Slot | Value |
|---|---|---|---|
| 0 | `#D80621` red | 5 | `#CC79A7` pink |
| 1 | `#0E0F11` ink | 6 | `#3A8DC4` sky |
| 2 | `#2A5DB0` blue | 7 | `#813131` brown |
| 3 | `#C27400` orange | 8 | `#7341D6` violet |
| 4 | `#2E9C5A` green | 9 | `#A50D72` magenta |

The palette was chosen for colour-blind separation: under simulated protanopia, deuteranopia and tritanopia (Machado 2009, full severity) every pair of slots stays at least ΔE 12 apart (closest: green/sky under tritanopia, red/orange under deuteranopia). Every slot has at least 3:1 contrast on white. Above ten series, slots repeat; the legend, the data table and the builder name every series, so colour is never the only key.

### Type

- **Geist** for titles, labels and values. Weights 400, 500 and 600.
- **Geist Mono** for codes, IDs, dates on axes, keyboard hints, the search query and small changes like `+3.0% 1Y`.
- All numbers use `font-variant-numeric: tabular-nums`.
- No Figtree, no Instrument Sans, no JetBrains Mono.

| Use | Font | Size / line | Weight |
|---|---|---|---|
| Question box (app screen) | Geist | 18 / 24 | 500 |
| Chart title | Geist | 32 / 38 | 600 |
| Blank-state message | Geist | 28 / 34 | 500 |
| Section or card title | Geist | 17 / 22 | 600 |
| Card value | Geist | 22 / 28 | 600 |
| Body, controls | Geist | 14 / 18 | 400–500 |
| Sub line | Geist | 13 / 16 | 400 |
| Codes, IDs, changes | Geist Mono | 11–13 / 16–18 | 400–500 |
| Footer | Geist Mono | 12 / 16 | 400 |

### Shape

- Square corners everywhere. No border radius.
- No shadows. No gradients.
- Lines are 1 px `Rule`. The only 2 px lines are the question box underline, the active tab underline, the in-flight progress line, the active statistics segment underline (red) and the current vintage marker (red, on the left edge of the row). A 1 px `Ink` rule sits over a stats row, a meta strip, and every section list.
- Cells in a grid are separated by 1 px gaps on a `Rule` background, not by borders on each card.
- Spacing steps: 4, 8, 12, 16, 20, 24, 32, 48.
- Page side padding: 48 px left, 24 px right (the right side holds the top bar links).

### Charts

- Chart types: `line`, `area`, `bar`, `stacked_bar`, `stacked_bar_100`, `stacked_area` (the spec's `chart.type`). Bars can be horizontal. The builder shows each type as a 16 px stroke icon.
- Line and area charts are for time series. Bar charts are for one period across categories (x is a dimension), or for discrete periods where a line would imply a trend. Census snapshot tables use bars.
- Stacked bars and stacked areas are for parts that add up (counts, currency). `stacked_bar_100` shows each part as a % of its bar.
- Colours come from the 10-slot palette (see Colour). Each series has its own slot. The user can change a slot in the builder.
- **Groups.** A combined group (published aggregate, sum, or recomputed ratio) is one series with its own slot, like any other. A group that could not be combined (`group` set, `group_method` null) shows each member, and its members are one hue family: the slot of the first member, each next member mixed lighter with white (100 % down to 45 %). Ink has no hue to shade, so a family never uses slot 1; it takes the first free hued slot. The family stays together in the legend, and each member is named with its group (`Prairies · Manitoba`). On x-category bars, the members of a group that could not be combined sit on a faint `Band` (`#F4F5F6`) with the group name in mono 11 at the top; combined categories need no band (the category is the group).
- **Two y axes** at most, one per unit. The first unit's labels are on the right, the second unit's on the left. With two axes, each axis title names its unit, and the head band shows the warning "two unit axes are shown".
- **Results need 2+ points.** A time chart with one visible series and fewer than two published values draws nothing and says "One period only, so there is no line to draw. The values are in Table." A flat single series says "Constant at <value> across the period." Every hidden series says "Every series is hidden. Show one in the chart builder."
- Line width 2 px. Markers only when a series has fewer than 40 points.
- Gridlines are horizontal only, `Grid` colour. The baseline is `Border`.
- Y labels in Geist Mono 11 px tertiary. Value-axis labels from 10,000 up are compact (`250K`, `1.25M`, `2M`, `3.2B`), so the widest label never runs out of its slot and is never cut; tooltips and the Table keep full values. X labels are years (time) or member names in mono 12 secondary (categories). Category labels never overlap and never rotate 45°: under 20 categories they wrap into their slot, up to 3 lines, then end in `…`. The full name is always in the tooltip and the Table panel.
- **Many categories (20 or more).** Bars turn horizontal by default, so every label reads on one line (cut at 240 px with `…`). Each category gets its own row (22 px for stacked bars, more for grouped bars), and the plot scrolls inside the stage. The value axis stays fixed at the top, and the legend moves above the plot so it stays in view. The 152 CMAs/CAs and the 166-row Census geographies use this layout. The builder's Horizontal box shows the effective state; unchecking it writes `chart.horizontal: false`, and then vertical labels stand at 90°.
- The legend sits under the plot, left aligned, Geist 13 ink, one square swatch per series. Clicking a legend item toggles that series for this session only; the builder's Hide toggle writes `chart.hidden` into the spec.
- Method line: when a group's value is not what a reader would assume, one mono 12 secondary line under the sub line says how it was made, one line per method: `Prairies, Atlantic: recomputed as Unemployment ÷ Labour force × 100`, `Provinces: published as Canada`. Sums get no line. A group that could not be combined has its warning instead.
- Gap note: `ViewResult.gap_note`, when set, is one more line in the same style, after the method lines ("Calgary and Toronto Food are not published by Statistics Canada.", "Some periods are not published; breaks in the lines mark them."). When it is shown, the engine's per-series `no_data` warnings are not (the note says the same in words). When a `substituted_geography` warning or the planner's reason already names the unpublished members, only the time part shows (`gap_parts.time`), or no gap line at all.
- Tooltip: shared, white, 1 px ink border, square, 9 px inset on every side. A small table: the period in Geist Mono 11 secondary on top, then one row per series: an 8 px square swatch and the name in Geist 12, the value right-aligned in its own column (600, tabular numbers), and the status mark with its official meaning in mono (`E use with caution`). Nothing wraps.
- Nothing sits on top of the plot except the tooltip. Titles go in a band above the plot.
- No credit, licence or help lines on a chart. Licence notes go on 07 Developers.
- **Gaps.** A blank value is a gap (`connectNulls: false`). A published zero is zero. A missing period stays in the series as a null point, so a line breaks there. A published point with a gap (or the series' end) on both sides gets a 3 px marker, or it would not show. Hovering a gap period lists that series in the tooltip with `–` in muted text, then its mark and official meaning (`– x suppressed to meet the confidentiality requirements of the Statistics Act`), or "Not published" when there is no mark. The swatch of a gap row is an outline. On bars, a missing bar is a 10 px muted `–` on the baseline, along the bar's direction (vertical and horizontal bars); a stacked bar gets one only when its whole stack is missing.
- **Unpublished series** (`ViewSeries.unpublished`: nothing published in the window, such as Calgary × Food). It has no line, no bar and no tooltip row. It stays in the legend, after the drawn series: its name in tertiary, then "not published" in mono 11, with no swatch; the entry does not toggle and does not dim other lines on hover. If every series is unpublished, the plot shows the gap note as its blank-state message.

## Components

| Component | Spec |
|---|---|
| **Top bar** | 56 px high, wordmark at left (padding 48), "API" and "MCP" at right (padding 24), and no rule under it on any page. The search box is centred on the viewport, not on the space between the wordmark and the nav, at one width, min(640 px, viewport − 440 px), 40 px high, 8 px from the top: the same x, y and width on the app screen, the home page and every reference page (`api/public/topbar.css`). It has a red `›`, Geist 18, a 2 px ink underline and no outline; reference pages submit it to `/?q=`. On the app screen a 2 px progress line runs along the bar's bottom edge while a request is in flight. The chart's actions sit in the detail rail, not in the top bar. Phones (≤ 900 px): the box fills the space after the wordmark and the nav is hidden. |
| **Logo** | The mark, 20 px, 8 px gap, then "statcan" in Geist 19/22 600, tight tracking, followed by "(2)" in red Geist Mono 15/22 500. The mark is the favicon: a white rising line ending in a red dot on an ink tile (`brand/README.md`). No government wordmark or maple leaf. |
| **Head band** | Above the plot, padding 20 24 12 48. Eyebrow in mono 12 secondary, one line, cut with an ellipsis: one source table shows its number (ink, linking to the official Statistics Canada table in a new tab) then `·` and the table title, with the full title in a tooltip (`14-10-0397-01 · Labour force characteristics by family structure, monthly…`); several tables show only their numbers, each linked, with titles in tooltips. Title Geist 32/38 600 (from `ViewResult.title`; it describes the chart, not the table). Sub line Geist 15 secondary, parts joined by ` · `, each part only once: `ViewResult.subtitle`; then the period from `ViewResult.period` (`Aug 2025 – Aug 2026`, one date when from = to) unless the subtitle already names it; then the axis units unless the subtitle names them; then the transform name only when the title does not already say it (a title with "% change" drops "% change over window"). Example: "Gasoline vs Food by province, % change over 1 year" / "Aug 2025 – Aug 2026 · %". Warnings (`ViewResult.warnings`) follow as mono 12 lines with a red `!`, never as a modal. "Also" offers the planner's alternatives as one mono 12 line of links, each cut to 36 characters; the row is absent when there are none. An alternative over the same tables with another chart type reads "as area chart" (etc.); other alternatives show the planner's label. The "Chart builder" button sits at the right, aligned to the bottom of the band; it is ink-filled while the sidebar is open. |
| **Detail rail** | 48 px band under the plot with no top rule, padding 0 24 0 48. One row of small buttons: Table, Notes (count), Download, Cite (count when more than one source), API; then, after a 1 px `Rule` divider, the two actions: **Screenshot** (outline, camera icon) and **Share** (ink fill, white text, share icon). Each button is 28 px high, Geist 13 500, count in mono 11 tertiary; a detail button whose popover is open is ink-filled with white text. On phones the two actions show icons only (their names stay as accessible labels). There is no toast: each action's own label confirms it (on phones the word shows in the button while it flashes). The independence line sits at the right in mono 12 tertiary (hidden on phones). Buttons and actions are hidden in the blank states. |
| **Screenshot** | Copies the export PNG to the clipboard (`navigator.clipboard.write` with a `ClipboardItem` holding the PNG's Promise, so Safari keeps the click's user activation); the label reads "Copied". If the clipboard cannot take an image (no `ClipboardItem`, not a secure context, or the write is refused), the same PNG downloads, named from the title (`renter-vs-owner-by-province.png`), and the label reads "Saved". The button's label reads "Copied", "Saved" or "Failed" for 1.5 s; every label shares one grid cell, so the button never changes size. The image is the **Export** below. |
| **Share** | Copies the published link, `https://statcan2.ca/?q=…&s=…` (the exact chart, with an open popover's `#p-…` if any); its label reads "Copied" for 1.5 s in a box of fixed size. On touch devices with `navigator.share` it opens the system share sheet instead. Local testing can point the link elsewhere with `?origin=…` (not copied into the link). |
| **Export** | One look for the Screenshot PNG and the OG image (`/og/chart.png`); the numbers live in `api/public/export-layout.js`, which both renderers import. Screenshot: a fixed 1600×900 canvas at 2× (3200×1800), the same at any window size and builder state; OG: 1200×630, every size scaled by width. 64 px side margins. Top to bottom: eyebrow in Geist Mono 20 red, uppercase, letter-spacing 1.5 px: `STATCAN2.CA` (`STATCAN2.CA / 2 TABLES` for several tables); title Geist 600 56 px on one line, shrinking to 40 px, then cut with `…`; the page's sub line in Geist 24 secondary; method and gap lines in Geist Mono 20 secondary; a 1 px `Rule`. The plot: lines 3.5 px, markers only on isolated points, axis labels Geist Mono 18 secondary, light gridlines, ticks at least 150 px apart, each axis titled with its unit when there are two. Legend: a line chart with 1–4 drawn series gets direct labels at the line ends instead (Geist 20 in the series colour, name then the last value in 600, pushed apart so they never overlap); otherwise one legend row of 14 px swatches and Geist 19 names, wrapping to at most 2 rows; over 12 series, the top 12 by last value and "+N more"; unpublished series listed as on screen ("not published"). A single bar series has no legend. Then a 1 px `Rule` and the footer in Geist Mono 18 secondary: `Source: Statistics Canada · Table 18-10-0004-01` at left (all tables, cut with `…` if too long), `statcan2.ca · Sep 2016 – Aug 2026` at right. The image never names the request host. Geist and Geist Mono are loaded for every character drawn before the canvas is drawn, and the plot's SVG embeds them, so no glyph falls back or drops (checked: every "s" of "Seasonally adjusted"). |
| **Detail popover** | Opened by its rail button; one at a time. It sits above its button, centred on it and clamped 12 px inside the window, with a 10 px caret pointing down at the button. White, 1 px `Border`, a very light shadow (0 2 10 ink at 6 %) only to lift it off the plot. No title inside: the ink-filled rail button says which one is open (the name stays for screen readers). A 24 px × sits in the top-right corner, in a 40 px lane on the right that content never enters (body padding), so the body's scrollbar sits at the popover's right edge, right of the ×. All content has one inset: 16 px top and bottom, 20 px left (16 px on phones); the Table has no top inset, because its sticky header carries it. The body is the only part that scrolls (it never scrolls the page). Width: Download and Cite 600 px, API 720 px, Notes 760 px; Table is as wide as its table plus the insets (no blank area to the right) up to 960 px, and a wider table scrolls inside. Never wider than the window minus 24 px. Height fits the content up to 70 % of the window, and never above the top bar. It closes on the same button, × , Esc, or a click outside; focus moves into it on open, Tab and Shift+Tab stay inside it, and focus returns to its button on close. `#p-table`, `#p-notes`, `#p-download`, `#p-cite`, `#p-api` open the matching popover on load, so old links keep working. A new chart keeps the open popover, re-filled and re-anchored; a blank state closes it. On phones (≤ 900 px) it is a bottom sheet: full width, directly above the rail, up to the top bar, 1 px ink rule on top, no caret, no shadow. Without JavaScript the five panels appear as plain sections below the screen, each with its title, and the rail buttons are links to them. |
| **Chart builder** | Right sidebar, 380 px, 1 px rule on the left, full height under the top bar, scrolls on its own. Closed by default. Head "Chart builder" with a × close. Every control sits on one grid: the section's 20 px insets are the left and right edges, and every select, input and segmented control is 32 px high, 1 px `Border`, square, Geist 13 (Geist Mono 12 in segments, mono in date fields). Field labels sit above their control in mono 11 secondary. Sections, each with a mono 11 uppercase label: Chart (the six type icons as one full-width segmented control with equal cells; for bars, Horizontal and Sort in two equal columns), Time (Latest 1Y 2Y 5Y 10Y 20Y Max as one full-width segmented control; From and To in two equal columns under it, plus At in a third for x-category charts), Transform (a full-width select; "Index = 100 at" adds a base field under it, empty for the first published point, or a period `2015`, `2015-06`, `2015-Q2`, written as `index_base`), Series (fixed 24 px swatch and 48 px Hide columns, then the name, on one line), Tables (one block per layer: table number, title, Remove; then one collapsible row per dimension: name and a mono summary such as `series · 10 selected`; inside, the Use select at full width, quick sets as mono chips, a search box above 8 members, the member list, and groups), Add table (search, then one row per hit), and a collapsed "How this was chosen" list of planner steps. On phones it is a bottom sheet, 72 % of the viewport high, with a 1 px ink rule on top; the same grid holds at 320 px. |
| **Member list** | At most 200 rows, never the whole dimension (a Census geography has 63,404 members). Without search text: the checked members first, as a flat list in the order they were picked (no indent, a rule under the last one), then the master checklist in tree order, indented 14 px per level. With search text: the matches across all members, in member order, each with its parent in mono 11 tertiary (`Saskatoon · Division No. 11`), because many places share a name. A mono 11 tertiary last row says how many more there are ("63,204 more members; search to find them", "3,668 more matches; type more to narrow"). Typing re-renders only that list, about 120 ms after the last key. |
| **Segmented control** | 32 px high, full width, equal cells, 1 px `Border` outline, segments in mono 12. The active segment has ink fill and white text. |
| **Button** | 32 px, 1 px `Border` outline, Geist 13 500, underlined on hover. Primary is ink fill with white text. The focus ring is 2 px red with a 2 px offset. |
| **Blank state** | Fills the plot area, centred both ways on the band between the top bar and the rail, with no rule of its own and an even 24 px side inset (12 px on phones). Message in Geist 28/34 500 tertiary ("Continue typing", "Sorry, nothing found"), centred text. |
| **Home grid** | The idle state. Key-indicator cards fill the window under the top bar on a white page: 4 columns at desktop, the 2×2 centre card in columns 2–3 of rows 1–2, `grid-auto-flow: dense` so the cards fill every cell around it (12 cards + the centre = 4 × 4; 1440 × 900 never scrolls). Each cell draws its own 1 px `Rule`. There is never a grey block, a placeholder or an empty cell: cards that would leave a part-filled last row are hidden for that layout. Mid widths (901–1199 px): the centre card is a band across the top, cards three to a row. Phones: two to a row, the page scrolls. Before the cards arrive only the centre card shows, with no frame. Indicator card (a link to `/?q=…&s=…`): label in Geist 13 500 secondary; the number in Geist 34 600 tabular, compact (`41.8M`, `$2.57T`, `6.4 %`, `169.8 2002=100`); the change with ▲ green / ▼ red / ▶ secondary and its kind (`+3.0% 12-month change`, `0.0 pts monthly change`); the period and table in Geist Mono 11 tertiary (`Q3 2026 · 17-10-0009-01`); a 5-year sparkline in its palette slot along the bottom. Centre card: a thin up arrow, "Type anything into the search bar" in Geist 28 600, and "Compare places, group regions, see change over any window, or index to a year." in Geist 15 secondary; clicking it (or Enter / Space) focuses the search box. Data: `GET /api/v1/highlights`. |
| **Data table** | In the Table popover. Sticky header with a 14 px top inset of its own, so it never moves and never meets the popover edge; a 1 px `Border` rule under it. First column: the period (Geist 12 secondary, tabular) or the category. One column per series: swatch, name, unit in Geist 11 tertiary; an unpublished series' head is tertiary with "not published" under its name. Values right-aligned in mono with tabular numbers; a status mark as a superscript with its meaning as a tooltip. A gap cell is `–` and its mark in tertiary (`– x`), with the meaning (or "Not published") as its tooltip. Latest period first, at most 500 rows; a Geist 12 tertiary line says when rows are cut, and Download has every row. The popover body scrolls; the table has no scroll box of its own. |
| **Footer** | One 48 px row at the bottom of every screen, with no horizontal rule. Geist Mono 12 tertiary. Reference pages show the disclaimer at left and a page-specific line at right. The app uses this same row as its detail rail and carries the disclaimer at right. |
| **Reference page** | `/api` and `/mcp` use one readable column, about 820 px wide. Geist 40/44 600 title, 22/28 section titles, generous 48 px section spacing, thin list rules, and very light code tints. No cards, rounded corners or shadows. |
| **Section head** | Title Geist 16/20 600, then a count in mono 12 secondary, then a spacer, then a right-hand line in mono 12 tertiary. Padding-bottom 12. A 1 px ink rule under it starts the list. |
| **List row** | Min-height 40, padding 10 0 9, gap 16, 1 px rule under each row. Codes and IDs in mono, text in Geist 14. Fixed-width slots for IDs and numbers so columns align across rows. |
| **Note tag** | Mono 11 tertiary, e.g. `note 9`, after a member or dimension name. It links to that note. |
| **Archived tag** | Mono 11 tertiary `archived` before the frequency. The row's title and numbers turn tertiary. Archived tables are listed, never hidden. |
| **Download row** | Two kinds, each under a Geist 11 500 uppercase tertiary label: "Chart data" ("This view") and "Full tables" (one row per table). Every row is one grid: the name in Geist 13 600 ("This view" or the table number, same style), a Geist 12 secondary sub line on one line cut with `…` ("2 series, as charted" or the table title), then two equal 112 px button slots with a down-arrow icon, so buttons line up across rows (on phones the name sits above and the two buttons split the width). "This view" Parquet is the primary button (ink fill); the rest are outline. Each button's tooltip says what the file holds. |
| **Cite block** | The citation string in Geist 14, then a Geist 12 tertiary line (`captured 30 Sep 2026 · build v0 · normalized n4 · <table URL>`) and a Copy button at the right. One block per source table; with several, a label row on top ("2 tables" at left, "Copy all" at right). |
| **API block** | A mono 13 label (`POST /api/v1/view`), an "Open ↗" link when it is a URL, a Copy button, then the request in mono 12 secondary, wrapped. "API reference →" under the last block links to `/api`. Copy buttons (here and in Cite) are one width, 88 px, and every word they can show ("Copy", "Copied", "Failed") shares one grid cell, so they never change size. |
| **Record** | Key–value rows. Key in mono 11 uppercase tertiary, 116 px slot. Value Geist 14 ink. A row is hidden when its field is empty (a Census table has no CANSIM row). |
| **Notes** | First a "Calculation" block when the view has `index_note` (how the index base was taken, e.g. "Index uses the first published point in 2016 as 100, when available."), then a "Groups" block when the view has groups (both are ours, not Statistics Canada's): one row per group, two columns, the label in 600 with its method tag, then the formula in mono 12 ink and the members in Geist 13 secondary. Then the published notes, grouped by source table, then by scope: table notes, then dimension notes, then member notes. Two columns, numbered with the note number as published (gaps in the numbering stay). Each block opens with one head line: the name in Geist 13 600 (table number, "Groups", "Calculation"), then the table title in Geist 13 secondary, cut with `…`, over a 1 px `Border` rule; no count (the rail has it). A dimension or member note has a Geist 12 tertiary tag (`Products and product groups · All-items`) above its text. Note HTML is rendered, but only the tags StatCan uses survive (a, b, i, em, strong, br, p, ul, ol, li, sup, sub); links keep only an http(s) or mailto href and open in a new tab. "(opens new window)" hints are removed. Note text is never shortened. The Notes count on the rail includes the calculation and the groups. |
| **Method tag** | Mono 11, 1 px `Border` outline, padding 0 5: `published`, `sum`, `ratio`. `not combined` and `not in table` are secondary with a dashed outline. Used in the builder and in Notes. |

## Screens

Each screen lists the API data it needs. Endpoints are in `api/README.md`.

### 01 App screen (`/`)

One screen does everything: the question box, the head band, the plot, the detail rail with its popovers, and the chart builder.

**Input to chart.**

- The question box has focus on load (without scrolling) and keeps it while the user types, except on the home page with an empty box, where the placeholder plays the typing demo. It does not take focus when the URL has a `#panel` hash or something else already has focus. Placeholder "What do you want to understand?".
- **Typing demo** (home only, in the same top-bar box): the placeholder types a query a character at a time, holds it, deletes it and types the next. It stops when the box gets focus or a key; leaving an empty box starts it again. With `prefers-reduced-motion` it shows whole queries, one every 3 s. Tab or → in an empty box takes the query on show and plans it. The queries (one array in `app.js`, from the planner): cost of living by province, past 10 years · gas vs. food inflation, ontario, rate of change · population vs inflation since 2018 indexed to 2015 · unemployment rate, provinces vs. territories · population growth, prairies vs. atlantic, since 2000 · employment in goods producing vs service producing industries by province as stacked bars · rent inflation Toronto vs Montreal · real gdp, year-over-year change, past 20 years · deaths by cause in ontario · average weekly earnings by industry.
- About 250 ms after the last keystroke, the page calls `GET /api/v1/plan?q=<text>&view=1`. Each new keystroke aborts the previous request. The progress line shows while a request is in flight.
- The old chart stays on screen until the new answer arrives. There is no flash and no spinner over the plot.
- The URL names the exact chart, always. Once a chart is on screen the address is `/?q=<text>&s=<spec>`, where `s` is `encodeSpec(ViewResult.spec)`: the server's resolved spec, so members are ids (not roles or labels) and it carries chart type, horizontal, sort, colours, hidden series, transform and time window. A link with `s` runs that spec as is and never calls the planner; `q` only refills the question box. A link with only `q` plans, and then gets its `s`. Typing replaces the history entry (`replaceState`), first with only `q` and then with `q` + `s` when the chart lands; Enter and every builder edit add an entry (`pushState`), so Back and Forward step through charts exactly. Blank states carry only `q`. An open detail popover is in the hash (`#p-table`, `#p-notes`, `#p-download`, `#p-cite`, `#p-api`) and is part of a shared link; opening or closing one does not add a history entry.
- First paint is server-rendered: the server runs the planner (or the spec in `s`) and embeds the state as JSON, so there is never a blank first paint. Without JavaScript the page still shows the head band, the blank-state message, and every panel, including the data table.

**States** (from `PlanResult.status`). The exact strings:

| State | When | Chart area |
|---|---|---|
| idle | empty input | the home grid (key-indicator cards around the centre card); the typing demo plays in the search box |
| need_more | the input is a fragment (`c`, `the`) | "Continue typing" |
| no_match | unrelated to anything StatCan publishes | "Sorry, nothing found"; then `PlanResult.reason` when there is one, in Geist 15/22 secondary, centred under it (max 560 px): "The Canadian Shield does not follow province borders; no Statistics Canada table publishes it as a province group."; then `alternatives` as links when there are any |
| ok | a spec ran | the chart |

In the three blank states there is no head band, no builder button, no rail buttons and no popovers. The rail keeps only the independence line, at the bottom of the window. No rule is drawn under the top bar (on any page). If the builder or a popover is open when the input turns blank, it closes. A view error from a builder edit is not one of these states: it keeps the builder open, and the builder scrolls inside itself.

**Chart builder.** It is closed by default. The head band button opens it. Esc closes it and returns focus to the button. It edits the spec directly. Each edit is posted to `POST /api/v1/view` about 200 ms later and re-renders. If an edit is invalid, the last good chart stays and the server's error shows as a warning line.

- Member selections are written in the shortest form that is exact: a role set (`{role:"province"}`, `{any:[province, territory]}`), `{childrenOf:id}`, `{all:true}`, else `{in:[ids]}`.
- A dimension can be fixed (one member, radio buttons), series, x (bars only; only one x across the view) or sum.
- **Groups** (series or x dimensions; mono 11 uppercase "Groups" label with a count). On a geography dimension, one chip per region from `GET /api/v1/regions` that has a member in this table (physiographic regions never; a region already grouped is not offered again). A chip adds `{label, members: {region}, region}` and takes those members out of the plain selection. A custom group names the checked members ("Group checked"); the checked members then show only as that group. Each group is a block: its name in an input on its own line (renaming keeps its colour and hidden state), then the method tag the last view used, a combine select (Auto, Published, Sum, Ratio; Auto writes no `agg`) and Remove (its members return to the selection), then its members in mono 11 tertiary on one line. At most 20 groups.
- Groups and their members are part of the spec, so the link, Share, Back/Forward and the PNG keep them. The resolved spec writes an empty selection as `{in: []}`, which the spec schema refuses; links and builder edits write it as `{not: {all: true}}` instead.
- Add table searches `GET /api/v1/cubes?q=` and adds the table with its first suggested view (`GET /api/v1/cubes/{pid}/views`). At most 4 tables.

**Detail popovers** (from the rail, one at a time; all from the current `ViewResult`):

- **Table**: the data table, built from series × points.
- **Notes**: `notes[]` from every source table in the view, merged and grouped (see Notes).
- **Download**: "This view" (Parquet, CSV from `links.parquet` / `links.csv`, exactly what the chart shows), then one row per source table with the full-table Parquet (`/api/v1/tables/{pid}/observations.parquet`) and "Source ZIP", a direct link to Statistics Canada's own ZIP with its CSV (`https://www150.statcan.gc.ca/n1/tbl/csv/{pid}-eng.zip`).
- **Cite**: every `sources[].citation`, with captured date, build, table URL and Copy.
- **API**: a curl for `POST /api/v1/view` with the current spec, the `GET /api/v1/view?s=` link, and the MCP `run_view` call with the spec JSON.

Data: `GET /api/v1/plan`, `POST /api/v1/view`, `GET /api/v1/cubes`, `GET /api/v1/cubes/{pid}`, `GET /api/v1/cubes/{pid}/views`. Static files are served from `api/public` at `/static/`.

### Removed screens and their URLs

- v3 02 Results is gone. `/search?q=` redirects (302) to `/?q=`.
- Dedicated table, series and place pages are gone. `/tables/{pid}` redirects (301) to `/?q=<table number>`; `/series/*` and `/places/*` redirect (301) to `/`. Their JSON API routes remain.


### API reference (`/api`)

- Free, read-only JSON over HTTPS. Three copy-ready quick starts show real, trimmed responses for plan, view and observations.
- Endpoint rows cover every `/api/v1` route, grouped as Charts, Tables, Series, Places, Files and Build. The one OpenAPI document is linked.
- Copy buttons keep one fixed width when their label changes.

### MCP reference (`/mcp`)

- The hosted Streamable HTTP endpoint is `https://statcan2.ca/api/mcp`.
- The server URL comes first, in one copy block. Then one row per client: a mono logo, the name, and its setup steps or snippet. Clients: Claude, Claude Code, ChatGPT, Codex, Gemini CLI, Grok (xAI API), Le Chat, Cursor, VS Code · Copilot, Windsurf, OpenCode, then local stdio.
- Client logos are inline SVGs from `@lobehub/icons-static-svg` (MIT), in `api/src/client_icons.ts`. They use `currentColor`.
- The tool list comes from the MCP server's shared tool metadata: name, one-line purpose and inputs. Each input shows its name and plain words (`pid` table ID); `m1`–`m9` show as one entry. The name column is 200 px, the same as the client rows.
- Example prompts show chart comparison, regional analysis and table discovery.

## Data and hand-off

- Design only with fields that exist. Check `SCHEMA.md` or the files on the SSD first.
- If a screen needs a field that does not exist, ask the data thread. Do not draw the field until it exists, or mark the screen as waiting on it here.
- When a screen changes, update this file and then build it in `api/`.
- Build IDs on examples are real IDs: Clean `v0`, Normalized `n4`, capture `baseline`, and Clean `census-full-1` for Census tables. The site reads them from `/api/v1/build`.
- `n4` is the Normalized build of `v0` only. 06 Census and the Census tables on 05 need the planned full Normalized build, which combines `wds-full-1` and `census-full-1`. In it, Census tables have `kind=snapshot`, `family=census_2021`, `queryable=true` when Clean observations exist, series keyed by coordinate, geography members mapped to `place_id`, and `...` kept as a status with a blank value.

## Open questions

1. **Stable view URLs.** Answered: a view is `/?q=<text>&s=<encodeSpec(ViewResult.spec)>`, written on every chart, not only after a builder edit (see 01). The server resolves every MemberSel to ids in `ViewResult.spec`, so a shared link opens the same chart after a planner or build change, as long as those member ids still exist in the table. Census cells use the same form with every dimension fixed. Length: base64url JSON. Measured on n8: CPI 256 characters, a two-table view 362, 44 CMAs × 3 age groups 515 URL characters, 166 geographies × 7 tenures 1,259; the ceiling is a spec at the 500-member limit, about 4,300. A compact form (raw-DEFLATE before base64url, about 1,600 characters at 500 members) is on hold: today's views fit, and it would need a versioned `decodeSpec` in `spec.ts`.
2. **Hosted MCP.** The design shows the local stdio setup. A hosted endpoint does not exist yet.
3. **Key series on a place page.** 05 uses a fixed list for provinces (see 05). Lists for Canada, CMAs, census divisions and health regions are still to be written. There is no field that ranks series for a place yet.
