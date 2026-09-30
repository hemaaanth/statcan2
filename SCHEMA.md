# Data layers and schema

Design for turning captured Statistics Canada files into something people can search, chart, and query, without changing what StatCan published. Facts below come from the 105-table build `v0`, the 525 captured Census (`98…`) ZIPs, and the WDS code sets captured 2026-09-30 (`statcan-ref/codesets/20260930T182041Z`, SHA-256 `392885a9…`). Anything not measured is marked *to verify*.

## Four layers

| Layer | Stored? | Unit of work | Changes when | Rebuilt from |
|---|---|---|---|---|
| **Raw** | yes, forever | one ZIP + manifest per (PID, language, capture) | never; a new download is a new capture | — |
| **Clean** | yes | one Parquet per table + catalogue Parquet + `build_manifest.json` | the reader learns a new file quirk | Raw |
| **Normalized** | yes | cross-table Parquet: places, units, periods, series, table facts | a mapping rule or code set improves | Clean + code sets + our mapping tables |
| **Presentation** | no | API JSON, HTML, SVG charts, MCP tool results | code deploys | Normalized, on request |

Rules that hold across layers:

1. **Official values are never rewritten.** Every Clean column is the string from the file. Normalized adds columns and tables beside them. A label like `Percentage` stays `Percentage`; we add `unit_family = percent`.
2. **Every stored file has a build ID and a SHA-256.** Normalized records which Clean build it came from; Clean records which capture and ZIP hashes it came from. Same inputs give identical bytes.
3. **Failures are recorded, not hidden.** A table that fails a check has no Parquet and an error string in the manifest. A member with no place mapping has `place_id = null` and a reason, not a guess.
4. **Nothing is aggregated across tables in storage.** Units, scales, and definitions differ by table. Totals inside a table are already members (`Canada`, `All-items`). Cross-table joins on place and period are a query the API offers, not a stored fact.

## Identity

| Thing | Key | Why |
|---|---|---|
| Table | `pid` (8-digit string of the inventory `productId`) | 3,509 tables have no CANSIM ID; titles collide |
| Dimension | `(pid, dimension_id)` | dimension IDs restart at 1 in every table |
| Member | `(pid, dimension_id, member_id)` | member IDs are per table; Ontario is member 8 different IDs across 39 tables |
| Series | `(pid, vector)`; `(pid, coordinate)` is equivalent | both unique per `ref_date` in all 107 checked tables |
| Observation | `(pid, coordinate, ref_date)` | verified unique whole-file in every built table |
| Place | `place_id` (ours, below) | the official `DGUID` is missing or non-standard in 40 of 105 tables |
| Capture / build | `capture_id`, `clean_build_id`, `normalized_build_id` | pinning |

## Clean layer (exists; `tools/wds_build.py`, contract in BUILD.md)

Per table: `obs/<pid>.parquet` with one row per observation, fixed columns (`ref_date`, `dguid`, `uom`, `uom_id`, `scalar_factor`, `scalar_id`, `vector`, `coordinate`, `value`, `value_num`, `status`, `symbol`, `terminated`, `decimals`, `member_id_1..9`). Catalogue: `cube`, `inventory_dimension`, `inventory_correction`, `cube_meta`, `dimension`, `member`, `attribute`, `symbol`, `survey`, `subject`, `note`, `correction`.

Two additions Clean still needs:

- **A Census reader.** Census files are the same metadata blocks plus a sideways observation file: the first N−1 dimensions come from `Coordinate` (`1.1.1.1.1`), the last dimension is spread across columns named `Dim (N):Member[ID]`, each followed by a `Symbol`/`Symbols` column. The reader unpivots each value column into one row, taking the last member ID from the header, and writes the same `obs` schema. *To verify:* what the `Symbol` column carries (status codes are expected), and whether every Census file follows this shape (seen in 3 of 525).
- **`--jobs N`** so the 35 multi-GB tables do not serialize a full run.

## Normalized layer (to build)

All files under `normalized/<normalized_build_id>/`. Every table carries `pid` where it applies.

### Code sets (from `getCodeSets`, official)

