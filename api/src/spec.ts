/**
 * The chart contract: one JSON "view spec" says what to chart, from which tables, members, and periods, and how to draw it.
 * The planner (Jev) writes a spec from a typed question; the chart builder edits it; POST /api/v1/view runs it;
 * /api/v1/view.parquet exports exactly what it shows. Every chart module imports its types from here.
 *
 * Words used below:
 * - cube: one table (`pid`). It has dimensions; each dimension has members; an observation is one member per
 *   dimension (the coordinate) plus a ref_date, a value, a status, and a unit.
 * - layer: one cube inside a view, with a selection for each of its dimensions.
 * - series: one line, bar group, or stack segment. It is one coordinate, or a sum of coordinates (a group).
 */
import { z } from "zod";

export const SPEC_VERSION = 1;
export const MAX_LAYERS = 4;
export const MAX_VIEW_SERIES = 40;
export const MAX_AXES = 2;
export const MAX_GROUP_MEMBERS = 500;

// ---------------------------------------------------------------- cube metadata (GET /api/v1/cubes/{pid})

/**
 * Dimension roles, first match wins: `geography` when at least half the members map to a place; `measure` for the
 * inventory's has_uom dimension (its members carry the units: "Unemployment rate", "Employment"); else `category`.
 * Time is ref_date, never a dimension. `CubeDimension.carries_unit` keeps has_uom even when the role is geography.
 */
export type DimensionRole = "geography" | "measure" | "category";

/**
 * Member roles, derived, never guessed from names alone:
 * - total: a root member (no parent) that is the parent of other members in its dimension (Canada, All-items, Both sexes).
 * - country / province / territory / region: geography level from member_place + place (territory = PT codes 60, 61, 62).
 * - leaf: no children. A member can be `total` and a geography role at once (`roles` is a list).
 */
export type MemberRole = "total" | "country" | "province" | "territory" | "region" | "leaf";

export interface CubeMember {
  id: number;
  label: string;
  parent_id: number | null;
  depth: number; // 0 for roots
  roles: MemberRole[];
  place_id: string | null;
  /** PT code from the DGUID-matched Normalized place; never inferred from a historical code-only member. */
  geo_code: string | null;
  classification_code: string | null;
  note_ids: number[];
  terminated: boolean;
}

export interface CubeDimension {
  id: number; // dimension_id, 1-based, restarts per table
  name: string;
  role: DimensionRole;
  /** Inventory has_uom: members of this dimension can have different units, so mixing them may need two axes. */
  carries_unit: boolean;
  note_ids: number[];
  /** Member chosen when a spec leaves this dimension out: the single `total` root, else the first root, else member 1. */
  default_member_id: number;
  members: CubeMember[];
}

export interface CubeInfo {
  pid: string;
  table_number: string; // 18-10-0006-01
  title: string;
  family: string; // wds | census_2021
  kind: string; // time_series | snapshot
  frequency: string | null;
  period_min: string | null;
  period_max: string | null;
  unit_families: string[];
  /** Units present in the table, from series: uom code + label + scalar. One table can mix units across its `measure` dimension. */
  units: { uom_code: string; uom: string; scalar: string; unit_family: string }[];
  dimensions: CubeDimension[];
  url: string; // official StatCan table page
}

// ---------------------------------------------------------------- the view spec (input)

/** A member reference: numeric member id, or the exact published label (case-insensitive). */
const MemberRef = z.union([z.number().int().positive(), z.string().min(1).max(300)]);
export type MemberRef = z.infer<typeof MemberRef>;

/**
 * Member set algebra, resolved server-side to member ids. The resolved ids come back in `ViewResult.spec`, so a saved
 * or shared spec is stable even if it was written with roles or labels.
 */
export type MemberSel =
  | { eq: MemberRef }
  | { in: MemberRef[] }
  | { role: MemberRole }
  | { region: string }
  | { childrenOf: MemberRef }
  | { descendantsOf: MemberRef }
  | { contains: string }
  | { all: true }
  | { any: MemberSel[] }
  | { and: MemberSel[] }
  | { not: MemberSel };

