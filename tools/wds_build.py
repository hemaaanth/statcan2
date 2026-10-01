#!/usr/bin/env python3
"""Build versioned query files from a WDS capture without changing its source ZIPs.

Outputs under <out>/<build-id>/ on the UUID-checked SSD:
  catalogue/*.parquet   inventory tables (all PIDs) and per-ZIP metadata blocks
  obs/<PID>.parquet     long-form observations, one file per built table
  build_manifest.json   source hashes, per-PID checks, output hashes

Example:
  .venv/bin/python -B tools/wds_build.py \\
      --capture /run/media/hemanth/Kingston/statcan-wds/baseline \\
      --out /run/media/hemanth/Kingston/statcan-derived \\
      --mount-uuid 72D0-2131 --pids 18100006,17100009
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import multiprocessing
import os
import platform
import re
import shutil
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

import duckdb
import pyarrow as pa

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wds_download import Drive, StorageStop, utc_now  # noqa: E402

MAX_DIMS = 9  # inventory: tables have 1-9 dimensions
TAIL = ["UOM", "UOM_ID", "SCALAR_FACTOR", "SCALAR_ID", "VECTOR", "COORDINATE",
        "VALUE", "STATUS", "SYMBOL", "TERMINATED", "DECIMALS"]
BATCH_ROWS = 200_000
ROW_GROUP = 100_000
NUMBER = re.compile(r"-?[0-9]+(\.[0-9]+)?")
INTEGER = re.compile(r"[0-9]+")

# Metadata CSV blocks, keyed by their header cells. Column maps fail loudly on unknown headers.
BLOCK_COLUMNS = {
    "cube": {"Cube Title": "cube_title", "Product Id": "product_id", "CANSIM Id": "cansim_id", "URL": "url",
             "Cube Notes": "cube_notes", "Archive Status": "archive_status", "Frequency": "frequency",
             "Start Reference Period": "start_reference_period", "End Reference Period": "end_reference_period",
             "Total number of dimensions": "total_dimensions", "Universe": "universe", "Variable List": "variable_list"},
    "dimension": {"Dimension ID": "dimension_id", "Dimension name": "dimension_name", "Dimension Notes": "dimension_notes",
                  "Dimension Correction Notes": "dimension_correction_notes", "Dimension Definitions": "dimension_definitions"},
    "member": {"Dimension ID": "dimension_id", "Member Name": "member_name", "Classification Code": "classification_code",
               "Member ID": "member_id", "Parent Member ID": "parent_member_id", "Terminated": "terminated",
               "Member Notes": "member_notes", "Member Correction Notes": "member_correction_notes",
               "Member Geo Attribute Keys": "member_geo_attribute_keys", "Member Definitions": "member_definitions"},
    "symbol": {"Description": "description", "Symbol": "symbol"},
    "survey": {"Survey Code": "survey_code", "Survey Name": "survey_name"},
    "subject": {"Subject Code": "subject_code", "Subject Name": "subject_name"},
    "note": {"Note ID": "note_id", "Note": "note"},
    "correction": {"Correction ID": "correction_id", "Correction Date": "correction_date", "Correction Note": "correction_note"},
    # Oldest writer dialect (2019 files): no Corrections block, this member-attribute block instead.
    "attribute": {"Dimension ID": "dimension_id", "Member ID": "member_id", "Attribute Key": "attribute_key", "Title": "title",
                  "Label": "label", "Long Label": "long_label", "Value": "value"},
}
OPTIONAL_BLOCKS = {"correction", "attribute"}
# Notes and corrections hold free text with unescaped quotes; they are parsed by record start, not as CSV.
LOOSE_BLOCKS = {"note": (re.compile(r'"?([0-9]+)"?,(.*)'), ["note_id", "note"]),
                "correction": (re.compile(r'"?([0-9]+)"?,"?([0-9-]+)"?,(.*)'), ["correction_id", "correction_date", "correction_note"])}
INT_COLUMNS = {"total_dimensions", "dimension_id", "member_id", "parent_member_id", "note_id"}

CATALOGUE_SCHEMAS = {
    "cube": pa.schema([("pid", pa.string()), ("product_id", pa.int64()), ("cansim_id", pa.string()),
                       ("title_en", pa.string()), ("title_fr", pa.string()), ("cube_start_date", pa.string()),
                       ("cube_end_date", pa.string()), ("release_time", pa.string()), ("issue_date", pa.string()),
                       ("archived", pa.string()), ("frequency_code", pa.int32()),
                       ("subject_codes", pa.list_(pa.string())), ("survey_codes", pa.list_(pa.string())),
                       ("dimension_count", pa.int32()), ("correction_count", pa.int32())]),
    "inventory_dimension": pa.schema([("pid", pa.string()), ("position", pa.int32()), ("name_en", pa.string()),
                                      ("name_fr", pa.string()), ("has_uom", pa.bool_())]),
    "inventory_correction": pa.schema([("pid", pa.string()), ("correction_date", pa.string()),
                                       ("note_en", pa.string()), ("note_fr", pa.string())]),
    "cube_meta": pa.schema([("pid", pa.string())] + [(c, pa.int32() if c in INT_COLUMNS else pa.string())
                                                     for c in BLOCK_COLUMNS["cube"].values()]
                           + [("note_block_raw", pa.string())]),
}
META_TABLES = ("dimension", "member", "attribute", "symbol", "survey", "subject", "note", "correction")
for _name in META_TABLES:
    CATALOGUE_SCHEMAS[_name] = pa.schema([("pid", pa.string())] + [(c, pa.int32() if c in INT_COLUMNS else pa.string())
                                                                   for c in BLOCK_COLUMNS[_name].values()])
CATALOGUE_ORDER = {"cube": "pid", "inventory_dimension": "pid, position", "inventory_correction": "pid, correction_date, note_en",
                   "cube_meta": "pid", "dimension": "pid, dimension_id", "member": "pid, dimension_id, member_id",
                   "attribute": "pid, dimension_id, member_id, attribute_key", "symbol": "pid, symbol, description",
                   "survey": "pid, survey_code", "subject": "pid, subject_code", "note": "pid, note_id", "correction": "pid, correction_id"}

OBS_SCHEMA = pa.schema(
    [("pid", pa.string()), ("row_index", pa.int64()), ("ref_date", pa.string()), ("dguid", pa.string()),
     ("uom", pa.string()), ("uom_id", pa.int32()), ("scalar_factor", pa.string()), ("scalar_id", pa.int32()),
     ("vector", pa.string()), ("coordinate", pa.string()), ("value", pa.string()), ("value_num", pa.float64()),
     ("status", pa.string()), ("symbol", pa.string()), ("terminated", pa.string()), ("decimals", pa.int32())]
    + [(f"member_id_{k}", pa.int32()) for k in range(1, MAX_DIMS + 1)])
OBS_ORDER = ", ".join(f"member_id_{k}" for k in range(1, MAX_DIMS + 1)) + ", ref_date, row_index"


class TableError(Exception):
    pass


# ---------------------------------------------------------------- metadata

def block_name(line):
    cells = next(csv.reader([line]), [])
    if not cells:
        return None
    if cells[0] == "Dimension ID":
        return {"Dimension name": "dimension", "Member Name": "member", "Member ID": "attribute"}.get(cells[1] if len(cells) > 1 else None)
    return {"Cube Title": "cube", "Symbol Legend": "symbol", "Survey Code": "survey", "Subject Code": "subject",
            "Note ID": "note", "Correction ID": "correction"}.get(cells[0])


def split_blocks(text):
    """Return {block name: lines} with each block's header as its first line. Notes keep blank lines."""
    blocks, current = {}, None
    for line in text.splitlines():
        name = block_name(line)
        if name:
            if name in blocks:
                raise TableError(f"metadata block {name!r} appears twice")
            current = blocks[name] = [] if name == "symbol" else [line]  # symbol header is the next line
        elif current is not None:
            current.append(line)
        elif line.strip():
            raise TableError(f"metadata text before first block header: {line[:80]!r}")
    missing = BLOCK_COLUMNS.keys() - OPTIONAL_BLOCKS - blocks.keys()
    if missing:
        raise TableError(f"metadata blocks missing: {sorted(missing)}")
    return blocks


