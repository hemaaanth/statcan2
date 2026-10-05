import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  family: string;
  language: string;
  inventory: { path: string; sha256: string; records: number };
  tool: Record<string, string>;
  catalogue: Record<string, { rows: number; bytes: number; sha256: string }>;
  tables: Record<string, TableReport>;
  summary: Record<string, number>;
}

interface CleanInput { dir: string; build_id: string; family?: string; manifest_sha256: string; tables_ok: number }

/** `normalize_manifest.json` written by tools/wds_normalize.py. */
export interface NormalizeManifest {
  build_id: string;
  built_at_utc: string;
  clean: { dir: string; build_id: string; manifest_sha256: string | null; tables_ok: number; inputs?: CleanInput[] };
  cleans?: CleanInput[];
  codesets: { path: string; sha256: string };
  refs: Record<string, string>;
  tool: Record<string, unknown>;
  files: Record<string, { rows: number; bytes: number; sha256: string; layout?: string; partition?: string }>;
  stats: Record<string, unknown>;
  warnings: ({ type: string } & Row)[];
}

/** Clean catalogue rows absent from Normalized; raw attributes are not queried by the API. */
const CATALOGUE = ["inventory_dimension", "inventory_correction", "cube_meta", "dimension", "member",
  "symbol", "survey", "subject", "note", "correction"];
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

export type PeriodKind = "day" | "week" | "month" | "quarter" | "half_year" | "year" | "fiscal_year" | "multi_year" | "other";

export interface ObservationFilter { from?: string; to?: string; vector?: string; members: (number | undefined)[] }

export interface SeriesLabel { dimension_id: number; dimension: string; member_id: number; member: string | null }
export interface Series {
  vector: string;
  coordinate: string;
  name: string;
  labels: SeriesLabel[];
  unit: string;
  scale: string;
  /** One kind for every point, else `other`. */
  period_kind: PeriodKind;
  /** [ref_date, value_num, status, period_start, period_end] */
  points: [string, number | null, string, string | null, string | null][];
}
export type SeriesResult =
  | { kind: "ok"; series: Series[]; total_points: number }
  | { kind: "too_many_vectors"; limit: number }
  | { kind: "too_many_points"; limit: number };

export type SeriesDetailResult =
  | { kind: "ok"; series: Row & { labels: SeriesLabel[]; points: Row[] } }
  | { kind: "not_found" }
  | { kind: "too_many_points"; limit: number }
  | { kind: "inconsistent"; n_obs: number; points: number };

/** Inventory facts kept in memory for every PID, from the Normalized `table` file. */
export interface TableInfo { title_en: string; frequency_code: number | null; frequency_en: string | null; kind: string; family: string; queryable: boolean }

/** Refuse to start unless `dir` lives on the filesystem with this UUID (same rule as tools/wds_download.py). */
export function requireMount(dir: string, uuid: string) {
  if (!/^[0-9A-Fa-f-]{4,64}$/.test(uuid)) throw new Error("invalid filesystem UUID");
  const device = statSync(`/dev/disk/by-uuid/${uuid}`);
  if (!device.isBlockDevice()) throw new Error(`UUID ${uuid} is not a block device`);
  if (statSync(dir).dev !== device.rdev) throw new Error(`${dir} is not mounted from UUID ${uuid}`);
}

/** BIGINT -> number; DATE (UTC midnight) -> "YYYY-MM-DD". */
function plain(rows: Row[]): Row[] {
  for (const row of rows) {
    for (const k in row) {
      const v = row[k];
      if (typeof v === "bigint") row[k] = Number(v);
      else if (v instanceof Date) row[k] = v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString();
    }
  }
  return rows;
}

const likeTerm = (term: string) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;
const MEMBER_IDS = Array.from({ length: MAX_DIMS }, (_, i) => `member_id_${i + 1}`);
const LABELS = Array.from({ length: MAX_DIMS }, (_, i) => `label_${i + 1}`);
const VECTOR = /^v[0-9]+$/i;

const SEMANTIC_QUERIES: [RegExp, string][] = [
  [/\bquality\s+of\s+life\b/i, "life satisfaction"],
  [/\bwell[-\s]?being\b/i, "life satisfaction"],
  [/\binflation\b/i, "consumer price index all-items"],
  [/\bcost\s+of\s+living\b/i, "consumer price index all-items"],
];
const CPI_COMPONENT = /\b(all[-\s]?items|food|shelter|housing|rent|mortgage|energy|gas|gasoline|transport|clothing|footwear|health|recreation|education|alcohol|tobacco|goods|services|excluding)\b/i;

function seriesSearchQuery(q: string) {
  let text = q.trim();
  for (const [pattern, replacement] of SEMANTIC_QUERIES) text = text.replace(pattern, replacement);
  text = text.replace(/\bcpi\b/ig, "consumer price index");
  if (/\bconsumer\s+price\s+index\b/i.test(text) && !CPI_COMPONENT.test(text)) text += " all-items";
  return text;
}

function seriesSearchDisplayQuery(q: string) {
  const text = seriesSearchQuery(q);
  return text === q.trim() ? undefined : text;
}

export { seriesSearchDisplayQuery };
/** `place` plus the number of tables that map a geography member to it. */
const PLACE_TABLES = `(SELECT pl.*, coalesce(n.n_tables, 0) AS n_tables FROM place pl
  LEFT JOIN (SELECT place_id, count(DISTINCT pid) AS n_tables FROM member_place GROUP BY place_id) n USING (place_id))`;