export const MemberSel: z.ZodType<MemberSel> = z.lazy(() =>
  z.union([
    z.strictObject({ eq: MemberRef }),
    z.strictObject({ in: z.array(MemberRef).min(1).max(MAX_GROUP_MEMBERS) }),
    z.strictObject({ role: z.enum(["total", "country", "province", "territory", "region", "leaf"]) }),
    z.strictObject({ region: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64) }),
    z.strictObject({ childrenOf: MemberRef }),
    z.strictObject({ descendantsOf: MemberRef }),
    z.strictObject({ contains: z.string().min(1).max(100) }),
    z.strictObject({ all: z.literal(true) }),
    z.strictObject({ any: z.array(MemberSel).min(1).max(20) }),
    z.strictObject({ and: z.array(MemberSel).min(1).max(20) }),
    z.strictObject({ not: MemberSel }),
  ]),
);

/**
 * What a dimension does in the chart:
 * - fixed: exactly one member; it is a filter and appears in the title, not the legend. Resolving to more than one is an error.
 * - series: each selected member (or group) is its own series (own colour; own stack segment in stacked charts).
 * - x: members become categories on the x axis (bar charts). The view then shows one period (see TimeWindow.at).
 * - sum: all selected members are added into one value. Only for additive units (see ADDITIVE_FAMILIES).
 */
export type DimensionUse = "fixed" | "series" | "x" | "sum";

export const DimensionSel = z.strictObject({
  use: z.enum(["fixed", "series", "x", "sum"]),
  members: MemberSel,
  /**
   * Named groups in a `series` or `x` dimension. `auto` prefers a published aggregate, then an additive sum,
   * then a supported ratio; otherwise it displays the members separately. `published` falls back to `auto`
   * with a warning if no exact published aggregate exists. Omitted `agg` means `auto`.
   */
  groups: z.array(z.strictObject({
    label: z.string().min(1).max(80), members: MemberSel,
    agg: z.enum(["auto", "published", "sum", "ratio"]).optional(),
    region: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).optional(),
  })).max(20).optional(),
});
export type DimensionSel = z.infer<typeof DimensionSel>;

export const Layer = z.strictObject({
  pid: z.string().regex(/^[0-9]{8}$/),
  /** Explain a source methodology that differs from another layer in this view; e.g. a three-month moving average. */
  method_difference: z.string().trim().min(1).max(500).optional(),
  /** Keyed by dimension id as a string ("1", "2"...). A dimension left out is `{use:"fixed", members:{eq: default_member_id}}`. */
  dims: z.record(z.string().regex(/^[1-9]$/), DimensionSel).default({}),
});
export type Layer = z.infer<typeof Layer>;

/** Presets count back from the latest period present in the selected data, not from today. */
export const TimePreset = z.enum(["latest", "1Y", "2Y", "5Y", "10Y", "20Y", "max"]);
export type TimePreset = z.infer<typeof TimePreset>;

export const TimeWindow = z.strictObject({
  preset: TimePreset.optional(),
  /** Inclusive ref_date bounds, any prefix form (2015, 2015-06, 2015-06-30); compared on period_start. Override preset. */
  from: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
  to: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
  /** For x-category charts: which single period to show. Default: the latest period in the window where every series has a value, else the latest. */
  at: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
});
export type TimeWindow = z.infer<typeof TimeWindow>;

/**
 * Applied per series, after sums:
 * - level: published values (scaled by scalar only when `chart.scale_values`).
 * - pct_change_yoy: % change vs the same period one year earlier (12 months, 4 quarters, 52 weeks, 1 year).
 * - pct_change_period: % change vs the previous period.
 * - pct_change_window: one value per series, % change from the first to the last period in the window (bars only).
 * - index_first: rebased so the first published point in the window, or in index_base's year/month/quarter/day, = 100.
 * - share_of_x: each series as % of the sum across the x categories in its period (stacked 100% bars).
 */
export const Transform = z.enum(["level", "pct_change_yoy", "pct_change_period", "pct_change_window", "index_first", "share_of_x"]);
export type Transform = z.infer<typeof Transform>;

export const ChartType = z.enum(["line", "area", "bar", "stacked_bar", "stacked_bar_100", "stacked_area"]);
export type ChartType = z.infer<typeof ChartType>;

