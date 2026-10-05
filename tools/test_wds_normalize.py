#!/usr/bin/env python3
"""In-memory checks for period rules, DGUID parsing, and place mapping. No SSD, no network."""

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
sys.path.insert(0, str(Path(__file__).parent))
import wds_normalize as norm

D = dt.date
V0_FREQUENCIES = (1, 2, 6, 9, 11, 12, 13, 15, 16, 18, 21)  # frequency codes of the 105 tables in v0
ALIASES = {"[0]": ("0000", "11124"), "[00]": ("0000", "11124"), "[11124]": ("0000", "11124"),
           "[12]": ("0002", "12"), "[35]": ("0002", "35")}


class PeriodTest(unittest.TestCase):
    def test_every_v0_shape_with_every_v0_frequency(self):
        year = (D(2015, 1, 1), D(2015, 12, 31), "year")
        fiscal = (D(2015, 4, 1), D(2016, 3, 31), "fiscal_year")
        for freq in V0_FREQUENCIES:
            month = {9: (D(2015, 4, 1), D(2015, 6, 30), "quarter"),
                     11: (D(2015, 4, 1), D(2015, 9, 30), "half_year")}.get(freq, (D(2015, 4, 1), D(2015, 4, 30), "month"))
            day = (D(2015, 4, 1), D(2015, 4, 7), "week") if freq == 2 else (D(2015, 4, 1), D(2015, 4, 1), "day")
            for ref_date, expected in (("2015", year), ("2015-04", month), ("2015-04-01", day), ("2015/2016", fiscal)):
                with self.subTest(ref_date=ref_date, frequency=freq):
                    self.assertEqual(norm.period(ref_date, freq), expected)

    def test_period_ends_cross_month_and_year(self):
        self.assertEqual(norm.period("2015-11", 9), (D(2015, 11, 1), D(2016, 1, 31), "quarter"))
        self.assertEqual(norm.period("2015-12", 6), (D(2015, 12, 1), D(2015, 12, 31), "month"))
        self.assertEqual(norm.period("2016-02", 6)[1], D(2016, 2, 29))
        self.assertEqual(norm.period("2015-12-29", 2), (D(2015, 12, 29), D(2016, 1, 4), "week"))
        self.assertEqual(norm.period("2015-07", 19)[2], "quarter")  # Occasional Quarterly
        self.assertEqual(norm.period("2015-07", None)[2], "month")

    def test_occasional_daily_with_quarterly_steps_is_a_day(self):
        # 17100009 is "Occasional Daily" but writes 1946-01-01, 1946-04-01, ...
        self.assertEqual(norm.period("1946-04-01", 21), (D(1946, 4, 1), D(1946, 4, 1), "day"))

    def test_split_years(self):
        self.assertEqual(norm.period("2007/2010", 18), (D(2007, 1, 1), D(2010, 12, 31), "multi_year"))
        self.assertEqual(norm.period("2016/2015", 12), (None, None, "other"))
        self.assertEqual(norm.period("2015/2015", 12), (None, None, "other"))

    def test_unknown_or_invalid_text_gives_other(self):
        for ref_date in ("", "2015Q1", "2015-1", "15", "2015-13", "2015-02-29", "2015-04-31", "0000", "2015-04-01T00",
                         " 2015", "2015/16"):
            with self.subTest(ref_date=ref_date):
                self.assertEqual(norm.period(ref_date, 12), (None, None, "other"))
        self.assertEqual(norm.period("2016-02-29", 1), (D(2016, 2, 29), D(2016, 2, 29), "day"))

    def test_shape(self):
        self.assertEqual(norm.ref_date_shape("2015/2016"), "9999/9999")



