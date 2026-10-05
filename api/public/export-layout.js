// One export look for the clipboard screenshot (chart.js chartPng, 1600×900 at 2×) and the server OG image
// (/og/chart.png, 1200×630). Numbers, colours and text rules live here; each renderer draws them its own way
// (canvas in the browser, SVG + resvg on the server). Plain data and pure functions: no DOM, safe to import in Node.
// Design: thr_a4rp374pwa/export-design.md and DESIGN.md "Screenshot".
import { PUBLIC_HOST, PUBLIC_ORIGIN, gapLine, subLine } from "./render.js";

/** The published site (defined in render.js, which the page and API panels also use). */
export { PUBLIC_HOST, PUBLIC_ORIGIN };

/** Same values as app.css :root and --c0..--c9 (the chart palette, in slot order). */
export const COLORS = {
  ink: "#0E0F11", muted: "#5A5F66", quiet: "#9AA0A6", rule: "#E6E7E9", grid: "#EDEEF0", lineStrong: "#C9CBCE", paper: "#FFFFFF",
  accent: "#D80621",
  palette: ["#D80621", "#0E0F11", "#2A5DB0", "#C27400", "#2E9C5A", "#CC79A7", "#3A8DC4", "#813131", "#7341D6", "#A50D72"],
};

/** Font families as both renderers name them (the OG renderer registers the Geist TTFs under these names). */
export const FONTS = { sans: "Geist", mono: "Geist Mono" };
/** Every face the export draws with: the browser loads each before rasterizing; the server registers each TTF. */
export const FACES = [{ family: FONTS.sans, weight: 400 }, { family: FONTS.sans, weight: 600 }, { family: FONTS.mono, weight: 400 }];

/**
 * The layout at its design size, 1600×900 CSS px. `y` values are text baselines (top of the canvas = 0); sizes are
 * font sizes in px. OG and any other size scale every number by width / 1600 (see scaled()).
 */
export const LAYOUT = {
  width: 1600, height: 900, pixelRatio: 2,
  margin: 64,
  title: { y: 108, size: 56, minSize: 40 }, // cap top near the 64 px margin
  subtitle: { y: 152, size: 24 },
  note: { gap: 30, size: 20 }, // method / gap lines, 30 px apart below the subtitle
  ruleGap: 26, // from the last head line's baseline to the head rule
  plot: { top: 24, bottom: 16, lineWidth: 3.5, markerRadius: 5, axisLabel: 18, axisTitle: 16, gridWidth: 1 },
  directLabel: { size: 20, gap: 12, minSpacing: 26, maxSeries: 4, maxWidth: 300 }, // names past maxWidth end in "…"
  legend: { size: 19, swatch: 14, itemGap: 28, rowHeight: 30, maxRows: 2, maxSeries: 12, top: 18 },
  footer: { size: 18, ruleGap: 28, bottom: 44 }, // rule 28 px above the footer baseline; baseline 44 px above the bottom
};

/** The layout at another width (OG: 1200). Every number scales by width / 1600; the height is given. */
export function scaled(width, height) {
  const k = width / LAYOUT.width;
  const walk = (v) => typeof v === "number" ? v * k : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, walk(x)])) : v;
  return { ...walk(LAYOUT), width, height, pixelRatio: LAYOUT.pixelRatio, scale: k };
}

/** Head text: title, the page's sub line, then the method and gap lines that explain a value. */
export function headText(view, methodLines = []) {
  const gap = gapLine(view, null);
  return { title: view.title, subtitle: subLine(view), notes: [...methodLines, ...(gap ? [gap] : [])] };
}

/**
 * Footer: "Table 18-10-0004-01" (every table, "Tables …" for several) at left and "statcan2.ca" at right. The period
 * is already in the sub line. The renderer cuts the left side with "…" when it is too long.
 */
export function footerText(view) {
  const tables = [...new Set(view.sources.map((s) => s.table_number))];
  return { left: `${tables.length > 1 ? "Tables" : "Table"} ${tables.join(", ")}`, right: PUBLIC_HOST };
}

