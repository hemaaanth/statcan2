import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicOrigin } from "./config.ts";
import { MAX_DIMS, MAX_LIMIT, MAX_SERIES, type Db, type ObservationFilter } from "./db.ts";
import { getCube } from "./cube.ts";
import { ViewSpec } from "./spec.ts";
import { runView } from "./view.ts";
import { planQuery } from "./planner.ts";

const NOT_OFFICIAL = `The data is not official: it is an independent copy of Statistics Canada tables, not produced or endorsed by Statistics Canada. Explore the published site at ${publicOrigin()}.`;
const BLANK_NOT_ZERO = "A blank value is not zero: value_num is null when nothing was published, so read status and symbol before using it.";
const FILTERS = "Filters: from/to are inclusive ref_date strings compared as text; vector is a series ID such as v41690914; m1..m9 are member IDs for dimensions 1..9 (see get_table).";
/** Public tool catalogue for the /mcp page; argument names match the registered schemas. */
export const mcpTools = [
  { name: "search_tables", description: `Search the Statistics Canada table inventory by whitespace-separated terms; every term must match the table ID, title, dimension names, member names, or notes. Each result has a frequency label, dates, whether this build holds its observations (queryable), and hit counts that show why it matched. ${NOT_OFFICIAL}`, args: ["q", "archived", "queryable", "limit"] },
  { name: "search_series", description: `Search series (one line of a table: one vector, or one coordinate in Census tables). Every word must appear in the table title or in the series' member labels; a term like v41690915 must equal the vector. Filter by pid, place_id (from get_place), or unit_family (percent, count, currency, index, mass, time, volume, rate, other). Each result has labels, place, unit, period range, observation counts, and a citation. Read points with get_series (pid + vector). ${NOT_OFFICIAL}`, args: ["q", "pid", "place_id", "unit_family", "limit"] },
  { name: "get_place", description: `Get a place: its level, schema and geo_code, every vintage of it (same schema and geo_code, e.g. Ontario 2011, 2016, 2021 DGUIDs), its parent, and every table that covers it, grouped by subject, with the member ID to filter on (m1), the number of series, and a citation per table. Find place_id values with search_series results or get_table members. ${NOT_OFFICIAL}`, args: ["place_id"] },
  { name: "get_table", description: `Get one table's metadata: title, official frequency, subject and survey names, dimensions with every member and its member ID, notes, corrections, symbol legend, and the build report. Use it to find the member IDs that filter get_series and get_observations. ${NOT_OFFICIAL}`, args: ["pid"] },
  { name: "get_series", description: `Get time series for a filter: one series per coordinate (the vector in WDS tables), each with member labels, unit, scale, period_kind, and points [ref_date, value_num, status, period_start, period_end]. At most ${MAX_SERIES} series; add filters if there are more. ${FILTERS} ${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, args: ["pid", "from", "to", "vector", ...Array.from({ length: MAX_DIMS }, (_, i) => `m${i + 1}`)] },
  { name: "get_observations", description: `Get observation rows for a filter, with member labels, place_id for dimension 1, unit_family, and period_start, period_end, period_kind. Values are the raw published strings: value, status, symbol, ref_date. value_num is derived, and status_en and symbol_en explain the codes. Page with limit (max ${MAX_LIMIT}) and offset; total counts every matching row. ${FILTERS} ${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, args: ["pid", "from", "to", "vector", ...Array.from({ length: MAX_DIMS }, (_, i) => `m${i + 1}`), "limit", "offset"] },
  { name: "get_cube", description: `Get a chartable table's dimensions, member IDs, roles, defaults, units, and period range. ${NOT_OFFICIAL}`, args: ["pid"] },
  { name: "run_view", description: `Run a chart spec across table layers. Returns resolved selections, plotted values, sources, and notes. ${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, args: ["spec"] },
  { name: "plan_chart", description: `Turn a question into an editable chart spec using the planner. A fragment returns need_more; an unrelated query returns no_match. ${NOT_OFFICIAL}`, args: ["q"] },
];

const filters = {
  from: z.string().optional().describe("Inclusive lower ref_date, compared as text, e.g. 2020-01"),
  to: z.string().optional().describe("Inclusive upper ref_date"),
  vector: z.string().optional().describe("Series ID, e.g. v41690914"),
  ...Object.fromEntries(Array.from({ length: MAX_DIMS }, (_, i) => [`m${i + 1}`, z.number().int().optional().describe(`Member ID for dimension ${i + 1}`)])),
};
const pidSchema = z.string().regex(/^[0-9]{8}$/).describe("WDS product ID, 8 digits, e.g. 18100006 for table 18-10-0006-01");

function toFilter(args: Record<string, unknown>): ObservationFilter {
  return {
    from: args.from as string | undefined,
    to: args.to as string | undefined,
    vector: args.vector as string | undefined,
    members: Array.from({ length: MAX_DIMS }, (_, i) => args[`m${i + 1}`] as number | undefined),
  };
}

export function createMcpServer(db: Db) {
const buildId = db.manifest.build_id;
function ok(data: Record<string, unknown>) {
  const body = { ...db.provenance, ...data };
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ...db.provenance, error: message }) }] };
}

/** The table must exist and be built before its observations can be read. */
function queryable(pid: string): string | undefined {
  const report = db.manifest.tables[pid];
  if (!report) return `table ${pid} is not built in build ${buildId}; use get_table to read its metadata`;
  if (report.status !== "ok") return `table ${pid} failed the build: ${report.errors.join("; ")}`;
  return undefined;
}

const server = new McpServer({ name: "statcan", version: "0.1.0" });
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

server.registerTool("search_tables", {
  description: mcpTools[0].description,
  inputSchema: {
    q: z.string().describe("Search terms, e.g. consumer price index food"),
    archived: z.enum(["1", "2"]).optional().describe("Raw inventory code: 1 archived, 2 current"),
    queryable: z.boolean().optional().describe("Only tables whose observations are in this build"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
  },
  annotations: { title: "Search tables", ...readOnly },
}, async ({ q, archived, queryable: onlyQueryable, limit }) => {
  const { total, rows } = await db.search(q, { archived, queryable: onlyQueryable, limit: limit ?? 25, offset: 0 });
  return ok({
    citation: `Statistics Canada Web Data Service table inventory, ${db.info.size} records, capture ${db.manifest.capture_id}, build ${buildId}, normalized ${db.normalized.build_id}`,
    note: NOT_OFFICIAL, q, total, results: rows.map((r) => ({ ...r, citation: db.citation(String(r.pid)) })),
  });
});

server.registerTool("search_series", {
  description: mcpTools[1].description,
  inputSchema: {
    q: z.string().describe("Search words, e.g. consumer price index food ontario; may be empty when a filter is given"),
    pid: pidSchema.optional(),
    place_id: z.string().optional().describe("Exact place_id, e.g. 2021A000235 or code:0002:35"),
    unit_family: z.string().optional().describe("Unit family, e.g. percent"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
  },
  annotations: { title: "Search series", ...readOnly },
}, async ({ q, pid, place_id, unit_family, limit }) => {
  const { total, rows, limited } = await db.seriesSearch({ q, pid, place_id, unit_family, limit: limit ?? 25, offset: 0 });
  return ok({ note: limited ? `${NOT_OFFICIAL} Broad search is capped to 12 tables and 5,000 series rows. Total counts only that subset; supply pid for exhaustive results.` : NOT_OFFICIAL,
    q, total, results: rows.map((r) => ({ ...r, citation: db.citation(String(r.pid)) })) });
});

server.registerTool("get_place", {
  description: mcpTools[2].description,
  inputSchema: { place_id: z.string().describe("place_id, e.g. 2021A000235 (a DGUID) or code:0002:35") },
  annotations: { title: "Get place", ...readOnly },
}, async ({ place_id }) => {
  const place = await db.place(place_id);
  if (!place) return fail(`unknown place_id ${place_id}`);
  return ok({ citation: `Places from Normalized build ${db.normalized.build_id} of build ${buildId}; each table below carries its own Statistics Canada citation`, note: NOT_OFFICIAL, ...place });
});

server.registerTool("get_table", {
  description: mcpTools[3].description,
  inputSchema: { pid: pidSchema },
  annotations: { title: "Get table metadata", ...readOnly },
}, async ({ pid }) => {
  const table = await db.table(pid);
  if (!table) return fail(`unknown PID ${pid}`);
  return ok({ citation: db.citation(pid), note: NOT_OFFICIAL, queryable: table.build?.status === "ok", time_series: table.cube.kind === "time_series", ...table });
});

server.registerTool("get_series", {
  description: mcpTools[4].description,
  inputSchema: { pid: pidSchema, ...filters },
  annotations: { title: "Get series", ...readOnly },
}, async ({ pid, ...args }) => {
  const problem = queryable(pid);
  if (problem) return fail(problem);
  const result = (await db.series(pid, toFilter(args), MAX_SERIES))!;
  if (result.kind === "too_many_vectors") return fail(`more than ${result.limit} series match; add filters (m1..m9, vector, from, to)`);
  if (result.kind === "too_many_points") return fail(`more than ${result.limit} points match; add filters (m1..m9, vector, from, to)`);
  const report = db.manifest.tables[pid];
  return ok({ citation: db.citation(pid), note: `${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, pid,
    source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256, total_points: result.total_points, series: result.series });
});

