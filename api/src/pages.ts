import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { int, observationFilter, type Config } from "./api.ts";
import type { Row } from "./db.ts";

// Frequency labels seen in the WDS code set for codes present in the sample; unseen codes show the raw number.
const FREQUENCY: Record<number, string> = { 1: "Daily", 6: "Monthly", 9: "Quarterly", 12: "Annual", 18: "Occasional", 21: "Occasional Daily" };
const ARCHIVED: Record<string, string> = { "1": "archived", "2": "current" };

const CSS = `
body{font:15px/1.45 system-ui,sans-serif;margin:0;color:#111}header{background:#1f2a44;color:#fff;padding:.6rem 1.2rem}
header a{color:#fff;text-decoration:none;font-weight:600}header small{opacity:.75;margin-left:1rem}main{max-width:70rem;margin:0 auto;padding:1rem 1.2rem}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}
th{background:#f3f4f6}.badge{display:inline-block;font-size:12px;padding:0 .4rem;border-radius:3px;background:#e5e7eb}.badge.ok{background:#d1fae5}
.badge.err{background:#fee2e2}form.filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:.6rem;margin:1rem 0}
label{display:block;font-size:13px;color:#444}input,select{width:100%;box-sizing:border-box;padding:.3rem}button{padding:.4rem .9rem}
details{margin:.4rem 0}summary{cursor:pointer}.muted{color:#666}.num{text-align:right;font-variant-numeric:tabular-nums}pre{white-space:pre-wrap}
.warn{background:#fef3c7;padding:.5rem .8rem;border-radius:4px}`;