/**
 * How the legend shows, by the number of drawn series (an unpublished series is listed but never drawn):
 * "none": a single series (the title and sub line say what it is), so the plot keeps the full width.
 * "direct": a line chart with 2–4 drawn series and nothing unpublished: labels at the line ends, no legend box.
 * "row": a legend row, wrapping to at most `legend.maxRows` lines. Over 12 entries: the top 12 by last value, "+N more".
 */
export function legendMode(view, { kind }) {
  const shown = view.series.filter((s) => !s.hidden);
  const drawn = shown.filter((s) => !s.unpublished);
  if (shown.length <= 1) return "none";
  if (kind === "line" && drawn.length && drawn.length <= LAYOUT.directLabel.maxSeries && drawn.length === shown.length) return "direct";
  return "row";
}

/** Last published value of a series, for direct labels and the "top 12 by last value" cut. */
export function lastValue(s) {
  for (let i = s.points.length - 1; i >= 0; i--) if (s.points[i][2] !== null) return { value: s.points[i][2], at: i };
  return null;
}

/**
 * Direct labels that do not overlap: start at each line end's y, then push apart to `minSpacing` (in the order they
 * sit), and keep them inside [top, bottom]. Input: [{ y, ... }]; returns the same objects with `ly` set.
 */
export function spreadLabels(items, { top, bottom, minSpacing }) {
  const out = [...items].sort((a, b) => a.y - b.y);
  for (let i = 0; i < out.length; i++) out[i].ly = Math.max(out[i].y, i ? out[i - 1].ly + minSpacing : top);
  for (let i = out.length - 1; i >= 0; i--) out[i].ly = Math.min(out[i].ly, i < out.length - 1 ? out[i + 1].ly - minSpacing : bottom);
  for (let i = 0; i < out.length; i++) out[i].ly = Math.max(out[i].ly, i ? out[i - 1].ly + minSpacing : top);
  return items;
}

/**
 * Ordered buckets read in their published order, never re-sorted by value: money and number ranges ("$5,000 to $9,999",
 * "Under $5,000", "$100,000 and over"), ages ("15 to 24 years"), percentiles and their kin ("Lowest decile", "Third
 * quintile", "90th percentile", "Top 1%"), sizes ("1 to 4 employees") and periods ("2021", "Q3 2024", "Jan 2025").
 * True when at least 70 % of the labels are such buckets, so one odd row ("Median after-tax income ($)", "Total")
 * does not flip the rule. Names (causes, industries, provinces, products) are false.
 */
const NUM = String.raw`\$?\d[\d,]*(?:\.\d+)?\s*%?`;
const ORDINAL_WORD = String.raw`(?:lowest|highest|bottom|top|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))`;
const BUCKET = [
  new RegExp(String.raw`^(?:from\s+)?${NUM}\s*(?:to|-|–|—|and under|under)\s*${NUM}`, "i"), // "$5,000 to $9,999", "15 to 24 years", "1-4 employees"
  new RegExp(String.raw`^(?:under|less than|below|up to|fewer than|more than|over)\s+${NUM}`, "i"), // "Under $5,000", "Less than 20 hours"
  new RegExp(String.raw`^${NUM}\s*(?:[a-z ]{0,20}\s)?(?:and|or)\s+(?:over|more|older|above|up|higher)\b`, "i"), // "$100,000 and over", "65 years and over"
  new RegExp(String.raw`^${NUM}\s*\+`, "i"), // "65+"
  new RegExp(String.raw`\b${ORDINAL_WORD}?\s*(?:percentile|decile|quintile|quartile|tercile)\b`, "i"), // "Lowest decile", "90th percentile"
  /^(?:top|bottom)\s+\d+(?:\.\d+)?\s*%/i, // "Top 1%"
  /^(?:\d{4}(?:[-/]\d{2,4})?|(?:q[1-4]|[1-4]q)\s*\d{4}|\d{4}\s*q[1-4]|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4})$/i, // periods
];
export function isOrdinal(labels) {
  const list = (labels ?? []).map((l) => String(l ?? "").trim()).filter(Boolean);
  if (list.length < 2) return false;
  const hits = list.filter((l) => BUCKET.some((re) => re.test(l))).length;
  return hits / list.length >= 0.7;
}