server.registerTool("get_observations", {
  description: mcpTools[5].description,
  inputSchema: {
    pid: pidSchema, ...filters,
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Rows per page, default 100"),
    offset: z.number().int().min(0).optional().describe("Rows to skip, default 0"),
  },
  annotations: { title: "Get observations", ...readOnly },
}, async ({ pid, limit, offset, ...args }) => {
  const problem = queryable(pid);
  if (problem) return fail(problem);
  const result = (await db.observations(pid, { ...toFilter(args), limit: limit ?? 100, offset: offset ?? 0 }))!;
  const report = db.manifest.tables[pid];
  return ok({ citation: db.citation(pid), note: `${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, pid,
    source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256, ...result });
});

server.registerTool("get_cube", {
  description: mcpTools[6].description,
  inputSchema: { pid: pidSchema },
  annotations: { title: "Get chart cube", ...readOnly },
}, async ({ pid }) => {
  const cube = await getCube(db, pid);
  return cube ? ok({ cube, citation: db.citation(pid), note: NOT_OFFICIAL }) : fail(`unknown or unbuilt PID ${pid}`);
});

server.registerTool("run_view", {
  description: mcpTools[7].description,
  inputSchema: { spec: ViewSpec },
  annotations: { title: "Run chart view", ...readOnly },
}, async ({ spec }) => {
  const outcome = await runView(db, spec);
  if (outcome.kind === "invalid") return fail(outcome.error);
  const { series, ...rest } = outcome.result;
  return ok({ ...rest, series: series.map(({ points, ...meta }) => ({
    ...meta, points: points.map(([ref_date, , value, status]) => [ref_date, value, status]),
  })) });
});

server.registerTool("plan_chart", {
  description: mcpTools[8].description,
  inputSchema: { q: z.string().min(1) },
  annotations: { title: "Plan chart", ...readOnly },
}, async ({ q }) => ok({ ...await planQuery(db, q), note: NOT_OFFICIAL }));

return server;
}