/** Colours are palette slots (DESIGN.md categorical palette), never raw hex, so the builder and themes stay in sync. */
export const ChartOptions = z.strictObject({
  type: ChartType,
  /** Horizontal bars when x categories are long labels. */
  horizontal: z.boolean().optional(),
  /** Series key (see ViewSeries.key) → palette slot 0..9. Unlisted series get slots in order. */
  colors: z.record(z.string(), z.number().int().min(0).max(9)).optional(),
  /** Hide these series keys without removing them from the data or download. */
  hidden: z.array(z.string()).max(MAX_VIEW_SERIES).optional(),
  /** Sort x categories by value (bars). */
  sort: z.enum(["none", "asc", "desc"]).optional(),
  scale_values: z.boolean().optional(),
});
export type ChartOptions = z.infer<typeof ChartOptions>;

export const ViewSpec = z.strictObject({
  v: z.literal(SPEC_VERSION),
  layers: z.array(Layer).min(1).max(MAX_LAYERS),
  time: TimeWindow.default({ preset: "max" }),
  transform: Transform.default("level"),
  /** Optional base period for index_first: YYYY, YYYY-MM, YYYY-Qn, or YYYY-MM-DD. */
  index_base: z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|-Q[1-4])?$/)
    .refine((base) => base.length !== 10 || new Date(`${base}T00:00:00Z`).toISOString().slice(0, 10) === base,
      "index_base must be a real calendar date").optional(),
  chart: ChartOptions.default({ type: "line" }),
  /** Optional user title; otherwise the server writes one from the tables and fixed members. */
  title: z.string().max(200).optional(),
});
export type ViewSpec = z.infer<typeof ViewSpec>;

/** Units that can be summed across members (same uom code and scalar required too). Never index, percent, rate, or time (durations are mostly averages or medians). */
export const ADDITIVE_FAMILIES = new Set(["count", "currency", "mass", "volume", "area", "length", "energy"]);

// ---------------------------------------------------------------- the view result (output of POST /api/v1/view)

export type Point = [ref_date: string, period_start: string, value: number | null, status: string];

export interface ViewSeries {
  /** Stable within a spec: `L{layer}:{dim}={member|g:label},...` over the series/x-varying dims. Used by chart.colors/hidden. */
  key: string;
  layer: number;
  pid: string;
  name: string; // legend label: member/measure, prefixed by the layer subject only when multi-layer subjects differ
  /** Every dimension's resolved member(s) for this series, in dimension order. A group lists all its members. */
  coordinate: { dimension_id: number; dimension: string; member_ids: number[]; label: string }[];
  kind: "observed" | "sum" | "ratio";
  /** Group attribution; fallback member lines share `group` but have no combined value. */
  group?: string;
  group_of?: string;
  group_method: "published" | "sum" | "ratio" | null;
  group_members: string[];
  vectors: string[]; // official vector ids behind this series (several when summed)
  unit: string; // after transform: "%" for pct_change_*, "index (<base> = 100)" for index_first, else published uom
  scale: string; // published scalar label ("units", "thousands"...); "units" after a % transform
  unit_family: string;
  axis: number; // 0 or 1
  color: number; // palette slot
  hidden: boolean;
  /** x === "time": one point per period. x is a dimension: one point per category, in `categories` order. */
  points: Point[];
  /** Internal null runs between the first and last published points, by ref_date. */
  gaps: { from: string; to: string; mark: string | null; meaning: string }[];
  /** First and last published ref_date in the requested window; null when none are published. */
  coverage: { first: string | null; last: string | null };
  /** True when every requested point is null. */
  unpublished: boolean;
}

export interface ViewNote {
  pid: string;
  note_id: number;
  text: string; // HTML as published (links kept)
  /** Why it applies: table-level, or which used dimension/member references it. */
  scope: { kind: "table" } | { kind: "dimension"; dimension: string } | { kind: "member"; dimension: string; member: string };
}

export interface ViewSource {
  pid: string;
  table_number: string;
  title: string;
  family: string;
  frequency: string | null;
  captured: string | null; // capture date of this table's ZIP
  url: string;
  citation: string; // Db.citation(pid)
  /** Status/symbol marks that appear in the shown points, with their official meaning. */
  marks: { mark: string; meaning: string }[];
  corrections: { date: string; note: string }[];
}

