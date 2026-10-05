import { createHash } from "node:crypto";
import { grainOf } from "../public/render.js";
import type { Db, Row } from "./db.ts";
import { MAX_SERIES_POINTS } from "./db.ts";
import { getCube } from "./cube.ts";
import { publicOrigin } from "./config.ts";
import { findRegion } from "./regions.ts";
import { findRatioRule } from "./ratio_rules.ts";
import {
  ADDITIVE_FAMILIES, MAX_GROUP_MEMBERS, MAX_VIEW_SERIES, ViewSpec, encodeSpec,
  type CubeDimension, type CubeInfo, type DimensionSel, type MemberRef, type MemberSel,
  type Point, type ViewNote, type ViewResult, type ViewSeries, type ViewSource, type ViewWarning,
} from "./spec.ts";

export type ViewOutcome =
  | { kind: "ok"; result: ViewResult }
  | { kind: "invalid"; status: 400 | 404 | 422; error: string };

type GroupMethod = "published" | "sum" | "ratio";
type RatioParts = { dimensionId: number; numerator: number; denominator: number; scale: number; formula: string };
type Choice = { ids: number[]; label: string; key: string; group: boolean; agg?: "auto" | "published" | "sum" | "ratio";
  method?: GroupMethod; groupLabel?: string; groupMembers?: string[]; sourceIds?: number[]; regionId?: string; missing?: string[] };
type Selection = { dimension: CubeDimension; use: DimensionSel["use"]; choices: Choice[]; ids: number[]; named: boolean };
type LayerData = { cube: CubeInfo; selections: Selection[]; rows: Row[]; periods: Map<string, string>; index: number; ratio?: RatioParts; ratioUnit?: string };
export type ExportRow = {
  series_key: string; series_name: string; layer: number; pid: string; table_number: string;
  vectors: string[]; coordinate: { dimension: string; members: string }[]; category: string | null;
  ref_date: string; period_start: string; period_end: string | null; value: number | null;
  value_published: string | null; status: string; unit: string; scale: string; unit_family: string; transform: string; hidden: boolean;
  group: string | null; group_method: GroupMethod | null; group_members: string[];
};
const exportsFor = new WeakMap<ViewResult, ExportRow[]>();
export const exportRows = (result: ViewResult): ExportRow[] => exportsFor.get(result) ?? [];
const invalid = (error: string, status: 400 | 404 | 422 = 422): ViewOutcome => ({ kind: "invalid", status, error });
const asText = (v: unknown) => String(v ?? "");
const PT_NAMES: Record<string, string> = {
  "10": "Newfoundland and Labrador", "11": "Prince Edward Island", "12": "Nova Scotia", "13": "New Brunswick",
  "24": "Quebec", "35": "Ontario", "46": "Manitoba", "47": "Saskatchewan", "48": "Alberta",
  "59": "British Columbia", "60": "Yukon", "61": "Northwest Territories", "62": "Nunavut",
};
const sql = (v: string) => `'${v.replaceAll("'", "''")}'`;
const TRANSFORM_SUFFIX: Record<ViewSpec["transform"], string> = {
  level: "",
  pct_change_yoy: ", % change year over year",
  pct_change_period: ", % change period over period",
  pct_change_window: ", % change over window",
  index_first: ", indexed to first = 100",
  share_of_x: ", share of categories (%)",
};
const YOY_LAG: Record<string, number> = { month: 12, quarter: 4, half_year: 2, week: 52, year: 1, fiscal_year: 1 };
const SOURCE_TITLE_LEAD = /^(?:Statistics Canada|CMHC|Bank of Canada|Government of Canada|Department of .+|(?:.+ )?Survey(?: of .+)?(?: \([^)]+\))?|Historical statistics)$/i;
const ORGANIZATION_TITLE_LEAD = /^[A-Z][\p{L}'-]+(?: (?:[A-Z][\p{L}'-]+|and|of|the))* (?:Corporation|Agency|Commission|Authority|Ministry|Secretariat|Association|Council|Board|Institute|Bureau)$/u;

function displayTitle(layer: LayerData): string {
  if (layer.cube.family !== "census_2021") return layer.cube.title;
  const title = layer.cube.title.split(": ")[0];
  const by = title.indexOf(" by ");
  if (by < 0) return title;
  let remaining = title.slice(by + 4).toLowerCase();
  const dimensions = layer.selections.filter((s) =>
    s.use === "x" || s.use === "fixed" && s.ids[0] === s.dimension.default_member_id)
    .map((s) => s.dimension.name.replace(/\s+\([^)]*\)$/, "").toLowerCase());
  while (remaining) {
    const name = dimensions.find((dimension) => remaining.startsWith(dimension) &&
      (remaining.length === dimension.length || /^(?:, | and )/.test(remaining.slice(dimension.length))));
    if (!name) return title;
    remaining = remaining.slice(name.length).replace(/^(?:, | and )/, "");
  }
  return title.slice(0, by);
}

function shortPlace(label: string): string {
  return label.split(" (")[0].replaceAll(" - ", " – ");
}

function resolve(dim: CubeDimension, sel: MemberSel, warnings: ViewWarning[]): number[] {
  const members = dim.members;
  const byRef = (ref: MemberRef): number[] => {
    const hits = members.filter((m) => typeof ref === "number" ? m.id === ref : m.label.toLowerCase() === ref.toLowerCase()).map((m) => m.id);
    if (!hits.length) warnings.push({ code: "member_not_found", message: `${dim.name}: ${ref} not found` });
    return hits;
  };
  const set = (s: MemberSel): Set<number> => {
    if ("eq" in s) return new Set(byRef(s.eq));
    if ("in" in s) return new Set(s.in.flatMap(byRef));
    if ("role" in s) return new Set(members.filter((m) => m.roles.includes(s.role)).map((m) => m.id));
    if ("region" in s) {
      const region = findRegion(s.region);
      return new Set(members.filter((m) => m.geo_code && region?.members.includes(m.geo_code)).map((m) => m.id));
    }
    if ("contains" in s) return new Set(members.filter((m) => m.label.toLowerCase().includes(s.contains.toLowerCase())).map((m) => m.id));
    if ("all" in s) return new Set(members.map((m) => m.id));
    if ("childrenOf" in s) { const parents = new Set(byRef(s.childrenOf)); return new Set(members.filter((m) => m.parent_id != null && parents.has(m.parent_id)).map((m) => m.id)); }
    if ("descendantsOf" in s) {
      const found = new Set(byRef(s.descendantsOf));
      let size = -1;
      while (size !== found.size) { size = found.size; for (const m of members) if (m.parent_id != null && found.has(m.parent_id)) found.add(m.id); }
      for (const id of byRef(s.descendantsOf)) found.delete(id);
      return found;
    }
    if ("any" in s) return new Set(s.any.flatMap((part) => [...set(part)]));
    if ("and" in s) { const [first, ...rest] = s.and.map(set); return new Set([...first].filter((id) => rest.every((part) => part.has(id)))); }
    const excluded = set(s.not);
    return new Set(members.filter((m) => !excluded.has(m.id)).map((m) => m.id));
  };
  return [...set(sel)];
}
function publishedMember(dim: CubeDimension, ids: number[], label: string, regionId?: string, complete = true): number | undefined {
  if (ids.length === 1 && complete) return ids[0];
  if (dim.role !== "geography") return undefined;
  const places = dim.members.filter((m) => m.geo_code);
  if (places.length === ids.length && places.every((m) => ids.includes(m.id)))
    return dim.members.find((m) => m.roles.includes("country") && m.label.toLowerCase() === "canada")?.id;
  const region = regionId ? findRegion(regionId) : undefined;
  const names = [label, ...(region ? [region.label, ...region.aliases] : [])].map((name) => name.toLowerCase());
  return dim.members.find((m) => !m.geo_code && m.label.toLowerCase() !== "canada" && names.includes(m.label.toLowerCase()))?.id;
}


