// Highcharts options from a ViewResult. Colours are palette slots read from the CSS variables --c0..--c9 (DESIGN.md).
import { COLORS, FACES, LAYOUT, footerText, headText, isOrdinal, lastValue, legendMode, spreadLabels } from "./export-layout.js";
import { METHOD_WORD, axisTitle, esc, fmtNum, gapMeaning, grainOf, isUnpublished, isHorizontal as baseHorizontal, marksOf, methodLines, ownPoints, periodLabel, seriesName, seriesShades } from "./render.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => Array.from({ length: 10 }, (_, i) => css(`--c${i}`) || "#0e0f11");
const ms = (d) => Date.parse(`${d}T00:00:00Z`);

const TYPES = {
  line: { type: "line" }, area: { type: "area" }, stacked_area: { type: "area", stacking: "normal" },
  bar: { type: "column" }, stacked_bar: { type: "column", stacking: "normal" }, stacked_bar_100: { type: "column", stacking: "percent" },
};

/** At this many x categories the plot grows one row per category (it scrolls inside the stage). */
export const MANY_CATEGORIES = 20;
/** Ordered buckets (income brackets, ages, deciles) stay columns up to this many categories, like a histogram. */
const ORDINAL_COLUMNS = 24;
const ordinalCats = (view) => view.x.kind === "category" && isOrdinal(view.categories ?? []);
/**
 * Bar orientation. The spec's `horizontal` wins. Otherwise ordered buckets read as columns (a histogram) up to 24 of
 * them, then as horizontal bars in member order; names keep render.js's rule (more than six, or long labels).
 * builder.js reads it from here, so the builder's Horizontal box shows the same thing the chart draws.
 */
export const isHorizontal = (view) => view.spec.chart.horizontal ?? (ordinalCats(view) ? (view.categories?.length ?? 0) > ORDINAL_COLUMNS : baseHorizontal(view));
/** A bucket label for a column: "(including loss)" style notes drop; a range breaks before its upper bound. */
const bracketLabel = (label) => esc(String(label).replace(/\s*\([^)]*\)\s*$/, "").trim()).replace(/\s+(to|-|–)\s+/, " $1<br>");

/**
 * Horizontal category bars read best largest first: when the spec does not choose an order (`chart.sort`), the
 * categories are put in descending order of the first drawn series' value (missing values last). Categories, every
 * series' points and the group arrays move together; the view itself (Table, Download) is not touched.
 */
function sortedForBars(view) {
  if (view.x.kind !== "category" || view.spec.chart.sort || !(view.categories?.length > 1)) return view;
  const lead = view.series.find((s) => !s.hidden && !isUnpublished(s));
  if (!lead) return view;
  const val = (i) => lead.points[i]?.[2] ?? -Infinity;
  const order = view.categories.map((_, i) => i).sort((a, b) => val(b) - val(a) || a - b);
  const pick = (arr) => arr && order.map((i) => arr[i]);
  return { ...view, categories: pick(view.categories), category_groups: pick(view.category_groups), category_methods: pick(view.category_methods),
    series: view.series.map((s) => ({ ...s, points: pick(s.points) })) };
}

