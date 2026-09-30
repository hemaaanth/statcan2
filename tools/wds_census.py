#!/usr/bin/env python3
"""Build Census-layout WDS tables (PIDs 98…) into the same query files as wds_build.py.

Census observation CSVs are sideways: the last dimension is spread across value columns
"<dimension name>:<member name>[<member id>]", each followed by a "Symbol" or "Symbols" column.
This reader unpivots each value column into one row of the ordinary obs schema. See BUILD.md, "Census layout".

Example:
  .venv/bin/python -B tools/wds_census.py \\
      --capture /run/media/hemanth/Kingston/statcan-wds/baseline \\
      --out /run/media/hemanth/Kingston/statcan-derived \\
      --mount-uuid 72D0-2131 --pids 98100034,98100001 --jobs 1
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import multiprocessing
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
import pyarrow.compute as pc
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wds_build as wb  # noqa: E402
from wds_build import (BATCH_ROWS, CATALOGUE_ORDER, CATALOGUE_SCHEMAS, MAX_DIMS, META_TABLES, NUMBER,  # noqa: E402
                       OBS_SCHEMA, TableError, copy_parquet, inventory_tables, parse_int, sha256_file)
from wds_download import Drive, StorageStop, utc_now  # noqa: E402

FAMILY = "census_2021"
SUBJECT_HEADER = re.compile(r'^"?Subject Code"?,', re.M)
VALUE_HEADER = re.compile(r"(.*)\[([0-9]+)\]")
SYMBOL_COLUMNS = {"Symbol", "Symbols"}
# WDS getCodeSets "symbol" representations. Every other code in a Census Symbol cell is a status code.
SYMBOL_CODES = {"p", "r"}


def read_metadata(archive, pid):
    """wds_build.read_metadata, but a missing Subject block is allowed: none of the 525 Census files has one."""
    text = archive.read(f"{pid}_MetaData.csv").decode("utf-8-sig")
    if not SUBJECT_HEADER.search(text):
        text += '\n"Subject Code","Subject Name"\n'
    blocks = wb.split_blocks(text)
    meta = {name: [] for name in wb.OPTIONAL_BLOCKS}
    for name, lines in blocks.items():
        meta[name] = wb.loose_rows(name, lines) if name in wb.LOOSE_BLOCKS else wb.block_rows(name, lines)
    if len(meta["cube"]) != 1:
        raise TableError(f"cube block has {len(meta['cube'])} rows")
    meta["cube"] = meta["cube"][0]
    meta["note_block_raw"] = "\n".join(blocks["note"])
    return meta


def value_member_ids(header, start, dim, members):
    """Last-dimension member IDs from the value column headers, checked against the member table."""
    if (len(header) - start) % 2 or len(header) == start:
        raise TableError(f"expected value/Symbol column pairs after Coordinate, got {header[start:]!r}")
    ids = []
    for j in range(start, len(header), 2):
        match = VALUE_HEADER.fullmatch(header[j])
        if not match:
            raise TableError(f"value column {header[j]!r} has no [member id]")
        member_id = int(match.group(2))
        member = members.get(member_id)
        text = match.group(1)
        if not text.startswith(dim["dimension_name"] + ":") or member is None:
            raise TableError(f"value column {header[j]!r} does not name a member of {dim['dimension_name']!r}")
        name = member["member_name"].strip()
        # 98100017 appends the member's note reference: "..., count (9) [3]".
        allowed = {name, f"{name} ({member['member_notes']})"} if member["member_notes"] else {name}
        if text[len(dim["dimension_name"]) + 1:].strip() not in allowed:
            raise TableError(f"value column {header[j]!r}: member {member_id} is {member['member_name']!r}")
        if header[j + 1] not in SYMBOL_COLUMNS:
            raise TableError(f"value column {header[j]!r} is followed by {header[j + 1]!r}, expected Symbol or Symbols")
        ids.append(member_id)
    if ids != sorted(set(ids)):
        raise TableError(f"value column member ids are not strictly ascending: {ids}")
    return ids


def census_batches(archive, pid, meta, report):
    """Yield Arrow batches in OBS_SCHEMA, one row per (CSV row, value column), already in OBS_ORDER.

    Rows must arrive in strictly ascending coordinate order and value columns in ascending member ID (true in every
    file checked), so the output needs no sort. Stops at the first hard error and records it in report["errors"];
    the caller discards the output.
    """
    dims = sorted(meta["dimension"], key=lambda d: d["dimension_id"])
    n = len(dims)
    coord = 1 + n  # REF_DATE, GEO, DGUID, labels of dimensions 2..N-1, Coordinate
    expected = ["REF_DATE", "GEO", "DGUID"] + [d["dimension_name"] for d in dims[1:-1]] + ["Coordinate"]
    # Row labels are the member name, or the name plus its classification code ("Logging [1133]").
    members = {(m["dimension_id"], m["member_id"]): (m["member_name"], f"{m['member_name']} {m['classification_code']}")
               for m in meta["member"]}
    dim_ids = [d["dimension_id"] for d in dims]
    label_cols = [1] + list(range(3, coord))
    legend = {s["symbol"] for s in meta["symbol"]}
    status, symbol, blank_by_status = Counter(), Counter(), Counter()
    unseen = set()
    codes = {}  # raw Symbol cell -> (status, symbol)
    mangled = rows = blank_tail = 0
    columns = {name: [] for name in ("row_index", "ref_date", "dguid", "coordinate", "value", "value_num",
                                     "status", "symbol", *(f"member_id_{k}" for k in range(1, n + 1)))}

    def flush():
        size = len(columns["row_index"])
        empty, null = pa.array([""] * size, pa.string()), pa.nulls(size, pa.int32())
        data = {"pid": pa.array([pid] * size, pa.string()), "uom": empty, "uom_id": null, "scalar_factor": empty,
                "scalar_id": null, "vector": empty, "terminated": empty, "decimals": null,
                **{f"member_id_{k}": null for k in range(n + 1, MAX_DIMS + 1)}}
        batch = pa.RecordBatch.from_pydict({name: data[name] if name in data else columns[name] for name in OBS_SCHEMA.names},
                                           schema=OBS_SCHEMA)
        for values in columns.values():
            values.clear()
        return batch

    def split_code(raw):
        """Split "r,E" into status "E" and symbol "r". Unknown codes are recorded, not fatal, as in wds_build."""
        parts = raw.split(",") if raw else []
        unseen.update(p for p in parts if p not in legend)
        codes[raw] = (",".join(p for p in parts if p not in SYMBOL_CODES), ",".join(p for p in parts if p in SYMBOL_CODES))
        return codes[raw]

    try:
        if n < 2:
            raise TableError(f"Census layout needs at least 2 dimensions, metadata has {n}")
        with archive.open(f"{pid}.csv") as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            header = next(reader, None) or []
            if header[:coord + 1] != expected:
                raise TableError(f"header mismatch: got {header[:coord + 1]!r}, expected {expected!r}")
            last_dim = dims[-1]
            last_members = {m["member_id"]: m for m in meta["member"] if m["dimension_id"] == last_dim["dimension_id"]}
            last_ids = value_member_ids(header, coord + 1, last_dim, last_members)
            suffixes = [f".{i}" for i in last_ids]
            width, cells, previous = len(header), len(last_ids), []
            for index, row in enumerate(reader, 1):
                if not row:
                    blank_tail += 1  # every Census file ends with two blank lines
                    continue
                if blank_tail:
                    raise TableError(f"row {index}: data after a blank line")
                if len(row) != width:
                    raise TableError(f"row {index}: width {len(row)}, expected {width}")
                parts = row[coord].split(".")
                if len(parts) != n - 1:
                    raise TableError(f"row {index}: coordinate {row[coord]!r} has {len(parts)} parts, expected {n - 1}")
                ids = [parse_int(p, "coordinate part", index) for p in parts]
                if ids <= previous:
                    # ponytail: no sort fallback; add ORDER BY {OBS_ORDER} in build_table if a file ever fails this.
                    raise TableError(f"row {index}: coordinate {row[coord]!r} is not after the previous row's")
                previous = ids
                for k, col in enumerate(label_cols):
                    names = members.get((dim_ids[k], ids[k]))
                    if names is None or row[col] not in names:
                        # Some observation files drop or misplace quotes inside labels, and some end a label with a
                        # newline inside the quotes (98100314); the member table is authoritative.
                        if names is None or row[col].replace('"', "").strip() != names[0].replace('"', "").strip():
                            raise TableError(f"row {index}: dimension {dim_ids[k]} member {ids[k]} is "
                                             f"{names and names[0]!r}, row label {row[col]!r}")
                        mangled += 1
                values = row[coord + 1::2]
                pairs = [codes.get(c) or split_code(c) for c in row[coord + 2::2]]
                value_nums = []
                for value, (st, _) in zip(values, pairs):
                    if value == "":
                        value_nums.append(None)
                        blank_by_status[st] += 1
                    elif NUMBER.fullmatch(value):
                        value_nums.append(float(value))
                    else:
                        raise TableError(f"row {index}: VALUE {value!r} is not numeric")
                c = columns
                c["row_index"].extend([index] * cells)
                c["ref_date"].extend([row[0]] * cells)
                c["dguid"].extend([row[2]] * cells)
                c["coordinate"].extend([row[coord] + s for s in suffixes])
                c["value"].extend(values)
                c["value_num"].extend(value_nums)
                c["status"].extend(st for st, _ in pairs)
                c["symbol"].extend(sy for _, sy in pairs)
                status.update(st for st, _ in pairs)
                symbol.update(sy for _, sy in pairs)
                for k in range(n - 1):
                    c[f"member_id_{k + 1}"].extend([ids[k]] * cells)
                c[f"member_id_{n}"].extend(last_ids)
                rows += cells
                if len(c["row_index"]) >= BATCH_ROWS:
                    yield flush()
            if columns["row_index"]:
                yield flush()
    except TableError as exc:
        report["errors"].append(str(exc))
    except (UnicodeDecodeError, csv.Error) as exc:
        report["errors"].append(f"after {rows} rows: {exc}")
    if mangled:
        report["warnings"].append(f"{mangled} row labels matched the member name only after removing double quotes "
                                  "and surrounding whitespace")
    report.update(row_count=rows, dims=n, status_counts=dict(status), symbol_counts=dict(symbol),
                  terminated_counts={"": rows} if rows else {}, blank_value_count=sum(blank_by_status.values()),
                  blank_value_by_status=dict(blank_by_status), codes_not_in_legend=sorted(unseen))


def rows_not_ascending(path, n):
    """Rows whose member_id_1..n tuple is not strictly above the previous row's (a duplicate or a sort break)."""
    bad, last = 0, None
    for batch in pq.ParquetFile(path).iter_batches(batch_size=1 << 20, columns=[f"member_id_{k}" for k in range(1, n + 1)]):
        cols = batch.columns
        if last is not None:
            cols = [pa.concat_arrays([pa.array([v], pa.int32()), c]) for v, c in zip(last, cols)]
        last = [c[-1].as_py() for c in cols]
        above = pa.repeat(False, len(cols[0]) - 1)  # lexicographic compare, last member first
        for c in reversed(cols):
            cur, prev = c[1:], c[:-1]
            above = pc.or_(pc.greater(cur, prev), pc.and_(pc.equal(cur, prev), above))
        bad += len(above) - pc.sum(above).as_py() if len(above) else 0
    return bad


