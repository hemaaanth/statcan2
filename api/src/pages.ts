import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { int, observationFilter, type Config } from "./api.ts";
import { ARCHIVED_EN, MAX_SERIES_POINTS, type Row, type Series, type SeriesDetailResult, type SeriesLabel } from "./db.ts";

// Pinned Highcharts build from a CDN; non-commercial licence applies (personal, non-profit project). SRI protects against CDN tampering.
const HIGHCHARTS = { src: "https://cdn.jsdelivr.net/npm/highcharts@13.1.1/highcharts.js", integrity: "sha384-FXT8Mj1JsVEsCNEB3qjrU1JPYJ94Ku7uMe0eopjumL2jEkPl1O9YeAZJn+qsOFVW" };
const MAX_CHART_SERIES = 12;
/** Snapshot tables: at most this many series (one bar each) in a bar chart. */
const MAX_BARS = 200;

/** Highcharts line options: x = period_start as a datetime, y = value_num (null = gap), point name = the raw ref_date, shown in the tooltip. */
function lineChart(title: string, note: string, series: Series[]) {
  const distinct = (pick: (s: Series) => string) => [...new Set(series.map(pick))].join("; ");
  const points = Math.max(...series.map((s) => s.points.length));
  return {
    chart: { type: "line", zooming: { type: "x" } },
    title: { text: title },
    subtitle: { text: note },
    xAxis: { type: "datetime", crosshair: true },
    yAxis: { title: { text: `Unit: ${distinct((s) => s.unit)} · Scale: ${distinct((s) => s.scale)}` } },
    tooltip: { shared: true, headerFormat: "<b>{point.key}</b><br>" },
    legend: { enabled: series.length > 1 },
    // turboThreshold 0: points are objects (they carry the ref_date name), and series can exceed 1,000 points.
    plotOptions: { series: { marker: { enabled: points < 60 }, connectNulls: false, animation: false, turboThreshold: 0 } },
    // A ref_date with no period (kind "other") has no place on a time axis; it stays in the table below.
    series: series.map((s) => ({ name: s.name, data: s.points.filter((p) => p[3]).map((p) => ({ x: Date.parse(`${p[3]}T00:00:00Z`), y: p[1], name: p[0] })) })),
  };
}

/** Highcharts bar options for a snapshot table: one category per member of dimension `across`, one bar series per combination of the other members that differ. */
function barChart(title: string, note: string, series: Series[], across: number) {
  const member = (s: Series, k: number) => s.labels.find((l) => l.dimension_id === k);
  const dims = [...new Set(series.flatMap((s) => s.labels.map((l) => l.dimension_id)))];
  const others = dims.filter((k) => k !== across && new Set(series.map((s) => member(s, k)?.member_id)).size > 1);
  const categories = new Map<number, string>();
  for (const l of series.map((s) => member(s, across)).filter((l): l is SeriesLabel => !!l).sort((a, b) => a.member_id - b.member_id)) {
    categories.set(l.member_id, l.member ?? `#${l.member_id}`);
  }
  const groups = new Map<string, Map<number, number | null>>();
  for (const s of series) {
    const name = others.map((k) => member(s, k)?.member ?? "").join(" · ") || "value";
    if (!groups.has(name)) groups.set(name, new Map());
    const id = member(s, across)?.member_id;
    if (id !== undefined) groups.get(name)!.set(id, s.points[0]?.[1] ?? null);
  }
  const distinct = (pick: (s: Series) => string) => [...new Set(series.map(pick))].join("; ");
  return {
    chart: { type: "bar", height: Math.max(420, categories.size * groups.size * 16 + 160) },
    title: { text: title },
    subtitle: { text: note },
    xAxis: { categories: [...categories.values()], title: { text: series[0] && member(series[0], across)?.dimension } },
    yAxis: { title: { text: `Unit: ${distinct((s) => s.unit) || "not given"} · Scale: ${distinct((s) => s.scale) || "not given"}` } },
    legend: { enabled: groups.size > 1 },
    plotOptions: { series: { animation: false } },
    series: [...groups].map(([name, values]) => ({ name, data: [...categories.keys()].map((id) => values.get(id) ?? null) })),
  };
}

