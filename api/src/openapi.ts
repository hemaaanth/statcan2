const pid = { name: "pid", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]{8}$" }, description: "WDS product ID" };
const paging = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000 } },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
];
const provenance = {
  build_id: { type: "string", description: "Build that produced this response. Pin it to reproduce results." },
  capture_id: { type: "string" },
  language: { type: "string", enum: ["en"] },
};
const filters = [
  { name: "from", in: "query", schema: { type: "string" }, description: "Inclusive lower REF_DATE, compared as text in the table's own format" },
  { name: "to", in: "query", schema: { type: "string" } },
  { name: "vector", in: "query", schema: { type: "string" }, description: "Series ID, e.g. v41690914" },
  ...Array.from({ length: 9 }, (_, i) => ({ name: `m${i + 1}`, in: "query", schema: { type: "integer" }, description: `Member ID for dimension ${i + 1}` })),
];

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "StatCan data API",
    version: "0.1.0",
    description: "Independent, read-only API over captured Statistics Canada WDS tables. Every response names the build it came from. Not an official Statistics Canada service. Data: Statistics Canada Open Licence.",
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/build": { get: { summary: "Build provenance", responses: { "200": { description: "Build ID, capture, inventory hash, queryable and failed tables" } } } },
    "/tables": {
      get: {
        summary: "Search the full WDS table inventory",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Whitespace-separated terms; all must match PID, CANSIM ID, title, dimension names, member names, or notes" },
          { name: "archived", in: "query", schema: { type: "string", enum: ["1", "2"] }, description: "Raw inventory code: 1 archived, 2 current" },
          { name: "queryable", in: "query", schema: { type: "boolean" }, description: "Only tables with observations in this build" },
          ...paging,
        ],
        responses: { "200": { description: "Results with per-field hit counts explaining the match", content: { "application/json": { schema: {
          type: "object", properties: { ...provenance, total: { type: "integer" }, results: { type: "array", items: { type: "object", properties: {
            pid: { type: "string" }, cansim_id: { type: "string", nullable: true }, title_en: { type: "string" }, archived: { type: "string" },
            frequency_code: { type: "integer" }, frequency_en: { type: "string", nullable: true, description: "Official WDS frequency label" },
            dimension_count: { type: "integer" }, queryable: { type: "boolean" },
            title_hits: { type: "integer" }, dimension_hits: { type: "integer" }, member_hits: { type: "integer" }, note_hits: { type: "integer" } } } } } } } } } },
      },
    },
    "/tables/{pid}": {
      get: {
        summary: "Table metadata: inventory record, official dimensions, members, notes, corrections, symbols, build report",
        parameters: [pid],
        responses: { "200": { description: "Metadata plus links" }, "404": { description: "Unknown PID" } },
      },
    },
    "/tables/{pid}/observations": {
      get: {
        summary: "Filtered, paginated observations with labels",
        description: "Raw `value`, `status`, `symbol`, and `ref_date` are the official strings. `value_num` is derived. Blank `value` means nothing was published; check `status`.",
        parameters: [pid, ...filters, ...paging],
        responses: { "200": { description: "Rows sorted by member IDs, ref_date, source row. `status_en` and `symbol_en` are official code-set descriptions next to the raw codes." }, "404": { description: "Not built" }, "409": { description: "Failed the build; errors included" } },
      },
    },
    "/tables/{pid}/series": {
      get: {
        summary: "One series per vector for a filter, for charts",
        description: "Each series has `vector`, `name`, `labels`, `unit`, `scale`, and `points: [ref_date, value_num, status]`. `value_num` is null when nothing was published; blank is not zero. At most 50 series and 200,000 points.",
        parameters: [pid, ...filters],
        responses: { "200": { description: "Series with provenance fields" }, "404": { description: "Not built" }, "409": { description: "Failed the build" }, "413": { description: "Too many series or points; add filters" } },
      },
    },
    "/tables/{pid}/observations.parquet": { get: { summary: "Whole-table Parquet for this build", parameters: [pid], responses: { "200": { description: "Parquet file; X-Content-SHA256 header" } } } },
    "/tables/{pid}/source.zip": { get: { summary: "Unchanged original Statistics Canada ZIP", parameters: [pid], responses: { "200": { description: "ZIP file; X-Content-SHA256 header" }, "404": { description: "Not captured or downloads disabled" } } } },
  },
};