def build_table(con, drive, capture, pid, out):
    """wds_build.build_table with the Census reader, no sort, and an order-based duplicate check.

    VECTOR does not exist in Census files, so duplicate_vector_ref_date is null.
    """
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
            reader = pa.RecordBatchReader.from_batches(OBS_SCHEMA, census_batches(archive, pid, meta, report))
            con.register("obs_stream", reader)
            # census_batches yields rows already in OBS_ORDER and DuckDB preserves insertion order, so no sort.
            # Without a sort, a multi-threaded COPY cuts row groups at timing-dependent points (98100456 differed
            # between two runs); one thread makes the bytes repeatable. Python parsing is the bottleneck anyway.
            con.execute("SET threads = 1")
            output = copy_parquet(con, drive, "SELECT * FROM obs_stream", path)
            con.unregister("obs_stream")
            if report["errors"]:
                return report, tables
            checks = con.execute(f"SELECT count(*), min(ref_date), max(ref_date) FROM read_parquet('{path.as_posix()}')").fetchone()
            if checks[0] != report["row_count"]:
                raise TableError(f"parquet has {checks[0]} rows, reader produced {report['row_count']}")
            # Duplicate check after writing: every row's member IDs strictly above the previous row's means sorted and
            # no repeated (coordinate, ref_date). A GROUP BY coordinate took 343 s of 456 s on 98100456.
            not_ascending = rows_not_ascending(path, report["dims"])
            if not_ascending:
                raise TableError(f"{not_ascending} rows in the written file are not above the previous row's member IDs")
            report.update(ref_date_min=checks[1], ref_date_max=checks[2], duplicate_coordinate_ref_date=0,
                          duplicate_vector_ref_date=None, parquet={"path": path.relative_to(out).as_posix(), **output})
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


