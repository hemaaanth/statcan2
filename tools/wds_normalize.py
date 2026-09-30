#!/usr/bin/env python3
"""Build the Normalized layer (SCHEMA.md) from a Clean build and the WDS code sets.

Inputs are read-only. Output goes to <clean>/normalized/<build-id>/ on the UUID-checked SSD:
  <code set>.parquet       frequency, subject, survey, uom, scalar, status, symbol,
                           classification_type, terminated (from codeSets.json)
  unit_family.parquet      unit codes seen in obs, grouped by data/ref/unit_family.csv
  place.parquet            places seen in the data (DGUIDs and mapped codes)
  member_place.parquet     geography member (dimension 1) -> place, with the rule that matched
  series.parquet           one row per (pid, vector)
  table.parquet            one row per PID in the Clean cube table
  normalize_manifest.json  inputs and their hashes, per-file rows/bytes/SHA-256, stats, warnings

Example:
  .venv/bin/python -B tools/wds_normalize.py \\
      --clean /run/media/hemanth/Kingston/statcan-derived/v0 \\
      --codesets /run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json \\
      --mount-uuid 72D0-2131 --build-id n1
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import platform
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import duckdb
import pyarrow as pa

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wds_build import MAX_DIMS, copy_parquet, sha256_file  # noqa: E402
from wds_download import Drive, StorageStop, utc_now  # noqa: E402

REF = Path(__file__).resolve().parent.parent / "data" / "ref"
RESERVE = 100 * 1024**3
UNIT_FAMILIES = {"percent", "count", "currency", "index", "mass", "time", "volume", "rate", "other"}

# Output name: (codeSets.json key, code field, English field, French field, representation field or None).
CODE_SETS = {
    "frequency": ("frequency", "frequencyCode", "frequencyDescEn", "frequencyDescFr", None),
    "subject": ("subject", "subjectCode", "subjectEn", "subjectFr", None),
    "survey": ("survey", "surveyCode", "surveyEn", "surveyFr", None),
    "uom": ("uom", "memberUomCode", "memberUomEn", "memberUomFr", None),
    "scalar": ("scalar", "scalarFactorCode", "scalarFactorDescEn", "scalarFactorDescFr", None),
    "status": ("status", "statusCode", "statusDescEn", "statusDescFr", "statusRepresentationEn"),
    "symbol": ("symbol", "symbolCode", "symbolDescEn", "symbolDescFr", "symbolRepresentationEn"),
    "classification_type": ("classificationType", "classificationTypeCode", "classificationTypeEn",
                            "classificationTypeFr", None),
    "terminated": ("terminated", "codeId", "codeTextEn", "codeTextFr", "displayCodeEn"),
}

# ------------------------------------------------------------------ periods

WEEKLY = {2}
QUARTERLY = {9, 19}  # Quarterly, Occasional Quarterly
SEMI_ANNUAL = {11}
REF_DATE = re.compile(r"(\d{4})(?:-(\d{2})(?:-(\d{2}))?|/(\d{4}))?")


def _month_end(year, month, months):
    """Last day of the span of `months` months that starts on the first of year-month."""
    y, m = divmod(month - 1 + months, 12)
    return dt.date(year + y, m + 1, 1) - dt.timedelta(days=1)


def period(ref_date, frequency_code):
    """Return (period_start, period_end, period_kind) for one REF_DATE text and the table's frequency code.

    The text gives the start. The frequency only stretches the end where the text shape is ambiguous:
    YYYY-MM is a month unless the table is quarterly or semi-annual; YYYY-MM-DD is a day unless the
    table is weekly. YYYY is a calendar year for every frequency (an "every 5 years" table still
    reports one reference year). YYYY/YYYY one year apart is a fiscal year, April 1 to March 31
    (to verify: some tables use July 1 to June 30); a wider span is calendar years first to last.
    Anything else gives (None, None, "other").
    """
    match = REF_DATE.fullmatch(ref_date or "")
    if match:
        year, month, day, year2 = match.groups()
        try:
            y = int(year)
            if year2:
                y2 = int(year2)
                if y2 == y + 1:
                    return dt.date(y, 4, 1), dt.date(y2, 3, 31), "fiscal_year"
                if y2 > y + 1:
                    return dt.date(y, 1, 1), dt.date(y2, 12, 31), "multi_year"
            elif day:
                start = dt.date(y, int(month), int(day))
                if frequency_code in WEEKLY:
                    return start, start + dt.timedelta(days=6), "week"
                return start, start, "day"
            elif month:
                start = dt.date(y, int(month), 1)
                if frequency_code in QUARTERLY:
                    return start, _month_end(y, start.month, 3), "quarter"
                if frequency_code in SEMI_ANNUAL:
                    return start, _month_end(y, start.month, 6), "half_year"
                return start, _month_end(y, start.month, 1), "month"
            else:
                return dt.date(y, 1, 1), dt.date(y, 12, 31), "year"
        except ValueError:  # month 13, day 31 in a short month, year 0000
            pass
    return None, None, "other"


def ref_date_shape(ref_date):
    return re.sub(r"[0-9]", "9", ref_date or "")


# ------------------------------------------------------------------- places

DGUID = re.compile(r"(\d{4})([AS])(\d{4})(\S+)")
BRACKETED = re.compile(r"\[([^\]]*)\]")


def parse_dguid(text):
    """Split a DGUID into vintage, geo_type, schema, geo_code. None when it is not well-formed."""
    match = DGUID.fullmatch(text or "")
    if not match:
        return None
    vintage, geo_type, schema, geo_code = match.groups()
    return {"vintage": int(vintage), "geo_type": geo_type, "schema": schema, "geo_code": geo_code}


def place_level(schema):
    # Other schemas stay "schema:<code>" until the geographic attribute file (92-151-X) is captured.
    return {"0000": "country", "0002": "province"}.get(schema, f"schema:{schema}")


def _most_common(counter):
    return min(counter.items(), key=lambda item: (-item[1], item[0]))[0]


def map_places(members, aliases):
    """Map geography members to places with the four rules of SCHEMA.md, in order.

    members: dicts with pid, member_id, member_name, classification_code, parent_member_id, and
    dguids (the distinct DGUID texts on the member's observation rows; empty when it has none).
    aliases: {classification code text such as "[35]": (schema, geo_code)} from place_alias.csv.
    Returns (place rows, member_place rows, number of places whose parent candidates disagree).
    """
    places = {}
    mapped = {}  # (pid, member_id) -> [place_id, match, notes]

    def code_place(schema, geo_code):
        place_id = f"code:{schema}:{geo_code}"
        places.setdefault(place_id, {"dguid": None, "vintage": None, "geo_type": None,
                                     "schema": schema, "geo_code": geo_code})
        return place_id

    for m in members:
        notes = []
        dguids = sorted(m["dguids"])
        code = m["classification_code"] or ""
        parsed = None
        if not dguids:
            notes.append("member has no observations")
        elif len(dguids) > 1:
            notes.append("several DGUIDs on observations: " + ", ".join(dguids))
        elif not dguids[0]:
            notes.append("no DGUID on observations")
        else:
            parsed = parse_dguid(dguids[0])
            bracket = BRACKETED.fullmatch(code)
            if parsed is None:
                notes.append(f"DGUID {dguids[0]!r} is not well-formed")
            elif bracket and bracket.group(1) != parsed["geo_code"]:
                notes.append(f"DGUID {dguids[0]} geo_code {parsed['geo_code']} disagrees with classification code {code}")
                parsed = None
        key = (m["pid"], m["member_id"])
        if parsed:  # rule 1
            places.setdefault(dguids[0], {"dguid": dguids[0], **parsed})
            mapped[key] = [dguids[0], "dguid", notes]
        elif code in aliases:  # rule 2
            mapped[key] = [code_place(*aliases[code]), "code", notes]
        else:
            notes.append(f"classification code {code} not in place_alias.csv" if code else "no classification code")
            mapped[key] = [None, None, notes]

    # Rule 3: exact name of a country or province place already found by rules 1 and 2.
    names = defaultdict(set)
    for m in members:
        place_id, match, _ = mapped[(m["pid"], m["member_id"])]
        if match:
            p = places[place_id]
            if place_level(p["schema"]) in ("country", "province"):
                names[m["member_name"]].add((p["schema"], p["geo_code"]))
    for m in members:
        entry = mapped[(m["pid"], m["member_id"])]
        if entry[1]:
            continue
        found = names.get(m["member_name"], set())
        if len(found) == 1:
            entry[0], entry[1] = code_place(*next(iter(found))), "name"
        else:  # rule 4
            entry[2].append(f"name matches {len(found)} country or province places" if found
                            else "name matches no country or province place")
            entry[1] = "none"

    name_counts = defaultdict(Counter)
    parent_counts = defaultdict(Counter)
    for m in members:
        place_id = mapped[(m["pid"], m["member_id"])][0]
        if place_id is None:
            continue
        name_counts[place_id][m["member_name"]] += 1
        parent = mapped.get((m["pid"], m["parent_member_id"]), [None])[0] if m["parent_member_id"] is not None else None
        if parent and parent != place_id:
            parent_counts[place_id][parent] += 1

    place_rows = [{"place_id": place_id, **p, "name_en": _most_common(name_counts[place_id]),
                   "level": place_level(p["schema"]),
                   "parent_place_id": _most_common(parent_counts[place_id]) if parent_counts[place_id] else None}
                  for place_id, p in sorted(places.items())]
    member_rows = [{"pid": pid, "dimension_id": 1, "member_id": member_id, "place_id": place_id, "match": match,
                    "note": "; ".join(notes) or None}
                   for (pid, member_id), (place_id, match, notes) in sorted(mapped.items())]
    return place_rows, member_rows, sum(1 for c in parent_counts.values() if len(c) > 1)


# ------------------------------------------------------------ reference CSVs

def read_csv(path, header):
    with open(path, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    if not rows or list(rows[0]) != header:
        raise ValueError(f"{path}: header must be {','.join(header)}")
    return rows


def read_unit_families(path):
    families = {}
    for r in read_csv(path, ["uom_code", "family", "symbol", "base_year", "note"]):
        code = int(r["uom_code"])
        if code in families or r["family"] not in UNIT_FAMILIES:
            raise ValueError(f"{path}: duplicate code or unknown family in row {r}")
        families[code] = {"family": r["family"], "symbol": r["symbol"] or None,
                          "base_year": int(r["base_year"]) if r["base_year"] else None, "note": r["note"] or None}
    return families


def read_aliases(path):
    aliases = {}
    for r in read_csv(path, ["classification_code", "schema", "geo_code", "note"]):
        if r["classification_code"] in aliases or not re.fullmatch(r"\d{4}", r["schema"]):
            raise ValueError(f"{path}: duplicate code or bad schema in row {r}")
        aliases[r["classification_code"]] = (r["schema"], r["geo_code"])
    return aliases


def code_set_table(records, spec):
    _, code, en, fr, representation = spec
    kinds = {type(r[code]) for r in records}
    if kinds not in ({int}, {str}):
        raise ValueError(f"code field {code} has types {kinds}")
    code_type = pa.int32() if kinds == {int} else pa.string()
    schema = pa.schema([("code", code_type), ("en", pa.string()), ("fr", pa.string()), ("representation", pa.string())])
    return pa.Table.from_pylist([{"code": r[code], "en": r[en], "fr": r[fr],
                                  "representation": r[representation] if representation else None} for r in records],
                                schema=schema)


# -------------------------------------------------------------------- build

MEMBER_IDS = [f"member_id_{k}" for k in range(1, MAX_DIMS + 1)]
PERIOD_SCHEMA = pa.schema([("ref_date", pa.string()), ("period_start", pa.date32()), ("period_end", pa.date32()),
                           ("period_kind", pa.string())])
PLACE_SCHEMA = pa.schema([("place_id", pa.string()), ("dguid", pa.string()), ("vintage", pa.int32()),
                          ("geo_type", pa.string()), ("schema", pa.string()), ("geo_code", pa.string()),
                          ("name_en", pa.string()), ("level", pa.string()), ("parent_place_id", pa.string())])
MEMBER_PLACE_SCHEMA = pa.schema([("pid", pa.string()), ("dimension_id", pa.int32()), ("member_id", pa.int32()),
                                 ("place_id", pa.string()), ("match", pa.string()), ("note", pa.string())])
UNIT_FAMILY_SCHEMA = pa.schema([("uom_code", pa.int32()), ("family", pa.string()), ("symbol", pa.string()),
                                ("base_year", pa.int32()), ("note", pa.string())])

# One pass over one Clean obs file. min/max pairs let the build check that a series never changes
# unit, scale, decimals, terminated flag, DGUID, or coordinate.
SERIES_PART_SQL = """
SELECT o.pid, o.vector, min(o.coordinate) AS coordinate, max(o.coordinate) AS coordinate_max,
       {member_ids},
       min(o.uom_id) AS uom_code, max(o.uom_id) AS uom_max, min(o.scalar_id) AS scalar_code, max(o.scalar_id) AS scalar_max,
       min(o.decimals) AS decimals, max(o.decimals) AS decimals_max,
       min(o.terminated) AS terminated_min, max(o.terminated) AS terminated_max,
       min(o.dguid) AS dguid_min, max(o.dguid) AS dguid_max,
       min(p.period_kind) AS kind_min, max(p.period_kind) AS kind_max,
       min(p.period_start) AS period_min, max(p.period_end) AS period_max,
       count(*) AS n_obs, count(*) FILTER (WHERE o.value <> '') AS n_published,
       arg_max(o.status, o.ref_date) AS last_status
FROM read_parquet('{obs}') o JOIN periods p USING (ref_date)
GROUP BY o.pid, o.vector
"""


def sql_path(path):
    text = Path(path).as_posix()
    if "'" in text:
        raise ValueError(f"path contains a quote: {text}")
    return text


def run(args):
    started = time.monotonic()
    clean = Path(args.clean).absolute()
    codesets = Path(args.codesets).absolute()
    clean_drive = Drive(clean, args.mount_uuid, reserve=0)
    Drive(codesets, args.mount_uuid, reserve=0)
    out = clean / "normalized" / args.build_id
    if out.exists():
        raise StorageStop(f"normalized build directory exists: {out}")
    drive = Drive(out, args.mount_uuid, RESERVE)

    expected = (codesets.parent / (codesets.name + ".sha256")).read_text().split()[0]
    codesets_sha = sha256_file(codesets)
    if codesets_sha != expected:
        raise ValueError(f"{codesets}: sha256 {codesets_sha} differs from .sha256 file {expected}")
    clean_manifest_path = clean / "build_manifest.json"
    clean_manifest = json.loads(clean_manifest_path.read_text())
    built = sorted(pid for pid, r in clean_manifest["tables"].items() if r["status"] == "ok")
    missing = [pid for pid in built if not (clean / "obs" / f"{pid}.parquet").exists()]
    if missing:
        raise ValueError(f"Clean manifest says ok but obs file is missing: {missing[:10]}")
    unit_families = read_unit_families(REF / "unit_family.csv")
    aliases = read_aliases(REF / "place_alias.csv")
    code_sets = json.loads(codesets.read_text())["object"]

    tmp = out / "tmp"
    drive.mkdir(tmp / "series")
    con = duckdb.connect(sql_path(tmp / "work.duckdb"))
    con.execute(f"SET temp_directory = '{sql_path(tmp / 'spill')}'")
    con.execute(f"SET memory_limit = '{args.memory_gib}GB'")
    con.execute(f"SET threads = {args.threads}")
    con.execute("SET enable_progress_bar = false")
    warnings = []
    files = {}

    def write(name, sql):
        """Stage the sorted result with all threads, then write it with one thread. Parallel Parquet
        writers cut row groups at varying rows (seen on series.parquet), which changes the bytes."""
        con.execute(f"CREATE OR REPLACE TABLE staged AS {sql}")
        rows = con.execute("SELECT count(*) FROM staged").fetchone()[0]
        con.execute("SET threads = 1")
        try:
            files[f"{name}.parquet"] = {"rows": rows, **copy_parquet(con, drive, "SELECT * FROM staged", out / f"{name}.parquet")}
        finally:
            con.execute(f"SET threads = {args.threads}")
            con.execute("DROP TABLE staged")
        print(f"wrote {name}.parquet rows={rows}", flush=True)

    # Clean catalogue, exact duplicate rows removed (v0 holds 10100139's metadata twice).
    clean_drive.check()
    for name in ("cube", "inventory_dimension", "dimension", "member", "note"):
        path = sql_path(clean / "catalogue" / f"{name}.parquet")
        con.execute(f"CREATE TABLE {name} AS SELECT DISTINCT * FROM read_parquet('{path}')")
        total = con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()[0]
        kept = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
        if total != kept:
            warnings.append({"type": "clean_catalogue_duplicate_rows", "table": name, "rows_dropped": total - kept})
    duplicate_members = con.execute("SELECT count(*) FROM (SELECT 1 FROM member GROUP BY pid, dimension_id, member_id "
                                    "HAVING count(*) > 1)").fetchone()[0]
    if duplicate_members:
        raise ValueError(f"Clean member table has {duplicate_members} member keys with differing rows")

    # Code sets.
    for name, spec in CODE_SETS.items():
        table = code_set_table(code_sets[spec[0]], spec)
        con.register("code_set", table)
        con.execute(f"CREATE TABLE cs_{name} AS SELECT * FROM code_set")
        con.unregister("code_set")
        write(name, f"SELECT * FROM cs_{name} ORDER BY code")

    # Series pass: one Clean obs file at a time.
    frequency = dict(con.execute("SELECT pid, frequency_code FROM cube").fetchall())
    for i, pid in enumerate(built, 1):
        clean_drive.check()
        obs = sql_path(clean / "obs" / f"{pid}.parquet")
        ref_dates = [r[0] for r in con.execute(f"SELECT DISTINCT ref_date FROM read_parquet('{obs}') ORDER BY 1").fetchall()]
        periods = [period(r, frequency.get(pid)) for r in ref_dates]
        unknown = Counter(ref_date_shape(r) for r, p in zip(ref_dates, periods) if p[0] is None)
        if unknown:
            warnings.append({"type": "unknown_ref_date_shape", "pid": pid, "shapes": dict(unknown)})
        con.register("periods", pa.Table.from_arrays(
            [pa.array(ref_dates, pa.string())] + [pa.array([p[k] for p in periods], PERIOD_SCHEMA.field(k + 1).type)
                                                  for k in range(3)], schema=PERIOD_SCHEMA))
        part = sql_path(tmp / "series" / f"{pid}.parquet")
        drive.check()
        con.execute(f"COPY ({SERIES_PART_SQL.format(member_ids=', '.join(f'min(o.{c}) AS {c}' for c in MEMBER_IDS), obs=obs)}) "
                    f"TO '{part}' (FORMAT PARQUET)")
        con.unregister("periods")
        print(f"[{i}/{len(built)}] {pid} series pass", flush=True)
    parts = f"read_parquet('{sql_path(tmp / 'series')}/*.parquet')"
    con.execute(f"CREATE TABLE series_part AS SELECT * FROM {parts}")

    checks = ["coordinate", "uom", "scalar", "decimals", "terminated", "dguid", "kind"]
    lows = {"coordinate": "coordinate", "uom": "uom_code", "scalar": "scalar_code", "decimals": "decimals"}
    for pid, *counts in con.execute(
            "SELECT pid, " + ", ".join(f"count(*) FILTER (WHERE {lows.get(c, c + '_min')} IS DISTINCT FROM {c}_max)"
                                       for c in checks) + " FROM series_part GROUP BY pid ORDER BY pid").fetchall():
        varying = {c: n for c, n in zip(checks, counts) if n}
        if varying:
            warnings.append({"type": "series_values_vary", "pid": pid, "series_by_field": varying})

    # Unit families for the codes present in obs.
    present = [r[0] for r in con.execute("SELECT DISTINCT uom_code FROM series_part UNION SELECT DISTINCT uom_max "
                                         "FROM series_part ORDER BY 1").fetchall()]
    unknown_units = [c for c in present if c not in unit_families]
    if unknown_units:
        warnings.append({"type": "unit_code_not_in_unit_family_csv", "uom_codes": unknown_units})
    not_in_code_set = sorted(set(present) - {r[0] for r in con.execute("SELECT code FROM cs_uom").fetchall()})
    if not_in_code_set:
        warnings.append({"type": "unit_code_not_in_code_set", "uom_codes": not_in_code_set})
    con.register("uf_rows", pa.Table.from_pylist(
        [{"uom_code": c, **unit_families.get(c, {"family": "other", "symbol": None, "base_year": None,
                                                  "note": "not in data/ref/unit_family.csv"})} for c in present],
        schema=UNIT_FAMILY_SCHEMA))
    con.execute("CREATE TABLE unit_family AS SELECT * FROM uf_rows")
    con.unregister("uf_rows")
    write("unit_family", "SELECT * FROM unit_family ORDER BY uom_code")

    # Places: geography members (dimension 1) of built tables.
    dguids = defaultdict(set)
    for pid, member_id, low, high in con.execute(
            "SELECT pid, member_id_1, min(dguid_min), max(dguid_max) FROM series_part GROUP BY ALL").fetchall():
        dguids[(pid, member_id)].update({low, high})
    members = [{"pid": pid, "member_id": member_id, "member_name": name, "classification_code": code,
                "parent_member_id": parent, "dguids": dguids.get((pid, member_id), set())}
               for pid, member_id, name, code, parent in con.execute(
                   "SELECT pid, member_id, member_name, classification_code, parent_member_id FROM member "
                   "WHERE dimension_id = 1 ORDER BY pid, member_id").fetchall()]
    place_rows, member_place_rows, parent_conflicts = map_places(members, aliases)
    for name, rows, schema in (("place", place_rows, PLACE_SCHEMA), ("member_place", member_place_rows, MEMBER_PLACE_SCHEMA)):
        con.register("rows", pa.Table.from_pylist(rows, schema=schema))
        con.execute(f"CREATE TABLE {name} AS SELECT * FROM rows")
        con.unregister("rows")
    write("place", "SELECT * FROM place ORDER BY place_id")
    write("member_place", "SELECT * FROM member_place ORDER BY pid, dimension_id, member_id")
    match_counts = Counter(r["match"] for r in member_place_rows)
    if match_counts.get("none"):
        warnings.append({"type": "geography_members_without_place", "members": match_counts["none"]})

    # Series.
    labels = ", ".join(f"l{k}.member_name AS label_{k}" for k in range(1, MAX_DIMS + 1))
    label_joins = " ".join(f"LEFT JOIN member l{k} ON l{k}.pid = s.pid AND l{k}.dimension_id = {k} "
                           f"AND l{k}.member_id = s.member_id_{k}" for k in range(1, MAX_DIMS + 1))
    write("series", f"""
        SELECT s.pid, s.vector, s.coordinate, {', '.join('s.' + c for c in MEMBER_IDS)}, {labels},
               mp.place_id, s.uom_code, uf.family AS unit_family, s.scalar_code, s.decimals,
               CASE WHEN s.kind_min = s.kind_max THEN s.kind_min ELSE 'other' END AS period_kind,
               s.period_min, s.period_max, s.n_obs, s.n_published, s.terminated_max = 't' AS terminated, s.last_status
        FROM series_part s {label_joins}
        LEFT JOIN member_place mp ON mp.pid = s.pid AND mp.member_id = s.member_id_1
        LEFT JOIN unit_family uf ON uf.uom_code = s.uom_code
        ORDER BY s.pid, {', '.join('s.' + c for c in MEMBER_IDS)}, s.vector""")
    series = f"read_parquet('{sql_path(out / 'series.parquet')}')"

    # Table: one row per PID in the Clean cube table.
    con.execute("CREATE TABLE built AS SELECT unnest(?::VARCHAR[]) AS pid", [built])
    con.execute("CREATE TABLE clean_build AS SELECT ?::VARCHAR AS id", [clean_manifest["build_id"]])
    unknown_codes = con.execute("""
        SELECT (SELECT list_sort(list(DISTINCT frequency_code)) FROM cube WHERE frequency_code NOT IN (SELECT code FROM cs_frequency)),
               (SELECT list_sort(list(DISTINCT c)) FROM (SELECT unnest(subject_codes) c FROM cube) WHERE c NOT IN (SELECT code FROM cs_subject)),
               (SELECT list_sort(list(DISTINCT c)) FROM (SELECT unnest(survey_codes) c FROM cube) WHERE c NOT IN (SELECT code FROM cs_survey))
        """).fetchone()
    for kind, codes in zip(("frequency", "subject", "survey"), unknown_codes):
        if codes:
            warnings.append({"type": f"{kind}_code_not_in_code_set", "codes": codes})
    write("table", f"""
        WITH s AS (SELECT pid, sum(n_obs)::BIGINT AS row_count, count(*) AS series_count, min(period_min) AS period_min,
                          max(period_max) AS period_max, list_sort(list(DISTINCT unit_family)) AS unit_families
                   FROM {series} GROUP BY pid),
             p AS (SELECT mp.pid, count(*) FILTER (WHERE mp.match <> 'none') AS n_places_mapped,
                          count(*) FILTER (WHERE mp.match = 'none') AS n_places_unmapped,
                          coalesce(list_sort(list(DISTINCT pl.level) FILTER (WHERE pl.level IS NOT NULL)), []::VARCHAR[]) AS place_levels
                   FROM member_place mp LEFT JOIN place pl USING (place_id) GROUP BY mp.pid),
             subj AS (SELECT u.pid, list(cs.en ORDER BY u.i) AS subject_en
                      FROM (SELECT pid, unnest(subject_codes) AS code, unnest(range(len(subject_codes))) AS i FROM cube) u
                      LEFT JOIN cs_subject cs USING (code) GROUP BY u.pid),
             surv AS (SELECT u.pid, list(cs.en ORDER BY u.i) AS survey_en
                      FROM (SELECT pid, unnest(survey_codes) AS code, unnest(range(len(survey_codes))) AS i FROM cube) u
                      LEFT JOIN cs_survey cs USING (code) GROUP BY u.pid),
             dims AS (SELECT pid, string_agg(dimension_name, ' | ' ORDER BY dimension_id) AS t FROM dimension GROUP BY pid),
             idims AS (SELECT pid, string_agg(name_en, ' | ' ORDER BY position) AS t FROM inventory_dimension GROUP BY pid),
             mems AS (SELECT pid, string_agg(member_name, ' | ' ORDER BY dimension_id, member_id) AS t FROM member GROUP BY pid),
             notes AS (SELECT pid, string_agg(regexp_replace(note, '<[^>]*>', ' ', 'g'), ' | ' ORDER BY note_id) AS t
                       FROM note GROUP BY pid)
        SELECT c.*,
               CASE WHEN c.cube_start_date IS DISTINCT FROM c.cube_end_date THEN 'time_series' ELSE 'snapshot' END AS kind,
               CASE WHEN c.pid LIKE '98%' THEN 'census_2021' ELSE 'wds' END AS family,
               f.en AS frequency_en,
               coalesce(subj.subject_en, []::VARCHAR[]) AS subject_en,
               coalesce(surv.survey_en, []::VARCHAR[]) AS survey_en,
               b.pid IS NOT NULL AS queryable,
               (SELECT id FROM clean_build) AS clean_build_id,
               s.row_count, s.series_count, s.period_min, s.period_max, s.unit_families,
               p.place_levels, p.n_places_mapped, p.n_places_unmapped,
               concat_ws(' | ', c.title_en, coalesce(dims.t, idims.t), mems.t, notes.t) AS search_text
        FROM cube c
        LEFT JOIN cs_frequency f ON f.code = c.frequency_code
        LEFT JOIN built b USING (pid) LEFT JOIN s USING (pid) LEFT JOIN p USING (pid)
        LEFT JOIN subj USING (pid) LEFT JOIN surv USING (pid) LEFT JOIN dims USING (pid) LEFT JOIN idims USING (pid)
        LEFT JOIN mems USING (pid) LEFT JOIN notes USING (pid)
        ORDER BY c.pid""")

    for pid, rows in con.execute(f"SELECT pid, sum(n_obs) FROM {series} GROUP BY pid ORDER BY pid").fetchall():
        if rows != clean_manifest["tables"][pid].get("row_count"):
            warnings.append({"type": "row_count_differs_from_clean_manifest", "pid": pid, "series_sum": rows,
                             "clean": clean_manifest["tables"][pid].get("row_count")})
    kinds = {kind: {"series": n, "obs": obs} for kind, n, obs in con.execute(
        f"SELECT period_kind, count(*), sum(n_obs)::BIGINT FROM {series} GROUP BY 1 ORDER BY 1").fetchall()}
    con.close()
    shutil.rmtree(tmp)

    manifest = {
        "build_id": args.build_id, "built_at_utc": utc_now(),
        "clean": {"dir": str(clean), "build_id": clean_manifest["build_id"],
                  "manifest_sha256": sha256_file(clean_manifest_path), "tables_ok": len(built)},
        "codesets": {"path": str(codesets), "sha256": codesets_sha},
        "refs": {f"data/ref/{name}": sha256_file(REF / name) for name in ("unit_family.csv", "place_alias.csv")},
        "tool": {"script": "tools/wds_normalize.py", "python": platform.python_version(), "duckdb": duckdb.__version__,
                 "pyarrow": pa.__version__, "memory_gib": args.memory_gib, "threads": args.threads},
        "files": files,
        "stats": {"place_match": dict(sorted(match_counts.items())), "places": len(place_rows),
                  "places_with_conflicting_parents": parent_conflicts, "period_kind": kinds},
        "warnings": warnings,
        "seconds": round(time.monotonic() - started, 1),
    }
    drive.atomic_json(out / "normalize_manifest.json", manifest)
    print(f"Normalized {args.build_id}: {len(files)} files, {len(warnings)} warnings -> {out}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clean", required=True, help="Clean build directory (build_manifest.json, catalogue/, obs/)")
    parser.add_argument("--codesets", required=True, help="captured codeSets.json; its sibling .sha256 file is checked")
    parser.add_argument("--mount-uuid", required=True, help="filesystem UUID that must back the inputs and the output")
    parser.add_argument("--build-id", required=True, help="output goes to <clean>/normalized/<build-id>/")
    parser.add_argument("--memory-gib", type=int, default=4, help="DuckDB memory limit; spills go to the output tmp/")
    parser.add_argument("--threads", type=int, default=2, help="DuckDB threads")
    args = parser.parse_args()
    try:
        return run(args)
    except (StorageStop, ValueError) as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
