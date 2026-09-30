import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
export const MAX_SERIES = 50;
/** Hard cap on points in one series response, so a daily table cannot build a multi-million-point answer. */
export const MAX_SERIES_POINTS = 200_000;

/** WDS `archived` has no published code set; 1 and 2 are the two values in the inventory. */
export const ARCHIVED_EN: Record<string, string> = { "1": "archived", "2": "current" };

export interface CodeSetsInfo { id: string; sha256: string; source?: string; captured_at_utc?: string }

interface CodeSetsFile { status: string; object: Record<string, Record<string, unknown>[]> }

/** Read `codeSets.json`, refuse it unless its SHA-256 equals the sibling `.sha256` file. */
function readCodeSets(file: string): { data: CodeSetsFile["object"]; info: CodeSetsInfo } {
  const bytes = readFileSync(file);
  const sum = `${file}.sha256`;
  if (!existsSync(sum)) throw new Error(`code sets: missing checksum file ${sum}`);
  const expected = readFileSync(sum, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected !== actual) throw new Error(`code sets: SHA-256 mismatch for ${file} (file ${actual}, ${sum} says ${expected})`);
  const parsed = JSON.parse(bytes.toString("utf8")) as CodeSetsFile;
  if (parsed.status !== "SUCCESS") throw new Error(`code sets: WDS status was ${parsed.status}`);
  const sourceFile = path.join(path.dirname(file), "source.json");
  const source = existsSync(sourceFile) ? JSON.parse(readFileSync(sourceFile, "utf8")) as { source?: string; captured_at_utc?: string } : {};
  return { data: parsed.object, info: { id: path.basename(path.dirname(file)), sha256: actual, source: source.source, captured_at_utc: source.captured_at_utc } };
}

/** "18100006" -> "18-10-0006-01", the form Statistics Canada prints. */
export function tableNumber(pid: string): string {
  return `${pid.slice(0, 2)}-${pid.slice(2, 4)}-${pid.slice(4, 8)}-01`;
}

/** True when the inventory says the table covers more than one reference period. */
export function isTimeSeries(cube: Row): boolean {
  return String(cube.cube_start_date).slice(0, 10) !== String(cube.cube_end_date).slice(0, 10);
}

export interface ObservationFilter { from?: string; to?: string; vector?: string; members: (number | undefined)[] }

export interface SeriesLabel { dimension_id: number; dimension: string; member_id: number; member: string | null }
export interface Series {
  vector: string;
  name: string;
  labels: SeriesLabel[];
  unit: string;
  scale: string;
  points: [string, number | null, string][];
}
export type SeriesResult =
  | { kind: "ok"; series: Series[]; total_points: number }
  | { kind: "too_many_vectors"; limit: number }
  | { kind: "too_many_points"; limit: number };

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

/** WDS code set name -> (code column, English label column, French label column, optional symbol column prefix). */
const CODE_SETS: Record<string, { code: string; en: string; fr: string; reprEn?: string; reprFr?: string; type: "INTEGER" | "VARCHAR" }> = {
  frequency: { code: "frequencyCode", en: "frequencyDescEn", fr: "frequencyDescFr", type: "INTEGER" },
  subject: { code: "subjectCode", en: "subjectEn", fr: "subjectFr", type: "VARCHAR" },
  survey: { code: "surveyCode", en: "surveyEn", fr: "surveyFr", type: "VARCHAR" },
  uom: { code: "memberUomCode", en: "memberUomEn", fr: "memberUomFr", type: "INTEGER" },
  scalar: { code: "scalarFactorCode", en: "scalarFactorDescEn", fr: "scalarFactorDescFr", type: "INTEGER" },
  status: { code: "statusCode", en: "statusDescEn", fr: "statusDescFr", reprEn: "statusRepresentationEn", reprFr: "statusRepresentationFr", type: "VARCHAR" },
  symbol: { code: "symbolCode", en: "symbolDescEn", fr: "symbolDescFr", reprEn: "symbolRepresentationEn", reprFr: "symbolRepresentationFr", type: "VARCHAR" },
  securityLevel: { code: "securityLevelCode", en: "securityLevelDescEn", fr: "securityLevelDescFr", reprEn: "securityLevelRepresentationEn", reprFr: "securityLevelRepresentationFr", type: "INTEGER" },
};

