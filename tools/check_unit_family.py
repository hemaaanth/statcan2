#!/usr/bin/env python3
"""Check that every official WDS unit code has a hand-kept family."""

import argparse
import csv
from collections import Counter
from pathlib import Path

import duckdb


CSV = Path(__file__).resolve().parents[1] / "data/ref/unit_family.csv"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("uom", type=Path, help="Normalized uom.parquet to check")
    args = parser.parse_args()

    with CSV.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ["uom_code", "family", "symbol", "base_year", "note"]:
            parser.error(f"unexpected header in {CSV}")
        families = {}
        for row in reader:
            code = int(row["uom_code"])
            if code in families or not row["family"]:
                parser.error(f"duplicate code or empty family: {code}")
            families[code] = row["family"]

    codes = {code for (code,) in duckdb.execute(
        "SELECT DISTINCT code FROM read_parquet(?)", [str(args.uom)]).fetchall()}
    missing = sorted(codes - families.keys())
    counts = Counter(families[code] for code in codes if code in families)
    print(f"{len(codes)} unit codes; {len(missing)} missing from {CSV}")
    for family, count in sorted(counts.items()):
        print(f"{family}: {count}")
    if missing:
        parser.exit(1, f"missing uom_code: {', '.join(map(str, missing))}\n")


if __name__ == "__main__":
    main()