`frequency`, `subject`, `survey`, `uom`, `scalar`, `status`, `symbol`, `classification_type`, `terminated`: the captured JSON written as Parquet, one file each, columns as given (`code`, `en`, `fr`, `representation_en`, `representation_fr`; status 10 is `<LOD` in English and `<LDD` in French). 17 frequencies, 622 subjects, 903 surveys, 465 units, 10 scalars, 11 status codes, 3 symbol codes. The `x` mark lives in `securityLevel`, not `status`; the API loads that set too. These replace the hard-coded label lookups in the API.

### `unit_family` (ours, hand-kept)

One row per `uom_code` seen in the data. Columns: `uom_code`, `family` (`percent`, `count`, `currency`, `index`, `mass`, `time`, `volume`, `rate`, `other`), `symbol` (`%`, `CAD`, `t`, `h`…), `base_year` (for `2024 constant dollars` and single-year index bases like `2002=100`), `note`. StatCan already keys units by code and names are 1:1 with codes (42 of 42 in `v0`), so this table never rewrites a name; it groups codes. Unknown codes get `family = other` and appear in a build warning so the table grows deliberately. Known oddity: `Persons in thousands` (428) appears with scalar `thousands` in three tables and `units` in one; whether that is a double scale is *to verify* per table.

### `period` rules (derived per row, stored on `series` and in `obs_normalized`)

`ref_date` shapes seen: `YYYY` (68 tables), `YYYY-MM` (29), `YYYY/YYYY` (5, fiscal years), `YYYY-MM-DD` (3). Shape alone does not give the frequency: quarterly tables also write `YYYY-MM`, and one table labelled "Occasional Daily" writes quarterly `YYYY-MM-DD`. So:

- `period_start` (DATE) = first day of the period from the text.
- `period_end` (DATE) = from `frequency_code` when it is a fixed interval (daily, weekly, monthly, quarterly, semi-annual, annual, every N years) else `period_start`. `YYYY` is always a calendar year, even in "every N years" tables. `YYYY/YYYY` → April 1 to March 31 by default; tables that state another split year (17100006 and 17100051 say July 1 to June 30) need a per-table override in `data/ref/period_override.csv` (*to build*). Whether a weekly date starts or ends its week is unstated (*to verify*, 10100073).
- `period_kind` = `day | week | month | quarter | half_year | year | fiscal_year | multi_year | other`.
- On `series`: `period_min` is the earliest `period_start`, `period_max` the latest `period_end`; `terminated` is a boolean.
- The raw `ref_date` stays and is what the API returns as the label. Charts use `period_start`.

### `place` and `member_place`

The bridge between tables, and between Census and everything else.

`place`: `place_id`, `dguid` (nullable), `vintage` (2011/2016/2021/null), `geo_type` (`A` administrative, `S` statistical, null), `schema` (4-digit DGUID schema: `0000` Canada, `0002` province/territory; other schemas keep `level = schema:<code>` until the 92-151-X reference is captured), `geo_code` (the trailing code: `11124`, `35`, `3520005`), `name_en`, `level` (`country | province | schema:<code>`; `province` covers territories), `parent_place_id`. `place_id` is the DGUID for DGUID matches and `code:<schema>:<geo_code>` (vintage-free) for code and name matches.

`member_place`: `pid`, `dimension_id`, `member_id`, `place_id`, `match` (`dguid | code | name | none`), `note`.

Mapping order, per geography member:

1. **`dguid`** on the observation rows is a well-formed DGUID (`^\d{4}[AS]\d{4}\S+$`) **and** its `geo_code` equals the member's classification code: exact place by DGUID. The second condition matters: `2021A11124` fits the pattern but would parse as schema `1112`. 68 of 105 tables for Canada, 42 for provinces. Vintages differ (`2016A000011124` and `2021A000011124` are both Canada); both rows exist in `place` and share `geo_code` + `schema`, so "same place, any vintage" is a query on those two columns.
2. **Classification code** listed in `data/ref/place_alias.csv` (Canada aliases `[0]`, `[00]`, `[11124]`; the 13 province/territory codes): place with `vintage = null`. Nothing is inferred from code length: `[3501]` means four different things in `v0` (a health council, a LHIN, an agricultural region, a census division).
3. **Name** matches exactly one `place.name_en` at country or province level: `match = name`. Provinces and territories only; never below, because names repeat.
4. Otherwise `place_id = null`, `match = none`. Observed non-standard `dguid` values that fall here: bare codes (`1001`, `00`), suffixed codes (`1104-D`, `5901T`), single letters (`B`, `J`).