export class Db {
  readonly buildDir: string;
  readonly manifest: Manifest;
  readonly codeSets: CodeSetsInfo;
  /** English labels from the official code sets. Frequency, subject, and survey are keyed by code; status and symbol by the printed mark in the data. */
  readonly labels: Record<"frequency" | "subject" | "survey" | "status" | "symbol", Map<string, string>> = {
    frequency: new Map(), subject: new Map(), survey: new Map(), status: new Map(), symbol: new Map(),
  };
  private readonly instance: DuckDBInstance;

  private constructor(buildDir: string, manifest: Manifest, codeSets: CodeSetsInfo, instance: DuckDBInstance) {
    this.buildDir = buildDir;
    this.manifest = manifest;
    this.codeSets = codeSets;
    this.instance = instance;
  }

  static async open(buildDir: string, codeSetsFile: string): Promise<Db> {
    const manifest = JSON.parse(readFileSync(path.join(buildDir, "build_manifest.json"), "utf8")) as Manifest;
    const codeSets = readCodeSets(codeSetsFile);
    // Spill next to the build, never in the process cwd (the OS disk holds no dataset bytes, not even temporaries).
    const instance = await DuckDBInstance.create(":memory:", { threads: "4", memory_limit: "2GB", temp_directory: path.join(buildDir, "tmp") });
    const db = new Db(buildDir, manifest, codeSets.info, instance);
    const c = await instance.connect();
    try {
      for (const name of CATALOGUE) {
        await c.run(`CREATE TABLE ${name} AS SELECT * FROM read_parquet($1)`, [path.join(buildDir, "catalogue", `${name}.parquet`)]);
      }
      for (const [name, spec] of Object.entries(CODE_SETS)) {
        const rows = codeSets.data[name];
        if (!Array.isArray(rows) || !rows.length) throw new Error(`code sets: "${name}" is missing or empty in ${codeSetsFile}`);
        await c.run(`CREATE TABLE code_${name} (code ${spec.type}, en VARCHAR, fr VARCHAR, repr_en VARCHAR, repr_fr VARCHAR)`);
        const put = await c.prepare(`INSERT INTO code_${name} VALUES ($1, $2, $3, $4, $5)`);
        for (const r of rows) {
          put.bind([r[spec.code], r[spec.en], r[spec.fr], spec.reprEn ? r[spec.reprEn] : null, spec.reprFr ? r[spec.reprFr] : null] as never);
          await put.run();
        }
      }
      // Observations carry the printed mark (E, x, p), not the numeric code, so status and symbol labels are keyed by it.
      // "x" is in the security-level set, not the status set.
      const labelSql: Record<keyof Db["labels"], string> = {
        frequency: "SELECT code, en FROM code_frequency WHERE en IS NOT NULL",
        subject: "SELECT code, en FROM code_subject WHERE en IS NOT NULL",
        survey: "SELECT code, en FROM code_survey WHERE en IS NOT NULL",
        status: "SELECT repr_en AS code, en FROM code_status WHERE repr_en IS NOT NULL UNION ALL SELECT repr_en, en FROM code_securityLevel WHERE repr_en IS NOT NULL",
        symbol: "SELECT repr_en AS code, en FROM code_symbol WHERE repr_en IS NOT NULL",
      };
      for (const [name, sql] of Object.entries(labelSql) as [keyof Db["labels"], string][]) {
        for (const r of plain((await c.runAndReadAll(sql)).getRowObjectsJS() as Row[])) db.labels[name].set(String(r.code), String(r.en));
      }
      await c.run("CREATE TABLE build_table (pid VARCHAR PRIMARY KEY, status VARCHAR)");
      const insert = await c.prepare("INSERT INTO build_table VALUES ($1, $2)");
      for (const [pid, t] of Object.entries(manifest.tables)) {
        insert.bind([pid, t.status]);
        await insert.run();
      }
      await c.run(`CREATE TABLE search AS
        SELECT c.pid, c.cansim_id, c.title_en, c.archived, c.frequency_code, f.en AS frequency_en, c.dimension_count, c.cube_start_date, c.cube_end_date,
               coalesce(b.status = 'ok', false) AS queryable,
               coalesce(d.names, '') AS dimension_text,
               coalesce(m.names, '') AS member_text,
               coalesce(n.text, '') AS note_text
        FROM cube c
        LEFT JOIN code_frequency f ON f.code = c.frequency_code
        LEFT JOIN build_table b USING (pid)
        LEFT JOIN (SELECT pid, string_agg(name_en, ' | ' ORDER BY position) AS names FROM inventory_dimension GROUP BY pid) d USING (pid)
        LEFT JOIN (SELECT pid, string_agg(member_name, ' | ' ORDER BY dimension_id, member_id) AS names FROM member GROUP BY pid) m USING (pid)
        LEFT JOIN (SELECT pid, string_agg(note, ' | ' ORDER BY note_id) AS text FROM note GROUP BY pid) n USING (pid)`);
    } finally {
      c.closeSync();
    }
    return db;
  }