export function chartOptions(inView) {
  // Names read largest first; ordered buckets keep the spec's member order (never re-sorted by value, never cut).
  const sortable = (TYPES[inView.spec.chart.type] ?? TYPES.line).type === "column" && isHorizontal(inView) && !/stacked/.test(inView.spec.chart.type) && !ordinalCats(inView);
  const view = sortable ? sortedForBars(inView) : inView;
  const ordinal = ordinalCats(view);
  const colors = palette();
  const kind = TYPES[view.spec.chart.type] ?? TYPES.line;
  const horizontal = kind.type === "column" && isHorizontal(view);
  const type = horizontal ? "bar" : kind.type;
  // Pixel height when each category gets its own row (MANY_CATEGORIES or more); 0 = fit the stage.
  const n = view.x.kind === "category" ? view.categories?.length ?? 0 : 0;
  const shownSeries = view.series.filter((s) => !s.hidden).length || 1;
  const rowPx = /stacked/.test(view.spec.chart.type) ? 22 : Math.max(22, 10 * shownSeries + 10);
  const rows = n >= MANY_CATEGORIES ? n * rowPx + 80 : 0;
  const isTime = view.x.kind === "time";
  const firstPlotted = (view.spec.transform === "pct_change_yoy" || view.spec.transform === "pct_change_period")
    ? view.period.from : null;
  const clipLeadingGap = isTime && firstPlotted && view.series.some((s) => s.points.some((p) => p[1] < firstPlotted));
  const grain = grainOf(view);
  const marks = marksOf(view);
  const mono = { fontFamily: css("--mono"), fontSize: "11px", color: css("--quiet") };
  const most = Math.max(0, ...view.series.map((s) => s.points.length));

  // A group that could not be combined is one hue family (shades of one slot), kept together in the legend.
  const shades = seriesShades(view);
  // Lighter shade = the palette hex mixed with white, as a hex (Highcharts derives hover and area fills from it).
  const mix = (sh) => {
    const hex = colors[sh.slot];
    if (sh.pct >= 100 || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const f = sh.pct / 100;
    return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f + 255 * (1 - f)).toString(16).padStart(2, "0")).join("")}`;
  };
  // Gaps: a null point stays in the data, so the line breaks there (connectNulls: false) and hovering it names the gap.
  // A published point between two gaps (or a gap and the series' end) would be invisible as a line, so it gets a marker.
  // An unpublished series (no published point in the window) draws nothing; it stays in the legend, muted, untoggleable.
  const isLine = kind.type !== "column";
  const quiet = css("--quiet"), faint = css("--line-strong");
  const series = view.series.map((s, i) => {
    const none = isUnpublished(s);
    const pts = ownPoints(s, isTime);
    const data = pts.map((p, j) => {
      const lone = isLine && p[2] !== null && pts[j - 1]?.[2] == null && pts[j + 1]?.[2] == null;
      return { x: isTime ? ms(p[1]) : j, y: p[2], ref: p[0], mark: p[3],
        meaning: p[2] === null ? gapMeaning(s, p, marks) : p[3] ? marks[s.pid]?.[p[3]] ?? "" : "",
        ...(lone ? { marker: { enabled: true } } : {}) };
    });
    return {
      // Unpublished entries go after the drawn series, so a paged legend (phones) starts with what is on the plot.
      name: seriesName(s), id: s.key, yAxis: Math.min(s.axis, view.axes.length - 1), visible: !s.hidden, legendIndex: shades[i].rank + (none ? view.series.length : 0),
      color: none ? faint : mix(shades[i]), data, custom: { unit: s.unit, method: s.group_method, unpublished: none },
      // No line, no hover: the legend entry and the gap note say it is not published; a "–" row on every tooltip is noise.
      ...(none ? { className: "is-unpublished", enableMouseTracking: false } : {}),
    };
  });

  // x categories from a group that was not combined: a faint band behind each run of its members, named at the top.
  const cg = view.x.kind === "category" ? view.category_groups ?? [] : [], cm = view.category_methods ?? [];
  const bands = [];
  cg.forEach((g, i) => {
    if (!g || cm[i]) return;
    const last = bands.at(-1);
    if (last && last.group === g && last.to === i - 0.5) last.to = i + 0.5;
    else bands.push({ group: g, from: i - 0.5, to: i + 0.5 });
  });

  // Value-axis ticks in compact form from 10,000 up (250K, 1.25M, 2M), so the widest tick never runs past its slot and
  // gets cut to "2,000…". Below that the plain number is short enough. Tooltips and the table keep full values.
  const compact = new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 2 });
  const axisNum = (v) => Math.abs(v) >= 10_000 ? compact.format(v) : fmtNum(v);

  const yAxis = view.axes.map((a, i) => ({
    title: { text: view.axes.length > 1 || view.spec.chart.type === "stacked_bar_100" ? (view.spec.chart.type === "stacked_bar_100" ? "%" : axisTitle(a)) : null, style: mono },
    opposite: i === 0, gridLineColor: i === 0 ? css("--grid") : "transparent", lineWidth: 0,
    labels: { style: mono, autoRotation: horizontal ? false : undefined, formatter() { return view.spec.chart.type === "stacked_bar_100" ? `${this.value}%` : axisNum(this.value); } },
    ...(horizontal ? { tickPixelInterval: 140 } : {}),
    reversedStacks: false,
  }));

  // Tooltip as a small HTML table. Styles are inline, not in app.css: Highcharts measures the box from the HTML it is
  // given, so CSS that lands later leaves extra space inside the border. Mono period; values right-aligned, tabular.
  const ttFont = css("--sans"), ttMono = css("--mono"), ttMuted = css("--muted");
  // A combined group names its method after the value (published / sum / ratio), in the same mono as status marks.
  // A gap row: "–" in place of the value, then what the gap is ("Not published", or the mark and its meaning).
  const point = (p) => {
    const method = p.series.options.custom?.method;
    const gap = p.y === null;
    const tail = gap ? [p.point.mark || "", p.point.meaning || "Not published"].filter(Boolean).join(" ")
      : [p.point.mark ? `${p.point.mark}${p.point.meaning ? ` ${p.point.meaning}` : ""}` : "", method ? METHOD_WORD[method] : ""].filter(Boolean).join(" · ");
    return `<tr${gap ? ` style="color:${ttMuted}"` : ""}><td style="padding:2px 16px 2px 0"><span style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${gap ? "transparent" : p.color};box-shadow:inset 0 0 0 1px ${p.color}"></span>${esc(p.series.name)}</td>`
      + `<td class="tt-val" style="padding:2px 0;text-align:right;font-weight:${gap ? 400 : 600};font-variant-numeric:tabular-nums">${gap ? "–" : fmtNum(p.y)}</td>`
      + (tail ? `<td style="padding:2px 0 2px 8px;font-family:${ttMono};color:${ttMuted}">${esc(tail)}</td>` : "") + "</tr>";
  };
  const bandColor = css("--band") || "#f4f5f6";
  const plotBands = bands.map((b) => ({ from: b.from, to: b.to, color: bandColor,
    label: { text: esc(b.group), useHTML: false, style: { ...mono, color: css("--muted") }, ...(horizontal ? { align: "right", verticalAlign: "top", textAlign: "right", x: -6, y: 14 } : { align: "center", verticalAlign: "top", y: 14 }) } }));

  return {
    // Horizontal bars: 56 px on the right so the longest bar's value label is never cut.
    chart: { type, backgroundColor: "transparent", spacing: [12, horizontal ? 56 : 8, 8, 0], animation: false, ...(isTime ? { zooming: { type: "x" } } : {}),
      events: { render: drawMissingBars },
      // Many horizontal bars: one row per category; the plot scrolls inside the chart while the value axis stays put.
      // The mask over the fixed axis band takes chart.backgroundColor, so it must be opaque (white) here.
      ...(horizontal && rows ? { scrollablePlotArea: { minHeight: rows, opacity: 1 }, backgroundColor: "#fff" } : {}),
      style: { fontFamily: css("--sans") } },
    accessibility: { enabled: false },
    title: { text: "" }, subtitle: { text: "" }, credits: { enabled: false }, exporting: { enabled: false },
    colors,
    xAxis: isTime
      ? { type: "datetime", ...(clipLeadingGap ? { min: ms(firstPlotted), minPadding: 0, startOnTick: false } : {}),
        crosshair: { color: css("--line-strong") }, lineColor: css("--line-strong"), tickColor: css("--line-strong"), labels: { style: mono } }
      : { categories: view.categories ?? [], lineColor: css("--line-strong"), tickLength: 0, plotBands,
        // Horizontal: one line per label, cut at 240 px; the tooltip names the full category.
        // Vertical, under MANY_CATEGORIES: wrap into the slot (up to 3 lines), no rotation.
        // Vertical forced by the user on MANY_CATEGORIES or more: slots are too narrow to wrap, so labels stand at 90°.
        // Ordered-bucket columns (histogram): never rotated; a range breaks before its upper bound ("$15,000 to" /
        // "$19,999") and a parenthetical drops ("Under $5,000"), so both bounds of every bracket read in 2 lines.
        labels: { style: { ...mono, color: css("--muted"), fontSize: "12px", textOverflow: "ellipsis", ...(horizontal ? { width: "240px", whiteSpace: "nowrap" } : { lineClamp: ordinal ? 2 : 3 }) },
          autoRotation: !horizontal && !ordinal && n >= MANY_CATEGORIES ? [-90] : false, step: 1,
          ...(ordinal && !horizontal ? { formatter() { return bracketLabel(this.value); } } : {}) } },
    yAxis,
    legend: { enabled: view.series.length > 1, align: "left", verticalAlign: horizontal ? "top" : "bottom", itemStyle: { color: css("--ink"), fontWeight: "400", fontSize: "13px", textOverflow: undefined },
      itemHiddenStyle: { color: css("--quiet") }, symbolRadius: 0, itemDistance: 20, maxHeight: 96, navigation: { style: mono },
      labelFormatter() {
        return this.options.custom?.unpublished
          ? `<span style="color:${quiet}">${esc(this.name)}</span> <span style="color:${quiet};font-family:${css("--mono")};font-size:11px">not published</span>`
          : esc(this.name);
      } },
    tooltip: {
      // HTML (not SVG text) so values can right-align in a column. The 9 px padding is the only inset; the table
      // inside has none, so the space inside the border is even.
      useHTML: true, shared: true, outside: true, borderColor: css("--ink"), borderRadius: 0, shadow: false, backgroundColor: "#fff", padding: 9,
      style: { fontSize: "12px", color: css("--ink") },
      formatter() {
        const pts = this.points ?? [this];
        const first = pts[0].point;
        const cat = view.categories?.[first.x] ?? first.category ?? "";
        // A category from a group: name the group (and its method when combined) after the category.
        const g = isTime ? null : view.category_groups?.[first.x], m = isTime ? null : view.category_methods?.[first.x];
        const head = isTime ? periodLabel(first.ref, new Date(first.x).toISOString().slice(0, 10), grain)
          : [cat, g && g !== cat ? g : "", m ? METHOD_WORD[m] : ""].filter(Boolean).join(" · ");
        return `<table class="tt" style="border-collapse:collapse;margin:0;font:12px/16px ${ttFont};white-space:nowrap"><tr><th colspan="3" class="tt-head" style="padding:0 0 4px;text-align:left;font:11px/16px ${ttMono};color:${ttMuted}">${esc(head)}</th></tr>${pts.map(point).join("")}</table>`;
      },
    },
    plotOptions: {
      // nullInteraction: a gap period is hoverable, so the shared tooltip can say what is missing there.
      series: { animation: false, connectNulls: false, nullInteraction: true, turboThreshold: 0, marker: { enabled: isTime && most < 40, radius: 3, symbol: "circle" },
        states: { inactive: { opacity: 0.35 } }, events: { legendItemClick: undefined } },
      line: { lineWidth: 2 }, area: { lineWidth: 1.5, fillOpacity: 0.18, stacking: kind.stacking },
      column: { stacking: kind.stacking, borderWidth: 0, borderRadius: 0, groupPadding: 0.12, pointPadding: 0.04 },
      // Horizontal bars carry their value at the bar's end (mono 11, muted), so a long list reads without the axis.
      bar: { stacking: kind.stacking, borderWidth: 0, borderRadius: 0, groupPadding: 0.12, pointPadding: 0.04,
        dataLabels: { enabled: !kind.stacking, crop: false, overflow: "allow", padding: 4, style: { ...mono, color: css("--muted"), fontWeight: "400", textOutline: "none" },
          formatter() { return this.y === null ? "" : view.spec.chart.type === "stacked_bar_100" ? `${fmtNum(this.y)}%` : axisNum(this.y); } } },
    },
    series,
  };
}