export class Db {
  readonly buildDir: string;
  readonly normalizedDir: string;
  readonly manifest: Manifest;
  readonly normalized: NormalizeManifest;
  readonly codeSets: CodeSetsInfo;
  /** English labels from the official code sets. Frequency, subject, survey, uom, scalar are keyed by code; status and symbol by the printed mark in the data. */
  readonly labels: Record<"frequency" | "subject" | "survey" | "uom" | "scalar" | "status" | "symbol", Map<string, string>> = {
    frequency: new Map(), subject: new Map(), survey: new Map(), uom: new Map(), scalar: new Map(), status: new Map(), symbol: new Map(),
  };
  readonly info = new Map<string, TableInfo>();
  private readonly instance: DuckDBInstance;
  private readonly cleanByPid: Map<string, { dir: string; manifest: Manifest }>;
  private coverageCache?: Promise<Row>;

  private constructor(buildDir: string, normalizedDir: string, manifest: Manifest, normalized: NormalizeManifest, codeSets: CodeSetsInfo,
    instance: DuckDBInstance, cleanByPid: Map<string, { dir: string; manifest: Manifest }>) {
    this.buildDir = buildDir;
    this.normalizedDir = normalizedDir;
    this.manifest = manifest;
    this.normalized = normalized;
    this.codeSets = codeSets;
    this.instance = instance;
    this.cleanByPid = cleanByPid;
  }