  /** Statistics Canada's own form for citing a table, with the capture date and the build that produced these rows. */
  citation(pid: string, title: unknown): string {
    const captured = this.manifest.tables[pid]?.source_captured_at_utc?.slice(0, 10) ?? `capture ${this.manifest.capture_id}`;
    return `Statistics Canada, Table ${tableNumber(pid)}, ${title}, captured ${captured}, build ${this.manifest.build_id}`;
  }

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const c: DuckDBConnection = await this.instance.connect();
    try {
      return plain((await c.runAndReadAll(sql, params as never)).getRowObjectsJS() as Row[]);
    } finally {
      c.closeSync();
    }
  }

  /** Lets DuckDB delete its spill files under <build>/tmp; a killed process leaves them behind. */
  close() {
    this.instance.closeSync();
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
      `SELECT pid, cansim_id, title_en, archived, frequency_code, frequency_en, dimension_count, cube_start_date, cube_end_date, queryable, ${hitColumns}
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
    const codes = (kind: "subject" | "survey", list: unknown) => ((list as string[] | null) ?? []).map((code) => ({ [`${kind}_code`]: code, [`${kind}_en`]: this.labels[kind].get(code) ?? null }));
    return {
      pid, cube: { ...cube, frequency_en: this.labels.frequency.get(String(cube.frequency_code)) ?? null } as Row,
      inventory_dimensions: inventoryDimensions, meta: meta ?? null,
      dimensions: dimensions.map((d): Row & { members: Row[] } => ({ ...d, members: members.filter((m) => m.dimension_id === d.dimension_id) })),
      notes, corrections, inventory_corrections: inventoryCorrections, symbols, surveys, subjects,
      // Official names for the inventory's own code lists; `surveys` and `subjects` above are the table's metadata blocks.
      subject_labels: codes("subject", cube.subject_codes), survey_labels: codes("survey", cube.survey_codes),
      build: this.manifest.tables[pid] ?? null,
    };
  }

  /** WHERE clause over `read_parquet($1) o`; `params[0]` is the file. */
  private filterClause(file: string, dims: number, f: ObservationFilter) {
    const params: unknown[] = [file];
    const where: string[] = [];
    if (f.from) { params.push(f.from); where.push(`o.ref_date >= $${params.length}`); }
    if (f.to) { params.push(f.to); where.push(`o.ref_date <= $${params.length}`); }
    if (f.vector) { params.push(f.vector); where.push(`o.vector = $${params.length}`); }
    f.members.forEach((id, i) => { if (id !== undefined && i < dims) { params.push(id); where.push(`o.member_id_${i + 1} = $${params.length}`); } });
    return { params, clause: where.length ? `WHERE ${where.join(" AND ")}` : "" };
  }

  /**
   * One line per vector for a filter. Returns `too_many_vectors` above `maxVectors` and `too_many_points` above
   * MAX_SERIES_POINTS, without reading the points. Undefined when the table has no Parquet file.
   */
  async series(pid: string, f: ObservationFilter, maxVectors: number): Promise<SeriesResult | undefined> {
    const file = this.parquetPath(pid);
    const dims = this.manifest.tables[pid]?.dims;
    if (!file || !dims) return undefined;
    const { params, clause } = this.filterClause(file, dims, f);
    // Count first: it is cheap (Parquet statistics), and a match above the point cap needs no vector scan.
    const totalPoints = Number((await this.one(`SELECT count(*) AS n FROM read_parquet($1) o ${clause}`, params))!.n);
    if (totalPoints > MAX_SERIES_POINTS) return { kind: "too_many_points", limit: MAX_SERIES_POINTS };
    const counts = await this.query(`SELECT o.vector FROM read_parquet($1) o ${clause} GROUP BY o.vector LIMIT ${maxVectors + 1}`, params);
    if (counts.length > maxVectors) return { kind: "too_many_vectors", limit: maxVectors };
    const ks = Array.from({ length: dims }, (_, i) => i + 1);
    const ids = ks.map((k) => `o.member_id_${k}`).join(", ");
    const [rows, dimensionRows, memberRows] = await Promise.all([
      this.query(`SELECT o.vector, o.uom, o.scalar_factor, o.ref_date, o.value_num, o.status, ${ids}
                  FROM read_parquet($1) o ${clause} ORDER BY ${ids}, o.ref_date, o.row_index`, params),
      this.query("SELECT dimension_id, dimension_name FROM dimension WHERE pid = $1", [pid]),
      this.query("SELECT dimension_id, member_id, member_name FROM member WHERE pid = $1", [pid]),
    ]);
    const dimensionName = new Map(dimensionRows.map((d) => [Number(d.dimension_id), String(d.dimension_name)]));
    const memberName = new Map(memberRows.map((m) => [`${m.dimension_id}.${m.member_id}`, String(m.member_name)]));
    const byVector = new Map<string, Series>();
    for (const r of rows) {
      const vector = String(r.vector);
      let s = byVector.get(vector);
      if (!s) {
        s = {
          vector, name: "", unit: String(r.uom ?? ""), scale: String(r.scalar_factor ?? ""), points: [],
          labels: ks.filter((k) => r[`member_id_${k}`] != null).map((k) => ({
            dimension_id: k, dimension: dimensionName.get(k) ?? `dimension ${k}`, member_id: Number(r[`member_id_${k}`]), member: memberName.get(`${k}.${r[`member_id_${k}`]}`) ?? null,
          })),
        };
        byVector.set(vector, s);
      }
      s.points.push([String(r.ref_date), typeof r.value_num === "number" && Number.isFinite(r.value_num) ? r.value_num : null, String(r.status ?? "")]);
    }
    const series = [...byVector.values()];
    // Name a line by the members that differ between lines; with one line nothing differs, so use all its members.
    const differs = (dimensionId: number) => new Set(series.map((s) => s.labels.find((l) => l.dimension_id === dimensionId)?.member_id)).size > 1;
    for (const s of series) {
      const shown = s.labels.filter((l) => differs(l.dimension_id));
      s.name = (shown.length ? shown : s.labels).map((l) => l.member ?? `#${l.member_id}`).join(" · ") || s.vector;
    }
    return { kind: "ok", series, total_points: totalPoints };
  }

  /** Filtered, paginated observations with labels joined from the member table. */
  async observations(pid: string, f: ObservationFilter & { limit: number; offset: number }) {
    const file = this.parquetPath(pid);
    const dims = this.manifest.tables[pid]?.dims;
    if (!file || !dims) return undefined;
    const { params, clause } = this.filterClause(file, dims, f);
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
    for (const r of rows) {
      r.status_en = r.status ? this.labels.status.get(String(r.status)) ?? null : null;
      r.symbol_en = r.symbol ? this.labels.symbol.get(String(r.symbol)) ?? null : null;
    }
    return { total, limit, offset, rows };
  }
}
