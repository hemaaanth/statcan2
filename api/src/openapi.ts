const pid = { name: "pid", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]{8}$" }, description: "WDS product ID" };
const paging = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000 } },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
];
const provenance = {
  build_id: { type: "string", description: "Clean build that produced this response. Pin it to reproduce results." },
  normalized_build_id: { type: "string", description: "Normalized build (normalized/<id>/ of that Clean build) that produced this response." },
  capture_id: { type: "string" },
  language: { type: "string", enum: ["en"] },
};
const filters = [
  { name: "from", in: "query", schema: { type: "string" }, description: "Inclusive lower REF_DATE, compared as text in the table's own format" },
  { name: "to", in: "query", schema: { type: "string" } },
  { name: "vector", in: "query", schema: { type: "string" }, description: "Series ID, e.g. v41690914" },
  ...Array.from({ length: 9 }, (_, i) => ({ name: `m${i + 1}`, in: "query", schema: { type: "integer" }, description: `Member ID for dimension ${i + 1}` })),
];
const period = {
  period_start: { type: ["string", "null"], format: "date", description: "First day of the period; null when ref_date has no known shape" },
  period_end: { type: ["string", "null"], format: "date" },
  period_kind: { type: "string", enum: ["day", "week", "month", "quarter", "half_year", "year", "fiscal_year", "multi_year", "other"] },
};
const json = (description: string, properties: Record<string, unknown> = {}) => ({
  description, content: { "application/json": { schema: { type: "object", properties: { ...provenance, ...properties } } } },
});
const seriesRow = {
  type: "object", properties: {
    pid: { type: "string" }, vector: { type: "string", description: "Empty in Census tables" }, coordinate: { type: "string" }, title_en: { type: "string" }, kind: { type: "string" },
    labels: { type: "array", items: { type: "string" }, description: "Member names, dimension order" },
    place_id: { type: ["string", "null"] }, place_name: { type: ["string", "null"] }, uom_code: { type: ["integer", "null"] }, uom_en: { type: ["string", "null"] },
    unit_family: { type: ["string", "null"] }, scalar_code: { type: ["integer", "null"] }, scalar_en: { type: ["string", "null"] }, decimals: { type: ["integer", "null"] },
    period_kind: period.period_kind, period_min: { type: "string", format: "date" }, period_max: { type: "string", format: "date" },
    n_obs: { type: "integer" }, n_published: { type: "integer" }, terminated: { type: "boolean" }, last_status: { type: "string" },
    links: { type: "object", properties: { self: { type: "string" }, html: { type: "string" } } },
  },
};
const seriesDetail = {
  summary: "One series: Normalized metadata and every point",
  description: "Labels, place, unit (`uom_en`, `unit_family`, `unit_symbol`, `unit_base_year`), scale, period range, counts, a citation, and `points` with `ref_date`, `period_start`, `period_end`, `period_kind`, raw `value`, `value_num`, `status`, `status_en`, `symbol`, `symbol_en`. Blank `value` means nothing was published; it is not zero.",
};
const seriesErrors = { "404": { description: "Unknown series" }, "409": { description: "The Normalized row does not match the observations (Census rows collapsed by the current normalizer)" }, "413": { description: "More than 200,000 points" } };

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "StatCan data API",
    version: "0.2.0",
    description: "Independent, read-only API over captured Statistics Canada WDS tables. Every response names the Clean and Normalized builds it came from (JSON fields and the X-Statcan-Build, X-Statcan-Normalized-Build headers). Not an official Statistics Canada service. Data: Statistics Canada Open Licence.",
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/build": { get: { summary: "Build provenance", responses: { "200": { description: "Clean build ID, capture, inventory hash, code sets, the Normalized manifest (clean build, code-set hash, files, stats), queryable and failed tables" } } } },
    "/coverage": {
      get: {
        summary: "How much of the inventory is captured, built, and queryable",
        responses: { "200": json("Counts, per-family counts, failed tables with build errors, upstream gaps with the downloader's last error, Normalized build warnings", {
          inventory: { type: "integer" }, captured: { type: ["integer", "null"], description: "null when the server has no capture directory" },
          built: { type: "integer" }, queryable: { type: "integer" },
          by_family: { type: "array", items: { type: "object", properties: { family: { type: "string" }, inventory: { type: "integer" }, captured: { type: ["integer", "null"] }, built: { type: "integer" }, queryable: { type: "integer" } } } },
          failed: { type: "array", items: { type: "object", properties: { pid: { type: "string" }, title_en: { type: "string" }, errors: { type: "array", items: { type: "string" } } } } },
          upstream_gaps: { type: ["array", "null"], items: { type: "object", properties: { pid: { type: "string" }, title_en: { type: "string" }, last_error: { type: ["string", "null"] }, last_attempt_utc: { type: ["string", "null"] }, attempts: { type: "integer" }, partial_bytes: { type: ["integer", "null"] } } } },
          normalized_warnings: { type: "array", items: { type: "object" } },
        }) },
      },
    },
    "/tables": {
      get: {
        summary: "Search the full WDS table inventory (Normalized `table`)",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Whitespace-separated terms; each must equal the PID or CANSIM ID or appear in search_text (title, dimension names, member names, notes)" },
          { name: "archived", in: "query", schema: { type: "string", enum: ["1", "2"] }, description: "Raw inventory code: 1 archived, 2 current" },
          { name: "kind", in: "query", schema: { type: "string", enum: ["time_series", "snapshot"] } },
          { name: "family", in: "query", schema: { type: "string", enum: ["wds", "census_2021"] } },
          { name: "queryable", in: "query", schema: { type: "boolean" }, description: "Only tables with observations in this build" },
          ...paging,
        ],
        responses: { "200": json("Results ranked by title hits", { total: { type: "integer" }, results: { type: "array", items: { type: "object", properties: {
          pid: { type: "string" }, cansim_id: { type: ["string", "null"] }, title_en: { type: "string" }, archived: { type: "string" },
          frequency_code: { type: "integer" }, frequency_en: { type: ["string", "null"], description: "Official WDS frequency label" },
          dimension_count: { type: "integer" }, queryable: { type: "boolean" }, kind: { type: "string" }, family: { type: "string" },
          subject_en: { type: "array", items: { type: ["string", "null"] } }, period_min: { type: ["string", "null"], format: "date" }, period_max: { type: ["string", "null"], format: "date" },
          series_count: { type: ["integer", "null"] }, unit_families: { type: ["array", "null"], items: { type: "string" } }, place_levels: { type: ["array", "null"], items: { type: "string" } },
          title_hits: { type: "integer", description: "Terms found in the title" }, text_hits: { type: "integer", description: "Terms found in search_text" } } } } }) },
      },
    },
    "/tables/{pid}": {
      get: {
        summary: "Table metadata: Normalized table record (as `cube`), official dimensions, members (dimension 1 with place_id), notes, corrections, symbols, build report",
        parameters: [pid],
        responses: { "200": { description: "Metadata plus links" }, "404": { description: "Unknown PID" } },
      },
    },
    "/tables/{pid}/observations": {
      get: {
        summary: "Filtered, paginated observations with labels",
        description: "Raw `value`, `status`, `symbol`, and `ref_date` are the official strings. `value_num` is derived. Blank `value` means nothing was published; check `status`. Each row adds `period_start`, `period_end`, `period_kind`, `place_id` (dimension 1), and `unit_family`.",
        parameters: [pid, ...filters, ...paging],
        responses: { "200": { description: "Rows sorted by member IDs, ref_date, source row. `status_en` and `symbol_en` are official code-set descriptions next to the raw codes." }, "404": { description: "Not built" }, "409": { description: "Failed the build; errors included" } },
      },
    },
    "/tables/{pid}/series": {
      get: {
        summary: "One series per coordinate (the vector in WDS tables) for a filter, for charts",
        description: "Each series has `vector`, `coordinate`, `name`, `labels`, `unit`, `scale`, `period_kind`, and `points: [ref_date, value_num, status, period_start, period_end]`. `value_num` is null when nothing was published; blank is not zero. At most 50 series and 200,000 points.",
        parameters: [pid, ...filters],
        responses: { "200": { description: "Series with provenance fields" }, "404": { description: "Not built" }, "409": { description: "Failed the build" }, "413": { description: "Too many series or points; add filters" } },
      },
    },
    "/tables/{pid}/observations.parquet": { get: { summary: "Whole-table Parquet for this build", parameters: [pid], responses: { "200": { description: "Parquet file; X-Content-SHA256 header" } } } },
    "/tables/{pid}/source.zip": { get: { summary: "Unchanged original Statistics Canada ZIP", parameters: [pid], responses: { "200": { description: "ZIP file; X-Content-SHA256 header" }, "404": { description: "Not captured or downloads disabled" } } } },
    "/series": {
      get: {
        summary: "Search series (Normalized `series`)",
        description: "Every word must appear in the table title or a member label; a term like `v41690915` must equal the vector. Ranked by title hits, then current before terminated, then table and member order.",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "pid", in: "query", schema: { type: "string", pattern: "^[0-9]{8}$" } },
          { name: "place_id", in: "query", schema: { type: "string" }, description: "Exact place_id, e.g. 2021A000235 or code:0002:35" },
          { name: "unit_family", in: "query", schema: { type: "string", enum: ["percent", "count", "currency", "index", "mass", "time", "volume", "rate", "other"] } },
          ...paging,
        ],
        responses: { "200": json("Matching series", { total: { type: "integer" }, results: { type: "array", items: seriesRow } }), "400": { description: "Bad pid" } },
      },
    },
    "/series/{pid}/{vector}": {
      get: { ...seriesDetail, parameters: [pid, { name: "vector", in: "path", required: true, schema: { type: "string", pattern: "^v[0-9]+$" } }],
        responses: { "200": { description: "Series with points" }, "400": { description: "Not a vector" }, ...seriesErrors } },
    },
    "/series/{pid}/c/{coordinate}": {
      get: { ...seriesDetail, description: `${seriesDetail.description} Census tables have no vector; use the coordinate. It works for WDS tables too.`,
        parameters: [pid, { name: "coordinate", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)*$" } }],
        responses: { "200": { description: "Series with points" }, "400": { description: "Not a coordinate" }, ...seriesErrors } },
    },
    "/places": {
      get: {
        summary: "Search places (Normalized `place`)",
        description: "Every term must appear in the name, or equal the place_id, DGUID, or geo_code. Countries first, then provinces and territories, then other schemas.",
        parameters: [{ name: "q", in: "query", schema: { type: "string" } }, ...paging],
        responses: { "200": json("Places with the number of tables that map to each", { total: { type: "integer" }, results: { type: "array", items: { type: "object", properties: {
          place_id: { type: "string" }, dguid: { type: ["string", "null"] }, vintage: { type: ["integer", "null"] }, geo_type: { type: ["string", "null"] },
          schema: { type: "string" }, geo_code: { type: "string" }, name_en: { type: "string" }, level: { type: "string" }, parent_place_id: { type: ["string", "null"] }, n_tables: { type: "integer" } } } } }) },
      },
    },
    "/places/{place_id}": {
      get: {
        summary: "A place, its vintages, and every table that covers it, grouped by subject",
        description: "Vintages are the place rows with the same `schema` and `geo_code`. Each table lists the members mapped to any vintage (`member_id`, `place_id`, `vintage`, `match`), `n_series`, a citation, and series-search links.",
        parameters: [{ name: "place_id", in: "path", required: true, schema: { type: "string" }, description: "e.g. 2021A000235 or code:0002:35 (URL-encode the colons if your client needs it)" }],
        responses: { "200": json("Place with vintages and subjects", { place: { type: "object" }, parent: { type: ["object", "null"] }, vintages: { type: "array", items: { type: "object" } }, n_tables: { type: "integer" },
          subjects: { type: "array", items: { type: "object", properties: { subject_en: { type: ["string", "null"] }, tables: { type: "array", items: { type: "object" } } } } } }), "404": { description: "Unknown place_id" } },
      },
    },
  },
};