def block_rows(name, lines):
    columns = BLOCK_COLUMNS[name]
    reader = csv.DictReader(lines, restkey="_extra", restval=None)
    unknown = [h for h in reader.fieldnames or [] if h not in columns]
    if unknown:
        raise TableError(f"metadata block {name!r} has unknown columns {unknown}")
    rows = []
    for raw in reader:
        extra = raw.pop("_extra", None)
        if extra and any(extra):
            raise TableError(f"metadata block {name!r} row wider than header: {extra}")
        if not any(raw.values()):
            continue
        row = {col: raw.get(header) for header, col in columns.items()}
        for col in columns.values():
            if col in INT_COLUMNS:
                row[col] = int(row[col]) if row[col] not in (None, "") else None
        rows.append(row)
    return rows


def loose_rows(name, lines):
    pattern, columns = LOOSE_BLOCKS[name]
    header = next(csv.reader(lines[:1]), [])
    if header[:len(columns)] != list(BLOCK_COLUMNS[name]):
        raise TableError(f"metadata block {name!r} has unexpected header {header}")
    records = []
    for line in lines[1:]:
        match = pattern.fullmatch(line)  # ponytail: a text line that itself looks like a record start is read as a new record
        if match:
            records.append([*match.groups()])
        elif records:
            records[-1][-1] += "\n" + line
        elif line.strip():
            raise TableError(f"{name} text before first record: {line[:80]!r}")
    rows = []
    for fields in records:
        text = fields[-1].rstrip("\n")
        if text.endswith('",'):
            text = text[:-1]  # newer dialect: trailing empty field
        if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
            text = text[1:-1]  # unescaped inner quotes exist upstream, so no CSV unescaping
        fields[-1] = text
        row = dict(zip(columns, fields))
        if columns[0] in INT_COLUMNS:
            row[columns[0]] = int(row[columns[0]])
        rows.append(row)
    return rows