/**
 * Bars with no value: a short "–" on the baseline, in the muted colour, where the bar would stand. Grouped bars get one
 * per missing bar; stacked bars one per category whose every visible segment is missing. Drawn on each render (so
 * legend toggles and the off-screen PNG redraw get them too) from the bar's slot in its series group, mapped to the
 * SVG root, so vertical and horizontal bars both work.
 */
function drawMissingBars() {
  const c = this;
  c.gapDashes?.destroy();
  c.gapDashes = undefined;
  const cols = c.series.filter((s) => s.visible && (s.type === "column" || s.type === "bar") && s.group);
  if (!cols.length) return;
  const g = c.gapDashes = c.renderer.g("gap-dashes").attr({ zIndex: 4 }).add();
  const color = css("--quiet");
  const dash = (s, p) => {
    const sh = p.shapeArgs, m = s.group.element.getCTM();
    if (!sh || !m) return;
    const base = s.translatedThreshold ?? s.yAxis.translate(0, 0, 1, 0, 1);
    const pt = new DOMPoint(sh.x + sh.width / 2, base).matrixTransform(m);
    const half = Math.min(5, Math.max(2, sh.width * 0.3));
    // Along the bar's own direction, from the baseline: horizontal on vertical bars (sitting just on the axis line),
    // horizontal from the baseline out on horizontal bars.
    const d = c.inverted ? ["M", pt.x + 1, pt.y, "L", pt.x + 1 + 2 * half, pt.y] : ["M", pt.x - half, pt.y - 2, "L", pt.x + half, pt.y - 2];
    c.renderer.path(d).attr({ stroke: color, "stroke-width": 1.5, "stroke-linecap": "butt" }).add(g);
  };
  if (cols[0].options.stacking) {
    const n = Math.max(...cols.map((s) => s.points.length));
    for (let i = 0; i < n; i++) if (cols.every((s) => s.points[i]?.y == null) && cols[0].points[i]) dash(cols[0], cols[0].points[i]);
  } else for (const s of cols) for (const p of s.points) if (p.y == null) dash(s, p);
}