function layout(title: string, buildId: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · StatCan data</title><style>${raw(CSS)}</style></head>
<body><header><a href="/">StatCan data</a><small>independent · build ${buildId} · <a href="/api/v1/openapi.json">API</a></small></header>
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
  const buildId = db.manifest.build_id;

  site.get("/", async (c) => {
    const q = c.req.query("q") ?? "";
    const archived = c.req.query("archived") ?? "";
    const queryable = c.req.query("queryable") === "true";
    const limit = 25;
    const offset = int(c.req.query("offset"), 0);
    const { total, rows } = await db.search(q, { archived: archived || undefined, queryable, limit, offset });
    const base = `/?q=${encodeURIComponent(q)}&archived=${archived}&queryable=${queryable}`;
    return c.html(layout("Search", buildId, html`
      <h1>Find a Statistics Canada table</h1>
      <p class="muted">${db.manifest.inventory.records.toLocaleString()} WDS tables in the inventory; ${db.manifest.summary.ok ?? 0} queryable in this build. Search titles, dimensions, members, and notes. Not an official Statistics Canada service.</p>
      <form class="filters" method="get" action="/">
        <label>Search<input name="q" value="${q}" placeholder="e.g. consumer price index food" autofocus></label>
        <label>Status<select name="archived"><option value="">any</option><option value="2" ${archived === "2" ? "selected" : ""}>current</option><option value="1" ${archived === "1" ? "selected" : ""}>archived</option></select></label>
        <label>Queryable only<input type="checkbox" name="queryable" value="true" ${queryable ? "checked" : ""} style="width:auto"></label>
        <label>&nbsp;<button>Search</button></label>
      </form>
      ${pager(base, total, limit, offset)}
      <table><tr><th>PID</th><th>Title</th><th>Frequency</th><th>Status</th><th>Dims</th><th>Period</th><th>Matched in</th></tr>
      ${rows.map((r) => html`<tr>
        <td><a href="/tables/${r.pid}">${r.pid}</a></td>
        <td>${r.title_en} ${r.queryable ? html`<span class="badge ok">queryable</span>` : ""}</td>
        <td>${FREQUENCY[r.frequency_code as number] ?? `code ${r.frequency_code}`}</td>
        <td>${ARCHIVED[r.archived as string] ?? r.archived}</td>
        <td class="num">${r.dimension_count}</td>
        <td>${String(r.cube_start_date).slice(0, 10)} – ${String(r.cube_end_date).slice(0, 10)}</td>
        <td class="muted">${["title", "dimension", "member", "note"].filter((f) => (r[`${f}_hits`] as number) > 0).join(", ")}</td>
      </tr>`)}
      </table>`));
  });

  site.get("/tables/:pid", async (c) => {
    const t = await db.table(c.req.param("pid"));
    if (!t) return c.html(layout("Not found", buildId, html`<h1>Unknown PID</h1>`), 404);
    const cube = t.cube;
    const build = t.build;
    const hasZip = captureDir !== undefined;
    return c.html(layout(`${t.pid}`, buildId, html`
      <h1>${cube.title_en}</h1>
      <p><span class="badge">PID ${t.pid}</span> ${cube.cansim_id ? html`<span class="badge">CANSIM ${cube.cansim_id}</span>` : ""}
        <span class="badge">${ARCHIVED[cube.archived as string] ?? cube.archived}</span>
        <span class="badge">${t.meta?.frequency ?? FREQUENCY[cube.frequency_code as number] ?? `frequency code ${cube.frequency_code}`}</span>
        <span class="badge">${String(cube.cube_start_date).slice(0, 10)} – ${String(cube.cube_end_date).slice(0, 10)}</span>
        ${build?.status === "ok" ? html`<span class="badge ok">queryable · ${(build.row_count ?? 0).toLocaleString()} rows</span>` : build ? html`<span class="badge err">build failed</span>` : html`<span class="badge">not built</span>`}</p>
      <p>
        ${build?.status === "ok" ? html`<a href="/tables/${t.pid}/observations">Browse observations</a> · <a href="/api/v1/tables/${t.pid}/observations">API JSON</a> · <a href="/api/v1/tables/${t.pid}/observations.parquet">Parquet</a> · ` : ""}
        <a href="/api/v1/tables/${t.pid}">Metadata JSON</a>
        ${hasZip ? html` · <a href="/api/v1/tables/${t.pid}/source.zip">Original ZIP</a>` : ""}
        · <a href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${t.pid}01" rel="external">statcan.gc.ca</a>
      </p>
      ${build && build.status !== "ok" ? html`<p class="warn">Not queryable in build ${buildId}: ${build.errors.join("; ")}</p>` : ""}
      ${build?.warnings.length ? html`<p class="warn">Build warnings: ${build.warnings.join("; ")}</p>` : ""}
      ${cube.title_fr ? html`<p class="muted" lang="fr">${cube.title_fr}</p>` : ""}

      <h2>Dimensions</h2>
      ${t.dimensions.length ? t.dimensions.map((d) => html`<details ${d.members.length <= 12 ? "open" : ""}>
        <summary><b>${d.dimension_id}. ${d.dimension_name}</b> <span class="muted">${d.members.length} members${d.dimension_notes ? ` · notes ${d.dimension_notes}` : ""}</span></summary>
        <table><tr><th>ID</th><th>Member</th><th>Code</th><th>Parent</th><th>Terminated</th><th>Notes</th></tr>
        ${d.members.map((m) => html`<tr><td class="num">${m.member_id}</td><td>${m.member_name}</td><td>${m.classification_code}</td><td class="num">${m.parent_member_id ?? ""}</td><td>${m.terminated}</td><td>${m.member_notes}</td></tr>`)}</table>
      </details>`) : html`<ol>${t.inventory_dimensions.map((d) => html`<li>${d.name_en}${d.has_uom ? html` <span class="muted">(carries unit of measure)</span>` : ""}</li>`)}</ol>
        <p class="muted">Member lists appear once this table is built.</p>`}

      ${t.notes.length ? html`<h2>Notes</h2><ol>${t.notes.map((n) => html`<li value="${n.note_id}"><pre>${n.note}</pre></li>`)}</ol>` : ""}
      ${t.corrections.length || t.inventory_corrections.length ? html`<h2>Corrections</h2>
        <table><tr><th>Date</th><th>Note</th></tr>
        ${t.corrections.map((r) => html`<tr><td>${r.correction_date}</td><td><pre>${r.correction_note}</pre></td></tr>`)}
        ${t.corrections.length ? "" : t.inventory_corrections.map((r) => html`<tr><td>${String(r.correction_date).slice(0, 10)}</td><td><pre>${r.note_en}</pre></td></tr>`)}</table>` : ""}
      ${t.symbols.length ? html`<h2>Symbols and status codes</h2><table>${t.symbols.map((s) => html`<tr><td><code>${s.symbol}</code></td><td>${s.description}</td></tr>`)}</table>` : ""}
      ${t.surveys.length ? html`<p class="muted">Survey: ${t.surveys.map((s) => `${s.survey_name} (${s.survey_code})`).join("; ")}. Subject: ${t.subjects.map((s) => `${s.subject_name} (${s.subject_code})`).join("; ")}.</p>` : ""}

      <h2>Provenance</h2>
      <table>
        <tr><td>Build</td><td>${buildId} (capture ${db.manifest.capture_id}, ${db.manifest.language})</td></tr>
        <tr><td>Inventory</td><td>${db.manifest.inventory.records.toLocaleString()} records, SHA-256 <code>${db.manifest.inventory.sha256}</code></td></tr>
        ${build ? html`<tr><td>Source ZIP</td><td>captured ${build.source_captured_at_utc}, SHA-256 <code>${build.source_sha256}</code></td></tr>` : ""}
        ${build?.parquet ? html`<tr><td>Parquet</td><td>${build.parquet.bytes.toLocaleString()} bytes, SHA-256 <code>${build.parquet.sha256}</code>; ref_date ${build.ref_date_min} – ${build.ref_date_max}; status codes ${JSON.stringify(build.status_counts)}</td></tr>` : ""}
        <tr><td>Release</td><td>${String(cube.release_time)}</td></tr>
      </table>`));
  });

  site.get("/tables/:pid/observations", async (c) => {
    const pid = c.req.param("pid");
    const t = await db.table(pid);
    if (!t) return c.html(layout("Not found", buildId, html`<h1>Unknown PID</h1>`), 404);
    if (t.build?.status !== "ok") return c.redirect(`/tables/${pid}`);
    const query = c.req.query();
    const filter = observationFilter(query);
    filter.limit = Math.min(filter.limit, 200);
    const result = (await db.observations(pid, filter))!;
    const dims = t.dimensions;
    const keep = Object.entries(query).filter(([k, v]) => v && k !== "offset").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return c.html(layout(`${pid} observations`, buildId, html`
      <h1><a href="/tables/${pid}">${t.cube.title_en}</a></h1>
      <p class="muted">${result.total.toLocaleString()} rows match. Raw values and status codes are shown as published; blank value means nothing was published. <a href="/api/v1/tables/${pid}/observations?${raw(keep)}">Same query as JSON</a>.</p>
      <form class="filters" method="get">
        ${dims.map((d, i) => html`<label>${d.dimension_name}
          ${d.members.length <= 300
            ? html`<select name="m${i + 1}"><option value="">all</option>${d.members.map((m) => html`<option value="${m.member_id}" ${query[`m${i + 1}`] === String(m.member_id) ? "selected" : ""}>${m.member_name}</option>`)}</select>`
            : html`<input name="m${i + 1}" value="${query[`m${i + 1}`] ?? ""}" placeholder="member ID (${d.members.length} members)">`}
        </label>`)}
        <label>From (ref_date)<input name="from" value="${query.from ?? ""}" placeholder="${t.build.ref_date_min}"></label>
        <label>To (ref_date)<input name="to" value="${query.to ?? ""}" placeholder="${t.build.ref_date_max}"></label>
        <label>Vector<input name="vector" value="${query.vector ?? ""}" placeholder="v…"></label>
        <label>&nbsp;<button>Filter</button></label>
      </form>
      ${pager(`/tables/${pid}/observations?${keep}`, result.total, result.limit, result.offset)}
      <table><tr><th>ref_date</th>${dims.map((d) => html`<th>${d.dimension_name}</th>`)}<th>value</th><th>status</th><th>symbol</th><th>unit</th><th>scale</th><th>vector</th><th>coordinate</th></tr>
      ${result.rows.map((r: Row) => html`<tr><td>${r.ref_date}</td>${dims.map((_, i) => html`<td>${r[`label_${i + 1}`]}</td>`)}
        <td class="num">${r.value}</td><td>${r.status}</td><td>${r.symbol}</td><td>${r.uom}</td><td>${r.scalar_factor}</td><td>${r.vector}</td><td>${r.coordinate}</td></tr>`)}
      </table>`));
  });

  return site;
}