def read_metadata(archive, pid):
    """Metadata blocks by name. Values stay raw text except declared integer IDs. Optional blocks default to []."""
    text = archive.read(f"{pid}_MetaData.csv").decode("utf-8-sig")
    blocks = split_blocks(text)
    meta = {name: [] for name in OPTIONAL_BLOCKS}
    for name, lines in blocks.items():
        meta[name] = loose_rows(name, lines) if name in LOOSE_BLOCKS else block_rows(name, lines)
    if len(meta["cube"]) != 1:
        raise TableError(f"cube block has {len(meta['cube'])} rows")
    meta["cube"] = meta["cube"][0]
    meta["note_block_raw"] = "\n".join(blocks["note"])
    return meta


# ------------------------------------------------------------ observations

def parse_int(field, name, row_index):
    if not INTEGER.fullmatch(field):
        raise TableError(f"row {row_index}: {name} {field!r} is not an integer")
    return int(field)


def observation_batches(archive, pid, meta, report):
    """Yield Arrow batches of raw rows plus derived member IDs and numeric value.

    Stops at the first hard error and records it in report["errors"]; the caller discards the output.
    """
    dims = sorted(meta["dimension"], key=lambda d: d["dimension_id"])
    n = len(dims)
    expected = ["REF_DATE", "GEO", "DGUID"] + [d["dimension_name"] for d in dims[1:]] + TAIL
    # Row labels are the member name, or the name plus its classification code ("Logging [1133]").
    members = {(m["dimension_id"], m["member_id"]): (m["member_name"], f"{m['member_name']} {m['classification_code']}")
               for m in meta["member"]}
    quote_mangled = 0
    dim_ids = [d["dimension_id"] for d in dims]
    label_cols = [1] + list(range(3, 2 + n))
    tail = 2 + n
    status, symbol, terminated, blank_by_status = Counter(), Counter(), Counter(), Counter()
    legend = {s["symbol"] for s in meta["symbol"]}
    unseen = set()
    rows = 0
    columns = {name: [] for name in OBS_SCHEMA.names}

    def flush():
        batch = pa.RecordBatch.from_pydict(columns, schema=OBS_SCHEMA)
        for values in columns.values():
            values.clear()
        return batch

    try:
        with archive.open(f"{pid}.csv") as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            header = next(reader, None)
            if header != expected:
                raise TableError(f"header mismatch: got {header!r}, expected {expected!r}")
            width = len(expected)
            for index, row in enumerate(reader, 1):
                if len(row) != width:
                    raise TableError(f"row {index}: width {len(row)}, expected {width}")
                parts = row[tail + 5].split(".")
                if len(parts) != n:
                    raise TableError(f"row {index}: coordinate {row[tail + 5]!r} has {len(parts)} parts, expected {n}")
                ids = [parse_int(p, "coordinate part", index) for p in parts]
                for k, col in enumerate(label_cols):
                    names = members.get((dim_ids[k], ids[k]))
                    if names is None or row[col] not in names:
                        # Some observation files drop or misplace quotes inside labels; the member table is authoritative.
                        if names is None or row[col].replace('"', "") != names[0].replace('"', ""):
                            raise TableError(f"row {index}: dimension {dim_ids[k]} member {ids[k]} is "
                                             f"{names and names[0]!r}, row label {row[col]!r}")
                        quote_mangled += 1
                value = row[tail + 6]
                if value == "":
                    value_num = None
                    blank_by_status[row[tail + 7]] += 1
                elif NUMBER.fullmatch(value):
                    value_num = float(value)
                else:
                    raise TableError(f"row {index}: VALUE {value!r} is not numeric")
                status[row[tail + 7]] += 1
                symbol[row[tail + 8]] += 1
                terminated[row[tail + 9]] += 1
                for code in (row[tail + 7], row[tail + 8]):
                    if code and code not in legend:
                        unseen.add(code)
                c = columns
                c["pid"].append(pid)
                c["row_index"].append(index)
                c["ref_date"].append(row[0])
                c["dguid"].append(row[2])
                c["uom"].append(row[tail])
                c["uom_id"].append(parse_int(row[tail + 1], "UOM_ID", index))
                c["scalar_factor"].append(row[tail + 2])
                c["scalar_id"].append(parse_int(row[tail + 3], "SCALAR_ID", index))
                c["vector"].append(row[tail + 4])
                c["coordinate"].append(row[tail + 5])
                c["value"].append(value)
                c["value_num"].append(value_num)
                c["status"].append(row[tail + 7])
                c["symbol"].append(row[tail + 8])
                c["terminated"].append(row[tail + 9])
                c["decimals"].append(parse_int(row[tail + 10], "DECIMALS", index))
                for k in range(MAX_DIMS):
                    c[f"member_id_{k + 1}"].append(ids[k] if k < n else None)
                rows += 1
                if rows % BATCH_ROWS == 0:
                    yield flush()
            if rows % BATCH_ROWS:
                yield flush()
    except TableError as exc:
        report["errors"].append(str(exc))
    except (UnicodeDecodeError, csv.Error) as exc:
        report["errors"].append(f"after row {rows}: {exc}")
    if quote_mangled:
        report["warnings"].append(f"{quote_mangled} row labels matched the member name only after removing double quotes")
    report.update(row_count=rows, dims=n, status_counts=dict(status), symbol_counts=dict(symbol),
                  terminated_counts=dict(terminated), blank_value_count=sum(blank_by_status.values()),
                  blank_value_by_status=dict(blank_by_status), codes_not_in_legend=sorted(unseen))