let chart;
/** Draw (or redraw) into el. Returns the Highcharts chart, or undefined if the library did not load. */
export function drawChart(el, view, label) {
  if (!window.Highcharts) { el.innerHTML = `<p class="blank-msg small">The chart library did not load. The values are in Table.</p>`; return; }
  chart?.destroy();
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  chart = window.Highcharts.chart(el, chartOptions(view));
  return chart;
}
export function clearChart() { chart?.destroy(); chart = undefined; }

let fontCss;
/**
 * @font-face rules for the page's Geist / Geist Mono faces (latin subset), each woff2 inlined as a data URL. The
 * page imports them from Google Fonts; that sheet is cross-origin, so its text is fetched (CORS allows it, and the
 * files come from the HTTP cache) rather than read from cssRules. Built once per page; on failure the PNG still
 * renders with fallback fonts.
 */
async function embeddedFonts() {
  if (fontCss !== undefined) return fontCss;
  const hrefs = [...document.querySelectorAll("style")].flatMap((s) => [...s.textContent.matchAll(/@import url\(['"]?([^'")]+fonts\.googleapis\.com[^'")]+)['"]?\)/g)].map((m) => m[1]));
  try {
    const text = (await Promise.all(hrefs.map(async (h) => (await fetch(h)).text()))).join("\n");
    const faces = [...text.matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    const out = await Promise.all(faces.map(async (body) => {
      const src = body.match(/url\(([^)]+)\)/)?.[1];
      const family = body.match(/font-family:\s*([^;]+);/)?.[1], weight = body.match(/font-weight:\s*(\d+)/)?.[1] ?? "400";
      if (!src || !family) return "";
      const blob = await (await fetch(src)).blob();
      const data = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(blob); });
      return `@font-face{font-family:${family};font-weight:${weight};font-style:normal;src:url(${data}) format("woff2")}`;
    }));
    fontCss = out.join("");
  } catch { fontCss = ""; }
  return fontCss;
}
/** Wait until every face the export draws with is loaded for the text it draws (Google Fonts splits Geist into unicode-range subsets). */
async function ensureFonts(text) {
  if (!document.fonts) return;
  await document.fonts.ready;
  const sample = [...new Set(text)].join("");
  await Promise.all(FACES.map((f) => document.fonts.load(`${f.weight} 20px "${f.family}"`, sample).catch(() => [])));
}

/**
 * PNG of the chart for sharing: a fixed 1600×900 canvas at 2× (3200×1800), the same at any window size and builder
 * state, laid out by export-layout.js (the OG image uses the same numbers). Top to bottom: eyebrow, title, sub line,
 * method / gap lines, a rule, the plot (Highcharts, redrawn off screen at export sizes), direct labels or a legend
 * row, a rule, and the footer. Drawn in the browser (SVG → canvas); no exporting module, no export server.
 * Series the user hid on screen this session stay out of the image.
 */
export async function chartPng(view) {
  if (!window.Highcharts) throw new Error("No chart to capture.");
  const L = LAYOUT, W = L.width, H = L.height, M = L.margin, inner = W - 2 * M;
  const sans = css("--sans"), mono = css("--mono"), C = COLORS;
  const opts = chartOptions(view);
  opts.series.forEach((s, i) => { s.visible = chart?.series[i]?.visible ?? s.visible; });
  const kind = (TYPES[view.spec.chart.type] ?? TYPES.line).type === "column" ? "bar" : "line";
  const shown = { ...view, series: view.series.map((s, i) => ({ ...s, hidden: !opts.series[i].visible, unpublished: isUnpublished(s) })) };
  const mode = legendMode(shown, { kind });
  const head = headText(view, methodLines(view)), foot = footerText(view);
  const entries = opts.series.map((s, i) => ({ s, v: shown.series[i] })).filter((e) => e.s.visible).sort((a, b) => a.s.legendIndex - b.s.legendIndex);
  await ensureFonts([head.eyebrow, head.title, head.subtitle, ...head.notes, foot.left, foot.right, ...entries.map((e) => `${e.s.name} ${fmtNum(lastValue(e.v)?.value)}`), "+0123456789 more not published"].join(""));

  const canvas = document.createElement("canvas");
  canvas.width = W * L.pixelRatio; canvas.height = H * L.pixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(L.pixelRatio, L.pixelRatio);
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";
  const font = (weight, size, family) => `${weight} ${size}px ${family}`;
  const width = (text, f) => { ctx.font = f; return ctx.measureText(text).width; };
  const fit = (text, f, max) => {
    if (width(text, f) <= max) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (width(`${text.slice(0, mid).trimEnd()}…`, f) <= max) lo = mid; else hi = mid - 1; }
    return `${text.slice(0, lo).trimEnd()}…`;
  };
  const text = (t, x, y, f, color, align = "left") => { ctx.font = f; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(t, x, y); };
  const rule = (y) => { ctx.fillStyle = C.rule; ctx.fillRect(M, Math.round(y), inner, 1); };

  // Head. The title shrinks 2 px at a time from 56 to 40 px to stay on one line, then ends in "…".
  ctx.letterSpacing = `${L.eyebrow.letterSpacing}px`;
  text(head.eyebrow, M, L.eyebrow.y, font(400, L.eyebrow.size, mono), C.accent);
  ctx.letterSpacing = "0px";
  let titleSize = L.title.size;
  while (titleSize > L.title.minSize && width(head.title, font(600, titleSize, sans)) > inner) titleSize -= 2;
  text(fit(head.title, font(600, titleSize, sans), inner), M, L.title.y, font(600, titleSize, sans), C.ink);
  let y = L.subtitle.y;
  if (head.subtitle) text(fit(head.subtitle, font(400, L.subtitle.size, sans), inner), M, y, font(400, L.subtitle.size, sans), C.muted);
  for (const n of head.notes.slice(0, 2)) { y += L.note.gap; text(fit(n, font(400, L.note.size, mono), inner), M, y, font(400, L.note.size, mono), C.muted); }
  const headRule = y + L.ruleGap;
  rule(headRule);

  // Footer: rule, then the source at left and the site · period at right.
  const footY = H - L.footer.bottom, footRule = footY - L.footer.ruleGap;
  const footFont = font(400, L.footer.size, mono);
  const rightW = width(foot.right, footFont);
  rule(footRule);
  text(fit(foot.left, footFont, inner - rightW - 40), M, footY, footFont, C.muted);
  text(foot.right, W - M, footY, footFont, C.muted, "right");

  // Legend row (5+ series, bars, or any unpublished entry): swatch + name, wrapping to two rows. Over 12 drawn series,
  // the top 12 by last value; whatever does not fit in two rows becomes "+N more".
  const lg = L.legend, legFont = font(400, lg.size, sans), noteFont = font(400, lg.size - 4, mono);
  let rows = [];
  if (mode === "row") {
    const drawn = entries.filter((e) => !e.v.unpublished), unpub = entries.filter((e) => e.v.unpublished);
    let keep = drawn;
    if (drawn.length > lg.maxSeries) {
      const top = new Set([...drawn].sort((a, b) => (lastValue(b.v)?.value ?? -Infinity) - (lastValue(a.v)?.value ?? -Infinity)).slice(0, lg.maxSeries));
      keep = drawn.filter((e) => top.has(e));
    }
    const items = [...keep.map((e) => ({ label: e.s.name, color: e.s.color })), ...unpub.map((e) => ({ label: e.s.name, muted: true }))];
    let more = entries.length - items.length;
    const itemW = (it) => it.more ? width(it.label, noteFont) : it.muted ? width(it.label, legFont) + 8 + width("not published", noteFont) : lg.swatch + 8 + width(it.label, legFont);
    const lay = (list) => {
      const out = [[]];
      let x = 0;
      for (const it of list) {
        const w = itemW(it);
        if (x && x + w > inner) { out.push([]); x = 0; }
        out.at(-1).push({ ...it, x, w: Math.min(w, inner) });
        x += w + lg.itemGap;
      }
      return out;
    };
    for (;;) {
      const list = more ? [...items, { label: `+${more} more`, more: true }] : items;
      rows = lay(list);
      if (rows.length <= lg.maxRows || !items.length) break;
      items.pop(); more++;
    }
  }
  const legendBottom = footRule - 20, legendTop = legendBottom - rows.length * lg.rowHeight;
  const plotTop = headRule + L.plot.top, plotBottom = (rows.length ? legendTop - lg.top : footRule - 20) - L.plot.bottom;
  rows.forEach((row, r) => {
    const base = legendTop + (r + 1) * lg.rowHeight - 8;
    for (const it of row) {
      const x = M + it.x;
      if (it.more) { text(it.label, x, base, noteFont, C.quiet); continue; }
      if (it.muted) {
        const label = fit(it.label, legFont, it.w - 8 - width("not published", noteFont));
        text(label, x, base, legFont, C.quiet);
        text("not published", x + width(label, legFont) + 8, base, noteFont, C.quiet);
        continue;
      }
      ctx.fillStyle = it.color; ctx.fillRect(x, base - lg.swatch + 1, lg.swatch, lg.swatch);
      text(fit(it.label, legFont, it.w - lg.swatch - 8), x + lg.swatch + 8, base, legFont, C.ink);
    }
  });

  // Direct labels (4 or fewer lines): name and last value at each line end, in the series colour, pushed apart so
  // they never overlap. Their column is reserved on the right of the plot.
  const dl = L.directLabel, nameFont = font(400, dl.size, sans), valFont = font(600, dl.size, sans);
  const labelOf = (e) => { const lv = lastValue(e.v); return lv ? { e, name: e.s.name, value: fmtNum(lv.value) } : null; };
  const direct = mode === "direct" ? entries.map(labelOf).filter(Boolean) : [];
  const labelW = direct.length ? Math.min(380, Math.max(...direct.map((d) => width(d.name, nameFont) + 8 + width(d.value, valFont)))) : 0;
  const labelCol = direct.length ? labelW + dl.gap + 4 : 0;

  // The plot: the page's chart options at export sizes. Axis 0 on the left (the right side is the label column);
  // a second unit axis on the right, with its unit title. Markers only on isolated points.
  const mono18 = (style) => ({ ...style, fontSize: `${L.plot.axisLabel}px`, color: C.muted });
  // Time axis at 18 px: ticks at least 150 px apart, so labels never touch; one line each ("2022", "Jan 2022").
  const timeAxis = view.x.kind === "time" ? { tickPixelInterval: 150, dateTimeLabelFormats: { day: "%e %b %Y", week: "%e %b %Y", month: "%b %Y", year: "%Y" } } : {};
  // Horizontal bars at export size: labels at the left (up to 360 px, one line), values at the bar ends in mono 16.
  // The 900 px canvas fits about 20 rows; past that, names keep the top 20 by value (the sort already put them first)
  // with a "+N more" note under the plot. Ordered buckets are never cut: every bracket is drawn, in member order.
  // Ordered-bucket columns wrap their labels to 2 lines under each column instead of running into the next one.
  const hbars = opts.chart.type === "bar";
  const ordinal = view.x.kind === "category" && isOrdinal(view.categories ?? []);
  const maxRows = 20, nCats = opts.xAxis.categories?.length ?? 0, cut = hbars && !ordinal && nCats > maxRows;
  const wrapCols = !hbars && ordinal && view.x.kind === "category";
  const xAxis = { ...opts.xAxis, ...timeAxis, labels: { ...opts.xAxis.labels, style: { ...mono18(opts.xAxis.labels.style), whiteSpace: wrapCols ? "normal" : "nowrap", ...(opts.xAxis.labels.style.width ? { width: hbars ? "360px" : "300px" } : {}), ...(wrapCols ? { fontSize: "15px", lineClamp: 2, textOverflow: "ellipsis" } : {}) } },
    ...(cut ? { categories: opts.xAxis.categories.slice(0, maxRows) } : {}),
    ...(opts.xAxis.plotBands ? { plotBands: opts.xAxis.plotBands.map((b) => ({ ...b, label: { ...b.label, style: { ...b.label.style, fontSize: "16px" }, y: 20 } })) } : {}) };
  if (cut) for (const s of opts.series) s.data = s.data.slice(0, maxRows);
  const yAxis = opts.yAxis.map((a, i) => ({ ...a, opposite: i === 1, labels: { ...a.labels, style: mono18(a.labels.style) },
    title: { ...a.title, style: { ...a.title.style, fontSize: `${L.plot.axisTitle}px`, color: C.muted } } }));
  const lw = L.plot.lineWidth;
  const plotOpts = { ...opts.plotOptions,
    series: { ...opts.plotOptions.series, marker: { enabled: false, radius: L.plot.markerRadius, symbol: "circle" }, states: { hover: { enabled: false }, inactive: { enabled: false } } },
    line: { ...opts.plotOptions.line, lineWidth: lw }, area: { ...opts.plotOptions.area, lineWidth: lw },
    bar: { ...opts.plotOptions.bar, dataLabels: { ...opts.plotOptions.bar.dataLabels, style: { ...opts.plotOptions.bar.dataLabels.style, fontSize: "16px" } } } };
  const chartOpts = { ...opts.chart, width: inner, height: Math.round(plotBottom - plotTop - (cut ? 28 : 0)), backgroundColor: C.paper, spacing: [10, labelCol || (hbars ? 80 : 6), 0, 0], animation: false };
  delete chartOpts.scrollablePlotArea;
  delete chartOpts.zooming;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${chartOpts.width}px;height:${chartOpts.height}px`;
  document.body.append(host);
  let svg, ends = [];
  try {
    const copy = window.Highcharts.chart(host, { ...opts, chart: chartOpts, xAxis, yAxis, plotOptions: plotOpts, legend: { enabled: false }, tooltip: { enabled: false } });
    // Where each labelled line ends (its last published point), in canvas coordinates.
    ends = direct.map((d) => {
      const s = copy.series.find((x) => x.options.id === d.e.s.id);
      const p = s && [...s.points].reverse().find((q) => q.y !== null && q.plotY != null);
      return p ? { ...d, color: s.color, y: plotTop + copy.plotTop + p.plotY } : null;
    }).filter(Boolean);
    svg = copy.container.querySelector("svg").cloneNode(true);
    copy.destroy();
  } finally { host.remove(); }
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(chartOpts.width));
  svg.setAttribute("height", String(chartOpts.height));
  // An SVG drawn through <img> cannot fetch fonts, so it would fall back to a wider face. Embed the Geist / Geist Mono
  // faces the page already loaded (same URLs as the stylesheet, so they come from the HTTP cache).
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `${await embeddedFonts()}text{font-family:${sans}}.highcharts-axis-labels text{font-family:${mono}}`;
  svg.insertBefore(style, svg.firstChild);
  const img = new Image();
  const blobUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  try { img.src = blobUrl; await img.decode(); } finally { URL.revokeObjectURL(blobUrl); }
  ctx.drawImage(img, M, plotTop, chartOpts.width, chartOpts.height);
  if (cut) text(`+${nCats - maxRows} more (smaller values)`, M, plotTop + chartOpts.height + 20, font(400, 16, mono), C.quiet);

  spreadLabels(ends, { top: plotTop + 14, bottom: plotBottom - 4, minSpacing: dl.minSpacing });
  const labelX = M + inner - labelCol + dl.gap;
  for (const d of ends) {
    const base = d.ly + 7;
    const name = fit(d.name, nameFont, labelW - 8 - width(d.value, valFont));
    text(name, labelX, base, nameFont, d.color);
    text(d.value, labelX + width(name, nameFont) + 8, base, valFont, d.color);
  }
  return await new Promise((ok, no) => canvas.toBlob((b) => b ? ok(b) : no(new Error("PNG encoding failed")), "image/png"));
}
