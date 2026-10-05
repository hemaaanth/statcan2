import { publicOrigin } from "./config.ts";

const origin = publicOrigin();
const siteServers = [{ url: origin }];

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
    phrase_hit: { type: "integer", description: "1 when a CPI query matched the exact Consumer Price Index table-title phrase" },
    title_hits: { type: "integer", description: "Search terms found in the table title" },
    links: { type: "object", properties: { self: { type: "string" }, html: { type: "string" } } },
  },
};
const seriesDetail = {
  summary: "One series: Normalized metadata and every point",
  description: "Labels, place, unit (`uom_en`, `unit_family`, `unit_symbol`, `unit_base_year`), scale, period range, counts, a citation, and `points` with `ref_date`, `period_start`, `period_end`, `period_kind`, raw `value`, `value_num`, `status`, `status_en`, `symbol`, `symbol_en`. Blank `value` means nothing was published; it is not zero.",
};
const seriesErrors = { "404": { description: "Unknown series" }, "409": { description: "The Normalized row does not match the observations for that coordinate" }, "413": { description: "More than 200,000 points" } };

const dataPaths = {
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
        title_hits: { type: "integer" }, dimension_hits: { type: "integer" }, member_hits: { type: "integer" }, note_hits: { type: "integer" }, text_hits: { type: "integer", description: "Dimension + member + note hits" } } } } }) },
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
      description: "`cpi` expands to `consumer price index`. Every word must appear in the table title or a member label; a term like `v41690915` must equal the vector. Ranked by exact CPI title phrase, then any title hit, then current before terminated, then table and member order.",
      parameters: [
        { name: "q", in: "query", schema: { type: "string" }, description: "Whitespace-separated terms; `cpi` is accepted as shorthand for Consumer Price Index" },
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
};

