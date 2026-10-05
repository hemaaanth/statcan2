// HTML for the app screen. Pure string functions: pages.ts renders the first paint with them, app.js re-renders with them.
// Every value from the API goes through esc() or sanitizeNote(); nothing else reaches innerHTML.

/** The published site. Image footers, eyebrows, share links and copyable API text name it, never the request host. */
export const PUBLIC_HOST = "statcan2.ca";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

export const TRANSFORMS = [["level", "Level"], ["pct_change_yoy", "% change, year over year"], ["pct_change_period", "% change, period"],
  ["pct_change_window", "% change over window"], ["index_first", "Index = 100 at"], ["share_of_x", "Share of x"]];

const CHART_LABEL = { line: "line chart", area: "area chart", bar: "bar chart", stacked_bar: "stacked bar chart",
  stacked_bar_100: "100% stacked bar chart", stacked_area: "stacked area chart" };
/** Same tables as the current view → a different reading of it, named by its chart type ("as area chart"); else the planner's label (a table title). */
function altLabel(alt, spec) {
  const pids = (s) => s.layers.map((l) => l.pid).join(",");
  if (pids(alt.spec) !== pids(spec)) return alt.label;
  return alt.spec.chart?.type && alt.spec.chart.type !== spec.chart.type ? `as ${CHART_LABEL[alt.spec.chart.type]}` : alt.label;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** base64url(JSON), same bytes as spec.ts encodeSpec. */
export function encodeSpec(spec) {
  let bin = "";
  for (const b of new TextEncoder().encode(JSON.stringify(spec))) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeSpec(s) {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
export const specHref = (q, spec) => `/?${q ? `q=${encodeURIComponent(q)}&` : ""}s=${encodeSpec(portableSpec(spec))}`;

/**
 * The resolved spec writes an empty selection as `{in: []}` (every member moved into groups, or a group with no member
 * in the cube), which the spec schema refuses. `{not: {all: true}}` is the same empty set and decodes; links use it.
 */
export function portableSpec(spec) {
  if (!JSON.stringify(spec).includes('"in":[]')) return spec;
  return JSON.parse(JSON.stringify(spec), (k, v) => v && typeof v === "object" && Array.isArray(v.in) && !v.in.length && Object.keys(v).length === 1 ? { not: { all: true } } : v);
}

// ---------------------------------------------------------------- groups

export const METHOD_WORD = { published: "published", sum: "sum", ratio: "ratio", not_combined: "not combined" };

/**
 * Colour and legend order per series. Members of a group that could not be combined (`group` set, no `group_method`)
 * are one family: the palette slot of the family's first member, each next member lighter (100 % → 45 % of the hue,
 * mixed with white), and kept together in the legend. Ink (slot 1) has no hue to shade (its shades read as the greys
 * of a hidden series), so a family on slot 1 takes the first hued slot that no other series or family uses. Every
 * other series, a combined group included, keeps its own slot at full strength.
 */
export function seriesShades(view) {
  const fams = new Map();
  view.series.forEach((s, i) => {
    if (!s.group || s.group_method) return;
    const k = `${s.layer}\u0000${s.group}`;
    fams.has(k) ? fams.get(k).push(i) : fams.set(k, [i]);
  });
  const out = view.series.map((s) => ({ slot: s.color % 10, pct: 100, rank: 0 }));
  const famOf = new Map();
  for (const idx of fams.values()) for (const i of idx) famOf.set(i, idx);
  const taken = new Set(view.series.filter((_, i) => !famOf.has(i)).map((s) => s.color % 10));
  for (const idx of fams.values()) taken.add(view.series[idx[0]].color % 10);
  for (const idx of fams.values()) {
    let slot = view.series[idx[0]].color % 10;
    if (slot === 1) { slot = [0, 2, 3, 4, 5, 6, 7, 8, 9].find((c) => !taken.has(c)) ?? 2; taken.add(slot); }
    idx.forEach((i, j) => { out[i] = { slot, pct: idx.length > 1 ? Math.round(100 - j * 55 / (idx.length - 1)) : 100, rank: 0 }; });
  }
  let rank = 0;
  const placed = new Set();
  view.series.forEach((_, i) => { if (!placed.has(i)) for (const j of famOf.get(i) ?? [i]) { placed.add(j); out[j].rank = rank++; } });
  return out;
}
/** Swatch markup for a shade: the palette class, plus a white mix for lighter family members. */
export const swatch = (sh) => `<span class="sw c${sh.slot}"${sh.pct < 100 ? ` style="background:color-mix(in srgb,var(--c${sh.slot}) ${sh.pct}%,#fff)"` : ""}></span>`;
/** Display name: a member of a group that was not combined carries its group ("Prairies · Manitoba"). */
export const seriesName = (s) => s.group && !s.group_method && !s.name.includes(s.group) ? `${s.group} · ${s.name}` : s.name;

/** Use the same category orientation in the interactive chart and its OG card. */
export const isHorizontal = (view) => view.spec.chart.horizontal ?? (view.x.kind === "category"
  && ((view.categories?.length ?? 0) > 6 || (view.categories ?? []).some((c) => String(c).length > 24)));

/**
 * A mixed-frequency time axis contains nulls for periods a slower series never publishes.
 * Drop only those nulls; a missing point on the series' own cadence still breaks the line.
 */
export function ownPoints(series, isTime) {
  if (!isTime) return series.points;
  const pub = series.points.filter((p) => p[2] !== null);
  const ms = (p) => Date.parse(`${p[1]}T00:00:00Z`);
  const t = pub.map(ms);
  let days = Infinity;
  for (let i = 1; i < t.length; i++) days = Math.min(days, t[i] - t[i - 1]);
  if (!Number.isFinite(days) || days < 20 * 86_400_000) return series.points;
  const monthOf = (p) => { const d = new Date(ms(p)); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const mo = pub.map(monthOf);
  let step = Infinity;
  for (let i = 1; i < mo.length; i++) if (mo[i] > mo[i - 1]) step = Math.min(step, mo[i] - mo[i - 1]);
  if (!Number.isFinite(step) || step <= 1) return series.points;
  const anchor = mo[0];
  return series.points.filter((p) => p[2] !== null || (((monthOf(p) - anchor) % step) + step) % step === 0);
}

/**
 * One line per method that a reader cannot guess from the chart: a recomputed ratio or a published aggregate standing
 * in for the group ("Prairies, Atlantic: recomputed as Unemployment ÷ Labour force × 100"). Sums read as sums, and a
 * group that was not combined already has its warning.
 */
export function methodLines(view) {
  const by = new Map();
  for (const g of view.group_notes ?? []) {
    if (g.method !== "ratio" && g.method !== "published") continue;
    const text = g.method === "ratio" ? `recomputed as ${g.formula ?? "a ratio of its parts"}` : g.formula ?? "published aggregate";
    by.set(text, [...(by.get(text) ?? []), g.label]);
  }
  return [...by].map(([text, labels]) => `${labels.join(", ")}: ${text}`);
}

// ---------------------------------------------------------------- gaps

/** No published point in the window: `unpublished` from the view engine, else derived from the points. */
export const isUnpublished = (s) => s.unpublished ?? (s.points.length > 0 && s.points.every((p) => p[2] === null));
/**
 * What a null point is, for the tooltip and the Table: the meaning of the `gaps` run that holds it, else the meaning of
 * the source mark, else "Not published". Nulls before or after the published run (coverage) carry no run, so they read
 * by their mark, as does a series that is not published at all.
 */
export function gapMeaning(s, p, marks) {
  const run = s.gaps?.find((g) => g.from <= p[0] && p[0] <= g.to);
  return run?.meaning || (p[3] && marks[s.pid]?.[p[3]]) || "Not published";
}

// ---------------------------------------------------------------- notes

const NOTE_TAGS = new Set(["a", "b", "i", "em", "strong", "br", "p", "ul", "ol", "li", "sup", "sub"]);
/** Published note HTML → only NOTE_TAGS, no attributes except a safe href; text escaped; tags balanced. */
export function sanitizeNote(input) {
  const src = String(input ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|iframe|object|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\s*\(opens new window\)/gi, ""); // StatCan's screen-reader hint; links here say target=_blank already
  // Keep entities that are already well formed; escape everything else.
  const text = (s) => s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const open = [];
  let out = "", last = 0;
  for (const m of src.matchAll(/<(\/?)([a-z][a-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    out += text(src.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[2].toLowerCase();
    if (!NOTE_TAGS.has(tag)) continue;
    if (tag === "br") { out += "<br>"; continue; }
    if (m[1]) {
      const at = open.lastIndexOf(tag);
      if (at < 0) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    if (tag === "a") {
      const href = (m[3].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) ?? []).slice(1).find((v) => v !== undefined) ?? "";
      out += /^(https?:|mailto:)/i.test(href.trim()) ? `<a href="${esc(href.trim())}" target="_blank" rel="noopener noreferrer">` : "<a>";
    } else out += `<${tag}>`;
    open.push(tag);
  }
  out += text(src.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

// ---------------------------------------------------------------- numbers and periods

const NUM = [0, 1, 2, 3].map((d) => new Intl.NumberFormat("en-CA", { maximumFractionDigits: d }));
export function fmtNum(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return NUM[a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3].format(v);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;
const ms = (d) => Date.parse(`${d}T00:00:00Z`);

/** Finest spacing between period starts in the view: day, week, month, quarter, half, year. */
export function grainOf(view) {
  if (view.x.kind !== "time") return "category";
  const starts = [...new Set(view.series.flatMap((s) => s.points.map((p) => p[1])))].sort();
  let gap = Infinity;
  for (let i = 1; i < starts.length; i++) gap = Math.min(gap, (ms(starts[i]) - ms(starts[i - 1])) / DAY);
  if (gap === Infinity) {
    const ref = view.series.find((s) => s.points.length)?.points[0]?.[0] ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(ref) ? "day" : /^\d{4}-\d{2}$/.test(ref) ? "month" : "year";
  }
  return gap <= 1.5 ? "day" : gap <= 8 ? "week" : gap <= 32 ? "month" : gap <= 95 ? "quarter" : gap <= 190 ? "half" : "year";
}

/** Readable period from the published ref_date and its period_start. */
export function periodLabel(ref, start, grain) {
  const d = new Date(ms(start || ref));
  if (!Number.isFinite(d.getTime())) return String(ref ?? "");
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (grain === "year") return /^\d{4}(\/\d{4})?$/.test(ref) ? ref : String(y);
  if (grain === "quarter") return `Q${Math.floor(m / 3) + 1} ${y}`;
  if (grain === "month" || grain === "half") return `${MONTHS[m]} ${y}`;
  return `${d.getUTCDate()} ${MONTHS[m]} ${y}`;
}

const unitText = (unit, scale) => [unit, scale && scale !== "units" ? scale : ""].filter(Boolean).join(", ");
export const axisTitle = (a) => unitText(a.unit, a.scale);

export function marksOf(view) {
  const out = {};
  for (const s of view.sources) out[s.pid] = Object.fromEntries(s.marks.map((m) => [m.mark, m.meaning]));
  return out;
}

/** "results need 2+ points": a time chart needs one visible series with two values; a flat single series is not drawn. */
export function chartBlocker(view) {
  // Nothing published for any requested series: say so (the gap note, when the engine wrote one, names them).
  if (view.series.length && view.series.every(isUnpublished)) return view.gap_note || "Statistics Canada does not publish these series for this period.";
  // A change over a one-period window is 0 by construction. view.period is a single date for this transform, so test the values.
  if (view.spec.transform === "pct_change_window" && view.series.every((s) => s.points.every((p) => p[2] === null || p[2] === 0))) return "The window has one period, so there is no change to show. Pick a longer time window.";
  if (view.x.kind !== "time") return view.series.some((s) => !s.hidden && s.points.some((p) => p[2] !== null)) ? null : "No published values in this period.";
  const visible = view.series.filter((s) => !s.hidden && !isUnpublished(s));
  if (!visible.length) return "Every series is hidden. Show one in the chart builder.";
  const values = visible.map((s) => s.points.map((p) => p[2]).filter((v) => v !== null));
  if (values.every((v) => v.length < 2)) return "One period only, so there is no line to draw. The values are in Table.";
  if (values.length === 1 && values[0].every((v) => v === values[0][0])) return `Constant at ${fmtNum(values[0][0])} across the period.`;
  return null;
}

// ---------------------------------------------------------------- home (idle)

/** A card's big number, compact and tabular: 41.8M, $2.57T (a millions-scale value is scaled up first), 169.8, 6.4%. */
const SCALE = { units: 1, tens: 10, hundreds: 100, thousands: 1e3, millions: 1e6, billions: 1e9 };
export function cardNumber(c) {
  const v = c.value * (SCALE[c.scale] ?? 1);
  const a = Math.abs(v);
  const n = a >= 1e4 ? new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: a >= 1e9 ? 2 : 1 }).format(v) : fmtNum(v);
  const money = /dollar/i.test(c.unit ?? "");
  return { text: money ? `$${n}` : n, unit: money || /^(persons|number|units)$/i.test(c.unit ?? "") ? "" : /^percent/i.test(c.unit ?? "") ? "%" : c.unit ?? "" };
}

/** "+3.0%", "−0.8%", "0.0 pts", with its arrow; the change kind follows in words. */
export function cardChange(c) {
  const ch = c.change ?? {};
  if (ch.value == null) return { arrow: "", text: "" };
  const sign = ch.value > 0 ? "+" : ch.value < 0 ? "−" : "";
  const unit = ch.unit === "pts" ? " pts" : ch.unit === "%" ? "%" : "";
  return { arrow: c.direction === "up" ? "▲" : c.direction === "down" ? "▼" : "▶", text: `${sign}${Math.abs(ch.value).toFixed(1)}${unit}` };
}

/** A spark path in a 100 × 32 box (the SVG stretches to its cell); it breaks at nulls. */
export function sparkPath(spark) {
  const ys = spark.map((p) => p[1]).filter((v) => v !== null);
  if (ys.length < 2) return "";
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1, n = spark.length - 1 || 1;
  let d = "", pen = false;
  spark.forEach(([, v], i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${(i / n * 100).toFixed(2)} ${(30 - (v - lo) / span * 28).toFixed(2)}`;
    pen = true;
  });
  return d;
}

/** "2026-08" → "Aug 2026" ("Q2 2026" for a quarterly card); "2026-07-01" → "1 Jul 2026"; "2025" stays. */
const cardPeriod = (c) => {
  const p = String(c.period_label ?? "");
  if (/quarter/.test(c.change?.kind ?? "") && /^\d{4}-\d{2}/.test(p)) return periodLabel(p, `${p.slice(0, 7)}-01`, "quarter");
  return /^\d{4}-\d{2}$/.test(p) ? periodLabel(p, `${p}-01`, "month") : /^\d{4}-\d{2}-\d{2}$/.test(p) ? periodLabel(p, p, "day") : p;
};

/**
 * The home page (the idle state): a grid of key-indicator cards around one 2×2 card in the middle that points at the
 * search box. Each indicator card is a link to its full chart (`/?q=…&s=…`). `highlights` is GET /api/v1/highlights;
 * before it arrives (or when it fails) the grid shows only the centre card.
 */
export function homeHtml(highlights) {
  const cards = highlights?.cards ?? [];
  // Cards that would leave a part-filled last row are hidden, per layout, so the grid always ends on a full row.
  // Desktop: 4 columns, the centre takes 4 cells. Mid: 3 columns, the centre is its own row. Phones: 2 columns, same.
  const fits = (cols, centreCells) => Math.max(0, Math.floor((cards.length + centreCells) / cols) * cols - centreCells);
  const keep = { d: fits(4, 4), m: fits(3, 0), p: fits(2, 0) };
  const card = (c, i) => {
    const num = cardNumber(c), ch = cardChange(c), d = sparkPath(c.spark ?? []);
    const spill = Object.entries(keep).filter(([, n]) => i >= n).map(([k]) => ` spill-${k}`).join("");
    return `<a class="hl-card${spill}" href="/?q=${encodeURIComponent(c.q)}&amp;s=${esc(c.s)}" data-id="${esc(c.id)}">
      <span class="hl-label">${esc(c.label)}</span>
      <span class="hl-value"><b>${esc(num.text)}</b>${num.unit ? `<span class="hl-unit">${esc(num.unit)}</span>` : ""}</span>
      ${ch.text ? `<span class="hl-change is-${esc(c.direction)}"><span class="hl-arrow" aria-hidden="true">${ch.arrow}</span>${esc(ch.text)} <span class="hl-kind">${esc(c.change.kind)}</span></span>` : ""}
      <span class="hl-period">${esc(cardPeriod(c))}<span class="hl-src"><span class="dot"> · </span>${esc(c.source)}</span></span>
      ${d ? `<svg class="hl-spark c${i % 10}" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>` : ""}
    </a>`;
  };
  const centre = `<div class="hl-centre" role="button" tabindex="0" data-focus-q aria-label="Focus the search bar">
    <svg class="hl-pointer" viewBox="0 0 24 40" aria-hidden="true"><path d="M12 38V4M5 11l7-7 7 7"/></svg>
    <p class="hl-cta">Type anything into the search bar</p>
    <p class="hl-sub">Compare places, group regions, see change over any window, or index to a year.</p>
  </div>`;
  return `<div class="home${cards.length ? "" : " is-empty"}"><div class="hl-grid">${centre}${cards.map(card).join("")}</div></div>`;
}

/**
 * The gap line under the sub line. A substituted geography (its warning) or the planner's reason already says which
 * members are not published, so then only the time-gap part shows (`gap_parts.time`), or nothing.
 */
export function gapLine(view, plan) {
  const said = plan?.reason || view.warnings.some((w) => w.code === "substituted_geography");
  return said ? view.gap_parts?.time ?? null : view.gap_note ?? null;
}

// ---------------------------------------------------------------- screen parts

/** The displayed period: annual and census sources use years even when their sole ref_date is an ISO date. */
export function periodText(view) {
  const { from, to } = view.period;
  if (!to) return "";
  const freq = (view.sources[0]?.frequency ?? "").toLowerCase();
  const yearly = view.sources.length > 0 && view.sources.every((source) =>
    source.family === "census_2021" || /annual|year/i.test(source.frequency ?? ""));
  const grain = yearly ? "year" : view.x.kind === "time" ? grainOf(view)
    : /quarter/.test(freq) ? "quarter" : /daily/.test(freq) ? "day" : "month";
  const fmt = (d) => periodLabel(d, d, grain);
  return from && from !== to ? `${fmt(from)} – ${fmt(to)}` : fmt(to);
}

/**
 * The sub line under a chart title, on the page, in the PNG and in the OG image: the engine's subtitle, then the
 * period, then the units, then the transform, each only when not already said.
 */
export function subLine(view) {
  const TRANSFORM_WORD = { pct_change_yoy: "% change", pct_change_period: "% change", pct_change_window: "% change", index_first: "index", share_of_x: "share" };
  const word = TRANSFORM_WORD[view.spec.transform];
  const named = view.spec.transform === "index_first" ? `index (${view.spec.index_base ? `${indexBaseLabel(view.spec.index_base)} = 100` : "first = 100"})` : TRANSFORMS.find(([k]) => k === view.spec.transform)?.[1];
  // The axis unit may already say "index (2015 = 100)"; then the transform is not repeated.
  const transform = word && !view.title.toLowerCase().includes(word) && !view.axes.some((a) => /index \(/i.test(a.unit ?? "")) ? named : "";
  // A subtitle that names the end year already carries the period (its own date format may differ from ours).
  const range = view.period.to && !view.subtitle.includes(view.period.to.slice(0, 4)) ? periodText(view) : "";
  const units = view.axes.map(axisTitle).filter((u) => u && !view.subtitle.includes(u)).join(" · ");
  return [view.subtitle, range, units, transform].filter(Boolean).join(" · ");
}

/** index_base as people read it: "2015", "Jun 2015", "Q2 2015", "1 Jun 2015". */
export function indexBaseLabel(b) {
  const q = b.match(/^(\d{4})-Q([1-4])$/);
  if (q) return `Q${q[2]} ${q[1]}`;
  if (/^\d{4}-\d{2}$/.test(b)) return periodLabel(b, `${b}-01`, "month");
  if (/^\d{4}-\d{2}-\d{2}$/.test(b)) return periodLabel(b, b, "day");
  return b;
}

/**
 * state: { q, plan, spec, view, error }. Returns HTML strings for each region of the app screen.
 * `blank` is non-empty when the chart area shows a message instead of a chart.
 */
export function parts(state) {
  const { q, plan, view, error } = state;
  const status = !q.trim() && !state.spec ? "idle" : plan && plan.status !== "ok" && !state.spec ? plan.status : view ? "ok" : "error";
  const out = { status, head: "", blank: "", table: "", notes: "", download: "", cite: "", api: "", counts: { notes: 0, cite: 0 } };
  if (status === "idle") { out.blank = homeHtml(state.highlights); return out; }
  if (status === "need_more") { out.blank = `<p class="blank-msg">Continue typing</p>`; return out; }
  if (status === "no_match") {
    const alts = plan.alternatives ?? [];
    // An explained no_match (a physiographic region, say) says why, under the message, smaller and muted.
    out.blank = `<div class="blank-idle"><p class="blank-msg">Sorry, nothing found</p>${plan.reason ? `<p class="blank-reason">${esc(plan.reason)}</p>` : ""}${alts.length ? `<ul class="examples">${alts.map((a) => `<li><a href="${esc(specHref(q, a.spec))}">${esc(a.label)}</a></li>`).join("")}</ul>` : ""}</div>`;
    return out;
  }
  if (status === "error") { out.blank = `<p class="blank-msg small">${esc(error || "This chart could not be drawn.")}</p>`; return out; }

  const alts = plan?.alternatives ?? [];
  const sub = subLine(view);
  // One table: number · table title (cut by CSS, full text in title=). Several: linked numbers, titles in tooltips.
  const one = view.sources.length === 1 ? view.sources[0] : null;
  const official = (source) => `<a href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${esc(source.pid)}01" target="_blank" rel="noopener" title="${esc(source.title)}">${esc(source.table_number)}</a>`;
  const eyebrow = one
    ? `${official(one)}<span class="eyebrow-title" title="${esc(one.title)}"> · ${esc(one.title)}</span>`
    : view.sources.map(official).join(" · ");
  out.head = `<div class="kicker">${eyebrow}</div>
    <h1 id="view-title">${esc(view.title)}</h1><div class="sub">${esc(sub)}</div>
    ${methodLines(view).map((l) => `<div class="method-line">${esc(l)}</div>`).join("")}
    ${gapLine(view, plan) ? `<div class="method-line gap-note">${esc(gapLine(view, plan))}</div>` : ""}
    ${(() => {
      // The gap note names unpublished series in words, so the engine's per-key no_data lines ("L0:1=25 has no …") go.
      const warns = view.gap_note ? view.warnings.filter((w) => w.code !== "no_data") : view.warnings;
      return error || warns.length ? `<ul class="warnings">${error ? `<li>${esc(error)}</li>` : ""}${warns.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul>` : "";
    })()}
    ${alts.length ? `<div class="alts"><span>Also</span>${alts.map((a) => `<a href="${esc(specHref(q, a.spec))}" title="${esc(a.label)}">${esc(altLabel(a, view.spec))}</a>`).join("")}</div>` : ""}`;
  out.blank = chartBlocker(view) ?? "";
  if (out.blank) out.blank = `<p class="blank-msg small">${esc(out.blank)}</p>`;
  out.table = tableHtml(view);
  out.notes = notesHtml(view);
  out.download = downloadHtml(view);
  out.cite = citeHtml(view);
  out.api = apiHtml(view);
  out.counts = { notes: view.notes.length + (view.group_notes?.length ?? 0) + (view.index_note ? 1 : 0), cite: view.sources.length };
  return out;
}

/** The server's view links, re-encoded with the portable spec when its own encoding carries an empty `in`. */
function viewLinks(view) {
  const spec = portableSpec(view.spec);
  if (spec === view.spec) return view.links;
  const s = encodeSpec(spec);
  return Object.fromEntries(Object.entries(view.links).map(([k, u]) => { const url = new URL(u); url.searchParams.set("s", s); return [k, url.toString()]; }));
}

const TABLE_ROWS = 500;
export function tableHtml(view) {
  const marks = marksOf(view), grain = grainOf(view);
  // A null cell is a gap: "–" and its mark ("– x"), with the meaning as the title ("Not published" without a mark).
  const cell = (s, p) => {
    if (!p) return `<td class="num"></td>`;
    if (p[2] === null) return `<td class="num gap" title="${esc(gapMeaning(s, p, marks))}">–${p[3] ? ` ${esc(p[3])}` : ""}</td>`;
    const mark = p[3] ? `<sup title="${esc(marks[s.pid]?.[p[3]] ?? p[3])}">${esc(p[3])}</sup>` : "";
    return `<td class="num">${fmtNum(p[2])}${mark}</td>`;
  };
  const shades = seriesShades(view);
  const head = `<tr><th>${esc(view.x.kind === "category" ? view.x.dimension : "Period")}</th>${view.series.map((s, i) =>
    `<th class="${s.hidden || isUnpublished(s) ? "quiet" : ""}">${swatch(shades[i])}${esc(seriesName(s))}${isUnpublished(s) ? `<span class="unit">not published</span>` : ""}<span class="unit">${esc(unitText(s.unit, s.scale))}</span></th>`).join("")}</tr>`;
  let rows, total;
  if (view.x.kind === "category") {
    total = view.categories?.length ?? 0;
    const cg = view.category_groups ?? [];
    rows = (view.categories ?? []).slice(0, TABLE_ROWS).map((c, i) => `<tr><th>${esc(c)}${cg[i] && cg[i] !== c ? `<span class="m-parent"> · ${esc(cg[i])}</span>` : ""}</th>${view.series.map((s) => cell(s, s.points[i])).join("")}</tr>`);
  } else {
    const byStart = new Map();
    for (const s of view.series) for (const p of s.points) if (!byStart.has(p[1])) byStart.set(p[1], p[0]);
    const starts = [...byStart.keys()].sort().reverse();
    total = starts.length;
    const index = view.series.map((s) => new Map(s.points.map((p) => [p[1], p])));
    rows = starts.slice(0, TABLE_ROWS).map((st) => `<tr><th>${esc(periodLabel(byStart.get(st), st, grain))}</th>${view.series.map((s, i) => cell(s, index[i].get(st))).join("")}</tr>`);
  }
  const more = total > TABLE_ROWS ? `<p class="table-more">Showing the latest ${TABLE_ROWS} of ${total.toLocaleString("en-CA")} rows. Download has every row.</p>` : "";
  return `<div class="data-wrap"><table class="data-table"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table></div>${more}`;
}

const SCOPE_RANK = { table: 0, dimension: 1, member: 2 };
/**
 * Groups first (how each group's values were made: method, members, formula), then the published notes grouped by
 * source table. The group block is ours, not Statistics Canada's, so it sits above the published notes.
 */
export function groupNotesHtml(view) {
  const gs = view.group_notes ?? [];
  if (!gs.length) return "";
  const table = (pid) => view.sources.find((s) => s.pid === pid)?.table_number ?? pid;
  const many = new Set(gs.map((g) => g.pid)).size > 1;
  return `<section class="note-group group-notes">${noteHead("Groups")}
    <ul class="group-list">${gs.map((g) => `<li><div class="g-line"><b>${esc(g.label)}</b><span class="m-tag m-${esc(g.method)}">${esc(METHOD_WORD[g.method] ?? g.method)}</span>${many ? `<span class="quiet">${esc(table(g.pid))}</span>` : ""}</div>
      ${g.formula ? `<div class="g-formula">${esc(g.formula)}</div>` : ""}<div class="g-members">${esc(g.members.join(", "))}</div></li>`).join("")}</ul></section>`;
}

/** A notes block's head: a name (a table number, "Groups") and an optional title, on one line. */
const noteHead = (name, title) => `<div class="note-head"><h2>${esc(name)}</h2>${title ? `<span title="${esc(title)}">${esc(title)}</span>` : ""}</div>`;

/** How the view's values were calculated (ours, not Statistics Canada's): today the index base, from `index_note`. */
const calcHtml = (view) => view.index_note ? `<section class="note-group calc-notes">${noteHead("Calculation")}<p class="g-formula">${esc(view.index_note)}</p></section>` : "";

export function notesHtml(view) {
  const groups = calcHtml(view) + groupNotesHtml(view);
  if (!view.notes.length) return groups + `<p class="muted">No notes published for these tables.</p>`;
  return groups + view.sources.map((src) => {
    const notes = view.notes.filter((n) => n.pid === src.pid).sort((a, b) => SCOPE_RANK[a.scope.kind] - SCOPE_RANK[b.scope.kind] || a.note_id - b.note_id);
    if (!notes.length) return "";
    return `<section class="note-group">${noteHead(src.table_number, src.title)}
      <div class="note-cols">${notes.map((n) => `<div class="note-row"><span class="id">${n.note_id}</span><div>${n.scope.kind === "table" ? "" : `<span class="note-tag">${esc(n.scope.kind === "member" ? `${n.scope.dimension} · ${n.scope.member}` : n.scope.dimension)}</span>`}<div class="note-text">${sanitizeNote(n.text)}</div></div></div>`).join("")}</div></section>`;
  }).join("");
}

/** Statistics Canada's own full-table ZIP (CSV) for a PID. Every captured source ZIP came from this URL. */
export const statcanZipUrl = (pid) => `https://www150.statcan.gc.ca/n1/tbl/csv/${pid}-eng.zip`;

const DOWN = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v8M2.5 5.5 6 9l3.5-3.5M1 11h10"/></svg>`;
/**
 * Two kinds of file, each under a small label: the chart's own data ("This view"), then each source table in full. Every
 * row is one grid (name and sub line, then two equal button slots), so the buttons line up across rows.
 */
export function downloadHtml(view) {
  const btn = (href, label, tip, primary) => `<a class="btn${primary ? " primary" : ""}" href="${esc(href)}" title="${esc(tip)}" download>${DOWN}${label}</a>`;
  const row = (name, sub, a, b) => `<div class="dl-row"><div class="dl-what"><b>${esc(name)}</b><span title="${esc(sub)}">${esc(sub)}</span></div>${a}${b}</div>`;
  const links = viewLinks(view);
  return `<div class="dl-kind">Chart data</div>` +
    row("This view", `${view.series.length} series, as charted`,
      btn(links.parquet, "Parquet", "The chart's data, with its spec and citations in the file metadata", true), btn(links.csv, "CSV", "The chart's data")) +
    `<div class="dl-kind">Full tables</div>` +
    view.sources.map((s) => row(s.table_number, s.title,
      btn(`/api/v1/tables/${s.pid}/observations.parquet`, "Parquet", "Every observation in the table"),
      btn(statcanZipUrl(s.pid), "Source ZIP", "Statistics Canada's original ZIP (CSV)"))).join("");
}

/** A Copy button that never changes size: every word it can show shares one grid cell (app.js flips the visible one). */
const copyBtn = (text, label = "Copy") =>
  `<button type="button" class="btn" data-copy="${esc(text)}"><span class="act-label" aria-live="polite"><span>${label}</span><span hidden>Copied</span><span hidden>Failed</span></span></button>`;

export function citeHtml(view) {
  const all = view.sources.map((s) => s.citation).join("\n");
  return `${view.sources.length > 1 ? `<div class="cite-all"><span class="dl-kind">${view.sources.length} tables</span>${copyBtn(all, "Copy all")}</div>` : ""}<ol class="cite-list">${view.sources.map((s) => `<li class="cite-row"><div><p>${esc(s.citation)}</p>
    <div class="hash">${s.captured ? `captured ${esc(periodLabel(s.captured, s.captured, "day"))} · ` : ""}build ${esc(view.build_id)} · normalized ${esc(view.normalized_build_id)} · <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a></div></div>
    ${copyBtn(s.citation)}</li>`).join("")}</ol>`;
}

export function apiHtml(view) {
  // Copyable text names the published site (statcan2.ca), not the host this page came from; the "open ↗" link stays
  // on this server, so it works in local dev too.
  const links = viewLinks(view), spec = portableSpec(view.spec);
  const self = new URL(links.self), published = `${PUBLIC_ORIGIN}${self.pathname}${self.search}`;
  const json = JSON.stringify(spec);
  const curl = `curl -s -X POST ${PUBLIC_ORIGIN}/api/v1/view -H 'content-type: application/json' -d '${json.replaceAll("'", "'\\''")}'`;
  const mcp = JSON.stringify({ tool: "run_view", arguments: { spec } }, null, 2);
  const block = (title, text, link) => `<div class="api-block"><div class="api-head"><b>${title}</b>${link ? `<a class="muted" href="${esc(link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}${copyBtn(text)}</div><pre>${esc(text)}</pre></div>`;
  return block("POST /api/v1/view", curl) + block("GET /api/v1/view?s=", published, `${self.pathname}${self.search}`) + block("MCP run_view", mcp) +
    `<p class="api-more"><a href="/api">API reference →</a></p>`;
}
