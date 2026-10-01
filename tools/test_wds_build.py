#!/usr/bin/env python3
"""In-memory checks for the WDS metadata and observation readers. No SSD, no network."""

import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import wds_build as build

PID = "99900001"

NEWER_META = (
    '\ufeff"Cube Title","Product Id","CANSIM Id",URL,"Cube Notes","Archive Status",Frequency,"Start Reference Period","End Reference Period","Total number of dimensions"\n'
    f'"Test, with comma","{PID}","","https://example/tv.action?pid={PID}01",1;2,"CURRENT - a cube available to the public and that is current","Monthly","1992-01-01","2026-08-01","2",\n'
    "\n"
    '"Dimension ID","Dimension name","Dimension Notes","Dimension Definitions"\n'
    '"1","Geography",,""\n'
    '"2","Products",2,""\n'
    "\n"
    '"Dimension ID","Member Name","Classification Code","Member ID","Parent Member ID",Terminated,"Member Notes","Member Definitions"\n'
    '"1","Canada","[11124]","1","",,,"",\n'
    '"2","All-items","","1","",,,"",\n'
    '"2","Food","","2","1",,,"",\n'
    "\n"
    "Symbol Legend\n"
    "Description,Symbol\n"
    '"not available for a specific reference period","..",\n'
    '"use with caution","E",\n'
    "\n"
    '"Survey Code","Survey Name"\n'
    '"2301","Consumer Price Index",\n'
    "\n"
    '"Subject Code","Subject Name"\n'
    '"18","Prices and price indexes",\n'
    "\n"
    '"Note ID",Note\n'
    '1,"First note with <a href="https://example" target="_blank">unescaped "quotes"</a>."\n'
    '2,"Second note spans lines\n'
    "\n"
    'and has a blank line."\n'
    "\n"
    '"Correction ID","Correction Date","Correction Note"\n'
    '"3671","2023-07-18","<p>Fixed "something" and "else".<br></p>",\n'
    "\n"
)

OLDER_META = (
    '\ufeff"Cube Title","Product Id","CANSIM Id",URL,"Cube Notes","Archive Status",Frequency,"Start Reference Period","End Reference Period","Total number of dimensions"\n'
    f'"Old style",{PID},276-0015,"https://example/tv.action?pid={PID}01",6,"ARCHIVED -  a cube publicly available but no longer being updated",Monthly,1943-01-01,2010-12-01,1\n'
    "\n"
    '"Dimension ID","Dimension name","Dimension Notes","Dimension Correction Notes","Dimension Definitions"\n'
    "1,Geography,,,\n"
    "\n"
    '"Dimension ID","Member Name","Classification Code","Member ID","Parent Member ID",Terminated,"Member Notes","Member Correction Notes","Member Geo Attribute Keys","Member Definitions"\n'
    "1,Canada,[11124],1,,t,,corrected,keys,\n"
    "\n"
    "Symbol Legend\n"
    "Description,Symbol\n"
    '"not available for a specific reference period",..\n'
    "\n"
    '"Survey Code","Survey Name"\n'
    "2301,Something\n"
    "\n"
    '"Subject Code","Subject Name"\n'
    "18,Prices\n"
    "\n"
    '"Note ID",Note\n'
    "\n"
    '"Dimension ID","Member ID","Attribute Key",Title,Label,"Long Label",Value\n'
    "\n"
    "\n"
)

OBS = (
    '\ufeff"REF_DATE","GEO","DGUID","Products","UOM","UOM_ID","SCALAR_FACTOR","SCALAR_ID","VECTOR","COORDINATE","VALUE","STATUS","SYMBOL","TERMINATED","DECIMALS"\r\n'
    '"1992-01","Canada","2016A000011124","All-items","2002=100","17","units ","0","v1","1.1","83.0","","","","1"\r\n'
    '"1992-01","Canada","2016A000011124","Food","2002=100","17","units ","0","v2","1.2","","..","","t","1"\r\n'
    '"1992-02","Canada","2016A000011124","Food","2002=100","17","units ","0","v2","1.2","6.7","E","","t","1"\r\n'
)


def archive(meta, obs):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr(f"{PID}_MetaData.csv", meta.encode("utf-8"))
        z.writestr(f"{PID}.csv", obs.encode("utf-8"))
    return zipfile.ZipFile(io.BytesIO(buffer.getvalue()))


def read_all(meta, obs):
    report = {"errors": [], "warnings": []}
    batches = list(build.observation_batches(archive(meta, obs), PID, build.read_metadata(archive(meta, obs), PID), report))
    return report, [row for batch in batches for row in batch.to_pylist()]