/** The chart routes: spec-driven views across tables, the planner, and social cards. */
const chart = {
  components: { schemas: {
    MemberSel: { oneOf: [
      { type: "object", additionalProperties: false, required: ["eq"], properties: { eq: { oneOf: [{ type: "integer" }, { type: "string" }] } } },
      { type: "object", additionalProperties: false, required: ["in"], properties: { in: { type: "array", items: { oneOf: [{ type: "integer" }, { type: "string" }] } } } },
      ...["role", "region", "childrenOf", "descendantsOf", "contains", "all", "any", "and", "not"].map((key) => ({
        type: "object", additionalProperties: false, required: [key], properties: { [key]: key === "all" ? { type: "boolean", const: true }
          : key === "any" || key === "and" ? { type: "array", items: { $ref: "#/components/schemas/MemberSel" } }
          : key === "not" ? { $ref: "#/components/schemas/MemberSel" }
          : key === "role" ? { enum: ["total", "country", "province", "territory", "region", "leaf"] }
          : key === "childrenOf" || key === "descendantsOf" ? { oneOf: [{ type: "integer" }, { type: "string" }] } : { type: "string" } },
      })),
    ] },
    CubeInfo: { type: "object", required: ["pid", "table_number", "title", "dimensions"], properties: {
      ...provenance, pid: { type: "string" }, table_number: { type: "string" }, title: { type: "string" },
      family: { type: "string" }, kind: { enum: ["time_series", "snapshot"] },
      frequency: { type: ["string", "null"] }, period_min: { type: ["string", "null"] }, period_max: { type: ["string", "null"] },
      unit_families: { type: "array", items: { type: "string" } },
      units: { type: "array", items: { type: "object", properties: {
        uom_code: { type: "string" }, uom: { type: "string" }, scalar: { type: "string" }, unit_family: { type: "string" },
      } } },
      dimensions: { type: "array", items: { type: "object", required: ["id", "name", "role", "default_member_id", "members"],
        properties: { id: { type: "integer" }, name: { type: "string" }, role: { enum: ["geography", "measure", "category"] },
          carries_unit: { type: "boolean" }, note_ids: { type: "array", items: { type: "integer" } },
          default_member_id: { type: "integer" }, members: { type: "array", items: { type: "object",
            properties: { id: { type: "integer" }, label: { type: "string" }, parent_id: { type: ["integer", "null"] },
              depth: { type: "integer" }, roles: { type: "array", items: { type: "string" } },
              place_id: { type: ["string", "null"] }, classification_code: { type: ["string", "null"] },
              geo_code: { type: ["string", "null"] },
              note_ids: { type: "array", items: { type: "integer" } }, terminated: { type: "boolean" } } } } } } },
      url: { type: "string", format: "uri" },
    } },
    ViewSpec: { type: "object", additionalProperties: false, required: ["v", "layers"], properties: {
      v: { const: 1 },
      layers: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", required: ["pid"], properties: {
        pid: { type: "string", pattern: "^[0-9]{8}$" },
        method_difference: { type: "string", minLength: 1, maxLength: 500 },
        dims: { type: "object", additionalProperties: { type: "object", required: ["use", "members"], properties: {
          use: { enum: ["fixed", "series", "x", "sum"] }, members: { $ref: "#/components/schemas/MemberSel" },
          groups: { type: "array", items: { type: "object", required: ["label", "members"], properties: {
            label: { type: "string" }, members: { $ref: "#/components/schemas/MemberSel" },
            agg: { enum: ["auto", "published", "sum", "ratio"], default: "auto" }, region: { type: "string" },
          } } },
        } } },
      } } },
      time: { type: "object", properties: { preset: { enum: ["latest", "1Y", "2Y", "5Y", "10Y", "20Y", "max"] },
        from: { type: "string" }, to: { type: "string" }, at: { type: "string" } } },
      transform: { enum: ["level", "pct_change_yoy", "pct_change_period", "pct_change_window", "index_first", "share_of_x"] },
      index_base: { type: "string", pattern: "^\\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01]))?|-Q[1-4])?$",
        description: "For index_first only: YYYY, YYYY-MM, YYYY-Qn, or YYYY-MM-DD. First published point in this base period = 100, even outside the visible window; omitted means the first published point in the window." },
      chart: { type: "object", required: ["type"], properties: { type: { enum: ["line", "area", "bar", "stacked_bar", "stacked_bar_100", "stacked_area"] },
        horizontal: { type: "boolean" }, colors: { type: "object", additionalProperties: { type: "integer", minimum: 0, maximum: 9 } },
        hidden: { type: "array", items: { type: "string" } }, sort: { enum: ["none", "asc", "desc"] }, scale_values: { type: "boolean" } } },
      title: { type: "string" },
    } },
    ViewResult: { type: "object", properties: {
      ...provenance, spec: { $ref: "#/components/schemas/ViewSpec" }, title: { type: "string" }, subtitle: { type: "string" },
      gap_note: { type: ["string", "null"], description: "Unpublished combinations and time gaps joined with a space, or null when neither applies." },
      gap_parts: { type: "object", required: ["unpublished", "time"], description: "Separate text so clients can omit unpublished when substituted_geography already explains it.",
        properties: { unpublished: { type: ["string", "null"] }, time: { type: ["string", "null"] } } },
      index_note: { type: ["string", "null"], description: "Index-base calculation for Notes; separate from the source tables' published notes." },
      x: { oneOf: [{ type: "object", required: ["kind"], properties: { kind: { const: "time" } } },
        { type: "object", required: ["kind", "dimension", "layer", "at"], properties: {
          kind: { const: "category" }, dimension: { type: "string" }, layer: { type: "integer" }, at: { type: "string", format: "date" },
        } }] },
      categories: { type: "array", items: { type: "string" } },
      category_groups: { type: "array", items: { type: ["string", "null"] } },
      category_methods: { type: "array", items: { enum: ["published", "sum", "ratio", null] } },
      axes: { type: "array", maxItems: 2, items: { type: "object", properties: {
        unit: { type: "string" }, scale: { type: "string" }, unit_family: { type: "string" },
      } } },
      series: { type: "array", maxItems: 40, items: { type: "object", properties: {
        key: { type: "string" }, layer: { type: "integer" }, pid: { type: "string" }, name: { type: "string" },
        coordinate: { type: "array", items: { type: "object", properties: {
          dimension_id: { type: "integer" }, dimension: { type: "string" },
          member_ids: { type: "array", items: { type: "integer" } }, label: { type: "string" },
        } } },
        kind: { enum: ["observed", "sum", "ratio"] }, vectors: { type: "array", items: { type: "string" } },
        group: { type: "string" }, group_of: { type: "string" },
        group_method: { enum: ["published", "sum", "ratio", null] },
        group_members: { type: "array", items: { type: "string" } },
        unit: { type: "string" }, scale: { type: "string" }, unit_family: { type: "string" },
        axis: { type: "integer" }, color: { type: "integer" }, hidden: { type: "boolean" },
        points: { type: "array", items: { type: "array", prefixItems: [
          { type: "string", description: "ref_date" }, { type: "string", format: "date" },
          { type: ["number", "null"] }, { type: "string", description: "status" },
        ], minItems: 4, maxItems: 4 } },
        gaps: { type: "array", description: "Internal null runs between first and last published points, split by source mark.", items: {
          type: "object", required: ["from", "to", "mark", "meaning"], properties: {
            from: { type: "string", description: "First ref_date in this run" }, to: { type: "string", description: "Last ref_date in this run" },
            mark: { type: ["string", "null"], description: "Official printed mark, or null when absent" }, meaning: { type: "string", description: "Official meaning or Not published" },
          },
        } },
        coverage: { type: "object", required: ["first", "last"], description: "Published ref_date bounds in this window; null for an unpublished series.", properties: {
          first: { type: ["string", "null"] }, last: { type: ["string", "null"] },
        } },
        unpublished: { type: "boolean", description: "True when every point in this series has no published value." },
      } } },
      period: { type: "object", properties: { from: { type: ["string", "null"] }, to: { type: ["string", "null"] } } },
      notes: { type: "array", items: { type: "object", properties: {
        pid: { type: "string" }, note_id: { type: "integer" }, text: { type: "string", description: "Published HTML" },
        scope: { type: "object", properties: { kind: { enum: ["table", "dimension", "member"] },
          dimension: { type: "string" }, member: { type: "string" } } },
      } } },
      group_notes: { type: "array", items: { type: "object", properties: {
        pid: { type: "string" }, label: { type: "string" }, method: { enum: ["published", "sum", "ratio", "not_combined"] },
        members: { type: "array", items: { type: "string" } }, formula: { type: "string" },
        method_difference: { type: "string" },
      } } },
      sources: { type: "array", items: { type: "object", properties: {
        pid: { type: "string" }, table_number: { type: "string" }, title: { type: "string" },
        family: { type: "string" }, frequency: { type: ["string", "null"] }, captured: { type: ["string", "null"] },
        url: { type: "string" }, citation: { type: "string" },
        marks: { type: "array", items: { type: "object", properties: { mark: { type: "string" }, meaning: { type: "string" } } } },
        corrections: { type: "array", items: { type: "object", properties: { date: { type: "string" }, note: { type: "string" } } } },
      } } },
      warnings: { type: "array", items: { type: "object", properties: { code: { type: "string", description: "Includes index_base_missing when a series lacks its requested published index base, territory_proxy when capital-city data stands in for an unavailable territory total, and substituted_geography for nearby published alternatives." }, message: { type: "string" }, total: { type: "integer" } } } },
      links: { type: "object", properties: { self: { type: "string" }, parquet: { type: "string" },
        csv: { type: "string" }, page: { type: "string" } } },
    } },
    PlanResult: { type: "object", properties: { ...provenance, status: { enum: ["ok", "need_more", "no_match"] },
      q: { type: "string" }, reason: { type: "string" }, spec: { $ref: "#/components/schemas/ViewSpec" },
      alternatives: { type: "array", items: { type: "object" } },
      steps: { type: "array", items: { type: "object" } }, planner: { enum: ["jev", "rule", "heuristic"] },
      ms: { type: "number" }, view: { $ref: "#/components/schemas/ViewResult" } } },
  } },
  paths: {
    "/highlights": { get: { summary: "Build-pinned home headline cards, cached per build", responses: { "200": json("Current headline cards", {
      cards: { type: "array", items: { type: "object", required: ["id", "label", "q", "s", "value", "unit", "scale", "period_label", "change", "direction", "spark", "source"], properties: {
        id: { type: "string" }, label: { type: "string" }, q: { type: "string" }, s: { type: "string", description: "Full base64url ViewSpec" },
        value: { type: "number" }, unit: { type: "string" }, scale: { type: "string" }, period_label: { type: "string" },
        change: { type: "object", properties: { value: { type: "number" }, unit: { enum: ["%", "pts", ""] },
          kind: { enum: ["12-month change", "monthly change", "quarterly change", "period-to-period change"] } } },
        direction: { enum: ["up", "down", "flat"] }, spark: { type: "array", items: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } },
        source: { type: "string", description: "Statistics Canada table number" },
      } } },
    }) } } },
    "/cubes": { get: { summary: "Search queryable tables for the chart builder", parameters: [
      { name: "q", in: "query", schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ], responses: { "200": json("Matching queryable tables", { q: { type: "string" }, total: { type: "integer" },
      results: { type: "array", items: { type: "object", properties: {
        pid: { type: "string" }, table_number: { type: "string" }, title: { type: "string" },
        frequency: { type: ["string", "null"] }, period_min: { type: ["string", "null"] }, period_max: { type: ["string", "null"] },
        family: { type: "string" }, unit_families: { type: "array", items: { type: "string" } },
      } } } }), "400": { description: "Invalid limit" } } } },
    "/regions": { get: { summary: "Named Canadian region sets and physiographic limitations",
      responses: { "200": json("Region ids, PT codes, aliases, source and notes", {
        regions: { type: "array", items: { type: "object", properties: {
          region_id: { type: "string" }, label: { type: "string" }, kind: { enum: ["sgc", "common", "physiographic"] },
          members: { type: "array", items: { type: "string" } }, aliases: { type: "array", items: { type: "string" } },
          source: { type: "string" }, note: { type: "string" },
        } } },
      }) } } },
    "/cubes/{pid}": { get: { summary: "Cube dimensions, roles, members, defaults, and units", parameters: [pid],
      responses: { "200": { description: "CubeInfo with build IDs", content: { "application/json": { schema: { $ref: "#/components/schemas/CubeInfo" } } } },
        "404": { description: "Unknown or unbuilt PID" } } } },
    "/cubes/{pid}/views": { get: { summary: "Two to five suggested labeled ViewSpecs", parameters: [pid],
      responses: { "200": json("Headline and applicable province, component, and latest-bar views", {
        views: { type: "array", items: { type: "object", properties: {
          label: { type: "string" }, spec: { $ref: "#/components/schemas/ViewSpec" },
        } } },
      }), "404": { description: "Unknown or unbuilt PID" } } } },
    "/view": {
      get: { summary: "Run a base64url-encoded spec", parameters: [{ name: "s", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Resolved chart view", content: { "application/json": { schema: { $ref: "#/components/schemas/ViewResult" } } } },
          "400": { description: "Invalid ViewSpec" }, "404": { description: "Unknown PID" }, "422": { description: "Invalid selection or incompatible chart" } } },
      post: { summary: "Run a ViewSpec", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ViewSpec" } } } },
        responses: { "200": { description: "Resolved chart view", content: { "application/json": { schema: { $ref: "#/components/schemas/ViewResult" } } } },
          "400": { description: "Invalid ViewSpec" }, "404": { description: "Unknown PID" }, "422": { description: "Invalid selection or incompatible chart" } } },
    },
    ...Object.fromEntries(["parquet", "csv"].map((format) => [`/view.${format}`, {
      get: { summary: `Export displayed view rows as ${format}`, parameters: [{ name: "s", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "One row per shown point, including hidden series; Parquet carries spec and citation metadata",
          content: { [format === "parquet" ? "application/vnd.apache.parquet" : "text/csv"]: { schema: { type: "string", format: format === "parquet" ? "binary" : undefined } } } },
          "400": { description: "Invalid ViewSpec" }, "404": { description: "Unknown PID" }, "422": { description: "Invalid view" } } },
      post: { summary: `Export ViewSpec as ${format}`, requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ViewSpec" } } } },
        responses: { "200": { description: "One row per shown point, including hidden series",
          content: { [format === "parquet" ? "application/vnd.apache.parquet" : "text/csv"]: { schema: { type: "string", format: format === "parquet" ? "binary" : undefined } } } },
          "400": { description: "Invalid ViewSpec" }, "404": { description: "Unknown PID" }, "422": { description: "Invalid view" } } },
    }])),
    "/og/chart.png": { servers: siteServers, get: { summary: "1200×630 chart social card; missing or invalid s uses the site card",
      parameters: [{ name: "s", in: "query", schema: { type: "string" }, description: "base64url ViewSpec" }],
      responses: { "200": { description: "PNG; public cache for one day", content: { "image/png": { schema: { type: "string", format: "binary" } } } } } } },
    "/og/site.png": { servers: siteServers, get: { summary: "1200×630 site social card",
      responses: { "200": { description: "PNG; public cache for one day", content: { "image/png": { schema: { type: "string", format: "binary" } } } } } } },
    "/og/text.png": { servers: siteServers, get: { summary: "Generic text social card",
      parameters: [{ name: "title", in: "query", schema: { type: "string" } }],
      responses: { "200": { description: "PNG; public cache for one day", content: { "image/png": { schema: { type: "string", format: "binary" } } } } } } },
    "/plan": { get: { summary: "Classify a question and return a ready ViewSpec or need_more/no_match",
      parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } },
        { name: "view", in: "query", schema: { type: "integer", enum: [0, 1] } }],
      responses: { "200": { description: "PlanResult", content: { "application/json": { schema: { $ref: "#/components/schemas/PlanResult" } } } } } } },
  },
};

/** One OpenAPI document for /api/v1: the table, series and place data, and the chart routes. */
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "StatCan API",
    version: "1.0.0",
    description: "Read-only data and charts for every captured Statistics Canada table. Every response names its Clean and Normalized builds. Independent copy, not an official Statistics Canada service.",
  },
  servers: [{ url: `${origin}/api/v1` }],
  components: chart.components,
  paths: { ...dataPaths, ...chart.paths },
};