# -------------------------------------------------------------------- build

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_parquet(con, drive, source_sql, path):
    drive.check()
    tmp = path.with_name(path.name + ".tmp")
    con.execute(f"COPY ({source_sql}) TO '{tmp.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {ROW_GROUP})")
    os.replace(tmp, path)
    return {"bytes": path.stat().st_size, "sha256": sha256_file(path)}


def inventory_tables(records):
    cube, dims, corrections = [], [], []
    for r in records:
        pid = str(r["productId"])
        cube.append({"pid": pid, "product_id": r["productId"], "cansim_id": r["cansimId"], "title_en": r["cubeTitleEn"],
                     "title_fr": r["cubeTitleFr"], "cube_start_date": r["cubeStartDate"], "cube_end_date": r["cubeEndDate"],
                     "release_time": r["releaseTime"], "issue_date": r["issueDate"], "archived": r["archived"],
                     "frequency_code": r["frequencyCode"], "subject_codes": r["subjectCode"], "survey_codes": r["surveyCode"],
                     "dimension_count": len(r["dimensions"]), "correction_count": len(r["corrections"])})
        for d in r["dimensions"]:
            dims.append({"pid": pid, "position": d["dimensionPositionId"], "name_en": d["dimensionNameEn"],
                         "name_fr": d["dimensionNameFr"], "has_uom": d["hasUOM"]})
        for c in r["corrections"]:
            corrections.append({"pid": pid, "correction_date": c["correctionDate"], "note_en": c["correctionNoteEn"],
                                "note_fr": c["correctionNoteFr"]})
    return {"cube": cube, "inventory_dimension": dims, "inventory_correction": corrections}