class MetadataTest(unittest.TestCase):
    def test_newer_dialect(self):
        meta = build.read_metadata(archive(NEWER_META, OBS), PID)
        self.assertEqual(meta["cube"]["cube_title"], "Test, with comma")
        self.assertEqual(meta["cube"]["total_dimensions"], 2)
        self.assertEqual([d["dimension_name"] for d in meta["dimension"]], ["Geography", "Products"])
        self.assertIsNone(meta["dimension"][0]["dimension_correction_notes"])
        food = meta["member"][2]
        self.assertEqual((food["dimension_id"], food["member_id"], food["parent_member_id"]), (2, 2, 1))
        self.assertEqual([s["symbol"] for s in meta["symbol"]], ["..", "E"])
        self.assertEqual(meta["correction"], [{"correction_id": "3671", "correction_date": "2023-07-18", "correction_note": '<p>Fixed "something" and "else".<br></p>'}])
        self.assertEqual(meta["note"], [
            {"note_id": 1, "note": 'First note with <a href="https://example" target="_blank">unescaped "quotes"</a>.'},
            {"note_id": 2, "note": "Second note spans lines\n\nand has a blank line."},
        ])
        self.assertTrue(meta["note_block_raw"].startswith('"Note ID",Note\n1,"First'))

    def test_older_dialect_optional_columns(self):
        meta = build.read_metadata(archive(OLDER_META, OBS), PID)
        self.assertEqual(meta["cube"]["archive_status"], "ARCHIVED -  a cube publicly available but no longer being updated")
        self.assertEqual(meta["dimension"][0]["dimension_correction_notes"], "")
        member = meta["member"][0]
        self.assertEqual((member["terminated"], member["member_correction_notes"], member["member_geo_attribute_keys"]), ("t", "corrected", "keys"))
        self.assertEqual(meta["note"], [])
        self.assertEqual(meta["correction"], [])
        self.assertEqual(meta["attribute"], [])

    def test_unknown_column_and_missing_block_fail(self):
        with self.assertRaisesRegex(build.TableError, "unknown columns"):
            build.read_metadata(archive(NEWER_META.replace('"Member Definitions"', '"Member Surprise"'), OBS), PID)
        with self.assertRaisesRegex(build.TableError, "missing"):
            build.read_metadata(archive(NEWER_META.replace('"Survey Code","Survey Name"\n"2301","Consumer Price Index",\n', ""), OBS), PID)

    def test_member_names_with_unescaped_quotes(self):
        meta = NEWER_META.replace('"2","Food","","2","1"', '"2","Rated "very good" or "excellent", food","","2","1"')
        food = build.read_metadata(archive(meta, OBS), PID)["member"][2]
        self.assertEqual((food["member_name"], food["member_id"], food["parent_member_id"]), ('Rated "very good" or "excellent", food', 2, 1))

    def test_member_note_ids_written_unquoted(self):
        meta = NEWER_META.replace('"2","Food","","2","1",,,"",', '"2","Food","","2","1","",4,5,6,')
        food = build.read_metadata(archive(meta, OBS), PID)["member"][2]
        self.assertEqual((food["member_notes"], food["member_definitions"]), ("4;5;6", ""))


class ObservationTest(unittest.TestCase):
    def test_rows_and_stats(self):
        report, rows = read_all(NEWER_META, OBS)
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["row_count"], 3)
        self.assertEqual([(r["row_index"], r["member_id_1"], r["member_id_2"], r["member_id_3"]) for r in rows], [(1, 1, 1, None), (2, 1, 2, None), (3, 1, 2, None)])
        self.assertEqual([(r["value"], r["value_num"], r["status"]) for r in rows], [("83.0", 83.0, ""), ("", None, ".."), ("6.7", 6.7, "E")])
        self.assertEqual(rows[0]["scalar_factor"], "units ")
        self.assertEqual(report["status_counts"], {"": 1, "..": 1, "E": 1})
        self.assertEqual(report["blank_value_by_status"], {"..": 1})
        self.assertEqual(report["terminated_counts"], {"": 1, "t": 2})
        self.assertEqual(report["codes_not_in_legend"], [])

    def test_label_with_classification_code_is_accepted(self):
        meta = NEWER_META.replace('"2","All-items","","1"', '"2","All-items","[1]","1"').replace('"2","Food","","2"', '"2","Food","[2]","2"')
        report, rows = read_all(meta, OBS.replace('"All-items"', '"All-items [1]"').replace('"Food"', '"Food [2]"'))
        self.assertEqual(report["errors"], [])
        self.assertEqual([r["member_id_2"] for r in rows], [1, 2, 2])

    def test_quote_mangled_label_is_a_warning(self):
        meta = NEWER_META.replace('"2","Food","","2","1"', '"2","Food (see ""note"")","","2","1"')
        report, rows = read_all(meta, OBS.replace('"Food"', '"Food (see note")"'))
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["warnings"], ["2 row labels matched the member name only after removing double quotes or trailing whitespace"])

    def test_label_with_trailing_newline_is_a_warning(self):
        report, rows = read_all(NEWER_META, OBS.replace('"Food"', '"Food\n"'))
        self.assertEqual(report["errors"], [])
        self.assertEqual(len(rows), 3)

    def test_header_mismatch_is_an_error(self):
        report, rows = read_all(NEWER_META, OBS.replace('"Products"', '"Product groups"'))
        self.assertEqual(rows, [])
        self.assertRegex(report["errors"][0], "header mismatch")

    def test_label_member_mismatch_is_an_error(self):
        report, rows = read_all(NEWER_META, OBS.replace('"1992-02","Canada","2016A000011124","Food"', '"1992-02","Canada","2016A000011124","Fooood"'))
        self.assertRegex(report["errors"][0], r"row 3: dimension 2 member 2 is 'Food', row label 'Fooood'")

    def test_non_numeric_value_is_an_error(self):
        report, rows = read_all(NEWER_META, OBS.replace('"83.0"', '"1e3"'))
        self.assertRegex(report["errors"][0], "VALUE '1e3' is not numeric")


if __name__ == "__main__":
    unittest.main()