function choices(dim: CubeDimension, ids: number[], groups: Choice[], use: Selection["use"]): Choice[] {
  const labels = new Map(dim.members.map((m) => [m.id, m.label]));
  const single = (id: number): Choice => ({ ids: [id], label: labels.get(id) ?? `#${id}`, key: String(id), group: false });
  return use === "fixed" || use === "sum"
    ? [{ ids, label: use === "sum" ? dim.name : single(ids[0]).label, key: String(ids[0]), group: use === "sum" }]
    : [...ids.map(single), ...groups.filter((g) => g.ids.length)];
}

function product<T>(lists: T[][], limit = MAX_VIEW_SERIES): T[][] {
  return lists.reduce<T[][]>((acc, list) => {
    const next: T[][] = [];
    for (const row of acc) for (const item of list) {
      next.push([...row, item]);
      if (next.length === limit) return next;
    }
    return next;
  }, [[]]);
}

function dateOffset(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
function inIndexBase(date: string, base: string): boolean {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(base);
  return quarter ? date.slice(0, 4) === quarter[1] && Math.ceil(Number(date.slice(5, 7)) / 3) === Number(quarter[2])
    : date.startsWith(base);
}

function indexBaseLabel(base?: string): string {
  if (!base) return "first";
  if (/^\d{4}$/.test(base)) return base;
  const quarter = /^(\d{4})-Q([1-4])$/.exec(base);
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`;
  const date = new Date(`${base.slice(0, 7)}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("en-CA", { month: "short", ...(base.length === 10 ? { day: "numeric" } : {}), year: "numeric",
    timeZone: "UTC" }).format(base.length === 10 ? new Date(`${base}T00:00:00Z`) : date);
}

function pct(now: number | null, before: number | null): number | null {
  return now == null || before == null || before === 0 ? null : (now / before - 1) * 100;
}
function transform(values: (number | null)[], dates: string[], mode: ViewSpec["transform"],
  lookback?: Map<string, string>): (number | null)[] {
  if (mode === "level" || mode === "share_of_x" || mode === "pct_change_window") return values;
  const byDate = new Map(dates.map((date, i) => [date, values[i]]));
  return values.map((value, i) => pct(value, byDate.get(lookback?.get(dates[i]) ?? "") ?? null));
}

function notesFor(cube: CubeInfo, selections: Selection[], rows: Row[]): ViewNote[] {
  const referenced = new Set(cube.dimensions.flatMap((d) => [...d.note_ids, ...d.members.flatMap((m) => m.note_ids)]));
  const seen = new Set<number>();
  const result: ViewNote[] = [];
  const add = (id: number, scope: ViewNote["scope"]) => {
    if (seen.has(id)) return;
    const row = rows.find((r) => Number(r.note_id) === id);
    if (row) { seen.add(id); result.push({ pid: cube.pid, note_id: id, text: asText(row.note), scope }); }
  };
  for (const row of rows) if (!referenced.has(Number(row.note_id))) add(Number(row.note_id), { kind: "table" });
  for (const d of cube.dimensions) for (const id of d.note_ids) add(id, { kind: "dimension", dimension: d.name });
  for (const s of selections) for (const m of s.dimension.members) if (s.ids.includes(m.id))
    for (const id of m.note_ids) add(id, { kind: "member", dimension: s.dimension.name, member: m.label });
  return result;
}

/** Offer stable, editable builder presets for a queryable cube. */
export async function suggestViews(db: Db, pid: string): Promise<{ label: string; spec: ViewSpec }[] | undefined> {
  const cube = await getCube(db, pid);
  if (!cube) return undefined;
  const base = (): ViewSpec => {
    const spec: ViewSpec = { v: 1, layers: [{ pid, dims: {} }], time: { preset: cube.kind === "snapshot" ? "latest" : "max" },
      transform: "level", chart: { type: cube.kind === "snapshot" ? "bar" : "line" } };
    if (cube.kind === "snapshot") {
      const geo = cube.dimensions.find((d) => d.role === "geography" && d.members.some((m) => m.roles.includes("province")));
      const category = geo ?? cube.dimensions.find((d) => d.members.length > 1);
      if (category) {
        const members = geo ? geo.members.filter((m) => m.roles.includes("province") || m.roles.includes("territory"))
          : category.members.filter((m) => m.parent_id === category.default_member_id);
        spec.layers[0].dims[String(category.id)] = { use: "x", members: { in: (members.length ? members : category.members).slice(0, 20).map((m) => m.id) } };
      }
    }
    return spec;
  };
  const result = [{ label: "Headline", spec: base() }];
  const geography = cube.dimensions.find((d) => d.role === "geography" && d.members.some((m) => m.roles.includes("province")));
  if (geography) {
    const spec = base();
    spec.layers[0].dims[String(geography.id)] = cube.kind === "snapshot"
      ? { use: "x", members: { any: [{ role: "province" }, { role: "territory" }] } }
      : { use: "series", members: { any: [{ role: "province" }, { role: "territory" }] } };
    result.push({ label: "By province", spec });
  }
  const category = cube.dimensions.find((d) => d.role !== "geography" && d.members.some((m) => m.parent_id === d.default_member_id));
  if (category) {
    const spec = base();
    spec.layers[0].dims[String(category.id)] = { use: "series", members: { in: category.members.filter((m) => m.parent_id === category.default_member_id).slice(0, 12).map((m) => m.id) } };
    result.push({ label: "Components", spec });
  }
  const varying = geography ?? category ?? cube.dimensions.find((d) => d.members.length > 1) ?? cube.dimensions[0];
  if (varying && cube.kind !== "snapshot") {
    const spec = base();
    spec.time = { preset: "latest" };
    spec.chart = { type: "bar" };
    spec.layers[0].dims[String(varying.id)] = { use: "x", members: { in: varying.members.slice(0, 12).map((m) => m.id) } };
    result.push({ label: "Latest bar", spec });
  }
  return result;
}

/** Resolve a spec and run exactly one observation query for each retained layer. */
export async function runView(db: Db, input: ViewSpec, opts: { origin?: string } = {}): Promise<ViewOutcome> {
  const parsed = ViewSpec.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.message, 400);
  const spec = parsed.data;
  const indexLabel = spec.transform === "index_first" ? indexBaseLabel(spec.index_base) : "";
  const warnings: ViewWarning[] = [];
  const layers: LayerData[] = [];
  let xDim: { dimension: string; layer: number } | undefined;
  let xSeen = false;
  if (spec.transform === "pct_change_window" && !["bar", "stacked_bar", "stacked_bar_100"].includes(spec.chart.type)) return invalid("pct_change_window requires a bar chart");
  if (spec.transform === "share_of_x" && !["bar", "stacked_bar", "stacked_bar_100"].includes(spec.chart.type)) return invalid("share_of_x requires an x-category bar chart");
  for (const [index, layer] of spec.layers.entries()) {
    const cube = await getCube(db, layer.pid);
    if (!cube) return invalid(`unknown PID: ${layer.pid}`, 404);
    if (Object.keys(layer.dims).some((key) => !cube.dimensions.some((d) => String(d.id) === key))) return invalid(`unknown dimension in ${layer.pid}`);
    const selections: Selection[] = [];
    const resolved: Record<string, DimensionSel> = {};
    let empty = false;
    let layerX: { dimension: string; layer: number } | undefined;
    for (const dimension of cube.dimensions) {
      const selection = layer.dims[String(dimension.id)] ?? { use: "fixed", members: { eq: dimension.default_member_id } };
      const ids = resolve(dimension, selection.members, warnings);
      const groups = (selection.groups ?? []).map((g): Choice => {
        const memberIds = resolve(dimension, g.members, warnings);
        const regionId = g.region ?? ("region" in g.members ? g.members.region : undefined);
        const region = regionId ? findRegion(regionId) : undefined;
        const missing = region?.members.filter((code) => !dimension.members.some((m) => m.geo_code === code))
          .map((code) => PT_NAMES[code] ?? code) ?? [];
        if (missing.length && memberIds.length) warnings.push({ code: "group_partial",
          message: `${g.label}: ${dimension.name} is missing ${missing.join(", ")}` });
        if (!memberIds.length) warnings.push({ code: "group_missing",
          message: `${g.label}: ${region?.members.length ? `this table has no ${region.label.toLowerCase()}` :
            region?.note ?? "no matching members in this table"}` });
        const choice: Choice = { ids: memberIds, sourceIds: memberIds, regionId, label: g.label, key: `g:${g.label}`, group: true,
          agg: g.agg ?? "auto", groupLabel: g.label, missing,
          groupMembers: memberIds.map((id) => dimension.members.find((m) => m.id === id)!.label) };
        const published = memberIds.length && (choice.agg === "auto" || choice.agg === "published")
          ? publishedMember(dimension, memberIds, g.label, regionId, missing.length === 0) : undefined;
        if (published) { choice.ids = [published]; choice.method = "published"; }
        else if (memberIds.length && choice.agg === "published") {
          warnings.push({ code: "group_published_unavailable",
            message: `${g.label}: no published aggregate; falling back to auto` });
          choice.agg = "auto";
        }
        return choice;
      });
      if (selection.use === "fixed" && ids.length !== 1) return invalid(`${dimension.name}: fixed selection must resolve to exactly one member`);
      if (cube.family === "census_2021" && selection.use === "x" && ids.length > MAX_GROUP_MEMBERS)
        return invalid(`more than ${MAX_GROUP_MEMBERS} Census categories match; narrow the members`);
      if (selection.use !== "fixed" && !ids.length && !groups.some((g) => g.ids.length)) {
        warnings.push({ code: "empty_selection", message: `${cube.title}: ${dimension.name} has no selected members` });
        empty = true;
      }
      if (selection.use === "x") {
        if (xSeen) return invalid("only one x dimension is allowed across a view");
        xSeen = true;
        layerX = { dimension: dimension.name, layer: index };
      }
      resolved[String(dimension.id)] = {
        use: selection.use, members: selection.use === "fixed" ? { eq: ids[0] } :
          ids.length ? { in: ids } : { not: { all: true } },
        ...(selection.groups ? { groups: groups.map((g, i) => ({
          label: g.label, members: g.sourceIds?.length ? { in: g.sourceIds } : { not: { all: true } },
          ...(selection.groups![i].agg ? { agg: selection.groups![i].agg } : {}),
          ...(g.regionId ? { region: g.regionId } : {}),
        })) } : {}),
      };
      selections.push({ dimension, use: selection.use, ids: [...new Set([...ids, ...groups.flatMap((g) => g.ids)])],
        choices: choices(dimension, ids, groups, selection.use),
        named: ("eq" in selection.members || "in" in selection.members) && !selection.groups?.length });
    }
    const rate = selections.find((s) => s.use === "fixed" && s.dimension.role === "measure" &&
      s.choices[0] && s.dimension.members.some((m) => m.id === s.ids[0] && findRatioRule(m.label, s.dimension.name)));
    const measure = rate?.dimension.members.find((m) => m.id === rate.ids[0]);
    const rule = measure && findRatioRule(measure.label, rate!.dimension.name);
    const numerator = rule && rate!.dimension.members.find((m) => m.label === rule.numerator);
    const denominator = rule && rate!.dimension.members.find((m) => m.label === rule.denominator);
    const ratio = rate && rule && numerator && denominator ? { dimensionId: rate.dimension.id,
      numerator: numerator.id, denominator: denominator.id, scale: rule.scale,
      formula: `${rule.numerator} ÷ ${rule.denominator} × ${rule.scale}` } : undefined;
    if (ratio && selections.some((s) => s.dimension.role === "geography" && s.choices.some((choice) =>
      choice.group && !choice.method && (choice.agg === "auto" || choice.agg === "ratio"))))
      rate!.ids.push(ratio.numerator, ratio.denominator);
    spec.layers[index].dims = resolved;
    if (cube.family === "census_2021" && selections.reduce((count, s) => count * s.ids.length, 1) > MAX_SERIES_POINTS)
      return invalid(`more than ${MAX_SERIES_POINTS} Census coordinates match; narrow the members`);
    if (empty) continue;
    if (layerX) xDim = layerX;
    const file = db.parquetPath(cube.pid)!;
    const clauses = selections.map((s) => `o.member_id_${s.dimension.id} IN (${s.ids.join(",")})`);
    const rows = await db.query(`SELECT o.ref_date, p.period_start, p.period_end, p.period_kind, o.value_num, o.value, o.status, o.symbol,
      o.vector, o.uom, o.uom_id, o.scalar_factor, o.scalar_id, uf.family AS unit_family,
      ${selections.map((s) => `o.member_id_${s.dimension.id}`).join(", ")}
      FROM read_parquet($1) o JOIN period p ON p.pid = $2 AND p.ref_date = o.ref_date
      LEFT JOIN unit_family uf ON uf.uom_code = o.uom_id
      WHERE ${clauses.join(" AND ")} ORDER BY p.period_start, ${selections.map((s) => `o.member_id_${s.dimension.id}`).join(", ")}
      LIMIT ${MAX_SERIES_POINTS + 1}`, [file, cube.pid]);
    if (rows.length > MAX_SERIES_POINTS) return invalid(`more than ${MAX_SERIES_POINTS} points match; narrow the members or time window`);
    const periods = new Map((await db.query("SELECT ref_date, period_start FROM period WHERE pid = $1", [cube.pid]))
      .map((row) => [asText(row.period_start), asText(row.ref_date)]));
    layers.push({ cube, selections, rows, periods, index, ratio,
      ratioUnit: ratio ? asText(rows.find((r) => Number(r[`member_id_${ratio.dimensionId}`]) === rate!.choices[0].ids[0])?.uom || "%") : undefined });
    if (layer.method_difference) warnings.push({ code: "group_method_difference", message: layer.method_difference });
  }
  if (spec.transform === "share_of_x" && !xDim) return invalid("share_of_x requires an x dimension");
  if (xDim && !["bar", "stacked_bar", "stacked_bar_100"].includes(spec.chart.type)) return invalid("x categories require a bar chart");
  const observedDates = [...new Set(layers.flatMap((l) => l.rows.map((r) => asText(r.period_start))))].filter(Boolean).sort();
  const earliest = observedDates[0], lastObserved = observedDates.at(-1);
  const dates = [...new Set([...observedDates, ...layers.flatMap((l) => [...l.periods.keys()]
    .filter((date) => !earliest || date >= earliest && date <= lastObserved!))])].sort();
  const latest = dates.at(-1);
  const from = spec.time.from;
  const to = spec.time.to;
  const years = Number.parseInt(spec.time.preset ?? "max", 10);
  const cutoff = !from && !to && Number.isFinite(years) && latest ? dateOffset(latest, years) : undefined;
  const window = dates.filter((d) => {
    if (from || to) return (!from || d >= from) && (!to || d.slice(0, to.length) <= to);
    if (spec.time.preset === "latest") return d === latest;
    return !cutoff || (spec.transform === "level" || spec.transform === "share_of_x" ? d > cutoff : d >= cutoff);
  });
  const inWindow = new Set(window);
  const lagged = spec.transform === "pct_change_yoy" || spec.transform === "pct_change_period";
  const lookbacks = new Map<number, Map<string, string>>();
  const history: string[] = [];
  if (lagged && window.length) for (const layer of layers) {
    const periods = [...new Set(layer.rows.map((r) => asText(r.period_start)))].filter(Boolean).sort();
    const kind = asText(layer.rows.find((r) => r.period_kind)?.period_kind);
    const lag = spec.transform === "pct_change_period" ? 1 : YOY_LAG[kind] ?? 1;
    const first = periods.findIndex((d) => d >= window[0]);
    if (first < 0) continue;
    const start = spec.transform === "pct_change_yoy" && kind === "day"
      ? periods.findIndex((d) => d >= dateOffset(window[0], 1)) : Math.max(0, first - lag);
    if (start >= 0) history.push(...periods.slice(start, first));
    const previous = new Map<string, string>();
    for (let i = first; i < periods.length && periods[i] <= window.at(-1)!; i++) {
      const prior = spec.transform === "pct_change_yoy" && kind === "day"
        ? `${Number(periods[i].slice(0, 4)) - 1}${periods[i].slice(4)}` : periods[i - lag];
      if (prior) previous.set(periods[i], prior);
    }
    lookbacks.set(layer.index, previous);
  }
  if (spec.transform === "index_first" && spec.index_base)
    history.push(...dates.filter((date) => inIndexBase(date, spec.index_base!)));
  const calculationWindow = history.length ? [...new Set([...history, ...window])].sort() : window;
  const inCalculation = calculationWindow === window ? inWindow : new Set(calculationWindow);
  const shown = layers.map((l) => ({ ...l, rows: l.rows.filter((r) => inCalculation.has(asText(r.period_start))) }));
  // Only published aggregates, like units that genuinely add, or rules backed by every member's parts may combine a group.
  for (const layer of shown) for (const selection of layer.selections) {
    for (const choice of [...selection.choices]) {
      if (!choice.group || choice.method || !choice.ids.length) continue;
      if (!choice.groupLabel && choice.ids.length < 2) continue;
      const rows = layer.rows.filter((r) => choice.ids.includes(Number(r[`member_id_${selection.dimension.id}`])) &&
        layer.selections.every((s) => s.use !== "fixed" || s.choices[0].ids.includes(Number(r[`member_id_${s.dimension.id}`]))));
      const units = new Set(rows.map((r) => `${r.uom_id}:${r.scalar_id}`));
      const counts = layer.cube.family === "census_2021" && layer.selections.some((s) =>
        s.use === "fixed" && s.dimension.name === "View" && /counts/i.test(s.choices[0].label));
      const additive = rows.length > 0 && units.size === 1 &&
        (counts || rows.every((r) => ADDITIVE_FAMILIES.has(asText(r.unit_family))));
      if (additive && (!choice.agg || choice.agg === "auto" || choice.agg === "sum") && !choice.missing?.length) {
        choice.method = "sum";
        continue;
      }
      const ratio = layer.ratio;
      if (choice.groupLabel && ratio && selection.dimension.role === "geography" &&
        (choice.agg === "auto" || choice.agg === "ratio") && !choice.missing?.length) {
        const parts = layer.rows.filter((r) => choice.ids.includes(Number(r[`member_id_${selection.dimension.id}`])) &&
          (Number(r[`member_id_${ratio.dimensionId}`]) === ratio.numerator ||
            Number(r[`member_id_${ratio.dimensionId}`]) === ratio.denominator));
        const present = new Set(parts.map((r) => `${r[`member_id_${selection.dimension.id}`]}:${r[`member_id_${ratio.dimensionId}`]}`));
        if (new Set(parts.map((r) => `${r.uom_id}:${r.scalar_id}`)).size === 1 &&
          parts.every((r) => ADDITIVE_FAMILIES.has(asText(r.unit_family))) &&
          choice.ids.every((id) => present.has(`${id}:${ratio.numerator}`) && present.has(`${id}:${ratio.denominator}`))) {
          choice.method = "ratio";
          continue;
        }
      }
      if (choice.groupLabel) {
        const measure = layer.selections.find((s) => s.use === "fixed" && s.dimension.role === "measure")?.choices[0].label ??
          layer.cube.title.split(",")[0];
        warnings.push({ code: "group_not_combined", message: `${measure} cannot be combined for ${choice.label}; showing each member` });
        selection.choices.splice(selection.choices.indexOf(choice), 1, ...choice.ids.map((id) => {
          const individual = choices(selection.dimension, [id], [], "series")[0];
          return { ...individual, key: `${choice.key}:${id}`, groupLabel: choice.label, groupMembers: choice.groupMembers };
        }));
      } else {
        warnings.push({ code: "sum_refused", message: `${layer.cube.title}: ${selection.dimension.name} cannot be summed (unit or scale is mixed or non-additive)` });
        selection.choices.splice(selection.choices.indexOf(choice), 1, ...choice.ids.map((id) => choices(selection.dimension, [id], [], "series")[0]));
        if (selection.use === "sum") selection.use = "series";
      }
    }
  }
  const generated: { series: ViewSeries; meta: (Row | undefined)[]; categories: string[];
    categoryChoices: (Choice | undefined)[]; raw: (Row | undefined)[][] }[] = [];
  for (const layer of shown) {
    if (generated.length === MAX_VIEW_SERIES) break;
    const byCoordinate = new Map(layer.rows.map((r) => [
      `${r.period_start}:${layer.selections.map((s) => r[`member_id_${s.dimension.id}`]).join(",")}`, r,
    ]));
    const variable = layer.selections.filter((s) => s.use === "series");
    const category = layer.selections.find((s) => s.use === "x");
    const combos = product(variable.map((s) => s.choices), MAX_VIEW_SERIES - generated.length);
    for (const combo of combos) {
      const choiceByDim = new Map(variable.map((s, i) => [s.dimension.id, combo[i]]));
      const categoryChoices = category?.choices ?? [undefined];
      const allRows: (Row | undefined)[][] = [];
      const points: Point[] = [];
      const metadata: (Row | undefined)[] = [];
      const ratioChoice = combo.find((choice) => choice.method === "ratio");
      for (const ch of categoryChoices) {
        for (const date of calculationWindow) {
          const memberSets = layer.selections.map((s) => (s === category ? ch! : choiceByDim.get(s.dimension.id) ?? s.choices[0]).ids);
          if (memberSets.reduce((count, ids) => count * ids.length, 1) > MAX_SERIES_POINTS)
            return invalid(`more than ${MAX_SERIES_POINTS} coordinates would be summed at one period`);
          const cells = product(memberSets, MAX_SERIES_POINTS + 1);
          const matching = cells.flatMap((ids) => {
            const row = byCoordinate.get(`${date}:${ids.join(",")}`);
            return row ? [row] : [];
          });
          const ratio = (ch?.method === "ratio" || ratioChoice) && layer.ratio;
          let sources = matching;
          let value: number | null;
          if (ratio) {
            const position = layer.selections.findIndex((s) => s.dimension.id === ratio.dimensionId);
            let numerator = 0, denominator = 0;
            sources = [];
            for (const ids of cells) {
              const original = ids[position];
              ids[position] = ratio.numerator;
              const n = byCoordinate.get(`${date}:${ids.join(",")}`);
              ids[position] = ratio.denominator;
              const d = byCoordinate.get(`${date}:${ids.join(",")}`);
              ids[position] = original;
              if (n) sources.push(n);
              if (d) sources.push(d);
              if (typeof n?.value_num !== "number" || typeof d?.value_num !== "number") continue;
              numerator += Number(n.value_num) * 10 ** Number(n.scalar_id ?? 0);
              denominator += Number(d.value_num) * 10 ** Number(d.scalar_id ?? 0);
            }
            value = sources.length === cells.length * 2 && sources.every((r) => typeof r.value_num === "number") && denominator
              ? numerator / denominator * ratio.scale : null;
          } else value = matching.length === cells.length && matching.every((r) => typeof r.value_num === "number")
            ? matching.reduce((n, r) => n + Number(r.value_num) * (spec.chart.scale_values ? 10 ** Number(r.scalar_id ?? 0) : 1), 0) : null;
          const first = matching[0] ?? sources[0];
          const missingMark = sources.find((row) => row.value_num == null && (row.status || row.symbol));
          points.push([asText(first?.ref_date ?? layer.periods.get(date) ?? date), date, value,
            value == null ? asText(missingMark?.status || missingMark?.symbol || first?.status || first?.symbol)
              : asText(first?.status || sources.find((r) => r.status)?.status)]);
          metadata.push(first);
          allRows.push(sources);
        }
      }
      const selected = layer.selections.map((s) => ({ s, choice: s.use === "x"
        ? { ids: s.ids, label: s.dimension.name, key: "x", group: false } as Choice : choiceByDim.get(s.dimension.id) ?? s.choices[0] }));
      const key = `L${layer.index}:${selected.filter(({ s }) => s.use === "series").map(({ s, choice }) => `${s.dimension.id}=${choice.key}`).join(",")}`;
      const first = metadata.find(Boolean) ?? layer.rows[0];
      const coordinate = selected.map(({ s, choice }) => ({ dimension_id: s.dimension.id, dimension: s.dimension.name, member_ids: choice.ids,
        label: choice.label }));
      const unit = asText(first?.uom);
      const originalScale = db.labels.scalar.get(asText(first?.scalar_id)) ?? asText(first?.scalar_factor ?? "units");
      const embeddedScale = originalScale !== "units" && unit.toLowerCase().includes(originalScale.toLowerCase());
      let displayUnit = unit;
      if (spec.chart.scale_values && embeddedScale && Number(first?.scalar_id ?? 0) !== 0) {
        const lower = unit.toLowerCase(), name = originalScale.toLowerCase();
        const prefix = `${name} of `, suffix = ` in ${name}`, parenthetical = ` (${name})`;
        if (lower.startsWith(prefix)) {
          displayUnit = unit.slice(prefix.length);
          displayUnit = displayUnit.charAt(0).toUpperCase() + displayUnit.slice(1);
        } else if (lower.endsWith(suffix)) displayUnit = unit.slice(0, -suffix.length);
        else if (lower.endsWith(parenthetical)) displayUnit = unit.slice(0, -parenthetical.length);
      }
      const scale = spec.chart.scale_values || embeddedScale ? "units" : originalScale;
      const chosenGroup = selected.find(({ s, choice }) => s.use === "series" && choice.groupLabel)?.choice;
      const categoryMethods = [...new Set(categoryChoices.map((choice) => choice?.method ?? null))];
      const method = chosenGroup?.method ?? (categoryMethods.length === 1 ? categoryMethods[0] ?? undefined : undefined);
      const isRatio = method === "ratio";
      const series: ViewSeries = { key, layer: layer.index, pid: layer.cube.pid, name: "", coordinate,
        kind: isRatio ? "ratio" :
          selected.some(({ s, choice }) => s.use !== "x" && choice.ids.length > 1) || categoryChoices.some((c) => c && c.ids.length > 1) ? "sum" : "observed",
        group: chosenGroup?.groupLabel, group_of: chosenGroup?.method === "published" ? chosenGroup.groupLabel : undefined,
        group_method: method ?? null, group_members: chosenGroup?.groupMembers ??
          [...new Set(categoryChoices.flatMap((choice) => choice?.groupMembers ?? []))],
        vectors: [...new Set(allRows.flat().filter((r): r is Row => !!r).map((r) => asText(r.vector)).filter(Boolean))],
        unit: spec.transform.startsWith("pct_change") || spec.transform === "share_of_x" ? "%" :
          spec.transform === "index_first" ? `index (${indexLabel} = 100)` : isRatio ? layer.ratioUnit! : displayUnit,
        scale: spec.transform === "level" && !isRatio ? scale : "units",
        unit_family: spec.transform === "level" ? isRatio ? "percent" : asText(first?.unit_family ?? "other") :
          spec.transform === "index_first" ? "index" : "percent",
        axis: 0, color: 0, hidden: spec.chart.hidden?.includes(key) ?? false, points,
        gaps: [], coverage: { first: null, last: null }, unpublished: false };
      generated.push({ series, meta: metadata, categories: categoryChoices.map((c) => c?.label ?? ""),
        categoryChoices, raw: allRows });
    }
  }
  const total = shown.reduce((n, layer) => n + layer.selections.filter((s) => s.use === "series").reduce((count, s) => count * s.choices.length, 1), 0);
  if (total > MAX_VIEW_SERIES) warnings.push({ code: "series_capped", message: `showing first ${MAX_VIEW_SERIES} of ${total} series`, total });
  const xIsCategory = !!xDim;
  let at = spec.time.at ? window.findLast((d) => d.startsWith(spec.time.at!)) : undefined;
  if (spec.time.at && xIsCategory && !at) return invalid(`time.at ${spec.time.at} is not in the selected window`);
  if (xIsCategory && !at) {
    at = [...window].reverse().find((date) => generated.every((g) => {
      const points = g.series.points.filter((p) => p[1] === date);
      return points.length === g.categories.length && points.every((p) => p[2] != null);
    })) ?? window.at(-1);
  }
  const allCategories = xIsCategory ? [...new Set(generated.flatMap((g) => g.categories))].filter(Boolean) : [];
  for (const g of generated) {
    const s = g.series;
    if (spec.transform === "pct_change_window") {
      const lastIndex = window.length - 1;
      const chosen = g.categories.map((category, i) => {
        const first = s.points[i * window.length]?.[2] ?? null;
        const last = s.points[i * window.length + lastIndex];
        const value = pct(last?.[2] ?? null, first);
        return { category, point: [asText(last?.[0]), asText(last?.[1]), value, value == null ? asText(last?.[3]) : ""] as Point,
          row: g.meta[i * window.length + lastIndex], raw: g.raw[i * window.length + lastIndex] ?? [] };
      });
      const repeat = xIsCategory && !g.categories[0];
      if (repeat) g.categories = [...allCategories];
      s.points = g.categories.map((_, i) => chosen[repeat ? 0 : i]?.point ?? ["", "", null, ""]);
      g.meta = g.categories.map((_, i) => chosen[repeat ? 0 : i]?.row);
      g.raw = g.categories.map((_, i) => chosen[repeat ? 0 : i]?.raw ?? []);
      if (repeat) g.categoryChoices = allCategories.map(() => undefined);
    } else {
      const indexed = (values: (number | null)[], category?: string) => {
        const base = values.find((v, i) => v != null && (!spec.index_base || inIndexBase(calculationWindow[i], spec.index_base)));
        if (spec.index_base && (base == null || base === 0)) warnings.push({ code: "index_base_missing",
          message: `${s.key}${category ? ` (${category})` : ""} has no usable published point in ${spec.index_base}` });
        return values.map((v) => base && v != null ? v / base * 100 : null);
      };
      const apply = (values: (number | null)[], category?: string) => spec.transform === "index_first"
        ? indexed(values, category) : transform(values, calculationWindow, spec.transform, lookbacks.get(s.layer));
      const values = s.points.map((p) => p[2]);
      const transformed = g.categories.length === 1 || spec.transform === "level" || spec.transform === "share_of_x"
        ? apply(values)
        : g.categories.flatMap((category, i) => apply(values.slice(i * calculationWindow.length, (i + 1) * calculationWindow.length), category));
      s.points = s.points.map((p, i) => [p[0], p[1], transformed[i], transformed[i] == null && p[2] != null ? "" : p[3]]);
      if (xIsCategory) {
        const selected = (g.categories[0] ? g.categories : allCategories).map((category, i) => {
          const j = (g.categories[0] ? i : 0) * calculationWindow.length + calculationWindow.indexOf(at ?? "");
          return { category, point: s.points[j], row: g.meta[j], raw: g.raw[j],
            choice: g.categoryChoices[g.categories[0] ? i : 0] };
        });
        g.categories = selected.map((v) => v.category);
        s.points = selected.map((v) => v.point ?? [at ?? "", at ?? "", null, ""]);
        g.meta = selected.map((v) => v.row);
        g.raw = selected.map((v) => v.raw ?? []);
        g.categoryChoices = selected.map((v) => v.choice);
      } else if (calculationWindow !== window) {
        if (spec.transform === "index_first" && spec.index_base) {
          const kept = s.points.flatMap((point, i) => inWindow.has(point[1]) ? [i] : []);
          s.points = kept.map((i) => s.points[i]);
          g.meta = kept.map((i) => g.meta[i]);
          g.raw = kept.map((i) => g.raw[i]);
        } else {
          const start = calculationWindow.length - window.length;
          s.points = s.points.slice(start);
          g.meta = g.meta.slice(start);
          g.raw = g.raw.slice(start);
        }
      }
    }
    if (!s.points.some((p) => p[2] != null)) warnings.push({ code: "no_data", message: `${s.key} has no published points in the window` });
  }
  if (spec.transform === "share_of_x") for (const g of generated) {
    const values = g.series.points.map((p) => p[2]);
    const denominator = values.every((v) => v != null) ? values.reduce<number>((n, v) => n + v!, 0) : 0;
    g.series.points = g.series.points.map((p) => [p[0], p[1], p[2] != null && denominator ? p[2] / denominator * 100 : null, p[3]]);
  }
  if (xIsCategory && spec.chart.sort && spec.chart.sort !== "none") {
    const direction = spec.chart.sort === "asc" ? 1 : -1;
    const sorted = allCategories.map((name, index) => ({ name, index,
      value: generated.reduce((sum, g) => sum + (g.series.points[g.categories.indexOf(name)]?.[2] ?? 0), 0) }))
      .sort((a, b) => direction * (a.value - b.value) || a.index - b.index);
    allCategories.splice(0, allCategories.length, ...sorted.map((item) => item.name));
    for (const g of generated) {
      const rows = new Map(g.categories.map((name, i) => [name,
        { point: g.series.points[i], meta: g.meta[i], raw: g.raw[i], choice: g.categoryChoices[i] }]));
      g.series.points = allCategories.map((name) => rows.get(name)?.point ?? [at ?? "", at ?? "", null, ""]);
      g.meta = allCategories.map((name) => rows.get(name)?.meta);
      g.raw = allCategories.map((name) => rows.get(name)?.raw ?? []);
      g.categoryChoices = allCategories.map((name) => rows.get(name)?.choice);
      g.categories = [...allCategories];
    }
  }
  for (const g of generated) {
    const series = g.series;
    const first = series.points.findIndex((point) => point[2] !== null);
    const last = series.points.findLastIndex((point) => point[2] !== null);
    series.coverage = { first: series.points[first]?.[0] ?? null, last: series.points[last]?.[0] ?? null };
    series.unpublished = first < 0;
    if (xIsCategory || first < 0) continue;
    const periods = layers.find((layer) => layer.index === series.layer)!.periods;
    let from: Point | undefined, to: Point | undefined, mark: string | null = null;
    const flush = () => {
      if (!from || !to) return;
      series.gaps.push({ from: from[0], to: to[0], mark,
        meaning: mark ? db.labels.status.get(mark) ?? db.labels.symbol.get(mark) ?? mark : "Not published" });
      from = to = undefined;
    };
    for (let i = first + 1; i < last; i++) {
      const point = series.points[i];
      if (!periods.has(point[1])) continue;
      if (point[2] !== null) { flush(); continue; }
      const currentMark = point[3] || null;
      if (from && mark !== currentMark) flush();
      from ??= point;
      to = point;
      mark = currentMark;
    }
    flush();
  }
  const axes: ViewResult["axes"] = [];
  const published = generated.filter((g) => !g.series.unpublished);
  const drawable = published.filter((g) => {
    const s = g.series;
    const index = axes.findIndex((a) => a.unit === s.unit && a.scale === s.scale);
    if (index >= 0) { s.axis = index; return true; }
    if (axes.length >= 2) { warnings.push({ code: "mixed_units", message: `dropped ${s.key}: ${s.unit} (${s.scale}) needs a third axis` }); return false; }
    s.axis = axes.length; axes.push({ unit: s.unit, scale: s.scale, unit_family: s.unit_family }); return true;
  });
  if (!axes.length && generated.length) {
    const first = generated[0].series;
    axes.push({ unit: first.unit, scale: first.scale, unit_family: first.unit_family });
  }
  for (const { series } of generated) if (series.unpublished) {
    series.axis = Math.max(0, axes.findIndex((a) => a.unit === series.unit && a.scale === series.scale));
  }
  const drawn = new Set(drawable);
  const accepted = generated.filter((g) => g.series.unpublished || drawn.has(g));
  if (axes.length === 2) warnings.push({ code: "mixed_units", message: "two unit axes are shown" });
  const used = new Set(Object.values(spec.chart.colors ?? {}));
  let slot = 0;
  for (const g of accepted) { while (used.has(slot) && slot < 10) slot++; g.series.color = spec.chart.colors?.[g.series.key] ?? slot++ % 10; }
  const leads = layers.map((layer) => {
    const trade = layer.cube.title.match(/\bfor (imports|exports)\b/i)?.[1];
    const countries = layer.selections.filter((s) => s.use === "fixed" && s.ids[0] !== s.dimension.default_member_id
      && /country of (?:origin|export)/i.test(s.dimension.name))
      .map((s) => s.dimension.members.find((m) => m.id === s.ids[0])?.label.match(/^(.+), country of (?:origin|export)$/i)?.[1]);
    if (trade && countries.length) {
      const concept = trade[0].toUpperCase() + trade.slice(1).toLowerCase();
      if (countries[0] && countries.every((country) => country === countries[0])) {
        const country = countries[0];
        return `${concept} from ${country === "United States" ? "the " : ""}${country}`;
      }
      return concept;
    }
    const labels = layer.selections.filter((s) => s.use === "fixed" && s.dimension.role !== "geography"
      && s.ids[0] !== s.dimension.default_member_id)
      .sort((a, b) => Number(b.dimension.role === "measure" || b.dimension.carries_unit)
        - Number(a.dimension.role === "measure" || a.dimension.carries_unit))
      .map((s) => s.dimension.members.find((m) => m.id === s.ids[0])?.label?.trim()).filter(Boolean);
    if (labels.length) return labels.join(" · ");
    const display = displayTitle(layer);
    let depth = 0;
    for (let i = 0; i < display.length; i++) {
      const char = display[i];
      if (char === "(") depth++;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === "," && depth === 0) {
        const first = display.slice(0, i).trim();
        if (!SOURCE_TITLE_LEAD.test(first) && !ORGANIZATION_TITLE_LEAD.test(first)) return first;
        const next = display.slice(i + 1).trim();
        const end = next.search(/,| (?:for|by|in) /i);
        const topic = (end < 0 ? next : next.slice(0, end)).trim();
        return topic ? topic[0].toUpperCase() + topic.slice(1) : first;
      }
    }
    return display.trim() || layer.cube.table_number;
  });
  const sharedSubject = layers.length > 1 && leads.every((lead) => lead.toLowerCase() === leads[0].toLowerCase());
  const names = accepted.map(({ series }) => {
    const layer = layers.find((l) => l.index === series.layer)!;
    const varying = new Set(layer.selections.filter((s) => s.use === "series").map((s) => s.dimension.id));
    const measure = new Set(layer.selections.filter((s) => s.use === "fixed" && (s.dimension.role === "measure" || s.dimension.carries_unit))
      .map((s) => s.dimension.id));
    const label = series.coordinate.filter((c) => varying.has(c.dimension_id)).map((c) => c.label.trim()).filter(Boolean).join(" · ")
      || series.coordinate.filter((c) => measure.has(c.dimension_id)).map((c) => c.label.trim()).filter(Boolean).join(" · ")
      || displayTitle(layer).trim() || layer.cube.table_number;
    const name = layer.cube.family === "census_2021"
      ? label.replace(/^Total - .+$/, "Total").replace(/^(?:19|20)\d{2} Counts$/, "Counts") : label;
    const subject = leads[layers.indexOf(layer)];
    const titled = spec.layers.length > 1 && !sharedSubject && !name.toLowerCase().includes(subject.toLowerCase())
      ? `${subject} · ${name}` : name;
    return { series, label: titled, tableNumber: layer.cube.table_number };
  });
  const nameCounts = new Map<string, number>();
  for (const { label } of names) nameCounts.set(label, (nameCounts.get(label) ?? 0) + 1);
  for (const { series, label, tableNumber } of names)
    series.name = nameCounts.get(label)! > 1 ? `${label} (${tableNumber})` : label;
  const families = new Set(layers.map((l) => l.cube.family));
  if (families.size > 1) warnings.push({ code: "mixed_family", message: "WDS and Census sources share this view" });
  const frequencies = new Set(layers.map((l) => l.cube.frequency));
  if (frequencies.size > 1) warnings.push({ code: "mixed_frequency", message: "source tables have different frequencies" });
  const group_notes: ViewResult["group_notes"] = [];
  const seenGroups = new Set<string>();
  for (const layer of layers) for (const selection of layer.selections) for (const choice of selection.choices) {
    if (!choice.groupLabel || !accepted.some((g) => g.series.layer === layer.index &&
      (selection.use === "x" ? g.categoryChoices.includes(choice) :
        g.series.key.includes(`${selection.dimension.id}=${choice.key}`)))) continue;
    const id = `${layer.index}:${selection.dimension.id}:${choice.groupLabel}`;
    if (seenGroups.has(id)) continue;
    seenGroups.add(id);
    const method = choice.method ?? "not_combined";
    const formula = method === "ratio" ? layer.ratio?.formula :
      method === "published" ? `published as ${selection.dimension.members.find((m) => m.id === choice.ids[0])?.label}` :
      method === "sum" ? `sum of ${choice.groupMembers?.join(", ")}` : "shown as individual members";
    group_notes.push({ pid: layer.cube.pid, label: choice.groupLabel, method,
      members: choice.groupMembers ?? [], formula,
      ...(spec.layers[layer.index].method_difference
        ? { method_difference: spec.layers[layer.index].method_difference } : {}) });
  }
  const unpublishedNames = accepted.filter((g) => g.series.unpublished).map((g) => g.series.name);
  const missingCategories = xIsCategory ? accepted.flatMap((g) => g.series.points.flatMap((point, i) =>
    point[2] === null && g.categories[i] ? [`${g.categories[i]} ${g.series.name}`] : [])) : [];
  const missingNames = [...new Set([...unpublishedNames, ...missingCategories])];
  const gapEntries = accepted.flatMap((g) => g.series.gaps.map((gap) => ({ name: g.series.name, ...gap })));
  const subject = leads.length && leads.every((lead) => lead === leads[0]) ? leads[0] : "";
  const places = missingNames.map((name) => name.replace(/, [^,]+$/, ""));
  const listed = places.length <= 2 ? places.join(" and ")
    : places.length === 3 ? `${places.slice(0, 2).join(", ")} and ${places[2]}`
      : `${places.slice(0, 2).join(", ")} and ${places.length - 2} more`;
  const missingText = places.length
    ? `${listed}${subject && places.every((name) => !name.toLowerCase().includes(subject.toLowerCase())) ? ` ${subject}` : ""} ${places.length === 1 ? "is" : "are"} not published by Statistics Canada.` : "";
  const gapText = gapEntries.length === 1
    ? `${gapEntries[0].name}: ${gapEntries[0].meaning}${gapEntries[0].mark ? ` (${gapEntries[0].mark})` : ""} ${gapEntries[0].from}–${gapEntries[0].to}.`
    : gapEntries.length ? "Some periods are not published; breaks in the lines mark them." : "";
  const gap_parts = { unpublished: missingText || null, time: gapText || null };
  const gap_note = [gap_parts.unpublished, gap_parts.time].filter(Boolean).join(" ") || null;
  const origin = opts.origin || publicOrigin();
  const link = (path: string) => new URL(path, origin).toString();
  const notes: ViewNote[] = [];
  const sources: ViewSource[] = [];
  for (const layer of layers) {
    notes.push(...notesFor(layer.cube, layer.selections, await db.query("SELECT note_id, note FROM note WHERE pid = $1 ORDER BY note_id", [layer.cube.pid])));
    const [corrections, inventoryCorrections] = await Promise.all([
      db.query("SELECT correction_date, correction_note FROM correction WHERE pid = $1 ORDER BY correction_id", [layer.cube.pid]),
      db.query("SELECT correction_date, note_en FROM inventory_correction WHERE pid = $1 ORDER BY correction_date", [layer.cube.pid]),
    ]);
    const marks = new Set(accepted.filter((g) => g.series.layer === layer.index).flatMap((g) => [
      ...g.series.points.map((p) => p[3]),
      ...g.raw.flatMap((rows) => rows.flatMap((r) => r ? [asText(r.status), asText(r.symbol)] : [])),
    ]));
    sources.push({ pid: layer.cube.pid, table_number: layer.cube.table_number, title: layer.cube.title, family: layer.cube.family,
      frequency: layer.cube.frequency, captured: db.manifest.tables[layer.cube.pid]?.source_captured_at_utc?.slice(0, 10) ?? null,
      url: layer.cube.url, citation: [db.citation(layer.cube.pid), `Independent copy: ${link(`/tables/${layer.cube.pid}`)}`,
        ...(indexLabel ? [`Indexed to ${indexLabel} = 100`] : []),
        ...group_notes.filter((note) => note.pid === layer.cube.pid)
        .map((note) => `${note.label}: ${note.formula}; members: ${note.members.join(", ")}`),
      ...accepted.filter((g) => g.series.layer === layer.index).flatMap((g) => [
        ...(g.series.unpublished ? [`${g.series.name}: not published for this selection`] : []),
        ...g.series.gaps.slice(0, 3).map((gap) => `${g.series.name}: ${gap.meaning} ${gap.from}–${gap.to}`),
        ...(xIsCategory ? g.series.points.flatMap((point, i) =>
          point[2] === null && g.categories[i] ? [`${g.categories[i]}: not published`] : []).slice(0, 3) : []),
      ])].join("; "),
      marks: [...marks].filter(Boolean).map((mark) => ({ mark, meaning: db.labels.status.get(mark) ?? db.labels.symbol.get(mark) ?? mark })),
      corrections: [...corrections.map((r) => ({ date: asText(r.correction_date), note: asText(r.correction_note) })),
        ...inventoryCorrections.map((r) => ({ date: asText(r.correction_date), note: asText(r.note_en) }))] });
  }
  const xName = xDim && layers.find((layer) => layer.index === xDim.layer)?.cube.family === "census_2021"
    ? xDim.dimension.replace(/\s+\([^)]*\)$/, "").replace(/^Language spoken most often at home$/i, "Language")
    : xDim?.dimension;
  const compared = sharedSubject ? [...new Set(names.map(({ series, label }) => series.group ?? label)
    .filter((label) => label.toLowerCase() !== leads[0].toLowerCase()))] : [];
  let title = spec.title ?? (sharedSubject
    ? `${leads[0]}${compared.length && compared.length <= 3 ? `, ${compared.join(" vs ")}` : ""}`
    : leads.join(" vs "));
  if (spec.title === undefined && layers.length === 1 && xDim) {
    if (/^Deaths and mortality rate\b/.test(title) && /^Cause of death \(ICD-10\)$/.test(xDim.dimension))
      title = "Deaths";
    if (/^Average weekly earnings including overtime for all employees$/.test(title) &&
      /North American Industry Classification System \(NAICS\)/.test(xDim.dimension))
      title = "Average weekly earnings";
  }
  if (spec.title === undefined && layers.length === 1 && layers[0].cube.family === "census_2021") {
    const geography = layers[0].selections.find((s) => s.dimension.role === "geography" && s.use === "fixed")?.choices[0]?.label;
    const place = geography && shortPlace(geography);
    if (place && geography !== "Canada" && !title.toLowerCase().includes(place.toLowerCase())) title += `, ${place}`;
  }
  if (spec.title === undefined && layers.length === 1 && accepted.length === 1) {
    const named = layers[0].selections.filter((s) => s.use === "series" && s.named && s.choices.length === 1);
    if (named.length === 1) title += `: ${named[0].choices[0].label}`;
  }
  if (spec.title === undefined) {
    if (layers.length === 1 && accepted.length >= 2 && accepted.length <= 3) {
      const varying = layers[0].selections.filter((s) => s.use === "series" && s.named && new Set(accepted.map((g) =>
        g.series.coordinate.find((c) => c.dimension_id === s.dimension.id)?.label)).size > 1);
      if (varying.length === 1) {
        const labels = accepted.map((g) => g.series.coordinate.find((c) =>
          c.dimension_id === varying[0].dimension.id)!.label);
        const display = labels.map((label) => {
          const parts = label.split(", ");
          return varying[0].dimension.role === "geography" && parts.length === 2 && labels.includes(parts[1])
            ? parts[0] : label;
        });
        const comparison = display.join(" vs ");
        const geography = varying[0].dimension.role === "geography";
        title = geography ? `${title}${display.some((label, i) => label !== labels[i]) ? ": " : ", "}${comparison}` : comparison;
      }
    }
    if (layers.length === 1 && xDim) {
      const x = layers[0].selections.find((s) => s.use === "x")!;
      if (x.named && x.choices.length >= 2 && x.choices.length <= 3) {
        title += `, ${x.choices.map((choice) =>
          x.dimension.role === "geography" && layers[0].cube.family === "census_2021" ? shortPlace(choice.label) : choice.label).join(" vs ")}`;
      } else {
        const roles = x.ids.map((id) => x.dimension.members.find((m) => m.id === id)?.roles ?? []);
        const province = roles.every((selected) => selected.includes("province"));
        const territory = roles.every((selected) => selected.includes("territory"));
        const both = roles.every((selected) => selected.includes("province") || selected.includes("territory"));
        const scope = province ? "province" : territory ? "territory" : both ? "province or territory"
          : /North American Industry Classification System \(NAICS\)/.test(xName!) ? "industry"
          : /^Cause of death \(ICD-10\)$/.test(xName!) ? "cause of death" : xName!;
        if (!(layers[0].cube.family === "census_2021" ? title.toLowerCase().includes(scope.toLowerCase()) : title.toLowerCase().endsWith(scope.toLowerCase()))) title += ` by ${scope}`;
      }
    }
    if (spec.transform === "pct_change_window" && window.length) {
      const preset = !from && !to && /^(\d+)Y$/.exec(spec.time.preset ?? "");
      title += preset ? `, % change over ${preset[1]} year${preset[1] === "1" ? "" : "s"}`
        : `, % change since ${from?.slice(0, 4) ?? window[0].slice(0, 4)}`;
    } else title += spec.transform === "index_first"
      ? `, indexed to ${indexLabel} = 100` : TRANSFORM_SUFFIX[spec.transform];
  }
  let plottedFrom: string | undefined;
  let plottedTo: string | undefined;
  if (lagged && !xIsCategory) for (const { series } of accepted) for (const point of series.points) {
    if (point[2] == null) continue;
    if (!plottedFrom || point[1] < plottedFrom) plottedFrom = point[1];
    if (!plottedTo || point[1] > plottedTo) plottedTo = point[1];
  }
  const plottedPeriod = !plottedFrom ? [] : plottedFrom === plottedTo ? [plottedFrom] : [plottedFrom, plottedTo!];
  const periodDates = xIsCategory && spec.transform !== "pct_change_window" && spec.transform !== "index_first"
    ? (at ? [at] : []) : lagged ? plottedPeriod : window;
  const periodYear = periodDates.length === 1 ? periodDates[0].slice(0, 4) : "";
  const fixed = [...new Set(layers.flatMap((l) => l.selections.filter((s) => s.use === "fixed"
    && (s.dimension.role === "geography" || !s.dimension.members.find((m) => m.id === s.ids[0])?.roles.includes("total")))
    .map((s) => {
      const label = s.dimension.members.find((m) => m.id === s.ids[0])?.label ?? "";
      return l.cube.family === "census_2021" && /^(?:Statistics\b|View$)/i.test(s.dimension.name) && periodYear &&
        label.startsWith(`${periodYear} `) ? label.slice(periodYear.length + 1) : label;
    })))]
    .filter((label) => label && !title.toLowerCase().includes(label.toLowerCase()));
  const periodKind = asText(layers[0]?.rows.find((r) => r.period_kind)?.period_kind);
  const grain = !xIsCategory && accepted.some(({ series }) => series.points.length)
    ? grainOf({ x: { kind: "time" }, series: accepted.map(({ series }) => series) }) : periodKind;
  const censusYear = layers.length > 0 && layers.every((layer) => layer.cube.family === "census_2021");
  const showDay = !censusYear && (grain === "day" || grain === "week");
  const showYear = censusYear || grain === "year" || grain === "fiscal_year";
  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    ...(showDay ? { day: "numeric", month: "short" } : showYear ? {} : { month: "short" }),
    year: "numeric", timeZone: "UTC",
  });
  const displayDate = (date: string) => date ? dateFormat.format(new Date(`${date}T00:00:00Z`)) : "";
  const unitLabels = spec.transform === "level" ? [...new Set(axes.map((axis) =>
    axis.scale && axis.scale !== "units" ? `${axis.unit} (${axis.scale})` : axis.unit).filter(Boolean))] : [];
  const fixedText = fixed.join(" ");
  const subtitle = [...fixed,
    periodDates.length ? periodDates.length === 1 ? displayDate(periodDates[0]) : `${displayDate(periodDates[0])} – ${displayDate(periodDates.at(-1)!)}` : "",
    ...unitLabels.filter((unit) => !title.toLowerCase().includes(unit.toLowerCase())
      && !new RegExp(`\\b${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(fixedText))].filter(Boolean).join(" · ");
  const url = encodeSpec(spec);
  const xGroupChoices = xDim && accepted.find((g) => g.series.layer === xDim.layer)?.categoryChoices;
  const result: ViewResult = { build_id: db.manifest.build_id, normalized_build_id: db.normalized.build_id, spec,
    title, subtitle, gap_note, gap_parts, index_note: !indexLabel ? null : spec.index_base
      ? `Index uses the first published point in ${indexLabel} as 100, when available.`
      : "Index uses the first published point in the displayed window as 100, when available.",
    x: xDim ? { kind: "category", ...xDim, dimension: xName!, at: at ?? "" } : { kind: "time" },
    ...(xDim ? { categories: allCategories } : {}),
    ...(xGroupChoices ? { category_groups: xGroupChoices.map((choice) => choice?.groupLabel ?? null),
      category_methods: xGroupChoices.map((choice) => choice?.method ?? null) } : {}),
    axes, series: accepted.map((g) => g.series),
    period: { from: periodDates[0] ?? null, to: periodDates.at(-1) ?? null }, notes, group_notes, sources, warnings,
    links: { self: link(`/api/v1/view?s=${url}`), parquet: link(`/api/v1/view.parquet?s=${url}`),
      csv: link(`/api/v1/view.csv?s=${url}`), page: link(`/?s=${url}`) } };
  exportsFor.set(result, accepted.flatMap((g) => g.series.points.map((p, i): ExportRow => ({
    series_key: g.series.key, series_name: g.series.name, layer: g.series.layer, pid: g.series.pid,
    table_number: layers.find((l) => l.index === g.series.layer)!.cube.table_number,
    vectors: [...new Set((g.raw[i] ?? []).flatMap((r) => r ? [asText(r.vector)] : []).filter(Boolean))],
    coordinate: g.series.coordinate.map((c) => ({ dimension: c.dimension,
      members: xIsCategory && g.series.layer === xDim?.layer && c.dimension === xDim.dimension
        ? [...new Set((g.raw[i] ?? []).flatMap((r) => r ? [asText(r[`member_id_${c.dimension_id}`])] : []))].join(",")
        : c.member_ids.join(",") })),
    category: xIsCategory ? g.categories[i] ?? null : null, ref_date: p[0],
    period_start: p[1], period_end: g.meta[i]?.period_end == null ? null : asText(g.meta[i]?.period_end), value: p[2],
    value_published: (g.categoryChoices[i]?.method === "published" || g.series.kind === "observed") && spec.transform === "level"
      ? asText(g.meta[i]?.value) || null : null,
    status: p[3], unit: g.series.unit, scale: g.series.scale, unit_family: g.series.unit_family, transform: spec.transform,
    hidden: g.series.hidden, group: g.categoryChoices[i]?.groupLabel ?? g.series.group ?? null,
    group_method: g.categoryChoices[i]?.method ?? g.series.group_method,
    group_members: g.categoryChoices[i]?.groupMembers ?? g.series.group_members,
  }))));
  return { kind: "ok", result };
}

export const exportHash = (spec: ViewSpec): string => createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 10);
export const quoteSql = sql;