  static async open(buildDir: string, normalizedDir: string, codeSetsFile: string, mountUuid?: string): Promise<Db> {
    const normalized = JSON.parse(readFileSync(path.join(normalizedDir, "normalize_manifest.json"), "utf8")) as NormalizeManifest;
    const inputs = normalized.cleans ?? normalized.clean.inputs ?? [normalized.clean as CleanInput];
    if (!inputs.length || normalized.clean.build_id !== inputs.map((input) => input.build_id).join("+")) {
      throw new Error(`Normalized build ${normalized.build_id}: Clean inputs do not match its build ID`);
    }
    const cleanByPid = new Map<string, { dir: string; manifest: Manifest }>();
    const cleans = inputs.map((input, index) => {
      const dir = index === 0 ? buildDir : input.dir;
      if (mountUuid) requireMount(dir, mountUuid);
      const bytes = readFileSync(path.join(dir, "build_manifest.json"));
      const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
      if (manifest.build_id !== input.build_id || (input.family && manifest.family !== input.family)) {
        throw new Error(`Normalized build ${normalized.build_id}: Clean input ${input.build_id} does not match ${dir}`);
      }
      if (input.manifest_sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`Normalized build ${normalized.build_id}: build_manifest.json of ${manifest.build_id} changed since it was normalized`);
      }
      if (input.tables_ok !== Object.values(manifest.tables).filter((t) => t.status === "ok").length) {
        throw new Error(`Normalized build ${normalized.build_id}: Clean table count changed for ${manifest.build_id}`);
      }
      for (const pid of Object.keys(manifest.tables)) {
        if (cleanByPid.has(pid)) throw new Error(`Normalized build ${normalized.build_id}: duplicate PID ${pid} in Clean inputs`);
        cleanByPid.set(pid, { dir, manifest });
      }
      return { dir, manifest };
    });
    const first = cleans[0].manifest;
    const manifest: Manifest = cleans.length === 1 ? first : {
      ...first, build_id: normalized.clean.build_id, tables: Object.assign({}, ...cleans.map(({ manifest: m }) => m.tables)),
      summary: Object.fromEntries([...new Set(cleans.flatMap(({ manifest: m }) => Object.keys(m.summary)))]
        .map((key) => [key, cleans.reduce((sum, { manifest: m }) => sum + (m.summary[key] ?? 0), 0)])),
    };
    const codeSets = readCodeSets(codeSetsFile);
    if (normalized.codesets.sha256 !== codeSets.info.sha256) {
      throw new Error(`Normalized build ${normalized.build_id} used code sets ${normalized.codesets.sha256}, not ${codeSets.info.sha256}`);
    }
    // Spill next to the build, never in the process cwd (the OS disk holds no dataset bytes, not even temporaries).
    const instance = await DuckDBInstance.create(":memory:", { threads: "4", memory_limit: "2GB", temp_directory: path.join(buildDir, "tmp") });
    const db = new Db(buildDir, normalizedDir, manifest, normalized, codeSets.info, instance, cleanByPid);
    const c = await instance.connect();
    const normalizedFile = (name: string) => path.join(normalizedDir, `${name}.parquet`);
    const seriesPath = normalized.files["series/"]?.layout === "partitioned_parquet_directory"
      ? path.join(normalizedDir, "series", "*.parquet")
      : normalizedFile("series");
    try {
      // DISTINCT: a duplicate catalogue member would duplicate joined observations.
      for (const name of CATALOGUE) {
        const files = cleans.map(({ dir }) => sqlString(path.join(dir, "catalogue", `${name}.parquet`))).join(", ");
        await c.run(`CREATE TABLE ${name} AS SELECT DISTINCT * FROM read_parquet([${files}])`);
      }
      await c.run(`CREATE TABLE tables AS SELECT *,
        lower(search_text) AS search_text_lower, lower(search_title) AS search_title_lower,
        lower(search_dimensions) AS search_dimensions_lower, lower(search_members) AS search_members_lower,
        lower(search_notes) AS search_notes_lower FROM read_parquet($1)`, [normalizedFile("table")]);
      for (const [file, name] of [["place", "place"], ["member_place", "member_place"], ["unit_family", "unit_family"], ["period", "period"]]) {
        await c.run(`CREATE TABLE ${name} AS SELECT * FROM read_parquet($1)`, [normalizedFile(file)]);
      }
      // `series` stays on disk; the Normalized manifest identifies its Parquet layout.
      await c.run(`CREATE VIEW series AS SELECT * FROM read_parquet(${sqlString(seriesPath)})`);
      await c.run("SELECT 1 FROM series LIMIT 1");
      for (const name of ["frequency", "subject", "survey", "uom", "scalar"] as const) {
        const rows = plain((await c.runAndReadAll("SELECT code, en FROM read_parquet($1) WHERE en IS NOT NULL", [normalizedFile(name)])).getRowObjectsJS() as Row[]);
        for (const r of rows) db.labels[name].set(String(r.code), String(r.en));
      }
      // Observations carry the printed mark (E, x, p), not the numeric code, so status and symbol labels are keyed by it.
      for (const name of ["status", "symbol"] as const) {
        const rows = (await c.runAndReadAll("SELECT representation, en FROM read_parquet($1) WHERE representation IS NOT NULL", [normalizedFile(name)])).getRowObjectsJS() as Row[];
        for (const r of rows) db.labels[name].set(String(r.representation), String(r.en));
      }
      const securityRows = (await c.runAndReadAll("SELECT representation, en FROM read_parquet($1) WHERE representation IS NOT NULL", [normalizedFile("security_level")])).getRowObjectsJS() as Row[];
      for (const r of securityRows) db.labels.status.set(String(r.representation), String(r.en));
      if (!db.labels.status.has("x")) throw new Error(`Normalized build ${normalized.build_id}: security_level has no "x"`);
      const infoRows = plain((await c.runAndReadAll("SELECT pid, title_en, frequency_code, frequency_en, kind, family, queryable FROM tables")).getRowObjectsJS() as Row[]);
      for (const r of infoRows) {
        db.info.set(String(r.pid), { title_en: String(r.title_en), frequency_code: r.frequency_code as number | null, frequency_en: r.frequency_en as string | null,
          kind: String(r.kind), family: String(r.family), queryable: r.queryable === true });
      }
    } finally {
      c.closeSync();
    }
    return db;
  }

  /** Build IDs every response carries. */
  get provenance() {
    return { build_id: this.manifest.build_id, normalized_build_id: this.normalized.build_id, capture_id: this.manifest.capture_id, language: this.manifest.language };
  }

  /** Statistics Canada's own form for citing a table, with the capture date and the builds that produced these rows. */
  citation(pid: string): string {
    const clean = this.cleanByPid.get(pid)?.manifest;
    const captured = clean?.tables[pid]?.source_captured_at_utc?.slice(0, 10) ?? `capture ${this.manifest.capture_id}`;
    return `Statistics Canada, Table ${tableNumber(pid)}, ${this.info.get(pid)?.title_en ?? "unknown table"}, captured ${captured}, build ${clean?.build_id ?? this.manifest.build_id}, normalized ${this.normalized.build_id}`;
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
    const clean = this.cleanByPid.get(pid);
    const file = clean?.manifest.tables[pid]?.parquet?.path;
    return file && path.join(clean!.dir, file);
  }

  /** A source link exists only when this table's Clean report names the captured original ZIP. */
  sourceZipPath(pid: string, captureDir?: string): string | undefined {
    const clean = this.cleanByPid.get(pid)?.manifest;
    const source = clean?.tables[pid]?.source_zip;
    if (!captureDir || !source || path.resolve(clean!.capture_dir) !== path.resolve(captureDir)) return undefined;
    const zip = path.join(captureDir, "zips", `${pid}-en.zip`);
    return path.resolve(source) === path.resolve(zip) && existsSync(zip) ? zip : undefined;
  }

  /** Read one PID part directly; never scan every Normalized series file for cube metadata. */
  seriesPath(pid: string): string {
    return this.normalized.files["series/"]?.layout === "partitioned_parquet_directory"
      ? path.join(this.normalizedDir, "series", `${pid}.parquet`)
      : path.join(this.normalizedDir, "series.parquet");
  }

  /** Every whitespace term must equal the PID or CANSIM ID or appear in the Normalized search fields. */
  async search(q: string, opts: { archived?: string; queryable?: boolean; kind?: string; family?: string; limit: number; offset: number }) {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    // DuckDB's Unicode ILIKE remains the reference for non-ASCII input; ASCII substrings can use pre-folded text.
    const unicode = /[^\x00-\x7f]/.test(q);
    const where: string[] = [];
    const params: unknown[] = [];
    const titleHits: string[] = [];
    const dimensionHits: string[] = [];
    const memberHits: string[] = [];
    const noteHits: string[] = [];
    for (const term of terms) {
      params.push(unicode ? likeTerm(term) : term.toLowerCase(), term);
      const like = `$${params.length - 1}`;
      const exact = `$${params.length}`;
      const matches = (column: string) => unicode ? `${column} ILIKE ${like} ESCAPE '\\'` : `contains(${column}_lower, ${like})`;
      titleHits.push(`(${matches("search_title")})::INT`);
      dimensionHits.push(`(${matches("search_dimensions")})::INT`);
      memberHits.push(`(${matches("search_members")})::INT`);
      noteHits.push(`(${matches("search_notes")})::INT`);
      where.push(`(pid = ${exact} OR cansim_id = ${exact} OR ${matches("search_text")})`);
    }
    for (const key of ["archived", "kind", "family"] as const) {
      if (opts[key]) { params.push(opts[key]); where.push(`${key} = $${params.length}`); }
    }
    if (opts.queryable) where.push("queryable");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const hit = (parts: string[]) => parts.join(" + ") || "0";
    const rows = await this.query(
      `SELECT pid, cansim_id, title_en, archived, frequency_code, frequency_en, dimension_count, cube_start_date, cube_end_date, queryable,
              kind, family, subject_en, period_min, period_max, series_count, unit_families, place_levels,
              ${hit(titleHits)} AS title_hits, ${hit(dimensionHits)} AS dimension_hits, ${hit(memberHits)} AS member_hits, ${hit(noteHits)} AS note_hits,
              ${hit([...dimensionHits, ...memberHits, ...noteHits])} AS text_hits, count(*) OVER () AS _total
       FROM tables ${clause}
       ORDER BY title_hits DESC, queryable DESC, text_hits DESC, title_en, pid
       LIMIT ${Math.min(opts.limit, MAX_LIMIT)} OFFSET ${Math.max(opts.offset, 0)}`, params);
    const total = rows.length ? Number(rows[0]._total) : Number((await this.one(`SELECT count(*) AS n FROM tables ${clause}`, params))!.n);
    for (const row of rows) delete row._total;
    return { total, rows };
  }

  async table(pid: string) {
    const cube = await this.one(`SELECT * EXCLUDE (search_text, search_text_lower, search_title_lower,
      search_dimensions_lower, search_members_lower, search_notes_lower) FROM tables WHERE pid = $1`, [pid]);
    if (!cube) return undefined;
    const [meta, dimensions, members, notes, corrections, inventoryCorrections, symbols, surveys, subjects, inventoryDimensions] = await Promise.all([
      this.one("SELECT * EXCLUDE (note_block_raw) FROM cube_meta WHERE pid = $1", [pid]),
      this.query("SELECT dimension_id, dimension_name, dimension_notes, dimension_definitions FROM dimension WHERE pid = $1 ORDER BY dimension_id", [pid]),
      this.query(`SELECT m.dimension_id, m.member_id, m.member_name, m.classification_code, m.parent_member_id, m.terminated, m.member_notes, mp.place_id, mp.match AS place_match
                  FROM member m LEFT JOIN member_place mp ON mp.pid = m.pid AND mp.dimension_id = m.dimension_id AND mp.member_id = m.member_id
                  WHERE m.pid = $1 ORDER BY m.dimension_id, m.member_id`, [pid]),
      this.query("SELECT note_id, note FROM note WHERE pid = $1 ORDER BY note_id", [pid]),
      this.query("SELECT correction_id, correction_date, correction_note FROM correction WHERE pid = $1 ORDER BY correction_id", [pid]),
      this.query("SELECT correction_date, note_en FROM inventory_correction WHERE pid = $1 ORDER BY correction_date", [pid]),
      this.query("SELECT symbol, description FROM symbol WHERE pid = $1 ORDER BY symbol", [pid]),
      this.query("SELECT survey_code, survey_name FROM survey WHERE pid = $1 ORDER BY survey_code", [pid]),
      this.query("SELECT subject_code, subject_name FROM subject WHERE pid = $1 ORDER BY subject_code", [pid]),
      this.query("SELECT position, name_en, name_fr, has_uom FROM inventory_dimension WHERE pid = $1 ORDER BY position", [pid]),
    ]);
    const codes = (kind: "subject" | "survey", list: unknown) => ((list as string[] | null) ?? []).map((code) => ({ [`${kind}_code`]: code, [`${kind}_en`]: this.labels[kind].get(code) ?? null }));
    return {
      pid, cube, inventory_dimensions: inventoryDimensions, meta: meta ?? null,
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
   * One line per series for a filter. A series is a coordinate: it equals the vector in WDS tables, and Census
   * tables have no vector. Returns `too_many_vectors` above `maxVectors` and `too_many_points` above
   * MAX_SERIES_POINTS, without reading the points. Undefined when the table has no Parquet file.
   */
  async series(pid: string, f: ObservationFilter, maxVectors: number): Promise<SeriesResult | undefined> {
    const file = this.parquetPath(pid);
    const dims = this.manifest.tables[pid]?.dims;
    if (!file || !dims) return undefined;
    const { params, clause } = this.filterClause(file, dims, f);
    // Count first: it is cheap (Parquet statistics), and a match above the point cap needs no coordinate scan.
    const totalPoints = Number((await this.one(`SELECT count(*) AS n FROM read_parquet($1) o ${clause}`, params))!.n);
    if (totalPoints > MAX_SERIES_POINTS) return { kind: "too_many_points", limit: MAX_SERIES_POINTS };
    const counts = await this.query(`SELECT o.coordinate FROM read_parquet($1) o ${clause} GROUP BY o.coordinate LIMIT ${maxVectors + 1}`, params);
    if (counts.length > maxVectors) return { kind: "too_many_vectors", limit: maxVectors };
    const ks = Array.from({ length: dims }, (_, i) => i + 1);
    const ids = ks.map((k) => `o.member_id_${k}`).join(", ");
    const [rows, dimensionRows, memberRows] = await Promise.all([
      this.query(`SELECT o.vector, o.coordinate, o.uom, o.scalar_factor, o.ref_date, o.value_num, o.status,
                         p.period_start, p.period_end, p.period_kind, ${ids}
                  FROM read_parquet($1) o JOIN period p ON p.pid = $${params.length + 1} AND p.ref_date = o.ref_date
                  ${clause} ORDER BY ${ids}, o.ref_date, o.row_index`, [...params, pid]),
      this.query("SELECT dimension_id, dimension_name FROM dimension WHERE pid = $1", [pid]),
      this.query("SELECT dimension_id, member_id, member_name FROM member WHERE pid = $1", [pid]),
    ]);
    const dimensionName = new Map(dimensionRows.map((d) => [Number(d.dimension_id), String(d.dimension_name)]));
    const memberName = new Map(memberRows.map((m) => [`${m.dimension_id}.${m.member_id}`, String(m.member_name)]));
    const byCoordinate = new Map<string, Series>();
    for (const r of rows) {
      const coordinate = String(r.coordinate);
      const periodKind = String(r.period_kind ?? "other") as PeriodKind;
      let s = byCoordinate.get(coordinate);
      if (!s) {
        s = {
          vector: String(r.vector ?? ""), coordinate, name: "", unit: String(r.uom ?? ""), scale: String(r.scalar_factor ?? ""), period_kind: periodKind, points: [],
          labels: ks.filter((k) => r[`member_id_${k}`] != null).map((k) => ({
            dimension_id: k, dimension: dimensionName.get(k) ?? `dimension ${k}`, member_id: Number(r[`member_id_${k}`]), member: memberName.get(`${k}.${r[`member_id_${k}`]}`) ?? null,
          })),
        };
        byCoordinate.set(coordinate, s);
      }
      if (s.period_kind !== periodKind) s.period_kind = "other";
      s.points.push([String(r.ref_date), typeof r.value_num === "number" && Number.isFinite(r.value_num) ? r.value_num : null, String(r.status ?? ""), r.period_start as string | null, r.period_end as string | null]);
    }
    const series = [...byCoordinate.values()];
    // Name a line by the members that differ between lines; with one line nothing differs, so use all its members.
    const differs = (dimensionId: number) => new Set(series.map((s) => s.labels.find((l) => l.dimension_id === dimensionId)?.member_id)).size > 1;
    for (const s of series) {
      const shown = s.labels.filter((l) => differs(l.dimension_id));
      s.name = (shown.length ? shown : s.labels).map((l) => l.member ?? `#${l.member_id}`).join(" · ") || s.vector || s.coordinate;
    }
    return { kind: "ok", series, total_points: totalPoints };
  }

  /** Filtered, paginated observations with labels joined from the member table, and period, place, unit family from Normalized. */
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
      `SELECT o.row_index, o.ref_date, p.period_start, p.period_end, p.period_kind, o.dguid, ${labels}, mp.place_id, o.uom, o.uom_id, uf.family AS unit_family, o.scalar_factor, o.scalar_id,
              o.vector, o.coordinate, o.value, o.value_num, o.status, o.symbol, o.terminated, o.decimals
       FROM (SELECT * FROM read_parquet($1) o ${clause} LIMIT ${limit} OFFSET ${offset}) o
       JOIN period p ON p.pid = ${pidParam} AND p.ref_date = o.ref_date
       ${joins}
       LEFT JOIN member_place mp ON mp.pid = ${pidParam} AND mp.dimension_id = 1 AND mp.member_id = o.member_id_1
       LEFT JOIN unit_family uf ON uf.uom_code = o.uom_id
       ORDER BY ${ks.map((k) => `o.member_id_${k}`).join(", ")}, o.ref_date, o.row_index`, [...params, pid]);
    for (const r of rows) {
      r.status_en = r.status ? this.labels.status.get(String(r.status)) ?? null : null;
      r.symbol_en = r.symbol ? this.labels.symbol.get(String(r.symbol)) ?? null : null;
    }
    return { total, limit, offset, rows };
  }

  /**
   * Series search over the Normalized `series` file. Every word must appear in the table title or a member label;
   * a term like `v41690915` must equal the vector. `pid`, `place_id`, `unit_family` are exact filters.
   */
  async seriesSearch(o: { q: string; pid?: string; place_id?: string; unit_family?: string; limit: number; offset: number }) {
    const searchQ = seriesSearchQuery(o.q);
    const terms = searchQ.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const words = terms.filter((t) => !VECTOR.test(t)).map(likeTerm);
    const vectors = terms.filter((t) => VECTOR.test(t)).map((t) => t.toLowerCase());
    const cpiPhrase = /\bconsumer\s+price\s+index\b/i.test(searchQ);
    // Candidate tables first, in memory. A series whose title or labels hold every word belongs to a table whose
    // search_text holds them too (it contains the title and every member name). The pid list then prunes row groups.
    const tParams: unknown[] = [];
    // A series needs two published periods; a one-date table cannot qualify and never needs a Parquet scan.
    const tWhere = ["queryable", "pid IN (SELECT pid FROM period GROUP BY pid HAVING count(*) >= 2)"];
    for (const w of words) { tParams.push(w); tWhere.push(`search_text ILIKE $${tParams.length} ESCAPE '\\'`); }
    if (o.pid) { tParams.push(o.pid); tWhere.push(`pid = $${tParams.length}`); }
    if (o.unit_family) { tParams.push(o.unit_family); tWhere.push(`list_contains(unit_families, $${tParams.length})`); }
    if (o.place_id) { tParams.push(o.place_id); tWhere.push(`pid IN (SELECT pid FROM member_place WHERE place_id = $${tParams.length})`); }
    // Per word, also which candidate titles hold it: a title match is a table fact, so the series scan needs no join.
    let candidates = (await this.query(`SELECT pid, title_en, archived, period_max, series_count${cpiPhrase ? `, search_title ILIKE ${sqlString("%consumer price index%")} ESCAPE '\\' AS phrase` : ", false AS phrase"}${words.map((_, i) => `, search_title ILIKE $${i + 1} ESCAPE '\\' AS w${i}`).join("")}
                                          FROM tables WHERE ${tWhere.join(" AND ")} ORDER BY pid`, tParams))
      .filter((r) => /^[0-9]{8}$/.test(String(r.pid)));
    if (!candidates.length) return { total: 0, rows: [] as Row[], limited: false };
    let limited = false;
    let sampled = false;
    if ((this.normalized.cleans?.length ?? 1) > 1 && !o.pid && !o.place_id && !o.unit_family && !vectors.length &&
      this.normalized.files["series/"]?.layout === "partitioned_parquet_directory" &&
      candidates.reduce((sum, row) => sum + Number(row.series_count ?? 0), 0) > 1_000_000) {
      // ponytail: bound broad discovery to 12 parts / 5,000 rows; an index is needed for exhaustive broad counts.
      const score = (row: Row) => words.reduce((n, _, i) => n + Number(row[`w${i}`] === true), 0);
      const titled = candidates.filter((row) => score(row) > 0);
      const ranked = (titled.length ? titled : candidates).sort((a, b) =>
        Number(b.phrase === true) - Number(a.phrase === true) || score(b) - score(a) ||
        Number(b.archived) - Number(a.archived) || String(a.title_en).length - String(b.title_en).length ||
        String(b.period_max).localeCompare(String(a.period_max)) || String(a.pid).localeCompare(String(b.pid)));
      candidates = [];
      let remaining = 5_000;
      for (const row of ranked) {
        const count = Number(row.series_count ?? Infinity);
        if (count > remaining) continue;
        candidates.push(row);
        remaining -= count;
        if (!remaining || candidates.length === 12) break;
      }
      if (!candidates.length) { candidates.push(ranked[0]); sampled = true; }
      limited = true;
    }
    const source = sampled ? `(SELECT * FROM read_parquet(${sqlString(this.seriesPath(String(candidates[0].pid)))}) LIMIT 5000)`
      : this.normalized.files["series/"]?.layout === "partitioned_parquet_directory"
        ? `read_parquet([${candidates.map((row) => sqlString(this.seriesPath(String(row.pid)))).join(", ")}])`
        : "series";
    const inList = (rows: Row[]) => rows.length ? `s.pid IN (${rows.map((r) => sqlString(String(r.pid))).join(", ")})` : "false";
    const params: unknown[] = [];
    const where = [inList(candidates), "COALESCE(s.n_published, 0) >= 2"];
    const phraseHit = inList(candidates.filter((r) => r.phrase === true));
    const titleHits: string[] = [];
    words.forEach((w, i) => {
      const inTitle = inList(candidates.filter((r) => r[`w${i}`] === true));
      params.push(w);
      // One ILIKE per label, OR'ed so DuckDB can skip the remaining labels after a match.
      where.push(`(${[...LABELS.map((l) => `s.${l} ILIKE $${params.length} ESCAPE '\\'`), inTitle].join(" OR ")})`);
      titleHits.push(`(${inTitle})::INT`);
    });
    for (const v of vectors) { params.push(v); where.push(`s.vector = $${params.length}`); }
    if (o.place_id) { params.push(o.place_id); where.push(`s.place_id = $${params.length}`); }
    if (o.unit_family) { params.push(o.unit_family); where.push(`s.unit_family = $${params.length}`); }
    const clause = `WHERE ${where.join(" AND ")}`;
    const order = ["phrase_hit DESC", "(title_hits > 0) DESC", "s.n_published DESC", "s.period_max DESC", "s.terminated", "s.pid", ...MEMBER_IDS.map((c) => `s.${c}`)];
    const outerOrder = order;
    const columns = ["pid", "vector", "coordinate", "labels", "place_id", "uom_code", "unit_family", "scalar_code", "decimals", "period_kind",
      "period_min", "period_max", "n_obs", "n_published", "terminated", "last_status", "title_hits", "phrase_hit"];
    const total = Number((await this.one(`SELECT count(*) AS n FROM ${source} s ${clause}`, params))!.n);
    // Page first on the series file alone, then join the page (<= MAX_LIMIT rows) to place names.
    const rows = await this.query(
      `SELECT ${columns.map((c) => `s.${c}`).join(", ")}, p.name_en AS place_name
       FROM (SELECT s.*, list_filter([${LABELS.map((l) => `s.${l}`).join(", ")}], lambda x: x IS NOT NULL) AS labels, ${titleHits.join(" + ") || "0"} AS title_hits, (${phraseHit})::INT AS phrase_hit
             FROM ${source} s ${clause} ORDER BY ${order.join(", ")}
             LIMIT ${Math.min(Math.max(o.limit, 1), MAX_LIMIT)} OFFSET ${Math.max(o.offset, 0)}) s
       LEFT JOIN place p USING (place_id)
       ORDER BY ${outerOrder.join(", ")}`, params);
    for (const r of rows) {
      const info = this.info.get(String(r.pid));
      Object.assign(r, { title_en: info?.title_en ?? null, kind: info?.kind ?? null, uom_en: this.labels.uom.get(String(r.uom_code)) ?? null,
        scalar_en: this.labels.scalar.get(String(r.scalar_code)) ?? null });
      const key = r.vector ? String(r.vector) : `c/${r.coordinate}`;
      r.links = { self: `/api/v1/series/${r.pid}/${key}`, html: `/series/${r.pid}/${key}` };
    }
    return { total, rows, limited };
  }

  /** One series: its Normalized row, labels, place, unit, and every point with its period. `vector` for WDS tables, `coordinate` for any table. */
  async seriesGet(pid: string, key: { vector: string } | { coordinate: string }): Promise<SeriesDetailResult> {
    const file = this.parquetPath(pid);
    const dims = this.manifest.tables[pid]?.dims;
    if (!file || !dims) return { kind: "not_found" };
    const [column, value] = "vector" in key ? ["vector", key.vector] : ["coordinate", key.coordinate];
    const row = await this.one(
      `SELECT s.*, p.name_en AS place_name, p.level AS place_level, uf.symbol AS unit_symbol, uf.base_year AS unit_base_year, uf.note AS unit_note
       FROM read_parquet($1) s LEFT JOIN place p USING (place_id) LEFT JOIN unit_family uf ON uf.uom_code = s.uom_code
       WHERE s.pid = $2 AND s.${column} = $3`, [this.seriesPath(pid), pid, value]);
    if (!row) return { kind: "not_found" };
    if (Number(row.n_obs) > MAX_SERIES_POINTS) return { kind: "too_many_points", limit: MAX_SERIES_POINTS };
    const ks = Array.from({ length: dims }, (_, i) => i + 1);
    const params: unknown[] = [file, row.coordinate];
    // Member IDs match the file's sort order, so DuckDB skips row groups; the coordinate makes the match exact.
    const memberWhere = ks.map((k) => { params.push(row[`member_id_${k}`]); return `o.member_id_${k} = $${params.length}`; });
    const [points, dimensionRows] = await Promise.all([
      this.query(`SELECT o.ref_date, p.period_start, p.period_end, p.period_kind, o.value, o.value_num, o.status, o.symbol FROM read_parquet($1) o
                  JOIN period p ON p.pid = $${params.length + 1} AND p.ref_date = o.ref_date
                  WHERE o.coordinate = $2 AND ${memberWhere.join(" AND ")} ORDER BY o.ref_date`, [...params, pid]),
      this.query("SELECT dimension_id, dimension_name FROM dimension WHERE pid = $1", [pid]),
    ]);
    // Retain a read-time corruption guard even when the Normalized producer checked n_obs.
    if (points.length !== Number(row.n_obs)) return { kind: "inconsistent", n_obs: Number(row.n_obs), points: points.length };
    for (const p of points) {
      p.status_en = p.status ? this.labels.status.get(String(p.status)) ?? null : null;
      p.symbol_en = p.symbol ? this.labels.symbol.get(String(p.symbol)) ?? null : null;
    }
    const dimensionName = new Map(dimensionRows.map((d) => [Number(d.dimension_id), String(d.dimension_name)]));
    const labels: SeriesLabel[] = ks.map((k) => ({ dimension_id: k, dimension: dimensionName.get(k) ?? `dimension ${k}`, member_id: Number(row[`member_id_${k}`]), member: (row[`label_${k}`] as string | null) ?? null }));
    const info = this.info.get(pid);
    const series: Row = {
      pid, vector: row.vector, coordinate: row.coordinate, title_en: info?.title_en, table_kind: info?.kind, family: info?.family, frequency_en: info?.frequency_en,
      place: row.place_id ? { place_id: row.place_id, name_en: row.place_name, level: row.place_level } : null,
      uom_code: row.uom_code, uom_en: this.labels.uom.get(String(row.uom_code)) ?? null, unit_family: row.unit_family,
      unit_symbol: row.unit_symbol, unit_base_year: row.unit_base_year, unit_note: row.unit_note,
      scalar_code: row.scalar_code, scalar_en: this.labels.scalar.get(String(row.scalar_code)) ?? null, decimals: row.decimals,
      period_kind: row.period_kind, period_min: row.period_min, period_max: row.period_max,
      n_obs: row.n_obs, n_published: row.n_published, terminated: row.terminated, last_status: row.last_status,
    };
    return { kind: "ok", series: { ...series, labels, points } };
  }

  /** Places whose name holds every term, or whose place_id, DGUID, or geo_code equals one. Countries and provinces first. */
  async places(q: string, limit: number, offset: number) {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const params: unknown[] = [];
    const where = terms.map((term) => {
      params.push(likeTerm(term), term);
      const [like, exact] = [`$${params.length - 1}`, `$${params.length}`];
      return `(p.name_en ILIKE ${like} ESCAPE '\\' OR p.place_id = ${exact} OR p.dguid = ${exact} OR p.geo_code = ${exact})`;
    });
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.one(`SELECT count(*) AS n FROM place p ${clause}`, params))!.n);
    const rows = await this.query(
      `SELECT * FROM ${PLACE_TABLES} p ${clause}
       ORDER BY CASE p.level WHEN 'country' THEN 0 WHEN 'province' THEN 1 ELSE 2 END, p.name_en, p.vintage DESC NULLS LAST, p.place_id
       LIMIT ${Math.min(Math.max(limit, 1), MAX_LIMIT)} OFFSET ${Math.max(offset, 0)}`, params);
    return { total, rows };
  }

  /** A place, every vintage of it (same schema and geo_code), and every table and series count that covers any vintage, grouped by subject. */
  async place(placeId: string) {
    const place = await this.one("SELECT * FROM place WHERE place_id = $1", [placeId]);
    if (!place) return undefined;
    const same = [place.schema, place.geo_code];
    const [vintages, parent, members] = await Promise.all([
      this.query(`SELECT * FROM ${PLACE_TABLES} p WHERE p.schema = $1 AND p.geo_code = $2 ORDER BY p.vintage NULLS LAST, p.place_id`, same),
      place.parent_place_id ? this.one("SELECT place_id, name_en, level, vintage FROM place WHERE place_id = $1", [place.parent_place_id]) : undefined,
      this.query(`SELECT mp.pid, mp.member_id, m.member_name, mp.place_id, p.vintage, mp.match
                  FROM member_place mp JOIN place p USING (place_id)
                  LEFT JOIN member m ON m.pid = mp.pid AND m.dimension_id = mp.dimension_id AND m.member_id = mp.member_id
                  WHERE p.schema = $1 AND p.geo_code = $2 ORDER BY mp.pid, mp.member_id`, same),
    ]);
    const pids = [...new Set(members.map((m) => String(m.pid)))].filter((pid) => /^[0-9]{8}$/.test(pid));
    const countedPids = pids.filter((pid) => this.parquetPath(pid));
    const source = this.normalized.files["series/"]?.layout === "partitioned_parquet_directory"
      ? `read_parquet([${countedPids.map((pid) => sqlString(this.seriesPath(pid))).join(", ")}])`
      : "series";
    const [tableRows, counts] = pids.length ? await Promise.all([
      this.query(`SELECT pid, title_en, subject_en, kind, family, frequency_en, period_min, period_max, release_time, queryable FROM tables
                  WHERE pid IN (${pids.map(sqlString).join(", ")}) ORDER BY title_en, pid`),
      countedPids.length ? this.query(`SELECT s.pid, count(*) AS n_series FROM ${source} s
                  WHERE s.pid IN (${countedPids.map(sqlString).join(", ")}) AND s.place_id IN (SELECT place_id FROM place WHERE schema = $1 AND geo_code = $2)
                  GROUP BY s.pid`, same) : Promise.resolve([] as Row[]),
    ]) : [[], []];
    const nSeries = new Map(counts.map((r) => [String(r.pid), Number(r.n_series)]));
    const groups = new Map<string | null, Row[]>();
    for (const t of tableRows) {
      const pid = String(t.pid);
      const subject = Array.isArray(t.subject_en) && typeof t.subject_en[0] === "string" ? t.subject_en[0] : null;
      const tableMembers = members.filter((m) => m.pid === pid).map(({ pid: _, ...m }) => m);
      const entry: Row = {
        ...t, members: tableMembers, n_series: nSeries.get(pid) ?? 0, citation: this.citation(pid),
        series_search: [...new Set(tableMembers.map((m) => `/api/v1/series?pid=${pid}&place_id=${encodeURIComponent(String(m.place_id))}`))],
      };
      if (!groups.has(subject)) groups.set(subject, []);
      groups.get(subject)!.push(entry);
    }
    const subjects = [...groups.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
      .map(([subject_en, tables]) => ({ subject_en, tables }));
    return { place, parent: parent ?? null, vintages, n_tables: tableRows.length, subjects };
  }

  /** Inventory, capture, build, and Normalized coverage. Computed once: every input is fixed for the life of the process. */
  coverage(captureDir?: string): Promise<Row> {
    this.coverageCache ??= this.computeCoverage(captureDir);
    return this.coverageCache;
  }

  private async computeCoverage(captureDir?: string): Promise<Row> {
    const m = this.manifest;
    const captured = captureDir
      ? new Set(readdirSync(path.join(captureDir, "manifests")).filter((f) => f.endsWith("-en.json")).map((f) => f.slice(0, -"-en.json".length)))
      : undefined;
    const families = await this.query(`SELECT family, count(*) AS inventory, count(*) FILTER (WHERE queryable) AS queryable FROM tables GROUP BY family ORDER BY family`);
    const byFamily = families.map((f) => {
      const pids = [...this.info].filter(([, t]) => t.family === f.family).map(([pid]) => pid);
      return { family: f.family, inventory: f.inventory, captured: captured ? pids.filter((pid) => captured.has(pid)).length : null,
        built: pids.filter((pid) => m.tables[pid]).length, queryable: f.queryable };
    });
    let gaps: Row[] | null = null;
    if (captured) {
      // Last recorded failure per PID from the downloader's log; a .part.json file holds the bytes of an unfinished ZIP.
      const failures = new Map<string, { attempts: number; error: string; at_utc: string }>();
      const log = path.join(captureDir!, "failures.jsonl");
      if (existsSync(log)) {
        for (const line of readFileSync(log, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const f = JSON.parse(line) as { pid: string; language: string; error: string; at_utc: string };
          if (f.language !== "en") continue;
          failures.set(f.pid, { attempts: (failures.get(f.pid)?.attempts ?? 0) + 1, error: f.error, at_utc: f.at_utc });
        }
      }
      gaps = [...this.info.keys()].filter((pid) => !captured.has(pid)).sort().map((pid) => {
        const part = path.join(captureDir!, "zips", `${pid}-en.zip.part.json`);
        const partInfo: unknown = existsSync(part) ? JSON.parse(readFileSync(part, "utf8")) : null;
        const f = failures.get(pid);
        return { pid, title_en: this.info.get(pid)!.title_en, last_error: f?.error ?? null, last_attempt_utc: f?.at_utc ?? null, attempts: f?.attempts ?? 0,
          partial_bytes: partInfo && typeof partInfo === "object" && "total" in partInfo && typeof partInfo.total === "number" ? partInfo.total : null };
      });
    }
    const reports = Object.entries(m.tables);
    return {
      inventory: this.info.size, captured: captured?.size ?? null, built: reports.length,
      queryable: reports.filter(([, t]) => t.status === "ok").length, by_family: byFamily,
      failed: reports.filter(([, t]) => t.status !== "ok").map(([pid, t]) => ({ pid, title_en: this.info.get(pid)?.title_en ?? null, errors: t.errors })),
      upstream_gaps: gaps, normalized_warnings: this.normalized.warnings,
    };
  }
}