export type ViewWarning =
  | { code: "mixed_family"; message: string } // WDS and Census in one chart
  | { code: "mixed_units"; message: string } // more than one axis
  | { code: "mixed_frequency"; message: string }
  | { code: "series_capped"; message: string; total: number }
  | { code: "no_data"; message: string } // a series has no points in the window
  | { code: "index_base_missing"; message: string } // no published point for this series in its requested index base
  | { code: "sum_refused"; message: string } // a sum/group over non-additive or mixed units was dropped
  | { code: "group_not_combined" | "group_partial" | "group_missing"; message: string }
  | { code: "group_published_unavailable"; message: string }
  | { code: "group_method_difference"; message: string }
  | { code: "substituted_geography"; message: string }
  | { code: "territory_proxy"; message: string } // territory estimate uses a different published series
  | { code: "member_not_found"; message: string }
  | { code: "chart_fallback"; message: string } // requested chart cannot represent these selected values
  | { code: "empty_selection"; message: string };

export interface ViewResult {
  build_id: string;
  normalized_build_id: string;
  /** The input spec with defaults filled and MemberSel resolved to `{in:[ids]}`/`{eq:id}` or `{not:{all:true}}` when empty; safe to share. */
  spec: ViewSpec;
  title: string;
  subtitle: string; // fixed members and period, e.g. "Canada · Seasonally adjusted · Sep 2025 – Aug 2026"
  /** Joined unpublished and time-gap explanations for API users; null when both are absent. */
  gap_note: string | null;
  /** Separate explanations so clients can avoid repeating substituted-geography warnings. */
  gap_parts: { unpublished: string | null; time: string | null };
  /** Index calculation for the Notes panel; separate from Statistics Canada's published notes. */
  index_note: string | null;
  x: { kind: "time" } | { kind: "category"; dimension: string; layer: number; at: string };
  categories?: string[];
  axes: { unit: string; scale: string; unit_family: string }[];
  /** Aligned with `categories` for x-group bars (including not-combined member categories). */
  category_groups?: (string | null)[];
  category_methods?: ("published" | "sum" | "ratio" | null)[];
  series: ViewSeries[];
  period: { from: string | null; to: string | null };
  notes: ViewNote[];
  /** Calculation provenance for the Notes panel and citations; distinct from StatCan's published notes. */
  group_notes: { pid: string; label: string; method: "published" | "sum" | "ratio" | "not_combined";
    members: string[]; formula?: string; method_difference?: string }[];
  sources: ViewSource[];
  warnings: ViewWarning[];
  links: { self: string; parquet: string; csv: string; page: string };
}

// ---------------------------------------------------------------- planner (GET /api/v1/plan?q=)

/**
 * - ok: `spec` is ready; the page shows it immediately.
 * - need_more: the input is a fragment ("c", "the"); the page shows an empty chart and "Continue typing".
 * - no_match: the input is unrelated to anything StatCan publishes, or no candidate table fits; "Nothing found".
 */
export type PlanStatus = "ok" | "need_more" | "no_match";

export interface PlanStep {
  question: string; // short name, e.g. "table", "time", "d2.members"
  answer: string;
  confidence: number | null;
  source: "jev" | "rule" | "default";
}

export interface PlanResult {
  status: PlanStatus;
  q: string;
  /** Explanation for a no_match result, e.g. a physiographic region cannot be selected by province. */
  reason?: string;
  spec?: ViewSpec;
  /** Up to 4 other readings (other tables or chart types) the page offers as one-click alternatives. */
  alternatives: { label: string; spec: ViewSpec }[];
  steps: PlanStep[];
  planner: "jev" | "rule" | "heuristic"; // heuristic = Jev unavailable or failed
  ms: number;
  build_id: string;
  normalized_build_id: string;
  view?: ViewResult; // when ?view=1
}

// ---------------------------------------------------------------- URL encoding

/** Specs travel in URLs as base64url(JSON). `/?s=...` opens the chart; `/api/v1/view.parquet?s=...` downloads it. */
export function encodeSpec(spec: ViewSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

export function decodeSpec(s: string): ViewSpec {
  return ViewSpec.parse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
}

export function statcanTableUrl(pid: string): string {
  return `https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${pid}01`;
}