def build_table(con, drive, capture, pid, out):
    """Build one table. Returns (report, metadata rows by catalogue table); rows are empty unless status is ok."""
    zip_path = capture / "zips" / f"{pid}-en.zip"
    path = out / "obs" / f"{pid}.parquet"
    started = time.monotonic()
    report = {"status": "error", "source_zip": str(zip_path), "errors": [], "warnings": []}
    tables = {name: [] for name in ("cube_meta", *META_TABLES)}
    try:
        manifest = json.loads((capture / "manifests" / f"{pid}-en.json").read_text())
        report["source_sha256"] = sha256_file(zip_path)
        if report["source_sha256"] != manifest["sha256"]:
            raise TableError(f"ZIP sha256 {report['source_sha256']} differs from capture manifest {manifest['sha256']}")
        report["source_captured_at_utc"] = manifest["completed_at_utc"]
        with zipfile.ZipFile(zip_path) as archive:
            names = sorted(archive.namelist())
            if names != sorted([f"{pid}.csv", f"{pid}_MetaData.csv"]):
                raise TableError(f"unexpected ZIP members {names}")
            meta = read_metadata(archive, pid)
            if meta["cube"]["total_dimensions"] != len(meta["dimension"]):
                raise TableError(f"cube says {meta['cube']['total_dimensions']} dimensions, block has {len(meta['dimension'])}")
            if '""' in meta["note_block_raw"]:
                report["warnings"].append("note block contains doubled quotes; stored without unescaping")
            reader = pa.RecordBatchReader.from_batches(OBS_SCHEMA, observation_batches(archive, pid, meta, report))
            con.register("obs_stream", reader)
            output = copy_parquet(con, drive, f"SELECT * FROM obs_stream ORDER BY {OBS_ORDER}", path)
            con.unregister("obs_stream")
            if report["errors"]:
                return report, tables
            checks = con.execute(f"""
                SELECT count(*), min(ref_date), max(ref_date),
                       (SELECT count(*) FROM (SELECT 1 FROM read_parquet('{path.as_posix()}') GROUP BY coordinate, ref_date HAVING count(*) > 1)),
                       (SELECT count(*) FROM (SELECT 1 FROM read_parquet('{path.as_posix()}') GROUP BY vector, ref_date HAVING count(*) > 1))
                FROM read_parquet('{path.as_posix()}')""").fetchone()
            if checks[0] != report["row_count"]:
                raise TableError(f"parquet has {checks[0]} rows, reader produced {report['row_count']}")
            report.update(ref_date_min=checks[1], ref_date_max=checks[2], duplicate_coordinate_ref_date=checks[3],
                          duplicate_vector_ref_date=checks[4], parquet={"path": path.relative_to(out).as_posix(), **output})
            tables["cube_meta"].append({"pid": pid, **meta["cube"], "note_block_raw": meta["note_block_raw"]})
            for name in META_TABLES:
                tables[name].extend({"pid": pid, **row} for row in meta[name])
            report["status"] = "ok"
    except (TableError, OSError, KeyError, ValueError, zipfile.BadZipFile, duckdb.Error) as exc:
        report["errors"].append(str(exc))
    finally:
        if report["status"] != "ok" and path.exists():
            path.unlink()
        report["seconds"] = round(time.monotonic() - started, 3)
    return report, tables


