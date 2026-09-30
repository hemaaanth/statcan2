#!/usr/bin/env python3
"""Checks for the Census-layout observation reader: in-memory ZIPs, one tiny temporary Parquet. No SSD, no network."""

import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import wds_census as census

PID = "98100001"

# Census metadata dialect: Universe/Variable List, no Subject block, Correction header directly followed by
# the member-attribute block.
META = (
    '\ufeff"Cube Title","Product Id","CANSIM Id",URL,"Cube Notes","Archive Status",Frequency,"Start Reference Period",'
    '"End Reference Period","Total number of dimensions",Universe,"Variable List"\n'
    f'"Test census","{PID}",,"https://example/tv.action?pid={PID}01",,"CURRENT - a cube available to the public and that is current",'
    '"Occasional","2021-01-01","2021-01-01","3","Everyone","Age (2), Sex (3)"\n'
    "\n"
    '"Dimension ID","Dimension name","Dimension Notes","Dimension Correction Notes","Dimension Definitions"\n'
    '"1","Geography",,,""\n'
    '"2","Age (2)",,,""\n'
    '"3","Sex (3)",,,""\n'
    "\n"
    '"Dimension ID","Member Name","Classification Code","Member ID","Parent Member ID",Terminated,"Member Notes",'
    '"Member Correction Notes","Member Geo Attribute Keys","Member Definitions"\n'
    '"1","Canada","[11124]","1","","",,,16,\n'
    '"2","Total - Age","","1","","",,,,\n'
    '"2","0 to 14 years","","2","1","",,,,\n'
    '"3","Total - Sex","","1","","",,,,\n'
    '"3","Male","","2","1","",,,,\n'
    '"3","Female ","","3","1","",1,,,\n'
    "\n"
    "Symbol Legend\n"
    "Description,Symbol\n"
    '"not available for a specific reference period","..",\n'
    '"use with caution","E",\n'
    '"not applicable","...",\n'
    '"revised","r",\n'
    '"suppressed to meet the confidentiality requirements of the Statistics Act","x",\n'
    "\n"
    '"Survey Code","Survey Name"\n'
    '"3901","Census of Population"\n'
    "\n"
    '"Note ID",Note\n'
    '1,"Sex at birth."\n'
    "\n"
    '"Correction ID","Correction Date","Correction Note"\n'
    '"Dimension ID","Member ID","Attribute Key",Title,Label,"Long Label",Value\n'
    '1,1,16,"DGUID","DGUID","DGUID","2021A000011124"\n'
)

HEADER = "REF_DATE,GEO,DGUID,Age (2),Coordinate,Sex (3):Total - Sex[1],Symbol,Sex (3):Male[2],Symbol,Sex (3):Female[3],Symbol\n"
# 98100001 spelling: space before the bracket, "Symbols", and the member note reference "(1)" before the ID.
SPACED_HEADER = ("REF_DATE,GEO,DGUID,Age (2),Coordinate,Sex (3): Total - Sex [1],Symbols,Sex (3): Male [2],Symbols,"
                 "Sex (3): Female (1) [3],Symbols\n")
ROWS = (
    '2021,Canada,2021A000011124,Total - Age,1.1,100,,48.5,r,52,"r,E"\n'
    "2021,Canada,2021A000011124,0 to 14 years,1.2,,x,0,...,,..\n"
    "\n"
    "\n"
)


def read_all(obs):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr(f"{PID}_MetaData.csv", META.encode("utf-8"))
        z.writestr(f"{PID}.csv", ("\ufeff" + obs).encode("utf-8"))
    archive = zipfile.ZipFile(io.BytesIO(buffer.getvalue()))
    report = {"errors": [], "warnings": []}
    batches = list(census.census_batches(archive, PID, census.read_metadata(archive, PID), report))
    return report, [row for batch in batches for row in batch.to_pylist()]


class CensusTest(unittest.TestCase):
    def test_unpivot_and_symbol_split(self):
        report, rows = read_all(HEADER + ROWS)
        self.assertEqual(report["errors"], [])
        self.assertEqual([r["coordinate"] for r in rows], ["1.1.1", "1.1.2", "1.1.3", "1.2.1", "1.2.2", "1.2.3"])
        self.assertEqual([r["row_index"] for r in rows], [1, 1, 1, 2, 2, 2])
        self.assertEqual([(r["member_id_1"], r["member_id_2"], r["member_id_3"], r["member_id_4"]) for r in rows[3:]],
                         [(1, 2, 1, None), (1, 2, 2, None), (1, 2, 3, None)])
        self.assertEqual([r["value"] for r in rows], ["100", "48.5", "52", "", "0", ""])
        self.assertEqual([r["value_num"] for r in rows], [100.0, 48.5, 52.0, None, 0.0, None])
        # Revision flags go to symbol, as in ordinary tables; everything else is a status code.
        self.assertEqual([r["status"] for r in rows], ["", "", "E", "x", "...", ".."])
        self.assertEqual([r["symbol"] for r in rows], ["", "r", "r", "", "", ""])
        self.assertEqual({(r["vector"], r["uom"], r["uom_id"], r["scalar_id"], r["decimals"], r["terminated"]) for r in rows},
                         {("", "", None, None, None, "")})
        self.assertEqual(report["row_count"], 6)
        self.assertEqual(report["blank_value_by_status"], {"x": 1, "..": 1})
        self.assertEqual(report["symbol_counts"], {"": 4, "r": 2})
        self.assertEqual(report["codes_not_in_legend"], [])

    def test_spaced_header_spelling(self):
        report, rows = read_all(SPACED_HEADER + ROWS)
        self.assertEqual(report["errors"], [])
        self.assertEqual([r["member_id_3"] for r in rows], [1, 2, 3, 1, 2, 3])

    def test_errors(self):
        cases = {
            "value column 'Sex (3):Female[2]': member 2 is 'Male'": HEADER.replace("Male[2]", "Female[2]") + ROWS,
            "row 2: dimension 2 member 2 is '0 to 14 years', row label '15 to 64 years'":
                HEADER + ROWS.replace("0 to 14 years", "15 to 64 years"),
            "row 5: data after a blank line": HEADER + ROWS + "2021,Canada,2021A000011124,Total - Age,1.1,1,,2,,3,\n",
            "row 1: VALUE '1e3' is not numeric": HEADER + ROWS.replace(",100,", ",1e3,"),
            "row 2: coordinate '1.1' is not after the previous row's": HEADER + ROWS.replace(",1.2,", ",1.1,"),
        }
        for message, obs in cases.items():
            with self.subTest(message):
                report, _ = read_all(obs)
                self.assertEqual(report["errors"], [message])

    def test_written_file_order_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "obs.parquet"
            for rows, bad in (([(1, 1), (1, 2), (2, 1)], 0), ([(1, 1), (1, 2), (1, 2)], 1), ([(1, 2), (2, 1), (1, 3)], 1)):
                census.pq.write_table(census.pa.table({"member_id_1": census.pa.array([r[0] for r in rows], census.pa.int32()),
                                                       "member_id_2": census.pa.array([r[1] for r in rows], census.pa.int32())}), path)
                self.assertEqual(census.rows_not_ascending(path, 2), bad, rows)


if __name__ == "__main__":
    unittest.main()
