import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import type { Db } from "./db.ts";
import { getCube } from "./cube.ts";
import { ViewSpec, decodeSpec } from "./spec.ts";
import { exportHash, exportRows, quoteSql, runView, suggestViews } from "./view.ts";
import { regions } from "./regions.ts";
import { loadHighlights, type Highlights } from "./highlights.ts";

export function chartRoutes({ db }: { db: Db }) {
  const api = new Hono();
  const provenance = db.provenance;
  api.get("/regions", (c) => c.json({ ...provenance, regions }));
  let highlights: Promise<Highlights> | undefined;
  api.get("/highlights", async (c) => {
    const cards = await (highlights ??= loadHighlights(db).catch((error) => { highlights = undefined; throw error; }));
    return c.json(cards);
  });
  api.get("/cubes", async (c) => {
    const q = c.req.query("q") ?? "";
    const rawLimit = Number(c.req.query("limit") ?? 25);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) return c.json({ error: "limit must be 1..100", ...provenance }, 400);
    const search = await db.search(q, { limit: rawLimit, offset: 0, queryable: true });
    return c.json({ ...provenance, q, total: search.total, results: search.rows.filter((r) => db.parquetPath(String(r.pid))).map((r) => ({
      pid: r.pid, table_number: `${String(r.pid).slice(0, 2)}-${String(r.pid).slice(2, 4)}-${String(r.pid).slice(4)}-01`,
      title: r.title_en, frequency: r.frequency_en, period_min: r.period_min, period_max: r.period_max,
      family: r.family, unit_families: r.unit_families,
    })) });
  });
  api.get("/cubes/:pid/views", async (c) => {
    const views = await suggestViews(db, c.req.param("pid"));
    return views ? c.json({ ...provenance, views }) : c.json({ error: "unknown PID", ...provenance }, 404);
  });
  api.get("/cubes/:pid", async (c) => {
    const cube = await getCube(db, c.req.param("pid"));
    return cube ? c.json({ ...provenance, ...cube }) : c.json({ error: "unknown PID", ...provenance }, 404);
  });
  async function parsedSpec(c: Context) {
    try {
      const raw: unknown = c.req.method === "GET" ? decodeSpec(c.req.query("s") ?? "") : await c.req.json();
      return ViewSpec.safeParse(raw);
    } catch { return ViewSpec.safeParse(null); }
  }
  async function handle(c: Context, format?: "parquet" | "csv") {
    const parsed = await parsedSpec(c);
    if (!parsed.success) return c.json({ error: "invalid ViewSpec", details: parsed.error.issues, ...provenance }, 400);
    const outcome = await runView(db, parsed.data);
    if (outcome.kind === "invalid") return c.json({ error: outcome.error, ...provenance }, outcome.status);
    if (!format) return c.json(outcome.result);
    const result = outcome.result;
    const rows = exportRows(result);
    const file = path.join(db.buildDir, "tmp", `${randomUUID()}.${format}`);
    const citations = result.sources.map((s) => s.citation).join("\n");
    const kv = `KV_METADATA { 'statcan.spec': ${quoteSql(JSON.stringify(result.spec))}, 'statcan.citations': ${quoteSql(citations)},
      'statcan.build_id': ${quoteSql(result.build_id)}, 'statcan.normalized_build_id': ${quoteSql(result.normalized_build_id)},
      'statcan.group_notes': ${quoteSql(JSON.stringify(result.group_notes))},
      'statcan.gap_note': ${quoteSql(result.gap_note ?? "")},
      'statcan.notes_url': ${quoteSql(`${result.links.page}#notes`)} }`;
    // JSON is only an in-memory query parameter. Dataset bytes and COPY output stay on the build filesystem.
    const statement = `COPY (SELECT
      value->>'series_key' AS series_key, value->>'series_name' AS series_name, (value->>'layer')::INTEGER AS layer,
      value->>'pid' AS pid, value->>'table_number' AS table_number,
      from_json(value->'vectors', '["VARCHAR"]') AS vectors,
      from_json(value->'coordinate', '[{"dimension":"VARCHAR","members":"VARCHAR"}]') AS coordinate,
      value->>'category' AS category, value->>'ref_date' AS ref_date,
      (value->>'period_start')::DATE AS period_start, (value->>'period_end')::DATE AS period_end,
      (value->>'value')::DOUBLE AS value, value->>'value_published' AS value_published,
      value->>'status' AS status, value->>'unit' AS unit, value->>'scale' AS scale,
      value->>'unit_family' AS unit_family, value->>'transform' AS transform, (value->>'hidden')::BOOLEAN AS hidden,
      value->>'group' AS "group", value->>'group_method' AS group_method,
      from_json(value->'group_members', '["VARCHAR"]') AS group_members
      FROM json_each($1)) TO ${quoteSql(file)} (FORMAT ${format}, ${format === "parquet" ? kv : "HEADER true"})`;
    try {
      await fs.mkdir(path.join(db.buildDir, "tmp"), { recursive: true });
      if (format === "parquet") await db.query(statement, [JSON.stringify(rows)]);
      else {
        // CSV has JSON text in its list columns, rather than DuckDB's list rendering.
        await db.query(statement.replace("from_json(value->'vectors', '[\"VARCHAR\"]')", "(value->'vectors')::VARCHAR")
          .replace("from_json(value->'coordinate', '[{\"dimension\":\"VARCHAR\",\"members\":\"VARCHAR\"}]')", "(value->'coordinate')::VARCHAR")
          .replace("from_json(value->'group_members', '[\"VARCHAR\"]')", "(value->'group_members')::VARCHAR"), [JSON.stringify(rows)]);
      }
      const stat = await fs.stat(file);
      const stream = Readable.from((async function* () {
        try { for await (const chunk of createReadStream(file)) yield chunk; }
        finally { await fs.unlink(file).catch(() => {}); }
      })());
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: { "Content-Type": format === "parquet" ? "application/vnd.apache.parquet" : "text/csv; charset=utf-8",
          "Content-Length": String(stat.size), "Content-Disposition": `attachment; filename="statcan-view-${exportHash(result.spec)}.${format}"`,
          "X-Statcan-Build": result.build_id, "X-Statcan-Normalized-Build": result.normalized_build_id },
      });
    } catch (error) {
      await fs.unlink(file).catch(() => {});
      throw error;
    }
  }
  api.get("/view", (c) => handle(c));
  api.post("/view", (c) => handle(c));
  for (const format of ["parquet", "csv"] as const) {
    api.get(`/view.${format}`, (c) => handle(c, format));
    api.post(`/view.${format}`, (c) => handle(c, format));
  }
  return api;
}