class SeriesGroupingTest(unittest.TestCase):
    def test_empty_vector_groups_by_coordinate(self):
        rows = []
        for coordinate, value in (("1.1", "10"), ("1.2", "20")):
            row = {
                "pid": "98100034", "vector": "", "coordinate": coordinate, "uom_id": None, "scalar_id": None,
                "decimals": 0, "terminated": "", "dguid": "", "ref_date": "2021A0000", "value": value, "status": "",
            }
            row.update({member_id: i for i, member_id in enumerate(norm.MEMBER_IDS, 1)})
            rows.append(row)
        with tempfile.TemporaryDirectory() as td:
            obs = Path(td) / "obs.parquet"
            pq.write_table(pa.Table.from_pylist(rows), obs)
            con = duckdb.connect()
            con.register("periods", pa.Table.from_pylist(
                [{"ref_date": "2021A0000", "period_start": D(2021, 1, 1),
                  "period_end": D(2021, 12, 31), "period_kind": "year"}],
                schema=norm.PERIOD_SCHEMA))
            result = con.execute(norm.SERIES_PART_SQL.format(
                member_ids=", ".join(f"min(o.{c}) AS {c}" for c in norm.MEMBER_IDS),
                obs=obs.as_posix())).fetchall()
        self.assertEqual(len(result), 2)
        self.assertEqual(sorted(row[2] for row in result), ["1.1", "1.2"])

    def test_census_direct_projection_preserves_order_and_cell_values(self):
        pid = "98100001"
        rows = []
        for member_id, value, status in ((1, "42", ""), (3, "", "x")):
            row = {"pid": pid, "vector": "", "coordinate": f"1.{member_id}",
                   "uom_id": None, "scalar_id": None, "decimals": None,
                   "terminated": "", "ref_date": "2021", "value": value, "status": status}
            row.update({field: (1 if i == 1 else member_id if i == 2 else None)
                        for i, field in enumerate(norm.MEMBER_IDS, 1)})
            rows.append(row)
        with tempfile.TemporaryDirectory() as td:
            obs = Path(td) / "obs.parquet"
            pq.write_table(pa.Table.from_pylist(rows), obs)
            con = duckdb.connect()
            con.execute("SET threads = 1")
            con.register("member", pa.Table.from_pylist([
                {"pid": pid, "dimension_id": 1, "member_id": 1, "member_name": "Canada"},
                {"pid": pid, "dimension_id": 2, "member_id": 1, "member_name": "Population"},
                {"pid": pid, "dimension_id": 2, "member_id": 3, "member_name": "Suppressed"},
            ]))
            con.register("member_place", pa.Table.from_pylist([
                {"pid": pid, "dimension_id": 1, "member_id": 1, "place_id": "2021A000011124"}]))
            con.register("unit_family", pa.Table.from_pylist([], schema=norm.UNIT_FAMILY_SCHEMA))
            result = con.execute(norm.census_series_sql(pid, obs.as_posix(), norm.period("2021", None)))
            names = [column[0] for column in result.description]
            projected = [dict(zip(names, row)) for row in result.fetchall()]
            con.close()
        self.assertEqual([(r["coordinate"], r["label_1"], r["label_2"], r["place_id"],
                           r["n_obs"], r["n_published"], r["last_status"]) for r in projected],
                         [("1.1", "Canada", "Population", "2021A000011124", 1, 1, ""),
                          ("1.3", "Canada", "Suppressed", "2021A000011124", 1, 0, "x")])
        self.assertEqual([(r["period_kind"], r["period_min"], r["period_max"]) for r in projected],
                         [("year", D(2021, 1, 1), D(2021, 12, 31))] * 2)

    def test_census_reuse_refuses_nonnull_units_and_wrong_hash(self):
        class Space:
            def check(self, _bytes=0):
                return None

        with tempfile.TemporaryDirectory() as td:
            source, dest = Path(td) / "source.parquet", Path(td) / "dest.parquet"
            pq.write_table(pa.table({"uom_id": pa.array([None, None], type=pa.int32()),
                                     "unit_family": pa.array([None, None], type=pa.string())}), source)
            norm.require_null_parquet_columns(source, 2, ("uom_id", "unit_family"))
            expected = {"bytes": source.stat().st_size, "sha256": norm.sha256_file(source)}
            self.assertEqual(norm.copy_verified_part(source, dest, expected, Space()), expected)
            self.assertEqual(norm.sha256_file(dest), expected["sha256"])
            dest.unlink()
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                norm.copy_verified_part(source, dest, {**expected, "sha256": "0" * 64}, Space())
            self.assertFalse(dest.exists())
            pq.write_table(pa.table({"uom_id": pa.array([None, 17], type=pa.int32())}), source)
            with self.assertRaisesRegex(ValueError, "not proven null"):
                norm.require_null_parquet_columns(source, 2, ("uom_id",))