/** Chart container, options as JSON (never executed), the pinned library, and a mount script. */
function chartBlock(config: { chart: { type: string; height?: number } }, jsonHref: string) {
  return html`<div id="chart" class="highcharts-light" style="height:${config.chart.height ?? 420}px;margin:1rem 0"></div>
    <script type="application/json" id="chart-config">${raw(JSON.stringify(config).replaceAll("<", "\\u003c"))}</script>
    <script src="${HIGHCHARTS.src}" integrity="${HIGHCHARTS.integrity}" crossorigin="anonymous"></script>
    <script>{const el=document.getElementById("chart");if(window.Highcharts)Highcharts.chart(el,JSON.parse(document.getElementById("chart-config").textContent));else el.textContent="The chart library did not load.";}</script>
    <p class="muted">Chart: <a href="https://www.highcharts.com/" rel="external">Highcharts</a>, non-commercial use. <a href="${jsonHref}">Same data as JSON</a>.</p>`;
}

function placeLink(placeId: unknown, text: unknown) {
  return placeId ? html`<a href="/places/${encodeURIComponent(String(placeId))}">${text}</a>` : html`${text}`;
}

const CSS = `
:root{color-scheme:light}body{font:15px/1.45 system-ui,sans-serif;margin:0;color:#111}header{background:#1f2a44;color:#fff;padding:.6rem 1.2rem}
header a{color:#fff;text-decoration:none;font-weight:600}header small{opacity:.75;margin-left:1rem}main{max-width:70rem;margin:0 auto;padding:1rem 1.2rem}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}
th{background:#f3f4f6}.badge{display:inline-block;font-size:12px;padding:0 .4rem;border-radius:3px;background:#e5e7eb}.badge.ok{background:#d1fae5}
.badge.err{background:#fee2e2}form.filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:.6rem;margin:1rem 0}
label{display:block;font-size:13px;color:#444}input,select{width:100%;box-sizing:border-box;padding:.3rem}button{padding:.4rem .9rem}
details{margin:.4rem 0}summary{cursor:pointer}.muted{color:#666}.num{text-align:right;font-variant-numeric:tabular-nums}pre{white-space:pre-wrap}
.warn{background:#fef3c7;padding:.5rem .8rem;border-radius:4px}`;