_worker = {}


def _worker_init(capture, out, uuid, reserve, memory_gib):
    _worker["capture"] = capture
    _worker["out"] = out
    _worker["drive"] = Drive(out, uuid, reserve)
    tmp = out / "tmp" / str(os.getpid())
    tmp.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"SET temp_directory = '{tmp.as_posix()}'")
    con.execute(f"SET memory_limit = '{memory_gib}GB'")
    con.execute("SET enable_progress_bar = false")
    _worker["con"] = con


def _worker_build(pid):
    try:
        return pid, *build_table(_worker["con"], _worker["drive"], _worker["capture"], pid, _worker["out"])
    except StorageStop as exc:
        return pid, {"status": "error", "errors": [str(exc)], "warnings": [], "seconds": 0}, {}


def run(args, worker=_worker_build, family="wds", script="tools/wds_build.py", pid_check=None):
    """Build args.pids into <out>/<build-id>/. Each finished table is saved to reports/<pid>.json at once, so a
    killed run loses only the tables in flight; --resume keeps the saved ok tables and builds the rest."""
    capture = Path(args.capture)
    Drive(capture, args.mount_uuid, reserve=0)
    out = Path(args.out) / args.build_id
    drive = Drive(out, args.mount_uuid, int(args.reserve_gib * 1024**3))
    if out.exists() and not args.resume:
        raise StorageStop(f"build directory exists: {out} (use --resume to continue it)")
    inventory_path = capture / "inventory.json"
    records = json.loads(inventory_path.read_text())
    tables = inventory_tables(records)
    tables.update({name: [] for name in ("cube_meta", *META_TABLES)})
    known = {row["pid"] for row in tables["cube"]}
    unknown = [pid for pid in args.pids if pid not in known]
    if unknown:
        raise StorageStop(f"PIDs not in the capture inventory: {unknown}")
    if pid_check:
        pid_check(args.pids)

    for sub in ("catalogue", "obs", "reports"):
        drive.mkdir(out / sub)
    if (out / "tmp").exists():
        shutil.rmtree(out / "tmp")  # spill files of a killed run
    drive.mkdir(out / "tmp")
    for partial in (out / "obs").glob("*.tmp"):
        partial.unlink()
    saved = {}
    for path in (out / "reports").glob("*.json"):
        entry = json.loads(path.read_text())
        parquet = entry["report"].get("parquet")
        if entry["report"]["status"] == "ok" and parquet and (out / parquet["path"]).exists() \
                and (out / parquet["path"]).stat().st_size == parquet["bytes"]:
            saved[path.stem] = entry
    # Smallest ZIPs first: most tables finish early and memory stays low. Several multi-GB tables sorting at once
    # exhausted RAM on a 30 GB laptop; run those as a separate --jobs 1 build.
    todo = [pid for pid in args.pids if pid not in saved]
    zip_bytes = {pid: (capture / "zips" / f"{pid}-en.zip").stat().st_size if (capture / "zips" / f"{pid}-en.zip").exists() else 0
                 for pid in todo}
    order = sorted(todo, key=lambda p: (zip_bytes[p], p))
    print(f"{len(args.pids) - len(todo)} tables kept from earlier runs, {len(order)} to build", flush=True)
    memory = max(1, args.memory_gib // args.jobs)
    with multiprocessing.get_context("forkserver").Pool(args.jobs, _worker_init,
                                                        (capture, out, args.mount_uuid, drive.reserve, memory)) as pool:
        for i, (pid, report, rows) in enumerate(pool.imap_unordered(worker, order), 1):
            saved[pid] = {"report": report, "rows": rows}
            drive.atomic_json(out / "reports" / f"{pid}.json", saved[pid])
            print(f"[{i}/{len(order)}] {pid} {report['status']} rows={report.get('row_count')} {report['seconds']}s "
                  f"{'; '.join(report['errors'])}", flush=True)
    reports = {}
    for pid in args.pids:
        reports[pid] = saved[pid]["report"]
        for name, items in saved[pid]["rows"].items():
            tables[name].extend(items)
    con = duckdb.connect()
    con.execute(f"SET temp_directory = '{(out / 'tmp').as_posix()}'")
    con.execute(f"SET memory_limit = '{args.memory_gib}GB'")

    files = {}
    for name, rows in tables.items():
        table = pa.Table.from_pylist(rows, schema=CATALOGUE_SCHEMAS[name])
        con.register("catalogue_table", table)
        path = out / "catalogue" / f"{name}.parquet"
        files[path.relative_to(out).as_posix()] = {"rows": len(rows),
                                                   **copy_parquet(con, drive, f"SELECT * FROM catalogue_table ORDER BY {CATALOGUE_ORDER[name]}", path)}
        con.unregister("catalogue_table")
    con.close()
    shutil.rmtree(out / "tmp")

    manifest = {
        "build_id": args.build_id, "built_at_utc": utc_now(), "family": family, "capture_dir": str(capture),
        "capture_id": capture.name, "language": "en",
        "inventory": {"path": str(inventory_path), "sha256": sha256_file(inventory_path), "records": len(records)},
        "tool": {"script": script, "python": platform.python_version(), "duckdb": duckdb.__version__,
                 "pyarrow": pa.__version__},
        "catalogue": files, "tables": reports,
        "summary": Counter(r["status"] for r in reports.values()),
    }
    drive.atomic_json(out / "build_manifest.json", manifest)
    print(f"Build {args.build_id}: {dict(manifest['summary'])} -> {out}")
    return 0 if manifest["summary"].get("error", 0) == 0 else 2


def main(description=__doc__, **run_options):
    parser = argparse.ArgumentParser(description=description, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--capture", required=True, help="capture directory holding inventory.json, zips/, manifests/")
    parser.add_argument("--out", required=True, help="derived-data root; the build is written to <out>/<build-id>/")
    parser.add_argument("--mount-uuid", required=True, help="filesystem UUID that must back both --capture and --out")
    parser.add_argument("--pids", help="comma-separated PIDs to build")
    parser.add_argument("--pids-file", help="file with one PID per line (alternative to --pids)")
    parser.add_argument("--build-id", default=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--reserve-gib", type=float, default=150, help="stop if SSD free space would fall below this")
    parser.add_argument("--memory-gib", type=int, default=8, help="total DuckDB memory limit, split across --jobs; sorts spill to <out>/<build-id>/tmp")
    parser.add_argument("--jobs", type=int, default=1, help="tables built in parallel (separate processes)")
    parser.add_argument("--resume", action="store_true", help="continue an existing build id; keeps its finished ok tables")
    args = parser.parse_args()
    if not args.pids and not args.pids_file:
        parser.error("--pids or --pids-file is required")
    listed = [p for p in (args.pids or "").split(",") if p] + \
        ([p.strip() for p in Path(args.pids_file).read_text().split() if p.strip()] if args.pids_file else [])
    args.pids = list(dict.fromkeys(listed))  # a PID listed twice would be built twice and duplicate its catalogue rows
    try:
        return run(args, **run_options)
    except StorageStop as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
