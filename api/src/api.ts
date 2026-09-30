import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { Db, MAX_DIMS, MAX_LIMIT, MAX_SERIES } from "./db.ts";
import { openapi } from "./openapi.ts";

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
  const provenance = { build_id: m.build_id, capture_id: m.capture_id, language: m.language };

  api.use("*", async (c, next) => {
    c.header("X-Statcan-Build", m.build_id);
    await next();
  });

  api.get("/openapi.json", (c) => c.json(openapi));

  api.get("/build", (c) => c.json({
    ...provenance, built_at_utc: m.built_at_utc, inventory: m.inventory, code_sets: db.codeSets, tool: m.tool, summary: m.summary,
    queryable_tables: Object.entries(m.tables).filter(([, t]) => t.status === "ok").map(([pid]) => pid),
    failed_tables: Object.fromEntries(Object.entries(m.tables).filter(([, t]) => t.status !== "ok").map(([pid, t]) => [pid, t.errors])),
  }));

  api.get("/tables", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(int(c.req.query("limit"), 50), MAX_LIMIT);
    const offset = int(c.req.query("offset"), 0);
    const archived = c.req.query("archived");
    if (archived && archived !== "1" && archived !== "2") return c.json({ error: "archived must be 1 or 2" }, 400);
    const { total, rows } = await db.search(q, { archived, queryable: c.req.query("queryable") === "true", limit, offset });
    return c.json({ ...provenance, q, total, limit, offset, results: rows });
  });

  api.get("/tables/:pid", async (c) => {
    const table = await db.table(c.req.param("pid"));
    if (!table) return c.json({ error: "unknown PID" }, 404);
    const pid = table.pid;
    const links: Record<string, string> = { self: `/api/v1/tables/${pid}`, html: `/tables/${pid}` };
    if (table.build?.status === "ok") {
      links.observations = `/api/v1/tables/${pid}/observations`;
      links.parquet = `/api/v1/tables/${pid}/observations.parquet`;
    }
    if (captureDir && existsSync(path.join(captureDir, "zips", `${pid}-en.zip`))) links.source_zip = `/api/v1/tables/${pid}/source.zip`;
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
    if (!/^[0-9]{8}$/.test(pid) || !captureDir) return c.json({ error: "source download not available" }, 404);
    const zip = path.join(captureDir, "zips", `${pid}-en.zip`);
    if (!existsSync(zip)) return c.json({ error: "source ZIP not captured" }, 404);
    const headers: Record<string, string> = {};
    const manifest = path.join(captureDir, "manifests", `${pid}-en.json`);
    if (existsSync(manifest)) headers["X-Content-SHA256"] = JSON.parse(readFileSync(manifest, "utf8")).sha256;
    return file(zip, `${pid}-eng.zip`, "application/zip", headers);
  });

  return api;
}
