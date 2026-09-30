import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export type Row = Record<string, unknown>;

export interface TableReport {
  status: "ok" | "error";
  source_zip: string;
  source_sha256?: string;
  source_captured_at_utc?: string;
  dims?: number;
  row_count?: number;
  ref_date_min?: string;
  ref_date_max?: string;
  status_counts?: Record<string, number>;
  symbol_counts?: Record<string, number>;
  blank_value_count?: number;
  duplicate_coordinate_ref_date?: number;
  duplicate_vector_ref_date?: number;
  parquet?: { path: string; bytes: number; sha256: string };
  errors: string[];
  warnings: string[];
}

export interface Manifest {
  build_id: string;
  built_at_utc: string;
  capture_id: string;
  capture_dir: string;
  language: string;
  inventory: { path: string; sha256: string; records: number };
  tool: Record<string, string>;
  catalogue: Record<string, { rows: number; bytes: number; sha256: string }>;
  tables: Record<string, TableReport>;
  summary: Record<string, number>;
}

const CATALOGUE = ["cube", "inventory_dimension", "inventory_correction", "cube_meta", "dimension", "member",
  "attribute", "symbol", "survey", "subject", "note", "correction"];
export const MAX_DIMS = 9;
export const MAX_LIMIT = 1000;

/** Refuse to start unless `dir` lives on the filesystem with this UUID (same rule as tools/wds_download.py). */
export function requireMount(dir: string, uuid: string) {
  if (!/^[0-9A-Fa-f-]{4,64}$/.test(uuid)) throw new Error("invalid filesystem UUID");
  const device = statSync(`/dev/disk/by-uuid/${uuid}`);
  if (!device.isBlockDevice()) throw new Error(`UUID ${uuid} is not a block device`);
  if (statSync(dir).dev !== device.rdev) throw new Error(`${dir} is not mounted from UUID ${uuid}`);
}

function plain(rows: Row[]): Row[] {
  for (const row of rows) for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
  return rows;
}

export class Db {
  readonly buildDir: string;
  readonly manifest: Manifest;
  private readonly instance: DuckDBInstance;

  private constructor(buildDir: string, manifest: Manifest, instance: DuckDBInstance) {
    this.buildDir = buildDir;
    this.manifest = manifest;
    this.instance = instance;
  }