class DguidTest(unittest.TestCase):
    def test_well_formed(self):
        self.assertEqual(norm.parse_dguid("2021A000235"), {"vintage": 2021, "geo_type": "A", "schema": "0002", "geo_code": "35"})
        self.assertEqual(norm.parse_dguid("2016S0503602"), {"vintage": 2016, "geo_type": "S", "schema": "0503", "geo_code": "602"})
        self.assertEqual(norm.parse_dguid("2016A000011124")["geo_code"], "11124")

    def test_not_a_dguid(self):
        for text in ("", None, "1001", "00", "1104-D", "5901T", "B", "2021X000235", "2021A0002", "2021A0002 35",
                     "21A000235", " 2021A000235"):
            with self.subTest(text=text):
                self.assertIsNone(norm.parse_dguid(text))

    def test_short_canada_form_matches_the_pattern(self):
        # Seen in 11100053 and 33100094. The pattern accepts it; map_places rejects it by the code check.
        self.assertEqual(norm.parse_dguid("2021A11124")["schema"], "1112")

    def test_level(self):
        self.assertEqual([norm.place_level(s) for s in ("0000", "0002", "0503")], ["country", "province", "schema:0503"])


def member(pid, member_id, name, code="", dguids=(), parent=None):
    return {"pid": pid, "member_id": member_id, "member_name": name, "classification_code": code,
            "parent_member_id": parent, "dguids": set(dguids)}