The `place` seed list comes from the DGUIDs and codes present in the data plus the official geography reference files (*to acquire*: 2021 Geographic Attribute File, catalogue 92-151-X, listed in SOURCE_COVERAGE.md). Until that file is captured, `place` covers only what appears in captured tables, with names taken from the member table.

### `table` (one row per PID; the search and browse record)

Inventory fields plus: `kind` (`time_series` if `cube_start_date != cube_end_date`, else `snapshot`; all 525 Census tables are snapshots with one 2021 period), `family` (`wds` or `census_2021`; Census is `pid` starting `98` and the sideways layout), `frequency_en`, `subject_en[]`, `survey_en[]`, `queryable`, `clean_build_id`, `row_count`, `series_count`, `period_min`, `period_max`, `unit_families[]`, `place_levels[]` (which geography levels the table covers), `n_places_mapped`, `n_places_unmapped`, `search_text` (title + dimension names + member names + notes, one string for the search index).

### `series` (one row per vector)

`pid`, `vector`, `coordinate`, `member_id_1..9`, `label_1..9` (member names, denormalized for display), `place_id` (from the geography dimension, if mapped), `uom_code`, `unit_family`, `scalar_code`, `decimals`, `period_kind`, `period_min`, `period_max`, `n_obs`, `n_published` (non-blank values), `terminated`, `last_status`. Derived by one `GROUP BY` over each Clean file. For a `snapshot` table `n_obs = 1`; the series table is still written so a Census cell has a stable ID, but charts and MCP treat snapshot series as points to compare, not lines. *To measure:* total series across the corpus; 24100055 alone has ~1 M.

### `obs_normalized` (view, not a copy)

The API reads Clean `obs/<pid>.parquet` and joins `period_start`, `place_id`, `unit_family` on request. `value_num × 10^scalar` (value in base units) is computed in the response when asked; it is not stored, because floats would lose the published precision that `value` + `decimals` keep.

## Presentation layer

Reads Normalized only. API and site exist (`api/`); they will switch from hard-coded labels to code sets, from `cube` to `table`, and gain `/series` search and `/series/{vector}` with a chart. MCP is a wrapper over four calls: search tables, get table, search/get series, get observations. Charts: Highcharts (non-commercial licence applies; this is a personal, non-profit project).

## Physical layout

```
statcan-wds/<capture_id>/            raw: inventory.json, zips/, manifests/     (SSD now; R2 later)
statcan-ref/codesets/<ts>/           raw: codeSets.json + sha256
statcan-derived/<clean_build_id>/    clean: catalogue/, obs/, build_manifest.json
statcan-derived/<clean_build_id>/normalized/<normalized_build_id>/   places, units, series, table, code sets, manifest
```

R2 holds the same paths. The API host keeps a local copy of `normalized/` and whichever `obs/` files it serves. Raw ZIPs are served straight from R2.

## What is deliberately not normalized

- Titles, dimension names, member names, notes: shown as published. Search handles word variants.
- Values: `value` stays text with `decimals`; `value_num` is a convenience.
- Cross-table sums or averages.
- French: deferred; every table above has room for `_fr` columns when French ZIPs are captured.

## Open items, in order

1. Census reader on 5 files of different sizes; confirm the `Symbol` column meaning and the unpivot rule.
2. `place` seed: acquire 92-151-X (geographic attribute file) and confirm DGUID schema codes.
3. Fiscal-year period bounds; frequency codes not yet seen (weekly, biweekly, bimonthly, every N years).
4. Series count and Normalized size after one full Clean run.