  static async open(buildDir: string): Promise<Db> {
    const manifest = JSON.parse(readFileSync(path.join(buildDir, "build_manifest.json"), "utf8")) as Manifest;
    // Spill next to the build, never in the process cwd (the OS disk holds no dataset bytes, not even temporaries).
    const instance = await DuckDBInstance.create(":memory:", { threads: "4", memory_limit: "2GB", temp_directory: path.join(buildDir, "tmp") });
    const db = new Db(buildDir, manifest, instance);
    const c = await instance.connect();
    try {
      for (const name of CATALOGUE) {
        await c.run(`CREATE TABLE ${name} AS SELECT * FROM read_parquet($1)`, [path.join(buildDir, "catalogue", `${name}.parquet`)]);
      }
      await c.run("CREATE TABLE build_table (pid VARCHAR PRIMARY KEY, status VARCHAR)");
      const insert = await c.prepare("INSERT INTO build_table VALUES ($1, $2)");
      for (const [pid, t] of Object.entries(manifest.tables)) {
        insert.bind([pid, t.status]);
        await insert.run();
      }
      await c.run(`CREATE TABLE search AS
        SELECT c.pid, c.cansim_id, c.title_en, c.archived, c.frequency_code, c.dimension_count, c.cube_start_date, c.cube_end_date,
               coalesce(b.status = 'ok', false) AS queryable,
               coalesce(d.names, '') AS dimension_text,
               coalesce(m.names, '') AS member_text,
               coalesce(n.text, '') AS note_text
        FROM cube c
        LEFT JOIN build_table b USING (pid)
        LEFT JOIN (SELECT pid, string_agg(name_en, ' | ' ORDER BY position) AS names FROM inventory_dimension GROUP BY pid) d USING (pid)
        LEFT JOIN (SELECT pid, string_agg(member_name, ' | ' ORDER BY dimension_id, member_id) AS names FROM member GROUP BY pid) m USING (pid)
        LEFT JOIN (SELECT pid, string_agg(note, ' | ' ORDER BY note_id) AS text FROM note GROUP BY pid) n USING (pid)`);
    } finally {
      c.closeSync();
    }
    return db;
  }

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const c: DuckDBConnection = await this.instance.connect();
    try {
      return plain((await c.runAndReadAll(sql, params as never)).getRowObjectsJS() as Row[]);
    } finally {
      c.closeSync();
    }
  }

  async one(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    return (await this.query(sql, params))[0];
  }

  parquetPath(pid: string): string | undefined {
    const p = this.manifest.tables[pid]?.parquet?.path;
    return p && path.join(this.buildDir, p);
  }

  /** Every whitespace term must appear in the PID, CANSIM ID, title, dimension names, member names, or notes. */
  async search(q: string, opts: { archived?: string; queryable?: boolean; limit: number; offset: number }) {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const where: string[] = [];
    const params: unknown[] = [];
    const fields = ["title_en", "dimension_text", "member_text", "note_text"];
    const hits: Record<string, string[]> = Object.fromEntries(fields.map((f) => [f, []]));
    for (const term of terms) {
      params.push(`%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, term);
      const like = `$${params.length - 1}`;
      const exact = `$${params.length}`;
      for (const f of fields) hits[f].push(`(${f} ILIKE ${like} ESCAPE '\\')::INT`);
      where.push(`(pid = ${exact} OR cansim_id = ${exact} OR ${fields.map((f) => `${f} ILIKE ${like} ESCAPE '\\'`).join(" OR ")})`);
    }
    if (opts.archived) { params.push(opts.archived); where.push(`archived = $${params.length}`); }
    if (opts.queryable) where.push("queryable");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const hitColumns = fields.map((f) => `${hits[f].join(" + ") || "0"} AS ${f.replace("_en", "").replace("_text", "")}_hits`).join(", ");
    const total = Number((await this.one(`SELECT count(*) AS n FROM search ${clause}`, params))!.n);
    const rows = await this.query(
      `SELECT pid, cansim_id, title_en, archived, frequency_code, dimension_count, cube_start_date, cube_end_date, queryable, ${hitColumns}
       FROM search ${clause}
       ORDER BY title_hits DESC, queryable DESC, dimension_hits DESC, member_hits DESC, note_hits DESC, title_en, pid
       LIMIT ${Math.min(opts.limit, MAX_LIMIT)} OFFSET ${Math.max(opts.offset, 0)}`, params);
    return { total, rows };
  }

  async table(pid: string) {
    const cube = await this.one("SELECT * FROM cube WHERE pid = $1", [pid]);
    if (!cube) return undefined;
    const [meta, dimensions, members, notes, corrections, inventoryCorrections, symbols, surveys, subjects] = await Promise.all([
      this.one("SELECT * EXCLUDE (note_block_raw) FROM cube_meta WHERE pid = $1", [pid]),
      this.query("SELECT dimension_id, dimension_name, dimension_notes, dimension_definitions FROM dimension WHERE pid = $1 ORDER BY dimension_id", [pid]),
      this.query("SELECT dimension_id, member_id, member_name, classification_code, parent_member_id, terminated, member_notes FROM member WHERE pid = $1 ORDER BY dimension_id, member_id", [pid]),
      this.query("SELECT note_id, note FROM note WHERE pid = $1 ORDER BY note_id", [pid]),
      this.query("SELECT correction_id, correction_date, correction_note FROM correction WHERE pid = $1 ORDER BY correction_id", [pid]),
      this.query("SELECT correction_date, note_en FROM inventory_correction WHERE pid = $1 ORDER BY correction_date", [pid]),
      this.query("SELECT symbol, description FROM symbol WHERE pid = $1 ORDER BY symbol", [pid]),
      this.query("SELECT survey_code, survey_name FROM survey WHERE pid = $1 ORDER BY survey_code", [pid]),
      this.query("SELECT subject_code, subject_name FROM subject WHERE pid = $1 ORDER BY subject_code", [pid]),
    ]);
    const inventoryDimensions = await this.query("SELECT position, name_en, name_fr, has_uom FROM inventory_dimension WHERE pid = $1 ORDER BY position", [pid]);
    return {
      pid, cube, inventory_dimensions: inventoryDimensions, meta: meta ?? null,
      dimensions: dimensions.map((d): Row & { members: Row[] } => ({ ...d, members: members.filter((m) => m.dimension_id === d.dimension_id) })),
      notes, corrections, inventory_corrections: inventoryCorrections, symbols, surveys, subjects,
      build: this.manifest.tables[pid] ?? null,
    };
  }

  /** Filtered, paginated observations with labels joined from the member table. */
  async observations(pid: string, f: { from?: string; to?: string; vector?: string; members: (number | undefined)[]; limit: number; offset: number }) {
    const file = this.parquetPath(pid);
    const dims = this.manifest.tables[pid]?.dims;
    if (!file || !dims) return undefined;
    const params: unknown[] = [file];
    const where: string[] = [];
    if (f.from) { params.push(f.from); where.push(`o.ref_date >= $${params.length}`); }
    if (f.to) { params.push(f.to); where.push(`o.ref_date <= $${params.length}`); }
    if (f.vector) { params.push(f.vector); where.push(`o.vector = $${params.length}`); }
    f.members.forEach((id, i) => { if (id !== undefined && i < dims) { params.push(id); where.push(`o.member_id_${i + 1} = $${params.length}`); } });
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const ks = Array.from({ length: dims }, (_, i) => i + 1);
    const pidParam = `$${params.length + 1}`;
    const joins = ks.map((k) => `LEFT JOIN member m${k} ON m${k}.pid = ${pidParam} AND m${k}.dimension_id = ${k} AND m${k}.member_id = o.member_id_${k}`).join("\n");
    const labels = ks.map((k) => `o.member_id_${k}, m${k}.member_name AS label_${k}`).join(", ");
    const limit = Math.min(Math.max(f.limit, 1), MAX_LIMIT);
    const offset = Math.max(f.offset, 0);
    const total = Number((await this.one(`SELECT count(*) AS n FROM read_parquet($1) o ${clause}`, params))!.n);
    // The build wrote each Parquet file already sorted by member IDs, ref_date, row_index, and DuckDB keeps file order
    // for scans without ORDER BY (preserve_insertion_order). Paging the bare scan avoids a top-N sort over the whole
    // table on deep offsets; the page (<= MAX_LIMIT rows) is then joined and re-sorted cheaply.
    const rows = await this.query(
      `SELECT o.row_index, o.ref_date, o.dguid, ${labels}, o.uom, o.uom_id, o.scalar_factor, o.scalar_id, o.vector, o.coordinate,
              o.value, o.value_num, o.status, o.symbol, o.terminated, o.decimals
       FROM (SELECT * FROM read_parquet($1) o ${clause} LIMIT ${limit} OFFSET ${offset}) o
       ${joins}
       ORDER BY ${ks.map((k) => `o.member_id_${k}`).join(", ")}, o.ref_date, o.row_index`, [...params, pid]);
    return { total, limit, offset, rows };
  }
}
