import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openFromEnv } from "./config.ts";
import { isTimeSeries, MAX_DIMS, MAX_LIMIT, MAX_SERIES, type ObservationFilter } from "./db.ts";

// stdout belongs to the MCP protocol. Anything else goes to stderr.
const { db } = await openFromEnv();
const buildId = db.manifest.build_id;

const NOT_OFFICIAL = "The data is not official: it is an independent copy of Statistics Canada tables, not produced or endorsed by Statistics Canada.";
const BLANK_NOT_ZERO = "A blank value is not zero: value_num is null when nothing was published, so read status and symbol before using it.";
const FILTERS = "Filters: from/to are inclusive ref_date strings compared as text; vector is a series ID such as v41690914; m1..m9 are member IDs for dimensions 1..9 (see get_table).";

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

function ok(data: Record<string, unknown>) {
  const body = { build_id: buildId, ...data };
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ build_id: buildId, error: message }) }] };
}

/** The table must exist and be built before its observations can be read. */
function queryable(pid: string): string | undefined {
  const report = db.manifest.tables[pid];
  if (!report) return `table ${pid} is not built in build ${buildId}; use get_table to read its metadata`;
  if (report.status !== "ok") return `table ${pid} failed the build: ${report.errors.join("; ")}`;
  return undefined;
}

async function titleOf(pid: string) {
  return (await db.one("SELECT title_en FROM cube WHERE pid = $1", [pid]))?.title_en;
}

const server = new McpServer({ name: "statcan", version: "0.1.0" });
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

server.registerTool("search_tables", {
  description: `Search the Statistics Canada table inventory by whitespace-separated terms; every term must match the table ID, title, dimension names, member names, or notes. Each result has a frequency label, dates, whether this build holds its observations (queryable), and hit counts that show why it matched. ${NOT_OFFICIAL}`,
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
    citation: `Statistics Canada Web Data Service table inventory, ${db.manifest.inventory.records} records, capture ${db.manifest.capture_id}, build ${buildId}`,
    note: NOT_OFFICIAL, q, total, results: rows.map((r) => ({ ...r, citation: db.citation(String(r.pid), r.title_en) })),
  });
});

server.registerTool("get_table", {
  description: `Get one table's metadata: title, official frequency, subject and survey names, dimensions with every member and its member ID, notes, corrections, symbol legend, and the build report. Use it to find the member IDs that filter get_series and get_observations. ${NOT_OFFICIAL}`,
  inputSchema: { pid: pidSchema },
  annotations: { title: "Get table metadata", ...readOnly },
}, async ({ pid }) => {
  const table = await db.table(pid);
  if (!table) return fail(`unknown PID ${pid}`);
  return ok({ citation: db.citation(pid, table.cube.title_en), note: NOT_OFFICIAL, queryable: table.build?.status === "ok", time_series: isTimeSeries(table.cube), ...table });
});

server.registerTool("get_series", {
  description: `Get time series for a filter: one series per vector, each with member labels, unit, scale, and points [ref_date, value_num, status]. At most ${MAX_SERIES} series; add filters if there are more. ${FILTERS} ${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`,
  inputSchema: { pid: pidSchema, ...filters },
  annotations: { title: "Get series", ...readOnly },
}, async ({ pid, ...args }) => {
  const problem = queryable(pid);
  if (problem) return fail(problem);
  const result = (await db.series(pid, toFilter(args), MAX_SERIES))!;
  if (result.kind === "too_many_vectors") return fail(`more than ${result.limit} series match; add filters (m1..m9, vector, from, to)`);
  if (result.kind === "too_many_points") return fail(`more than ${result.limit} points match; add filters (m1..m9, vector, from, to)`);
  const report = db.manifest.tables[pid];
  return ok({ citation: db.citation(pid, await titleOf(pid)), note: `${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, pid,
    source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256, total_points: result.total_points, series: result.series });
});

server.registerTool("get_observations", {
  description: `Get observation rows for a filter, with member labels. Values are the raw published strings: value, status, symbol, ref_date. value_num is derived, and status_en and symbol_en explain the codes. Page with limit (max ${MAX_LIMIT}) and offset; total counts every matching row. ${FILTERS} ${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`,
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
  return ok({ citation: db.citation(pid, await titleOf(pid)), note: `${NOT_OFFICIAL} ${BLANK_NOT_ZERO}`, pid,
    source_sha256: report.source_sha256, parquet_sha256: report.parquet?.sha256, ...result });
});

await server.connect(new StdioServerTransport());
console.error(`statcan MCP server: build ${buildId}, code sets ${db.codeSets.sha256.slice(0, 12)}, on stdio`);
