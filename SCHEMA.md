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
| Series | `(pid, vector)` when `vector` is non-empty; otherwise `(pid, coordinate)` | WDS vectors identify lines; Census has empty vectors, so each coordinate is the stable series key |
| Observation | `(pid, coordinate, ref_date)` | verified unique whole-file in every built table |
| Place | `place_id` (ours, below) | the official `DGUID` is missing or non-standard in 40 of 105 tables |
| Capture / build | `capture_id`, `clean_build_id`, `normalized_build_id` | pinning |

## Clean layer (exists; `tools/wds_build.py`, contract in BUILD.md)

Per table: `obs/<pid>.parquet` with one row per observation, fixed columns (`ref_date`, `dguid`, `uom`, `uom_id`, `scalar_factor`, `scalar_id`, `vector`, `coordinate`, `value`, `value_num`, `status`, `symbol`, `terminated`, `decimals`, `member_id_1..9`). Catalogue: `cube`, `inventory_dimension`, `inventory_correction`, `cube_meta`, `dimension`, `member`, `attribute`, `symbol`, `survey`, `subject`, `note`, `correction`.

Clean now handles ordinary WDS tables and the 2021 Census WDS-sideways layout. Remaining Clean additions:

- **Large-table scheduling.** Keep the 35 multi-GB WDS tables out of parallel builds unless the host has memory headroom.

## Normalized layer (exists; current gate build `v0/normalized/n4`)

All files under `normalized/<normalized_build_id>/`. Every table carries `pid` where it applies. Large series output is a `series/` Parquet part directory (`*.parquet`, one PID per part) so full Census builds do not need both temporary series parts and a final monolithic file.

### Code sets (from `getCodeSets`, official)

`frequency`, `subject`, `survey`, `uom`, `scalar`, `status`, `symbol`, `classification_type`, `security_level`, `terminated`: the captured JSON written as Parquet, one file each, columns `code`, `en`, `fr`, `representation`. `security_level` is from official `securityLevel`; its representation `x` labels suppressed cells. These replace hard-coded label lookups in the API.

### `unit_family` (ours, hand-kept)

`data/ref/unit_family.csv` has one hand-kept row for each of the 465 codes in the captured `uom` code set. The Normalized `unit_family.parquet` contains only codes seen in Clean observations (42 in the 105-table `n4-units` sample); Census null units add no row. The CSV columns are `uom_code`, `family`, `symbol` (only standard short display symbols), `base_year` (single-year constant-dollar and index bases), and `note`. Code counts by family: `percent` 10, `count` 79, `currency` 37, `index` 81, `mass` 27, `time` 9, `volume` 23, `rate` 145, `area` 7, `length` 6, `energy` 10, `ratio` 4, `other` 27. Rates, averages, ratios, confidence-interval bounds, statistical weights, and unspecified or non-additive physical units are kept distinct from additive measures. The view engine sums only `count`, `currency`, `mass`, `volume`, `area`, `length`, and `energy`; `time` is not summed because most duration units (days, months, years) hold averages or medians such as median age or job tenure. Names are never rewritten. A future code missing from the CSV falls to `other` with a build warning; `tools/check_unit_family.py <uom.parquet>` checks coverage against a code set before building. Known scale risk: `Persons in thousands` (428) occurs with scalar `thousands` in three tables and `units` in one; whether that is a double scale is *to verify* per table.

### `period` rules (derived per `ref_date`, stored in `period`)

`period.parquet` has one row per `(pid, ref_date)` with `period_start`, `period_end`, and `period_kind`. `ref_date` shapes seen: `YYYY` (68 tables in `v0`), `YYYY-MM` (29), `YYYY/YYYY` (5, fiscal years), `YYYY-MM-DD` (3). Shape alone does not give the frequency: quarterly tables also write `YYYY-MM`, and one table labelled "Occasional Daily" writes quarterly `YYYY-MM-DD`. So:

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

Inventory fields plus: `kind` (`time_series` if `cube_start_date != cube_end_date`, else `snapshot`; all 525 Census tables are snapshots with one 2021 period), `family` (`wds` or `census_2021`; Census is `pid` starting `98` and the sideways layout), `frequency_en`, `subject_en[]`, `survey_en[]`, `queryable`, `clean_build_id`, `row_count`, `series_count`, `period_min`, `period_max`, `unit_families[]`, `place_levels[]` (which geography levels the table covers), `n_places_mapped`, `n_places_unmapped`, and search fields:

- `search_title`: title only.
- `search_dimensions`: dimension labels.
- `search_members`: member labels.
- `search_notes`: note text with HTML tags removed.
- `search_text`: compatibility field, concatenating the four fields above.

### `series` (one row per vector, or per coordinate when vector is empty)

Physical layout: `series/*.parquet`, one part per built PID. Logical columns: `pid`, `vector`, `coordinate`, `member_id_1..9`, `label_1..9` (member names, denormalized for display), `place_id` (from the geography dimension, if mapped), `uom_code`, `unit_family`, `scalar_code`, `decimals`, `period_kind`, `period_min`, `period_max`, `n_obs`, `n_published` (non-blank values), `terminated`, `last_status`. WDS time series are grouped by `vector`; when the vector is empty, the coordinate is the key. Census Clean verifies one observation per coordinate and strict member-ID order. Census series are projected directly from each observation, with member labels and place IDs from constant lookup lists, so no per-cell `GROUP BY` or second sort is needed. Each Census `series.n_obs` is 1; WDS groups check their counts against the observations. Charts and MCP treat snapshot series as points to compare, not lines. Full `n7` has 50,554,526,028 series: 49,923,588,701 Census cells and 630,937,327 WDS series.

### `obs_normalized` (view, not a copy)

The API reads Clean `obs/<pid>.parquet` and joins `period_start`, `place_id`, `unit_family` on request. `value_num × 10^scalar` (value in base units) is computed in the response when asked; it is not stored, because floats would lose the published precision that `value` + `decimals` keep.

## Presentation layer

The API reads Clean observations on request and joins Normalized periods and unit families.
No view is stored. DuckDB reads each selected table's Parquet once per view.
`/api/v1/cubes/{pid}` describes dimensions, roles, members, defaults, and units.
`/api/v1/cubes/{pid}/views` offers editable starter specs.
`/api/v1/plan?q=` returns a `PlanResult` from a typed question.
`/api/v1/view` resolves the spec, validates member selections and sums, and returns chart series.
Fixed dimensions pick one member. Series dimensions produce lines; x dimensions produce categories.
Group and sum values require matching additive units and scales. A missing component leaves a gap.
Time presets use the latest selected period, not the current date.
Transforms run after sums. Mixed units use at most two axes.
Notes are scoped to the tables, dimensions, and selected members in the view.
Each source includes its citation, captured date, marks, and corrections.
Parquet and CSV exports contain the displayed values, including hidden series.
Export files are temporary on the Clean build filesystem and removed after streaming.
The stable `/api/v1` API and its site pages remain available as legacy interfaces.

## Physical layout

```
statcan-wds/<capture_id>/            raw: inventory.json, zips/, manifests/     (SSD now; R2 later)
statcan-ref/codesets/<ts>/           raw: codeSets.json + sha256
statcan-derived/<clean_build_id>/    clean: catalogue/, obs/, build_manifest.json
statcan-derived/<clean_build_id>/normalized/<normalized_build_id>/
                                      normalized: table.parquet, period.parquet,
                                      code sets, place/member_place, unit_family,
                                      series/*.parquet, normalize_manifest.json
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