class PlaceMappingTest(unittest.TestCase):
    def mapped(self, members):
        places, member_places, conflicts = norm.map_places(members, ALIASES)
        return ({p["place_id"]: p for p in places},
                {(m["pid"], m["member_id"]): m for m in member_places}, conflicts)

    def test_rules_apply_in_order(self):
        places, mp, _ = self.mapped([
            member("A", 1, "Canada", "[11124]", {"2016A000011124"}),
            member("A", 2, "Ontario", "[35]", {"2016A000235"}, parent=1),
            member("B", 1, "Canada", "[11124]", {"2021A000011124"}),
            member("B", 2, "Ontario", "[35]", {"2021A000235"}, parent=1),
            member("C", 1, "Ontario by District Health Council", "[35]", {"35"}),
            member("C", 2, "Toronto District Health Council, Ontario", "[3504]", {"3504"}, parent=1),
            member("D", 1, "Nova Scotia", "[12]", {"2016A000212"}),
            member("E", 1, "Nova Scotia", "", {""}),
            member("E", 2, "Canada (excluding territories)", "", {""}),
            member("F", 1, "Kings, Nova Scotia", "[1207]", {"2021A00031207"}),
            member("G", 1, "Kings, Nova Scotia", "", {""}),
        ])
        self.assertEqual(mp[("A", 2)]["match"], "dguid")
        self.assertEqual(mp[("A", 2)]["place_id"], "2016A000235")
        self.assertIsNone(mp[("A", 2)]["note"])
        self.assertEqual((mp[("C", 1)]["match"], mp[("C", 1)]["place_id"]), ("code", "code:0002:35"))
        self.assertIn("not well-formed", mp[("C", 1)]["note"])
        self.assertEqual((mp[("C", 2)]["match"], mp[("C", 2)]["place_id"]), ("none", None))
        self.assertIn("[3504] not in place_alias.csv", mp[("C", 2)]["note"])
        self.assertEqual((mp[("E", 1)]["match"], mp[("E", 1)]["place_id"]), ("name", "code:0002:12"))
        self.assertEqual(mp[("E", 2)]["match"], "none")
        self.assertEqual(mp[("F", 1)]["match"], "dguid")
        # Names below province level never match, even when unique.
        self.assertEqual(mp[("G", 1)]["match"], "none")

        # Ontario: one schema + geo_code across vintages and match types.
        ontario = {(places[mp[k]["place_id"]]["schema"], places[mp[k]["place_id"]]["geo_code"])
                   for k in (("A", 2), ("B", 2), ("C", 1))}
        self.assertEqual(ontario, {("0002", "35")})
        self.assertEqual(places["2016A000235"]["vintage"], 2016)
        self.assertIsNone(places["code:0002:35"]["vintage"])
        self.assertEqual(places["2016A000235"]["parent_place_id"], "2016A000011124")
        self.assertEqual(places["2016A000235"]["level"], "province")
        self.assertEqual(places["2021A00031207"]["level"], "schema:0003")

    def test_dguid_that_disagrees_with_the_code_falls_to_the_code(self):
        _, mp, _ = self.mapped([member("A", 1, "Canada", "[11124]", {"2021A11124"})])
        self.assertEqual((mp[("A", 1)]["match"], mp[("A", 1)]["place_id"]), ("code", "code:0000:11124"))
        self.assertIn("disagrees", mp[("A", 1)]["note"])

    def test_dguid_without_a_code_is_used(self):
        _, mp, _ = self.mapped([member("A", 1, "Atlantic", "", {"2021A00011"})])
        self.assertEqual(mp[("A", 1)]["place_id"], "2021A00011")

    def test_several_dguids_or_no_observations_fall_through(self):
        _, mp, _ = self.mapped([member("A", 1, "Ontario", "[35]", {"2016A000235", "2021A000235"}),
                                member("A", 2, "Quebec", "", set())])
        self.assertEqual((mp[("A", 1)]["match"], mp[("A", 1)]["place_id"]), ("code", "code:0002:35"))
        self.assertIn("several DGUIDs", mp[("A", 1)]["note"])
        self.assertEqual(mp[("A", 2)]["match"], "none")
        self.assertIn("no observations", mp[("A", 2)]["note"])

    def test_name_matching_two_places_is_not_mapped(self):
        _, mp, _ = self.mapped([member("A", 1, "Region", "", {"2021A000235"}),
                                member("B", 1, "Region", "", {"2021A000212"}),
                                member("C", 1, "Region", "", {""})])
        self.assertEqual(mp[("C", 1)]["match"], "none")
        self.assertIn("matches 2", mp[("C", 1)]["note"])

    def test_place_name_is_the_most_common_member_name(self):
        places, _, _ = self.mapped([member("A", 1, "Nova Scotia [PR120000000]", "[12]", {"2021A000212"}),
                                    member("B", 1, "Nova Scotia", "[12]", {"2021A000212"}),
                                    member("C", 1, "Nova Scotia", "[12]", {"2021A000212"})])
        self.assertEqual(places["2021A000212"]["name_en"], "Nova Scotia")

    def test_parent_conflicts_are_counted(self):
        places, _, conflicts = self.mapped([
            member("A", 1, "Canada", "[11124]", {"2021A000011124"}),
            member("A", 2, "Ontario", "[35]", {"2021A000235"}, parent=1),
            member("B", 1, "Canada", "[00]", {"00"}),
            member("B", 2, "Ontario", "[35]", {"2021A000235"}, parent=1),
            member("C", 1, "Canada", "[00]", {"00"}),
            member("C", 2, "Ontario", "[35]", {"2021A000235"}, parent=1),
        ])
        self.assertEqual(conflicts, 1)
        self.assertEqual(places["2021A000235"]["parent_place_id"], "code:0000:11124")


if __name__ == "__main__":
    unittest.main()