def _worker_build(pid):
    w = wb._worker  # filled by wb._worker_init in each pool process
    try:
        return pid, *build_table(w["con"], w["drive"], w["capture"], pid, w["out"])
    except StorageStop as exc:
        return pid, {"status": "error", "errors": [str(exc)], "warnings": [], "seconds": 0}, {}


def run(args):
    """wds_build.run with the Census worker and "family" in the manifest."""
    capture = Path(args.capture)
    Drive(capture, args.mount_uuid, reserve=0)
    out = Path(args.out) / args.build_id
    drive = Drive(out, args.mount_uuid, int(args.reserve_gib * 1024**3))
    if out.exists():
        raise StorageStop(f"build directory exists: {out}")
    inventory_path = capture / "inventory.json"
    records = json.loads(inventory_path.read_text())
    tables = inventory_tables(records)
    tables.update({name: [] for name in ("cube_meta", *META_TABLES)})
    known = {row["pid"] for row in tables["cube"]}
    unknown = [pid for pid in args.pids if pid not in known]
    if unknown:
        raise StorageStop(f"PIDs not in the capture inventory: {unknown}")
    not_census = [pid for pid in args.pids if not pid.startswith("98")]
    if not_census:
        raise StorageStop(f"not Census PIDs (98…): {not_census}")

    for sub in ("catalogue", "obs", "tmp"):
        drive.mkdir(out / sub)
    zip_bytes = {pid: (capture / "zips" / f"{pid}-en.zip").stat().st_size if (capture / "zips" / f"{pid}-en.zip").exists() else 0
                 for pid in args.pids}
    order = sorted(args.pids, key=lambda p: -zip_bytes[p])
    reports = {}
    memory = max(1, args.memory_gib // args.jobs)
    with multiprocessing.get_context("forkserver").Pool(args.jobs, wb._worker_init,
                                                        (capture, out, args.mount_uuid, drive.reserve, memory)) as pool:
        for i, (pid, report, rows) in enumerate(pool.imap_unordered(_worker_build, order), 1):
            reports[pid] = report
            for name, items in rows.items():
                tables[name].extend(items)
            print(f"[{i}/{len(order)}] {pid} {report['status']} rows={report.get('row_count')} {report['seconds']}s "
                  f"{'; '.join(report['errors'])}", flush=True)
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
        "build_id": args.build_id, "built_at_utc": utc_now(), "family": FAMILY, "capture_dir": str(capture),
        "capture_id": capture.name, "language": "en",
        "inventory": {"path": str(inventory_path), "sha256": sha256_file(inventory_path), "records": len(records)},
        "tool": {"script": "tools/wds_census.py", "python": platform.python_version(), "duckdb": duckdb.__version__,
                 "pyarrow": pa.__version__},
        "catalogue": files, "tables": reports,
        "summary": Counter(r["status"] for r in reports.values()),
    }
    drive.atomic_json(out / "build_manifest.json", manifest)
    print(f"Build {args.build_id}: {dict(manifest['summary'])} -> {out}")
    return 0 if manifest["summary"].get("error", 0) == 0 else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--capture", required=True, help="capture directory holding inventory.json, zips/, manifests/")
    parser.add_argument("--out", required=True, help="derived-data root; the build is written to <out>/<build-id>/")
    parser.add_argument("--mount-uuid", required=True, help="filesystem UUID that must back both --capture and --out")
    parser.add_argument("--pids", help="comma-separated PIDs to build")
    parser.add_argument("--pids-file", help="file with one PID per line (alternative to --pids)")
    parser.add_argument("--build-id", default=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--reserve-gib", type=float, default=150, help="stop if SSD free space would fall below this")
    parser.add_argument("--memory-gib", type=int, default=8, help="total DuckDB memory limit, split across --jobs; sorts spill to <out>/<build-id>/tmp")
    parser.add_argument("--jobs", type=int, default=1, help="tables built in parallel (separate processes)")
    args = parser.parse_args()
    if not args.pids and not args.pids_file:
        parser.error("--pids or --pids-file is required")
    args.pids = [p for p in (args.pids or "").split(",") if p] + \
        ([p.strip() for p in Path(args.pids_file).read_text().split() if p.strip()] if args.pids_file else [])
    try:
        return run(args)
    except StorageStop as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
