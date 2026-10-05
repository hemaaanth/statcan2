import { type Db, tableNumber } from "./db.ts";
import { type CubeDimension, type CubeInfo, type CubeMember, type MemberRole, statcanTableUrl } from "./spec.ts";

/** PT codes of the three territories; every other 2-digit PT code at province level is a province. */
const TERRITORY_CODES = new Set(["60", "61", "62"]);

const noteIds = (text: unknown): number[] =>
  String(text ?? "").split(";").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);

const cache = new Map<string, Promise<CubeInfo | undefined>>();

/** Cube metadata with derived roles. Cached per PID for the life of the process (the build is immutable). */
export function getCube(db: Db, pid: string): Promise<CubeInfo | undefined> {
  let hit = cache.get(pid);
  if (!hit) {
    hit = loadCube(db, pid);
    cache.set(pid, hit);
    hit.catch(() => cache.delete(pid));
  }
  return hit;
}

async function loadCube(db: Db, pid: string): Promise<CubeInfo | undefined> {
  const table = await db.one(
    `SELECT pid, title_en, family, kind, frequency_en, period_min, period_max, unit_families FROM tables WHERE pid = $1 AND series_count IS NOT NULL`, [pid]);
  const file = db.parquetPath(pid);
  if (!table || !file) return undefined;
  const [dimensions, members, inventory, units] = await Promise.all([
    db.query("SELECT dimension_id, dimension_name, dimension_notes FROM dimension WHERE pid = $1 ORDER BY dimension_id", [pid]),
    db.query(`SELECT m.dimension_id, m.member_id, m.member_name, m.parent_member_id, m.classification_code, m.member_notes, m.terminated,
                     mp.place_id, p.level, p.geo_code
              FROM member m
              LEFT JOIN member_place mp ON mp.pid = m.pid AND mp.dimension_id = m.dimension_id AND mp.member_id = m.member_id
              LEFT JOIN place p ON p.place_id = mp.place_id
              WHERE m.pid = $1 ORDER BY m.dimension_id, m.member_id`, [pid]),
    db.query("SELECT position, has_uom FROM inventory_dimension WHERE pid = $1", [pid]),
    // Census source cells have no UOM code; its member labels are the only available unit clues.
    table.family === "census_2021" ? Promise.resolve([]) : db.query(
      "SELECT DISTINCT uom_code, scalar_code, unit_family FROM read_parquet($1) WHERE pid = $2 ORDER BY uom_code, scalar_code",
      [db.seriesPath(pid), pid]),
  ]);
  const hasUom = new Set(inventory.filter((r) => r.has_uom === true).map((r) => Number(r.position)));

  const dims: CubeDimension[] = dimensions.map((d) => {
    const id = Number(d.dimension_id);
    const rows = members.filter((m) => Number(m.dimension_id) === id);
    const parentOf = new Map(rows.map((m) => [Number(m.member_id), m.parent_member_id == null ? null : Number(m.parent_member_id)]));
    const hasChildren = new Set([...parentOf.values()].filter((p): p is number => p !== null));
    const depth = (memberId: number): number => {
      let n = 0;
      for (let p = parentOf.get(memberId) ?? null; p !== null && n < 50; p = parentOf.get(p) ?? null) n++;
      return n;
    };
    // Two members can share one PT code: "Northwest Territories including Nunavut" (pre-1999) and "Northwest Territories"
    // both carry 61. Only DGUID-matched members keep the province/territory role; the other is a historical region.
    const dguidCodes = new Set(rows.filter((m) => m.level === "province" && !String(m.place_id).startsWith("code:")).map((m) => String(m.geo_code)));
    const list: CubeMember[] = rows.map((m) => {
      const memberId = Number(m.member_id);
      const parent = parentOf.get(memberId) ?? null;
      // A parent id that is not a member of this dimension is treated as a root.
      const parentId = parent !== null && parentOf.has(parent) ? parent : null;
      const roles: MemberRole[] = [];
      if (parentId === null && hasChildren.has(memberId)) roles.push("total");
      const level = m.level == null ? null : String(m.level);
      if (level === "country") roles.push("country");
      else if (level === "province" && String(m.place_id).startsWith("code:") && dguidCodes.has(String(m.geo_code))) roles.push("region");
      else if (level === "province") roles.push(TERRITORY_CODES.has(String(m.geo_code ?? "")) ? "territory" : "province");
      else if (level) roles.push("region");
      const geoCode = (roles.includes("province") || roles.includes("territory")) && m.place_id != null && !String(m.place_id).startsWith("code:")
        && m.geo_code != null ? String(m.geo_code) : null;
      if (!hasChildren.has(memberId)) roles.push("leaf");
      return {
        id: memberId, label: String(m.member_name ?? `#${memberId}`), parent_id: parentId, depth: parentId === null ? 0 : depth(memberId), roles,
        place_id: m.place_id == null ? null : String(m.place_id),
        geo_code: geoCode,
        classification_code: m.classification_code ? String(m.classification_code) : null,
        note_ids: noteIds(m.member_notes), terminated: m.terminated === "1" || m.terminated === "true",
      };
    });
    const mapped = list.filter((m) => m.place_id !== null).length;
    const roots = list.filter((m) => m.parent_id === null);
    const totals = roots.filter((m) => m.roles.includes("total"));
    return {
      id, name: String(d.dimension_name), note_ids: noteIds(d.dimension_notes),
      role: list.length && mapped * 2 >= list.length ? "geography" : hasUom.has(id) ? "measure" : "category",
      carries_unit: hasUom.has(id),
      default_member_id: (totals.length === 1 ? totals[0] : roots[0] ?? list[0])?.id ?? 1,
      members: list,
    };
  });

  if (table.period_max && dims.length) {
    const columns = dims.map((d) => `member_id_${d.id}`);
    // One scan when the cube enters the build-scoped cache. Use actual numeric observations:
    // series.period_max can include trailing unpublished rows.
    // DuckDB ranks and returns one row: census cubes publish millions of recent coordinates, which must never
    // reach the JS heap. Rank per dimension: the current default, then roots, then the rest, each in member order.
    const rank = dims.map((d, i) => {
      const roots = d.members.filter((m) => m.parent_id === null && m.id !== d.default_member_id).map((m) => m.id);
      const column = `o.${columns[i]}`;
      return `CASE WHEN ${column} = ${Number(d.default_member_id)} THEN 0${roots.length
        ? ` WHEN list_contains([${roots.map(Number).join(",")}], ${column}) THEN 1` : ""} ELSE 2 END, ${column}`;
    });
    const best = await db.one(
      `SELECT ${columns.map((column) => `o.${column}`).join(", ")}
       FROM read_parquet($1) o
       WHERE o.pid = $2 AND o.value_num IS NOT NULL AND o.ref_date IN
         (SELECT ref_date FROM period WHERE pid = $2 AND period_end
           ${table.frequency_en === "Monthly"
             ? ">= date_trunc('month', CAST($3 AS DATE)) - INTERVAL '11 months'"
             : "= CAST($3 AS DATE)"})
       ORDER BY ${rank.join(", ")} LIMIT 1`,
      [file, pid, String(table.period_max)]);
    if (best) dims.forEach((d, i) => { d.default_member_id = Number(best[columns[i]!]); });
  }

  return {
    pid, table_number: tableNumber(pid), title: String(table.title_en), family: String(table.family), kind: String(table.kind),
    frequency: table.frequency_en == null ? null : String(table.frequency_en),
    period_min: table.period_min == null ? null : String(table.period_min), period_max: table.period_max == null ? null : String(table.period_max),
    unit_families: (table.unit_families as string[] | null) ?? [],
    units: units.map((u) => ({
      uom_code: String(u.uom_code), uom: db.labels.uom.get(String(u.uom_code)) ?? String(u.uom_code),
      scalar: db.labels.scalar.get(String(u.scalar_code)) ?? String(u.scalar_code), unit_family: String(u.unit_family ?? "other"),
    })),
    dimensions: dims,
    url: statcanTableUrl(pid),
  };
}
