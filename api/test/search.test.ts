import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { openFromEnv } from "../src/config.ts";
import { MAX_LIMIT, type Db } from "../src/db.ts";

// The original ILIKE and separate count queries are the reference for both matching and rank.
async function reference(db: Db, q: string, opts: Parameters<Db["search"]>[1]) {
  const params: unknown[] = [];
  const where: string[] = [];
  const hits = [[], [], [], []] as string[][];
  for (const term of q.trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    params.push(`%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, term);
    const like = `$${params.length - 1}`;
    const exact = `$${params.length}`;
    for (const [i, field] of ["search_title", "search_dimensions", "search_members", "search_notes"].entries()) {
      hits[i].push(`(${field} ILIKE ${like} ESCAPE '\\')::INT`);
    }
    where.push(`(pid = ${exact} OR cansim_id = ${exact} OR search_text ILIKE ${like} ESCAPE '\\')`);
  }
  for (const key of ["archived", "kind", "family"] as const) {
    if (opts[key]) { params.push(opts[key]); where.push(`${key} = $${params.length}`); }
  }
  if (opts.queryable) where.push("queryable");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const score = (columns: string[]) => columns.join(" + ") || "0";
  const total = Number((await db.one(`SELECT count(*) AS n FROM tables ${clause}`, params))!.n);
  const rows = await db.query(`SELECT pid, cansim_id, title_en, archived, frequency_code, frequency_en, dimension_count,
    cube_start_date, cube_end_date, queryable, kind, family, subject_en, period_min, period_max, series_count, unit_families, place_levels,
    ${score(hits[0])} AS title_hits, ${score(hits[1])} AS dimension_hits, ${score(hits[2])} AS member_hits,
    ${score(hits[3])} AS note_hits, ${score([...hits[1], ...hits[2], ...hits[3]])} AS text_hits
    FROM tables ${clause} ORDER BY title_hits DESC, queryable DESC, text_hits DESC, title_en, pid
    LIMIT ${Math.min(opts.limit, MAX_LIMIT)} OFFSET ${Math.max(opts.offset, 0)}`, params);
  return { total, rows };
}

const mounted = existsSync(process.env.STATCAN_BUILD ?? "");
test("table search preserves matching, ranking, filters, pagination, and total", { skip: !mounted && "build is not mounted" }, async () => {
  const { db } = await openFromEnv();
  const cases: [string, Parameters<Db["search"]>[1]][] = [
    ["CPI", { queryable: true, limit: 12, offset: 0 }],
    ["population by province", { queryable: true, limit: 12, offset: 0 }],
    ["health", { archived: "2", kind: "time_series", family: "wds", queryable: true, limit: 3, offset: 7 }],
    ["gasoline%", { limit: 10, offset: 0 }],
    ["_", { limit: 10, offset: 0 }],
    ["\\", { limit: 10, offset: 0 }],
    ["É", { limit: 10, offset: 0 }],
    ["", { limit: 10, offset: 100_000 }],
  ];
  try {
    for (const [q, opts] of cases) {
      assert.deepEqual(await db.search(q, opts), await reference(db, q, opts), `q=${JSON.stringify(q)}`);
    }
  } finally {
    db.close();
  }
});