function layout(title: string, builds: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · StatCan data</title><style>${raw(CSS)}</style></head>
<body><header><a href="/">StatCan data</a><small>independent · build ${builds} · <a href="/coverage">coverage</a> · <a href="/api/v1/openapi.json">API</a></small></header>
<main>${body}</main></body></html>`;
}

function pager(base: string, total: number, limit: number, offset: number) {
  const prev = offset > 0 ? `${base}&offset=${Math.max(offset - limit, 0)}` : null;
  const next = offset + limit < total ? `${base}&offset=${offset + limit}` : null;
  return html`<p class="muted">${offset + 1}–${Math.min(offset + limit, total)} of ${total}
    ${prev ? html`· <a href="${prev}">previous</a>` : ""} ${next ? html`· <a href="${next}">next</a>` : ""}</p>`;
}

export function pageRoutes({ db, captureDir }: Config) {
  const site = new Hono();
  const builds = `${db.manifest.build_id} / normalized ${db.normalized.build_id}`;
  const chartNote = `Unofficial. Gaps are values Statistics Canada did not publish, not zeros. Build ${builds}.`;
  const notFound = (what: string) => layout("Not found", builds, html`<h1>${what}</h1>`);

  site.get("/", async (c) => {
    const q = c.req.query("q") ?? "";
    const archived = c.req.query("archived") ?? "";
    const kind = c.req.query("kind") ?? "";
    const queryable = c.req.query("queryable") === "true";
    const limit = 25;
    const offset = int(c.req.query("offset"), 0);
    const { total, rows } = await db.search(q, { archived: archived || undefined, kind: kind || undefined, queryable, limit, offset });
    const base = `/?q=${encodeURIComponent(q)}&archived=${encodeURIComponent(archived)}&kind=${encodeURIComponent(kind)}&queryable=${queryable}`;
    return c.html(layout("Search", builds, html`
      <h1>Find a Statistics Canada table</h1>
      <p class="muted">${db.info.size.toLocaleString()} WDS tables in the inventory; ${db.manifest.summary.ok ?? 0} queryable in this build. Search titles, dimensions, members, and notes. Not an official Statistics Canada service.</p>
      <form class="filters" method="get" action="/">
        <label>Search<input name="q" value="${q}" placeholder="e.g. consumer price index food" autofocus></label>
        <label>Status<select name="archived"><option value="">any</option><option value="2" ${archived === "2" ? "selected" : ""}>current</option><option value="1" ${archived === "1" ? "selected" : ""}>archived</option></select></label>
        <label>Kind<select name="kind"><option value="">any</option><option value="time_series" ${kind === "time_series" ? "selected" : ""}>time series</option><option value="snapshot" ${kind === "snapshot" ? "selected" : ""}>snapshot</option></select></label>
        <label>Queryable only<input type="checkbox" name="queryable" value="true" ${queryable ? "checked" : ""} style="width:auto"></label>
        <label>&nbsp;<button>Search</button></label>
      </form>
      ${pager(base, total, limit, offset)}
      <table><tr><th>PID</th><th>Title</th><th>Frequency</th><th>Kind</th><th>Status</th><th>Dims</th><th>Period</th><th>Matched in</th></tr>
      ${rows.map((r) => html`<tr>
        <td><a href="/tables/${r.pid}">${r.pid}</a></td>
        <td>${r.title_en} ${r.queryable ? html`<span class="badge ok">queryable</span>` : ""}</td>
        <td>${r.frequency_en ?? `code ${r.frequency_code}`}</td>
        <td>${r.kind === "snapshot" ? "snapshot" : "time series"}</td>
        <td>${ARCHIVED_EN[r.archived as string] ?? r.archived}</td>
        <td class="num">${r.dimension_count}</td>
        <td>${r.period_min ? `${r.period_min} – ${r.period_max}` : `${String(r.cube_start_date).slice(0, 10)} – ${String(r.cube_end_date).slice(0, 10)}`}</td>
        <td class="muted">${Number(r.title_hits) > 0 ? "title" : Number(r.text_hits) > 0 ? "dimensions, members, or notes" : ""}</td>
      </tr>`)}
      </table>`));
  });

  site.get("/tables/:pid", async (c) => {
    const t = await db.table(c.req.param("pid"));
    if (!t) return c.html(notFound("Unknown PID"), 404);
    const cube = t.cube;
    const build = t.build;
    const hasZip = captureDir !== undefined;
    return c.html(layout(`${t.pid}`, builds, html`
      <h1>${cube.title_en}</h1>
      <p><span class="badge">PID ${t.pid}</span> ${cube.cansim_id ? html`<span class="badge">CANSIM ${cube.cansim_id}</span>` : ""}
        <span class="badge">${ARCHIVED_EN[cube.archived as string] ?? cube.archived}</span>
        <span class="badge">${cube.frequency_en ?? t.meta?.frequency ?? `frequency code ${cube.frequency_code}`}</span>
        <span class="badge">${cube.kind === "snapshot" ? "snapshot" : "time series"}</span>
        <span class="badge">${String(cube.cube_start_date).slice(0, 10)} – ${String(cube.cube_end_date).slice(0, 10)}</span>
        ${build?.status === "ok" ? html`<span class="badge ok">queryable · ${(build.row_count ?? 0).toLocaleString()} rows · ${Number(cube.series_count ?? 0).toLocaleString()} series</span>` : build ? html`<span class="badge err">build failed</span>` : html`<span class="badge">not built</span>`}</p>
      <p>
        ${build?.status === "ok" ? html`<a href="/tables/${t.pid}/observations">Browse observations</a> · <a href="/api/v1/tables/${t.pid}/observations">API JSON</a> · <a href="/api/v1/series?pid=${t.pid}">Series JSON</a> · <a href="/api/v1/tables/${t.pid}/observations.parquet">Parquet</a> · ` : ""}
        <a href="/api/v1/tables/${t.pid}">Metadata JSON</a>
        ${hasZip ? html` · <a href="/api/v1/tables/${t.pid}/source.zip">Original ZIP</a>` : ""}
        · <a href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${t.pid}01" rel="external">statcan.gc.ca</a>
      </p>
      ${build && build.status !== "ok" ? html`<p class="warn">Not queryable in build ${db.manifest.build_id}: ${build.errors.join("; ")}</p>` : ""}
      ${build?.warnings.length ? html`<p class="warn">Build warnings: ${build.warnings.join("; ")}</p>` : ""}
      ${cube.title_fr ? html`<p class="muted" lang="fr">${cube.title_fr}</p>` : ""}

      <h2>Dimensions</h2>
      ${t.dimensions.length ? t.dimensions.map((d) => html`<details ${d.members.length <= 12 ? "open" : ""}>
        <summary><b>${d.dimension_id}. ${d.dimension_name}</b> <span class="muted">${d.members.length} members${d.dimension_notes ? ` · notes ${d.dimension_notes}` : ""}</span></summary>
        <table><tr><th>ID</th><th>Member</th><th>Code</th><th>Parent</th><th>Terminated</th><th>Notes</th>${d.dimension_id === 1 ? html`<th>Place</th>` : ""}</tr>
        ${d.members.map((m) => html`<tr><td class="num">${m.member_id}</td><td>${placeLink(m.place_id, m.member_name)}</td><td>${m.classification_code}</td><td class="num">${m.parent_member_id ?? ""}</td><td>${m.terminated}</td><td>${m.member_notes}</td>${d.dimension_id === 1 ? html`<td class="muted">${m.place_id ?? ""} ${m.place_match ? `(${m.place_match})` : ""}</td>` : ""}</tr>`)}</table>
      </details>`) : html`<ol>${t.inventory_dimensions.map((d) => html`<li>${d.name_en}${d.has_uom ? html` <span class="muted">(carries unit of measure)</span>` : ""}</li>`)}</ol>
        <p class="muted">Member lists appear once this table is built.</p>`}

      ${t.notes.length ? html`<h2>Notes</h2><ol>${t.notes.map((n) => html`<li value="${n.note_id}"><pre>${n.note}</pre></li>`)}</ol>` : ""}
      ${t.corrections.length || t.inventory_corrections.length ? html`<h2>Corrections</h2>
        <table><tr><th>Date</th><th>Note</th></tr>
        ${t.corrections.map((r) => html`<tr><td>${r.correction_date}</td><td><pre>${r.correction_note}</pre></td></tr>`)}
        ${t.corrections.length ? "" : t.inventory_corrections.map((r) => html`<tr><td>${String(r.correction_date).slice(0, 10)}</td><td><pre>${r.note_en}</pre></td></tr>`)}</table>` : ""}
      ${t.symbols.length ? html`<h2>Symbols and status codes</h2><table>${t.symbols.map((s) => html`<tr><td><code>${s.symbol}</code></td><td>${s.description}</td></tr>`)}</table>` : ""}
      ${t.survey_labels.length || t.subject_labels.length ? html`<p class="muted">Survey: ${t.survey_labels.map((s) => s.survey_en ?? `code ${s.survey_code}`).join("; ") || "none listed"}.
        Subject: ${t.subject_labels.map((s) => s.subject_en ?? `code ${s.subject_code}`).join("; ") || "none listed"}.</p>` : ""}

      <h2>Provenance</h2>
      <table>
        <tr><td>Build</td><td>${db.manifest.build_id} (capture ${db.manifest.capture_id}, ${db.manifest.language}); normalized ${db.normalized.build_id}</td></tr>
        <tr><td>Inventory</td><td>${db.manifest.inventory.records.toLocaleString()} records, SHA-256 <code>${db.manifest.inventory.sha256}</code></td></tr>
        ${build ? html`<tr><td>Source ZIP</td><td>captured ${build.source_captured_at_utc}, SHA-256 <code>${build.source_sha256}</code></td></tr>` : ""}
        ${build?.parquet ? html`<tr><td>Parquet</td><td>${build.parquet.bytes.toLocaleString()} bytes, SHA-256 <code>${build.parquet.sha256}</code>; ref_date ${build.ref_date_min} – ${build.ref_date_max}; status codes ${JSON.stringify(build.status_counts)}</td></tr>` : ""}
        <tr><td>Release</td><td>${String(cube.release_time)}</td></tr>
      </table>`));
  });

  site.get("/tables/:pid/observations", async (c) => {
    const pid = c.req.param("pid");
    const t = await db.table(pid);
    if (!t) return c.html(notFound("Unknown PID"), 404);
    if (t.build?.status !== "ok") return c.redirect(`/tables/${pid}`);
    const query = c.req.query();
    const filter = observationFilter(query);
    filter.limit = Math.min(filter.limit, 200);
    const result = (await db.observations(pid, filter))!;
    const dims = t.dimensions;
    const keep = Object.entries(query).filter(([k, v]) => v && k !== "offset").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const title = t.cube.title_en as string;
    // Time series: lines over a time axis. Snapshot (one period): bars across one dimension. Both ignore paging.
    let chart: HtmlEscapedString | Promise<HtmlEscapedString> | string = "";
    if (t.cube.kind === "time_series") {
      const lines = await db.series(pid, filter, MAX_CHART_SERIES);
      chart = lines?.kind === "ok" && lines.series.length
        ? chartBlock(lineChart(title, chartNote, lines.series), `/api/v1/tables/${pid}/series?${keep}`)
        : html`<p class="muted">A chart appears when the filter matches at most ${MAX_CHART_SERIES} series and ${MAX_SERIES_POINTS.toLocaleString()} points.</p>`;
    } else {
      const bars = await db.series(pid, filter, MAX_BARS);
      // Default: spread bars across the dimension with the most members in the match, so the fewest bar groups remain.
      const members = (k: unknown) => bars?.kind === "ok" ? new Set(bars.series.map((s) => s.labels.find((l) => l.dimension_id === k)?.member_id)).size : 0;
      const widest = dims.reduce((best, d) => (members(d.dimension_id) > members(best?.dimension_id) ? d : best), dims[0]);
      const config = bars?.kind === "ok" && bars.series.length ? barChart(title, chartNote, bars.series, int(query.across, Number(widest?.dimension_id ?? 1))) : undefined;
      chart = config && config.series.length <= MAX_CHART_SERIES
        ? chartBlock(config, `/api/v1/tables/${pid}/series?${keep}`)
        : html`<p class="muted">This table has one reference period. A bar chart appears when the filter matches at most ${MAX_BARS} series in at most ${MAX_CHART_SERIES} bar groups; fix some dimensions below.</p>`;
    }
    return c.html(layout(`${pid} observations`, builds, html`
      <h1><a href="/tables/${pid}">${title}</a></h1>
      <p class="muted">${result.total.toLocaleString()} rows match. Raw values and status codes are shown as published; blank value means nothing was published, not zero. <a href="/api/v1/tables/${pid}/observations?${keep}">Same query as JSON</a>.</p>
      ${chart}
      <form class="filters" method="get">
        ${dims.map((d, i) => html`<label>${d.dimension_name}
          ${d.members.length <= 300
            ? html`<select name="m${i + 1}"><option value="">all</option>${d.members.map((m) => html`<option value="${m.member_id}" ${query[`m${i + 1}`] === String(m.member_id) ? "selected" : ""}>${m.member_name}</option>`)}</select>`
            : html`<input name="m${i + 1}" value="${query[`m${i + 1}`] ?? ""}" placeholder="member ID (${d.members.length} members)">`}
        </label>`)}
        ${t.cube.kind === "snapshot" ? html`<label>Bars across<select name="across"><option value="">dimension with the most members</option>${dims.map((d) => html`<option value="${d.dimension_id}" ${query.across === String(d.dimension_id) ? "selected" : ""}>${d.dimension_name}</option>`)}</select></label>` : ""}
        <label>From (ref_date)<input name="from" value="${query.from ?? ""}" placeholder="${t.build.ref_date_min}"></label>
        <label>To (ref_date)<input name="to" value="${query.to ?? ""}" placeholder="${t.build.ref_date_max}"></label>
        <label>Vector<input name="vector" value="${query.vector ?? ""}" placeholder="v…"></label>
        <label>&nbsp;<button>Filter</button></label>
      </form>
      ${pager(`/tables/${pid}/observations?${keep}`, result.total, result.limit, result.offset)}
      <table><tr><th>ref_date</th><th>period</th>${dims.map((d) => html`<th>${d.dimension_name}</th>`)}<th>value</th><th>status</th><th>symbol</th><th>unit</th><th>scale</th><th>series</th><th>coordinate</th></tr>
      ${result.rows.map((r: Row) => html`<tr><td>${r.ref_date}</td><td class="muted">${r.period_start ? `${r.period_start} – ${r.period_end}` : r.period_kind}</td>
        ${dims.map((_, i) => html`<td>${i === 0 ? placeLink(r.place_id, r.label_1) : r[`label_${i + 1}`]}</td>`)}
        <td class="num">${r.value}</td><td title="${r.status_en ?? ""}">${r.status}</td><td title="${r.symbol_en ?? ""}">${r.symbol}</td><td>${r.uom}</td><td>${r.scalar_factor}</td>
        <td><a href="/series/${pid}/${r.vector ? r.vector : `c/${r.coordinate}`}">${r.vector || "series"}</a></td><td>${r.coordinate}</td></tr>`)}
      </table>`));
  });

  const seriesPage = (pid: string, result: SeriesDetailResult) => {
    if (result.kind === "not_found") return { status: 404 as const, body: notFound("Unknown series") };
    if (result.kind !== "ok") {
      const why = result.kind === "inconsistent"
        ? `The Normalized series row says ${result.n_obs} observations; the table has ${result.points} for this coordinate.`
        : `More than ${result.limit} points.`;
      return { status: 409 as const, body: layout("Series unavailable", builds, html`<h1>Series unavailable</h1><p class="warn">${why}</p>`) };
    }
    const s = result.series;
    const key = s.vector ? String(s.vector) : `c/${s.coordinate}`;
    const labels = s.labels;
    const chart = s.table_kind === "time_series" && s.points.length > 1
      ? chartBlock(lineChart(String(s.title_en), chartNote, [{
        vector: String(s.vector), coordinate: String(s.coordinate), name: labels.map((l) => l.member ?? `#${l.member_id}`).join(" · "), labels,
        unit: String(s.uom_en ?? s.uom_code ?? ""), scale: String(s.scalar_en ?? s.scalar_code ?? ""), period_kind: s.period_kind as Series["period_kind"],
        points: s.points.map((p) => [String(p.ref_date), typeof p.value_num === "number" ? p.value_num : null, String(p.status ?? ""), p.period_start as string | null, p.period_end as string | null]),
      }]), `/api/v1/series/${pid}/${key}`)
      : html`<p class="muted">${s.table_kind === "snapshot" ? "This table has one reference period: compare this value with others on the table's observations page." : "One point; no line to draw."}</p>`;
    const place = s.place as Row | null;
    return { status: 200 as const, body: layout(`${pid} ${key}`, builds, html`
      <h1><a href="/tables/${pid}">${s.title_en}</a></h1>
      <p><span class="badge">PID ${pid}</span> ${s.vector ? html`<span class="badge">${s.vector}</span>` : ""} <span class="badge">coordinate ${s.coordinate}</span>
        <span class="badge">${s.frequency_en}</span> <span class="badge">${s.period_kind}</span> ${s.terminated ? html`<span class="badge err">terminated</span>` : ""}</p>
      <table>
        ${labels.map((l) => html`<tr><td>${l.dimension}</td><td>${l.dimension_id === 1 && place ? placeLink(place.place_id, l.member) : l.member} <span class="muted">member ${l.member_id}</span></td></tr>`)}
        <tr><td>Unit</td><td>${s.uom_en ?? `code ${s.uom_code}`} <span class="muted">family ${s.unit_family ?? "none"}${s.unit_base_year ? `, base year ${s.unit_base_year}` : ""}</span></td></tr>
        <tr><td>Scale</td><td>${s.scalar_en ?? `code ${s.scalar_code}`}</td></tr>
        <tr><td>Period</td><td>${s.period_min} – ${s.period_max}</td></tr>
        <tr><td>Observations</td><td>${s.n_obs} (${s.n_published} with a value); last status ${s.last_status || "none"}</td></tr>
      </table>
      ${chart}
      <p class="muted">Cite: ${db.citation(pid)}. <a href="/api/v1/series/${pid}/${key}">JSON</a>.</p>
      <table><tr><th>ref_date</th><th>period</th><th>value</th><th>status</th><th>symbol</th></tr>
      ${s.points.map((p) => html`<tr><td>${p.ref_date}</td><td class="muted">${p.period_start ? `${p.period_start} – ${p.period_end}` : p.period_kind}</td>
        <td class="num">${p.value}</td><td title="${p.status_en ?? ""}">${p.status}</td><td title="${p.symbol_en ?? ""}">${p.symbol}</td></tr>`)}
      </table>`) };
  };

  site.get("/series/:pid/c/:coordinate", async (c) => {
    const { pid, coordinate } = c.req.param();
    const page = seriesPage(pid, await db.seriesGet(pid, { coordinate }));
    return c.html(page.body, page.status);
  });

  site.get("/series/:pid/:vector", async (c) => {
    const { pid, vector } = c.req.param();
    const page = seriesPage(pid, await db.seriesGet(pid, { vector }));
    return c.html(page.body, page.status);
  });

  site.get("/places/:place_id", async (c) => {
    const r = await db.place(c.req.param("place_id"));
    if (!r) return c.html(notFound("Unknown place"), 404);
    const p = r.place;
    return c.html(layout(String(p.name_en), builds, html`
      <h1>${p.name_en}</h1>
      <p><span class="badge">${p.level}</span> <span class="badge">schema ${p.schema}</span> <span class="badge">geo_code ${p.geo_code}</span>
        ${p.vintage ? html`<span class="badge">vintage ${p.vintage}</span>` : html`<span class="badge">no vintage (matched by code or name)</span>`}
        ${r.parent ? html`· part of ${placeLink(r.parent.place_id, r.parent.name_en)}` : ""}</p>
      <p class="muted">${r.n_tables} tables cover this place in any vintage. Same place, any vintage = same schema and geo_code. <a href="/api/v1/places/${encodeURIComponent(String(p.place_id))}">JSON</a>.</p>
      <h2>Vintages</h2>
      <table><tr><th>place_id</th><th>DGUID</th><th>Vintage</th><th>Type</th><th>Name</th><th>Tables</th></tr>
      ${r.vintages.map((v) => html`<tr><td>${placeLink(v.place_id, v.place_id)}</td><td>${v.dguid ?? ""}</td><td>${v.vintage ?? ""}</td><td>${v.geo_type ?? ""}</td><td>${v.name_en}</td><td class="num">${v.n_tables}</td></tr>`)}
      </table>
      ${r.subjects.map((g) => html`<h2>${g.subject_en ?? "No subject listed"}</h2>
        <table><tr><th>PID</th><th>Title</th><th>Kind</th><th>Period</th><th>Member</th><th>Matched as</th><th>Series</th></tr>
        ${g.tables.map((t) => html`<tr><td><a href="/tables/${t.pid}">${t.pid}</a></td><td>${t.title_en}</td><td>${t.kind === "snapshot" ? "snapshot" : t.frequency_en}</td>
          <td>${t.period_min ?? ""} – ${t.period_max ?? ""}</td>
          <td>${(t.members as Row[]).map((m) => html`<div><a href="/tables/${t.pid}/observations?m1=${m.member_id}">${m.member_name}</a></div>`)}</td>
          <td class="muted">${(t.members as Row[]).map((m) => html`<div>${m.place_id} (${m.match}${m.vintage ? `, ${m.vintage}` : ""})</div>`)}</td>
          <td class="num">${t.n_series}</td></tr>`)}
        </table>`)}`));
  });

  site.get("/coverage", async (c) => {
    const cov = await db.coverage(captureDir);
    const byFamily = cov.by_family as Row[];
    const failed = cov.failed as Row[];
    const gaps = cov.upstream_gaps as Row[] | null;
    const warnings = cov.normalized_warnings as Row[];
    return c.html(layout("Coverage", builds, html`
      <h1>Coverage</h1>
      <table>
        <tr><td>Tables in the WDS inventory</td><td class="num">${cov.inventory}</td></tr>
        <tr><td>Captured (English ZIP on disk)</td><td class="num">${cov.captured ?? "unknown: STATCAN_CAPTURE not set"}</td></tr>
        <tr><td>Built in Clean build ${db.manifest.build_id}</td><td class="num">${cov.built}</td></tr>
        <tr><td>Queryable</td><td class="num">${cov.queryable}</td></tr>
      </table>
      <h2>By family</h2>
      <table><tr><th>Family</th><th>Inventory</th><th>Captured</th><th>Built</th><th>Queryable</th></tr>
      ${byFamily.map((f) => html`<tr><td>${f.family}</td><td class="num">${f.inventory}</td><td class="num">${f.captured ?? ""}</td><td class="num">${f.built}</td><td class="num">${f.queryable}</td></tr>`)}
      </table>
      <h2>Failed in the build</h2>
      ${failed.length ? html`<table><tr><th>PID</th><th>Title</th><th>Errors</th></tr>
        ${failed.map((f) => html`<tr><td><a href="/tables/${f.pid}">${f.pid}</a></td><td>${f.title_en}</td><td>${(f.errors as string[]).join("; ")}</td></tr>`)}</table>`
        : html`<p>None: every table built in ${db.manifest.build_id} passed.</p>`}
      <h2>Upstream gaps</h2>
      ${gaps === null ? html`<p class="muted">Unknown: STATCAN_CAPTURE not set.</p>` : html`<p class="muted">Inventory tables with no captured ZIP, with the downloader's last recorded error.</p>
        <table><tr><th>PID</th><th>Title</th><th>Last error</th><th>Attempts</th><th>Last attempt</th><th>Bytes received</th></tr>
        ${gaps.map((g) => html`<tr><td><a href="/tables/${g.pid}">${g.pid}</a></td><td>${g.title_en}</td><td>${g.last_error ?? "none recorded"}</td><td class="num">${g.attempts}</td><td>${g.last_attempt_utc ?? ""}</td><td class="num">${g.partial_bytes ?? ""}</td></tr>`)}</table>`}
      <h2>Normalized build warnings</h2>
      ${warnings.length ? html`<ul>${warnings.map((w) => html`<li><code>${w.type}</code> <span class="muted">${JSON.stringify(Object.fromEntries(Object.entries(w).filter(([k]) => k !== "type")))}</span></li>`)}</ul>` : html`<p>None.</p>`}`));
  });

  return site;
}
