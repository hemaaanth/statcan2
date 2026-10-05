import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { Db, MAX_DIMS, MAX_LIMIT, MAX_SERIES, type SeriesDetailResult } from "./db.ts";
import { openapi } from "./openapi.ts";
import { statcanZipUrl } from "../public/render.js";

export interface Config {
  db: Db;
  captureDir?: string; // enables original ZIP downloads
}

export function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export function observationFilter(query: Record<string, string | undefined>) {
  return {
    from: query.from || undefined,
    to: query.to || undefined,
    vector: query.vector || undefined,
    members: Array.from({ length: MAX_DIMS }, (_, i) => (query[`m${i + 1}`] ? int(query[`m${i + 1}`], NaN) : undefined)),
    limit: int(query.limit, 100),
    offset: int(query.offset, 0),
  };
}

function file(filePath: string, name: string, type: string, extra: Record<string, string> = {}) {
  const size = statSync(filePath).size;
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
    headers: { "Content-Type": type, "Content-Length": String(size), "Content-Disposition": `attachment; filename="${name}"`, ...extra },
  });
}

export function apiRoutes({ db, captureDir }: Config) {
  const api = new Hono();
  const m = db.manifest;
  const n = db.normalized;
  const provenance = db.provenance;

  api.get("/openapi.json", (c) => c.json(openapi));

  api.get("/build", (c) => c.json({
    ...provenance, built_at_utc: m.built_at_utc, inventory: m.inventory, code_sets: db.codeSets, tool: m.tool, summary: m.summary,
    normalized: { build_id: n.build_id, built_at_utc: n.built_at_utc, clean: n.clean, cleans: n.cleans, codesets: n.codesets, refs: n.refs, tool: n.tool, files: n.files, stats: n.stats, warnings: n.warnings.length },
    queryable_tables: Object.entries(m.tables).filter(([, t]) => t.status === "ok").map(([pid]) => pid),
    failed_tables: Object.fromEntries(Object.entries(m.tables).filter(([, t]) => t.status !== "ok").map(([pid, t]) => [pid, t.errors])),
  }));

  api.get("/coverage", async (c) => c.json({ ...provenance, ...(await db.coverage(captureDir)) }));

  api.get("/tables", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(int(c.req.query("limit"), 50), MAX_LIMIT);
    const offset = int(c.req.query("offset"), 0);
    const archived = c.req.query("archived");
    if (archived && archived !== "1" && archived !== "2") return c.json({ error: "archived must be 1 or 2", ...provenance }, 400);
    const kind = c.req.query("kind");
    if (kind && kind !== "time_series" && kind !== "snapshot") return c.json({ error: "kind must be time_series or snapshot", ...provenance }, 400);
    const family = c.req.query("family") || undefined;
    const { total, rows } = await db.search(q, { archived, kind, family, queryable: c.req.query("queryable") === "true", limit, offset });
    return c.json({ ...provenance, q, total, limit, offset, results: rows });
  });

  api.get("/series", async (c) => {
    const q = c.req.query("q") ?? "";
    const pid = c.req.query("pid") || undefined;
    if (pid && !/^[0-9]{8}$/.test(pid)) return c.json({ error: "pid must be 8 digits", ...provenance }, 400);
    const filters = { pid, place_id: c.req.query("place_id") || undefined, unit_family: c.req.query("unit_family") || undefined };
    const limit = Math.min(int(c.req.query("limit"), 50), MAX_LIMIT);
    const offset = int(c.req.query("offset"), 0);
    const { total, rows, limited } = await db.seriesSearch({ q, ...filters, limit, offset });
    if (limited) c.header("X-Statcan-Search-Scope", "capped");
    return c.json({ ...provenance, q, ...filters, total, limit, offset, results: rows });
  });

  function seriesResponse(c: Context, pid: string, result: SeriesDetailResult) {
    const report = m.tables[pid];
    switch (result.kind) {
      case "not_found": return c.json({ error: "unknown series", ...provenance }, 404);
      case "too_many_points": return c.json({ error: `more than ${result.limit} points`, ...provenance }, 413);
      case "inconsistent": return c.json({ error: `Normalized series row says ${result.n_obs} observations, the table has ${result.points} for this coordinate. The Normalized build failed its series consistency contract.`, ...provenance }, 409);
      case "ok": return c.json({ ...provenance, citation: db.citation(pid), source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256,
        links: { table: `/api/v1/tables/${pid}`, html: `/series/${pid}/${result.series.vector || `c/${result.series.coordinate}`}` }, ...result.series });
    }
  }

  api.get("/series/:pid/c/:coordinate", async (c) => {
    const { pid, coordinate } = c.req.param();
    if (!/^[0-9]+(\.[0-9]+)*$/.test(coordinate)) return c.json({ error: "coordinate must look like 1.2.3", ...provenance }, 400);
    return seriesResponse(c, pid, await db.seriesGet(pid, { coordinate }));
  });

  api.get("/series/:pid/:vector", async (c) => {
    const { pid, vector } = c.req.param();
    if (!/^v[0-9]+$/.test(vector)) return c.json({ error: "vector must look like v41690915; Census series use /series/{pid}/c/{coordinate}", ...provenance }, 400);
    return seriesResponse(c, pid, await db.seriesGet(pid, { vector }));
  });

  api.get("/places", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(int(c.req.query("limit"), 50), MAX_LIMIT);
    const offset = int(c.req.query("offset"), 0);
    const { total, rows } = await db.places(q, limit, offset);
    return c.json({ ...provenance, q, total, limit, offset, results: rows });
  });

  api.get("/places/:place_id", async (c) => {
    const place = await db.place(c.req.param("place_id"));
    if (!place) return c.json({ error: "unknown place_id", ...provenance }, 404);
    return c.json({ ...provenance, ...place, links: { html: `/places/${encodeURIComponent(String(place.place.place_id))}` } });
  });

  api.get("/tables/:pid", async (c) => {
    const table = await db.table(c.req.param("pid"));
    if (!table) return c.json({ error: "unknown PID", ...provenance }, 404);
    const pid = table.pid;
    const links: Record<string, string> = { self: `/api/v1/tables/${pid}`, html: `/tables/${pid}` };
    if (table.build?.status === "ok") {
      links.observations = `/api/v1/tables/${pid}/observations`;
      links.parquet = `/api/v1/tables/${pid}/observations.parquet`;
    }
    links.source_zip = `/api/v1/tables/${pid}/source.zip`;
    return c.json({ ...provenance, ...table, links });
  });

  api.get("/tables/:pid/observations", async (c) => {
    const pid = c.req.param("pid");
    const report = m.tables[pid];
    if (report?.status !== "ok") {
      return c.json({ error: report ? "table failed the build" : "table not built", ...provenance, build: report ?? null }, report ? 409 : 404);
    }
    const filter = observationFilter(c.req.query());
    if (filter.members.some((v) => v !== undefined && Number.isNaN(v))) return c.json({ error: "m1..m9 must be integers" }, 400);
    const result = await db.observations(pid, filter);
    return c.json({ ...provenance, pid, source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256,
      filter: { from: filter.from, to: filter.to, vector: filter.vector, members: filter.members.slice(0, report.dims) }, ...result });
  });

  api.get("/tables/:pid/series", async (c) => {
    const pid = c.req.param("pid");
    const report = m.tables[pid];
    if (report?.status !== "ok") {
      return c.json({ error: report ? "table failed the build" : "table not built", ...provenance, build: report ?? null }, report ? 409 : 404);
    }
    const filter = observationFilter(c.req.query());
    if (filter.members.some((v) => v !== undefined && Number.isNaN(v))) return c.json({ error: "m1..m9 must be integers" }, 400);
    const result = (await db.series(pid, filter, MAX_SERIES))!;
    if (result.kind === "too_many_vectors") return c.json({ error: `more than ${result.limit} series match; add filters (m1..m9, vector, from, to)`, ...provenance }, 413);
    if (result.kind === "too_many_points") return c.json({ error: `more than ${result.limit} points match; add filters (m1..m9, vector, from, to)`, ...provenance }, 413);
    return c.json({ ...provenance, pid, source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256,
      filter: { from: filter.from, to: filter.to, vector: filter.vector, members: filter.members.slice(0, report.dims) },
      total_points: result.total_points, series: result.series });
  });

  api.get("/tables/:pid/observations.parquet", (c) => {
    const pid = c.req.param("pid");
    const filePath = db.parquetPath(pid);
    if (!filePath) return c.json({ error: "table not queryable" }, 404);
    return file(filePath, `${pid}-${m.build_id}.parquet`, "application/vnd.apache.parquet", { "X-Content-SHA256": m.tables[pid].parquet!.sha256 });
  });

  api.get("/tables/:pid/source.zip", (c) => {
    const pid = c.req.param("pid");
    const zip = db.sourceZipPath(pid, captureDir);
    // Without the capture, send the client to the same file at Statistics Canada. It may be newer than this build's source_sha256.
    if (!zip) return db.info.has(pid) ? c.redirect(statcanZipUrl(pid), 302) : c.json({ error: "unknown PID", ...provenance }, 404);
    const hash = m.tables[pid].source_sha256;
    return file(zip, `${pid}-eng.zip`, "application/zip", hash ? { "X-Content-SHA256": hash } : {});
  });

  return api;
}
