# Building query files from a WDS capture

[`tools/wds_build.py`](tools/wds_build.py) turns captured English ZIPs into Parquet files plus a manifest. It never writes inside the capture directory. Source ZIPs are opened read-only with `zipfile`; nothing is extracted. Both the capture and the output root must sit on the UUID-checked SSD; the OS disk holds no dataset bytes. The build stops if SSD free space would fall below `--reserve-gib` (default 150 GiB, above the downloader's own 100 GiB reserve).

```bash
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -B tools/wds_build.py \
  --capture /run/media/hemanth/Kingston/statcan-wds/baseline \
  --out /run/media/hemanth/Kingston/statcan-derived \
  --mount-uuid 72D0-2131 --pids 18100006,17100009
.venv/bin/python -B -m unittest tools.test_wds_build
```

Each run writes a new `<out>/<build-id>/` (default build ID: UTC timestamp) and refuses to overwrite an existing one. A build is reproducible: the same capture, PIDs, and tool versions produce byte-identical Parquet files. Build `m1a` and a repeat `m1b` over the 10 sampled PIDs matched on all 21 output hashes.

## Output contract

```
<out>/<build-id>/
  build_manifest.json     build ID, capture path and inventory hash, tool versions,
                          per-file bytes + SHA-256, per-PID report (below)
  catalogue/*.parquet     see tables below
  obs/<PID>.parquet       one file per table with status "ok"
```

`build_manifest.json` per-PID report: `status` (`ok`/`error`), `source_zip`, `source_sha256` (recomputed and compared with the capture manifest), `source_captured_at_utc`, `dims`, `row_count`, `ref_date_min/max`, `status_counts`, `symbol_counts`, `terminated_counts`, `blank_value_count`, `blank_value_by_status`, `codes_not_in_legend`, `duplicate_coordinate_ref_date`, `duplicate_vector_ref_date`, `parquet` (path, bytes, sha256), `errors`, `warnings`, `seconds`. A table with any hard error has no Parquet file. Hard errors: source hash mismatch, unexpected ZIP members, unknown or missing metadata block/column, observation header not matching the metadata dimensions, wrong row width, wrong coordinate part count, a row label that matches neither the member name nor `name [classification code]` (a quote-only difference is a warning), a non-integer ID field, a non-blank `VALUE` that is not `-?digits(.digits)?`.

### Catalogue tables

All rows carry `pid` (decimal string of the WDS `productId`). Inventory tables cover every PID in `inventory.json`; metadata tables cover only PIDs built with status `ok`.

| File | Source | Columns |
|---|---|---|
| `cube` | inventory | `product_id` (raw integer), `cansim_id`, `title_en`, `title_fr`, `cube_start_date`, `cube_end_date`, `release_time`, `issue_date`, `archived` (raw code string), `frequency_code`, `subject_codes`, `survey_codes` (lists), `dimension_count`, `correction_count` |
| `inventory_dimension` | inventory | `position`, `name_en`, `name_fr`, `has_uom` |
| `inventory_correction` | inventory | `correction_date`, `note_en`, `note_fr` (HTML) |
| `cube_meta` | metadata Cube block | `cube_title`, `product_id`, `cansim_id`, `url`, `cube_notes` (raw `;` list), `archive_status`, `frequency`, `start_reference_period`, `end_reference_period`, `total_dimensions`, `universe`, `variable_list` (2019 dialect only), `note_block_raw` |
| `dimension` | Dimensions block | `dimension_id`, `dimension_name`, `dimension_notes`, `dimension_correction_notes`, `dimension_definitions` |
| `member` | Members block | `dimension_id`, `member_id`, `member_name`, `classification_code`, `parent_member_id`, `terminated`, `member_notes`, `member_correction_notes`, `member_geo_attribute_keys`, `member_definitions` |
| `symbol` | Symbol Legend | `description`, `symbol` |
| `survey`, `subject` | Survey / Subject blocks | `survey_code`, `survey_name` / `subject_code`, `subject_name` |
| `note` | Notes block | `note_id`, `note` (raw text between the outer quotes; no CSV unescaping, because upstream mixes escaped and unescaped quotes) |
| `correction` | Corrections block | `correction_id`, `correction_date`, `correction_note`. Absent in the 2019 dialect. |
| `attribute` | member-attribute block (2019 dialect only, empty so far) | `dimension_id`, `member_id`, `attribute_key`, `title`, `label`, `long_label`, `value` |

Three writer dialects are handled: 2019 files (Cube row has `Universe`/`Variable List`, no Corrections block, a member-attribute block instead), 2020–2021 files (extra `Dimension Correction Notes`, `Member Correction Notes`, `Member Geo Attribute Keys` columns), and current files. Optional columns are null when the file does not have them. Notes and corrections are parsed by record start (`N,` / `N,date,`), not as CSV, because their text has unescaped quotes. Every other value is the raw string from the file.

### Observations `obs/<PID>.parquet`

One schema for every table, sorted by `member_id_1..9, ref_date, row_index`, ZSTD, 100,000-row groups.

| Column | Type | Meaning |
|---|---|---|
| `pid` | string | table |
| `row_index` | int64 | 1-based data row in the source CSV |
| `ref_date`, `dguid`, `uom`, `scalar_factor`, `vector`, `coordinate`, `value`, `status`, `symbol`, `terminated` | string | raw text, untrimmed; empty string when the field was empty |
| `uom_id`, `scalar_id`, `decimals` | int32 | parsed integer codes |
| `value_num` | float64 | `VALUE` as a number; null when blank. Use `value` and `decimals` for exact display. |
| `member_id_1` … `member_id_9` | int32 | `COORDINATE` parts; null beyond the table's dimension count |

Labels (`GEO` and the other dimension columns) are not stored. The build checks every row's labels against the member table and refuses the table on any mismatch, so `member` + `member_id_k` reproduces them exactly.

## Results on the 10-PID sample (build `m1a`)

All 10 built with status `ok` in 14 s. Full-file findings extend [DATA_LAYOUT.md](DATA_LAYOUT.md), which had seen only the first 20,000 rows:

- `(coordinate, ref_date)` and `(vector, ref_date)` are unique in every file.
- Row counts: 498 to 861,300 (12100087). Reader throughput was about 170,000 rows/s.
- Parquet is smaller than the source ZIP: 12100087 is 3.8 MB Parquet from a 16.7 MB ZIP (211 MB CSV); 10100139 is 2.1 MB from 3.4 MB. All 10 observation files total 13.6 MB against 34.8 MB of ZIPs. Labels are dropped and ZSTD compresses the rest well. Do not extrapolate to Census tables.
- `STATUS` over whole files: `..`, `F`, `x` always had a blank `VALUE`; `E` never did. No other code appeared. `SYMBOL` was empty in every row.
- 12100087's Notes block contains a CSV-escaped `""`; the build records a warning and stores the text raw.
- DuckDB on the largest file: one full series (7 member filters) or a `ref_date` range answered in about 2 ms from a warm cache.

## Results on a 96-PID stratified batch (builds `batch1`, `batch1-retry`) and one 1.9 GB ZIP (`big1`)

96 captured PIDs were drawn with seed 20260930, 16 per stratum of inventory archive code × dimension band (1–2, 3–4, 5+). The first pass failed 30; all 30 were parser gaps, fixed and rebuilt with the 10 anchors (anchor hashes unchanged):

- 18 tables: row labels carry the classification code, `Logging [1133]`, while the member name does not. `GEO` labels never do.
- 9 tables: 2019 writer dialect (extra Cube columns, no Corrections block, member-attribute block).
- 2 tables: correction notes with unescaped quotes.
- 1 table (13100635): 6,048 observation rows whose labels lost inner quotes (`(denominator for Exposed ... home")"`); accepted with a warning because the member table is authoritative.

Whole-batch facts: 107.6 M rows in the 66 first-pass successes; `STATUS` codes seen: `..`, `A`–`F`, `x`, `0s`; `SYMBOL` seen: `p`, `r`; every code was in the file's own legend; no duplicate `(coordinate, ref_date)` or `(vector, ref_date)` anywhere. Parquet totalled 291 MB from 1,152 MB of ZIPs (0.25×).

Largest table so far, 24100055 (1.86 GB ZIP, 5 dimensions): 202,174,587 rows, built in 45 min at about 74,000 rows/s, 336 MB Parquet (0.18×). DuckDB's sort spilled to `tmp/` and left free space unchanged afterwards. The Python `csv` reader is the bottleneck; the largest captured ZIP (12100152, 6.9 GB) would take about 3 h at this rate. Options when that matters: run PIDs in parallel processes, or move observation parsing to DuckDB's CSV reader and keep the Python checks as SQL.

Not covered: Census-layout tables (none captured yet), tables with a `Release` dimension, French ZIPs, the 2–7 GB ZIPs.

## Normalized layer

[`tools/wds_normalize.py`](tools/wds_normalize.py) reads one or more Clean builds and the captured WDS code sets and writes the Normalized files described in [SCHEMA.md](SCHEMA.md). It never changes a Clean file. Output goes to `<first-clean-build-dir>/normalized/<build-id>/`; an existing build ID is refused. The inputs and the output must sit on the UUID-checked SSD. The tool checks the code set file against its sibling `.sha256` file and stops on a mismatch.

```bash
.venv/bin/python -B tools/wds_normalize.py \
  --clean /run/media/hemanth/Kingston/statcan-derived/wds-full-1 \
          /run/media/hemanth/Kingston/statcan-derived/census-full-1 \
  --codesets /run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json \
  --mount-uuid 72D0-2131 --build-id <normalized-build-id> --memory-gib 4 --threads 2
.venv/bin/python -B -m unittest tools.test_wds_normalize
```

DuckDB works in `<build-id>/tmp/` (a work database and spill files); the folder is deleted at the end. Observation files are read one at a time, never all at once. Small output files are sorted and written by one DuckDB thread, because parallel Parquet writers cut row groups at different rows from run to run. `series/` is written as one DuckDB-compressed Parquet part per PID; this avoids a monolithic staging table or duplicate final `series.parquet` during Census builds. Census Clean verifies that each cell has one observation and arrives in member-ID order. Its direct series projection uses constant member-label and place lists rather than per-cell joins or a second sort. A single writer retains that order. The same Clean build, code sets, `data/ref/*.csv`, and tool versions give byte-identical Parquet files.

For a unit-map-only rebuild, `--reuse-census-from <normalized-dir>` copies Census series parts from a previous combined build. exFAT has no hardlinks or reflinks. Reuse checks both Clean manifest hashes and every Census Clean observation SHA-256, the code-set and place-alias hashes, tool versions, and null Census unit columns. It also requires byte-identical `period`, `place`, and `member_place` files. Every source and copied part is checked against the source manifest SHA-256. The new manifest records the source manifest hash, reused part count, rows, bytes, and per-part hashes. Reference CSV hashes are captured before they are read and checked again before finalizing the build; a reference edit during a run now fails rather than recording the later version.

### Output contract

| File | One row per | Columns and rules |
|---|---|---|
| `frequency`, `subject`, `survey`, `uom`, `scalar`, `status`, `symbol`, `classification_type`, `security_level`, `terminated` | code in `codeSets.json` | `code` (integer where StatCan gives integers, string where it gives strings: `subject`, `survey`, `status`, `symbol`), `en`, `fr`, `representation` (English display text such as `..`, `p`, or `x`; null for sets without one). `security_level` comes from official `securityLevel`. `wdsResponseStatus` is not written. |
| `unit_family` | `uom_id` seen in any Clean `obs` file | `uom_code`, `family`, `symbol`, `base_year`, `note`, taken from the hand-kept [`data/ref/unit_family.csv`](data/ref/unit_family.csv). A code missing from the CSV gets `family = other` and a manifest warning. Census rows with null units do not create a unit row. |
| `period` | `(pid, ref_date)` seen in any Clean `obs` file | `pid`, `ref_date`, `period_start`, `period_end`, `period_kind` from the rules below. |
| `place` | place seen in the data | `place_id`, `dguid`, `vintage`, `geo_type`, `schema`, `geo_code`, `name_en`, `level`, `parent_place_id` (see below) |
| `member_place` | member of dimension 1 (the `GEO` dimension) of every built table | `pid`, `dimension_id` (always 1), `member_id`, `place_id`, `match` (`dguid`, `code`, `name`, `none`), `note` (why earlier rules did not apply) |
| `series/*.parquet` | `(pid, vector)` when `vector` is non-empty; otherwise `(pid, coordinate)` | One part per built PID. Columns: `pid`, `vector`, `coordinate`, `member_id_1..9`, `label_1..9` (member names), `place_id` (via `member_place` for `member_id_1`), `uom_code`, `unit_family`, `scalar_code`, `decimals`, `period_kind`, `period_min` (earliest `period_start`), `period_max` (latest `period_end`), `n_obs`, `n_published` (non-blank `value`), `terminated` (boolean: any row has `t`), `last_status` (`status` at the latest `ref_date`). Sorted by `pid, member_id_1..9`. |
| `table` | PID in the Clean `cube` table (all inventory PIDs, built or not) | all `cube` columns, then `kind` (`time_series` when `cube_start_date` differs from `cube_end_date`, else `snapshot`), `family` (`census_2021` for PIDs starting `98`, else `wds`), `frequency_en`, `subject_en[]`, `survey_en[]` (code-set labels in inventory order), `queryable` (Clean has an `obs` file), `clean_build_id`, `row_count`, `series_count`, `period_min`, `period_max`, `unit_families[]`, `place_levels[]`, `n_places_mapped`, `n_places_unmapped` (all from `series_stats` and `member_place`; null when not built), `search_title`, `search_dimensions`, `search_members`, `search_notes`, and compatibility `search_text` (the four search fields joined by ` | `) |
| `normalize_manifest.json` | build | build ID, `clean` (single-input compatibility record), `cleans[]` (each Clean build ID/path/manifest hash), code set path and SHA-256, SHA-256 of both `data/ref` CSVs, tool versions, per-file rows/bytes/SHA-256, `files["series/"]` with the part-directory summary, `stats` (place `match` counts, `period_kind` counts by series and by observation, places whose parent differs between tables), `warnings` |

Warnings the build records instead of failing: exact duplicate rows in the Clean catalogue (dropped), unit codes missing from `unit_family.csv` or from the `uom` code set, frequency/subject/survey codes missing from the code sets, `ref_date` text with an unknown shape (listed by PID and shape), series whose unit, scale, decimals, terminated flag, DGUID, coordinate, or period kind changes between rows, geography members without a place, and a PID whose observation count differs from the Clean manifest. The build fails if a member key has two different rows or if any `series.n_obs` does not equal the observations grouped into that series key.

### Period rules

`period(ref_date, frequency_code)` is a pure function. The text gives the start; the table frequency only lengthens the end where the text shape is ambiguous.

| `ref_date` shape | Frequency | `period_start` – `period_end` | `period_kind` |
|---|---|---|---|
| `YYYY` | any | Jan 1 – Dec 31 | `year` |
| `YYYY-MM` | 9 Quarterly, 19 Occasional Quarterly | first of month – end of third month | `quarter` |
| `YYYY-MM` | 11 Semi-annual | first of month – end of sixth month | `half_year` |
| `YYYY-MM` | any other | the month | `month` |
| `YYYY-MM-DD` | 2 Weekly | the date – date + 6 days | `week` |
| `YYYY-MM-DD` | any other | the date | `day` |
| `YYYY/YYYY`, years one apart | any | Apr 1 – Mar 31 of the second year | `fiscal_year` |
| `YYYY/YYYY`, years further apart | any | Jan 1 of the first year – Dec 31 of the second | `multi_year` |
| anything else, or an invalid date | any | null – null | `other`, plus a manifest warning |

"Every N years" tables write `YYYY` and report one reference year, so they get `year`, not an N-year span. "Occasional Daily" 17100009 writes quarterly `YYYY-MM-DD` dates; they are days. *To verify:*

- `fiscal_year` bounds. Of the 5 `YYYY/YYYY` tables in `v0`, 27100029 says "fiscal year" and 21100137 says "business year ending between April 1st and March 31st"; 17100006 (deaths) and 17100051 (births, "July 1 to June 30") use demographic years, so April–March is wrong for them. A per-table override is needed; it is not built.
- `week`: 10100073 dates are Wednesdays; whether the date starts or ends the week is not stated.
- `multi_year`: 13100457 ("four-year period estimates", `2007/2010`) is read as calendar years.
- Frequencies not seen in `v0`: 4 Biweekly and 7 Bimonthly fall to `day` / `month`.

### Place mapping

Only dimension 1 is mapped. It is `Geography` in 103 of 105 `v0` tables; the others are `Geography, place of residence` (13100756) and `Country of visit` (24100081). The rules run in the SCHEMA.md order, per member:

1. **`dguid`**: the member's observation rows carry exactly one `DGUID`, it matches `^\d{4}[AS]\d{4}\S+$`, and, when the member has a bracketed classification code, the code equals the parsed `geo_code`. `place_id` is the DGUID. The code check rejects `2021A11124` and `2016A11124` (11100053, 33100094): they fit the pattern but parse as schema `1112`, code `4`, while the member code is `[11124]`.
2. **`code`**: the member's classification code text is listed in [`data/ref/place_alias.csv`](data/ref/place_alias.csv) (`[0]`, `[00]`, `[11124]` → Canada; the 13 two-digit province and territory codes). `place_id = code:<schema>:<geo_code>`, for example `code:0002:35`; `vintage`, `dguid`, `geo_type` are null.
3. **`name`**: the member name equals a name of a country or province place found by rules 1–2, and all such names point to one `(schema, geo_code)`. `place_id` is the `code:` place for it.
4. **`none`**: `place_id` null; `note` lists why each rule failed.

Code length is not used to infer a schema, although SCHEMA.md suggests it. In `v0` the code `[3501]` means four places: Champlain District Health Council, Erie St. Clair LHIN, Southern Ontario agricultural region, and census division Stormont, Dundas and Glengarry. The 4-digit codes on non-DGUID members are 470 members of 5 health tables, all health regions, not census divisions. 5-digit codes mix peer groups and "Non CMA-CA" areas, and 7-digit codes serve both CSDs and CCSs. Add a code to `place_alias.csv` only when its meaning is certain.

`place.name_en` is the most common member name among members mapped to the place (ties: alphabetical first). `level` is `country` for schema `0000`, `province` for `0002`, and `schema:<code>` for every other schema until the Geographic Attribute File (92-151-X) is captured; that file would give level names, official names, and the parent chain below province. `parent_place_id` comes from `parent_member_id` when both member and parent map; when tables disagree (Nova Scotia's parent is Canada in most tables and Atlantic in three), the most common parent wins and `stats.places_with_conflicting_parents` counts it. The same place in two vintages is two `place` rows sharing `schema` and `geo_code`; "same place, any vintage" is a query on those two columns.

### Deliberately not mapped

- Places below province level by name, and any code not in `place_alias.csv` (health regions, economic regions, peer groups, "Non CMA-CA" areas, foreign countries).
- Regional aggregates without a DGUID (`Atlantic provinces`, `Canada (excluding territories)`, `Rest of Quebec`).
- Unit scale: `value × 10^scalar` is not stored (SCHEMA.md). Unit names are never rewritten; `unit_family` only groups codes.
- French labels beyond the code sets.

### Results on `v0` (build `n4`)

`n4` took 61.1 s (4 GB, 2 threads) and wrote 105 `series/*.parquet` parts plus 15 other Parquet files.

| File | Rows | Bytes |
|---|---:|---:|
| `series/` | 5,904,721 | 12,035,944 |
| `table` | 8,271 | 1,090,120 |
| `period` | 36,564 | 164,993 |
| `place` | 2,451 | 51,974 |
| `member_place` | 8,280 | 20,388 |
| `unit_family` | 42 | 1,525 |
| code sets (10 files) | 17 / 622 / 903 / 465 / 10 / 11 / 3 / 91 / 2 / 2 | 68,781 total |

- Place `match`: `dguid` 7,167, `code` 78, `name` 119, `none` 916. 1,747 of 2,451 places are schema `0502`. 66 places have parents that differ between tables.
- `period_kind` by series (observations): `year` 5,693,201 (80.0 M), `month` 56,719 (30.8 M), `multi_year` 127,120 (254 k), `half_year` 14,353, `quarter` 6,757 (295 k), `fiscal_year` 6,512 (306 k), `day` 54 (681 k), `week` 5 (10 k). No unknown `ref_date` shape.
- Unit codes: 42 in `obs`, all in `unit_family.csv`. `family = other` only for 301 `Vehicle-kilometres`.
- Warnings: the Clean `v0` catalogue holds 10100139's metadata twice (40 member, 2 dimension, 1 note duplicate rows, dropped), and 916 geography members have no place. No series changes unit, scale, decimals, terminated flag, DGUID, or coordinate between rows. Series sums equal the Clean row counts.
- Spot checks: `Ontario` is a member in 47 tables; all map to schema `0002`, `geo_code` `35` (`2011A000235`, `2016A000235`, `2021A000235` by DGUID; `code:0002:35` by name in 8 tables). 10100004 (quarterly, `YYYY-MM`) has 354 series, all `quarter`, 1978-04-01 to 2026-06-30. 18100006 (CPI) has 11 series, all `uom_code` 17 (`2002=100`), `unit_family = index`, `month`.

### Full combined Normalized build (`n7`)

`statcan-n7.service` completed successfully on 2026-10-04 in 37,859.1 s (10 h 31 min) at `--memory-gib 6 --threads 4`. The first pass over both Clean builds took 3,848.0 s; the per-PID series writes took 33,737.6 s, including 24,275.9 s (6 h 45 min) for Census and 9,428.0 s (2 h 37 min) for WDS. `table` took 13.9 s; cleanup and manifest took 233.4 s. The unit's memory ceiling was raised from 12 to 16 GiB after `statcan-n6` finished; the DuckDB 6 GiB limit did not change.

| File | Rows | Bytes |
|---|---:|---:|
| `series/` | 50,554,526,028 | 39,379,166,481 |
| Census series (525 parts) | 49,923,588,701 | 37,839,344,269 (35.24 GiB) |
| WDS series (7,736 parts) | 630,937,327 | 1,539,822,212 (1.43 GiB) |
| `table` | 8,271 (8,261 queryable) | 9,479,581 |
| `period` | 583,137 | 1,303,452 |
| `place` | 106,593 | 926,226 |
| `member_place` | 1,707,502 | 4,062,537 |

`normalize_manifest.json` lists both input Clean builds, all 8,261 per-PID parts, and six warnings: duplicated inventory rows across the two inputs (dropped), varying scalar in 24100029, varying DGUID/period kind in 33100167, 362 unit codes absent from `unit_family.csv`, and 88,259 geography members without a mapped place. No Census table has a warning. File existence and the part-directory summary hash match the manifest; sampled Parquet hashes match. `table` contains 7,736 WDS and 525 Census queryable PIDs. Its family row-count sums match both Clean manifests. Census 98100001 and 98100404 have `n_obs = 1` in every series row and 154 and 551,712,000 rows respectively; WDS 18100006 and 12100152 series sums match their Clean observation counts. The SSD had 207 GiB free after the run, above the 150 GiB reserve.

API inputs: `STATCAN_BUILD=/run/media/hemanth/Kingston/statcan-derived/wds-full-1`, `STATCAN_NORMALIZED=/run/media/hemanth/Kingston/statcan-derived/wds-full-1/normalized/n8`, and `STATCAN_CODESETS=/run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json`. The API validates both entries in `normalized.cleans[]`, loads each Clean catalogue, and routes each PID to its own Clean observation Parquet. Set `STATCAN_CAPTURE=/run/media/hemanth/Kingston/statcan-wds/baseline` to serve captured original source ZIPs for both families. See [api/README.md](api/README.md).
Direct DuckDB search over the `n7` table's 8,271 rows took 14–25 ms for the observed `population` and `inflation` queries in the original build check. A separate 20-query direct table-scan check had p50 10.2 ms and p95 22.4 ms; HTTP search is measured separately.

### Full combined Normalized build (`n8`)

`statcan-n8.service` completed on 2026-10-04 in 16,109.0 s (4 h 28 min 29 s), at `--memory-gib 6 --threads 4` and a 12 GiB systemd memory ceiling. Its log is `/run/media/hemanth/Kingston/statcan-derived/n8.log`. The first stage, including the Census reuse checks, took 2,785.3 s; series output took 10,681.0 s. `--reuse-census-from /run/media/hemanth/Kingston/statcan-derived/wds-full-1/normalized/n7` verified the two Clean inputs, all 525 Clean Census observation hashes, all 525 source series hashes, null Census units, and the unchanged shared files. It then copied and rechecked all 525 Census parts (37,839,344,269 bytes). The n8 manifest records the n7 manifest hash and those reuse checks. No n6 or n7 files were removed. On 2026-10-04 the retired builds were deleted to free space: Normalized n3, n4, n6 and n7, and the sample Clean builds v0, big1, census-big1 and census-s2a. n8 is the only Normalized build kept; the full Clean builds and raw captures remain. The `wds-full-1/parts/` folder (14 GB of per-PID catalogue parts, already merged into `catalogue/` and not listed in the manifest) was also deleted; only `wds_build.py --resume` reads it.

Launch command (use a new build ID to repeat it):

```bash
systemd-run --user --unit=statcan-n8 \
  --working-directory=/home/hemanth/Projects/statcan --property=MemoryMax=12G \
  bash -c 'exec .venv/bin/python -u -B tools/wds_normalize.py \
    --clean /run/media/hemanth/Kingston/statcan-derived/wds-full-1 \
            /run/media/hemanth/Kingston/statcan-derived/census-full-1 \
    --codesets /run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json \
    --mount-uuid 72D0-2131 --build-id n8 --memory-gib 6 --threads 4 \
    --reuse-census-from /run/media/hemanth/Kingston/statcan-derived/wds-full-1/normalized/n7 \
    > /run/media/hemanth/Kingston/statcan-derived/n8.log 2>&1'
```

| Output | Rows | Bytes |
|---|---:|---:|
| `series/` (8,261 parts) | 50,554,526,028 | 39,379,160,759 |
| WDS series (7,736 parts) | 630,937,327 | 1,539,816,490 |
| Census series (525 parts) | 49,923,588,701 | 37,839,344,269 |
| `table` (8,261 queryable PIDs) | 8,271 | 9,479,661 |
| `unit_family` (observed UOM codes) | 404 | 4,089 |

| Unit family | Series rows |
|---|---:|
| area | 24,241,752 |
| count | 236,393,436 |
| currency | 163,004,355 |
| energy | 30,440 |
| index | 200,783 |
| length | 38,710 |
| mass | 83,151 |
| other | 341,893 |
| percent | 193,897,379 |
| rate | 5,167,562 |
| ratio | 1,066,865 |
| time | 6,424,772 |
| volume | 46,229 |
| Census (null) | 49,923,588,701 |
| **Total** | **50,554,526,028** |

The updated CSV covers all 465 official UOM codes; `tools/check_unit_family.py` reports zero missing. All 630,937,327 WDS series rows have the CSV family for their code. Compared with n7, only `unit_family.parquet`, `table.unit_families`, and `series.unit_family` changed: 1,205 WDS part hashes changed, with all 146,582,436 non-family rows in those parts identical; the other parts have identical hashes. The 1,205 changed table family lists have the same PIDs; every other table column and every other small file is identical. All 525 Census part hashes match n7, and their unit columns remain null. The five remaining warnings concern duplicate inventory rows, varying scalar or DGUID/period kind in two WDS tables, and 88,259 unmapped geography members. There is no missing-unit-family warning. The SSD had 171 GiB free after the build, above the 150 GiB reserve.

The n7 manifest's `unit_family.csv` hash happens to equal n8's: the CSV was edited during n7, after n7 had read it, and n7 recorded reference hashes only at the end. Its 362-missing-code warning and Parquet values show that it used the old map. n8 records reference hashes before reading and checks them again before finalizing.

## Census layout

[`tools/wds_census.py`](tools/wds_census.py) builds the 525 Census tables (PIDs `98…`). It has the same command line, safety checks (UUID, reserve, read-only ZIPs), output contract, obs schema, sort order, ZSTD and row-group settings as `wds_build.py`, and imports its metadata parser, schemas, and worker setup. The manifest adds `"family": "census_2021"` at the top level. PIDs that do not start with `98` are refused.

```bash
.venv/bin/python -B tools/wds_census.py \
  --capture /run/media/hemanth/Kingston/statcan-wds/baseline \
  --out /run/media/hemanth/Kingston/statcan-derived \
  --mount-uuid 72D0-2131 --pids 98100034,98100001 --jobs 1
.venv/bin/python -B -m unittest tools.test_wds_census
```

### Layout as observed

Evidence: the observation header and metadata of all 525 ZIPs; every row of the 194 smallest (ZIP under 5 MB: 1.95 GB of CSV, 98.1 M cells); full builds of 98100456 (medium) and 98100404 (largest ZIP).

- Same two ZIP members as ordinary tables.
- Metadata uses the 2020–2021 writer columns (`Universe` and `Variable List` on the Cube row, `Dimension Correction Notes`, `Member Correction Notes`, `Member Geo Attribute Keys`). **No file has a Subject block** (the inventory `subjectCode` is null for all 525 too), so `wds_census.read_metadata` accepts a missing Subject block and `catalogue/subject` stays empty. The Corrections header is always empty and is followed directly by a member-attribute block, which holds geography attributes only (`ALT_GEO_CODE`, `GEO_LEVEL_DESC`, `DGUID`, `DQF_CODE`, `TNR_SHORT_FORM` …).
- Observation header, all 525 files: `REF_DATE, GEO, DGUID, <names of dimensions 2..N-1>, Coordinate`, then one pair per member of dimension N: a value column, then `Symbol` (507 files) or `Symbols` (18). Dimension counts 2 to 9.
- Value column names: `<dimension N name>:<member name>[<member ID>]` in 505 files; `<dimension N name>: <member name> [<member ID>]` in 18; both in 2. 98100017 adds the member's note ID: `…, count (9) [3]`, where member 3 has `Member Notes` = `9`. Member names can end in a space (98100085, 98100230). Rule: the ID is the trailing `[digits]`; the text before it must start with `<dimension N name>:` and the rest, trimmed, must equal the trimmed member name or `name (member notes)`. Otherwise the table fails.
- `Coordinate` holds the member IDs of dimensions 1..N-1. Value column member IDs ascend in all 525 headers. Rows ascend strictly by coordinate in every file read in full.
- Every file ends with two blank lines. They are accepted only at the end.
- `REF_DATE` is `2021` in every row read. `DGUID` was never empty in the 194 files.
- 98100314, 98100378, and 98100379 write one label with a newline inside the quotes (`"95% confidence interval upper bound, Count\n"`) on every row. Labels that match only after removing double quotes and surrounding whitespace are accepted with a warning, like the ordinary reader's quote rule.

### Unpivot rule

One output row per (CSV row, value column), in the ordinary obs schema:

| Column | Census source |
|---|---|
| `coordinate` | `Coordinate` + `.` + member ID from the value column header (`1.1.1.1.1.3`), so `(pid, coordinate, ref_date)` stays unique |
| `member_id_1..N-1`, `member_id_N` | `Coordinate` parts; the header member ID |
| `row_index` | CSV data row, repeated across the row's value columns |
| `ref_date`, `dguid` | as in the row |
| `value`, `value_num` | the value cell; same numeric rule as ordinary tables |
| `status`, `symbol` | the Symbol cell, split as below |
| `vector` | `''`: Census files have no vector. `duplicate_vector_ref_date` is null. |
| `terminated` | `''`: no such column |
| `uom`, `scalar_factor` / `uom_id`, `scalar_id`, `decimals` | `''` / null: see Units |

All ordinary checks apply: header names against metadata, labels against member names (with the `[code]` and quote rules), coordinate part count (N−1), integer IDs, numeric `VALUE`, codes against the file's own legend, row count of the written file. Two checks are Census-specific:

- **Order instead of a sort.** Because rows and value columns arrive in member-ID order, the output is already in `member_id_1..9, ref_date, row_index` order. The reader fails a table whose coordinates do not strictly ascend, and nothing is sorted. The obs `COPY` runs on one DuckDB thread: without a sort, a parallel writer cut row groups at different rows in two runs of 98100456.
- **Duplicate check after writing** reads the written file's member IDs and fails the table unless every row is strictly above the previous one. That proves both the order and that `(coordinate, ref_date)` has no duplicate, so `duplicate_coordinate_ref_date` is always 0 in an `ok` table. The ordinary `GROUP BY coordinate, ref_date` took 343 s of a 456 s build on 98100456; this check takes 5 s.

### What `Symbol` holds

Status and symbol codes, from the same 14-code legend as ordinary tables (identical in all 525 files). Counts over the 194 fully read files:

| Cell | Cells | Value in those cells | Legend meaning |
|---|---:|---|---|
| empty | 83,584,376 | numeric | — |
| `...` | 10,235,568 | `0` in 10,233,857, blank in 1,711 | not applicable |
| `x` | 4,288,678 | always blank | suppressed (confidentiality) |
| `r` | 6,548 (11 tables) | numeric | revised |
| `..` | 3,373 | always blank | not available |
| `r,E` | 31 (3 tables) | numeric | revised + use with caution |
| `E` | 28 | numeric in 26, blank in 2 | use with caution |

98100456 adds 30.0 M `...` and 6.7 M `x`; 98100404 has no codes at all. Every code was in the file's legend.

The cell mixes two WDS code sets: `p` and `r` are in the `symbol` code set, the rest in `status`. Ordinary tables keep them apart (`STATUS` had `..`, `x`, `E`, `F`, `A`–`D`, `0s`; `SYMBOL` had `p`, `r`). So the reader splits the cell on `,`: `p`/`r` go to `symbol`, everything else to `status` (`r,E` → status `E`, symbol `r`). Two codes of one kind would be kept comma-joined; not seen. **`...` usually comes with `VALUE` `0`**: that zero means "not applicable", not a count of zero. Use `status`.

### Units

Census ZIPs carry no unit. There are no `UOM`, `UOM_ID`, `SCALAR_FACTOR`, `SCALAR_ID`, or `DECIMALS` columns; the Members block has no unit column; the attribute block is geography only. The inventory marks exactly one dimension per Census table `hasUOM` (the last dimension in 278 tables, another in 247), so units belong to members of that dimension, and today they are visible only in member names (`Population, count`, `…, intercensal growth (percent)`, a `Statistics` dimension with `Count` and `95% confidence interval lower bound, Count`). The reader writes `uom` and `scalar_factor` as `''` and `uom_id`, `scalar_id`, `decimals` as null. The WDS `getCubeMetadata` member `memberUomCode` would fill them; it is not captured.

### Results (builds `census-s2a`, `census-s2b`, `census-big1`)

Measured with `--jobs 1 --memory-gib 2` while the 4-worker full WDS build ran (load average 22–42 on 16 cores).

| PID | Dims | Rows | ZIP bytes | Parquet bytes | Parquet / ZIP | Seconds | Rows/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| 98100034 | 3 | 210 | 4,410 | 5,991 | 1.36 | 0.05 | |
| 98100039 | 3 | 378 | 4,622 | 6,951 | 1.50 | 0.07 | |
| 98100036 | 3 | 336 | 4,798 | 6,792 | 1.42 | 0.27 | |
| 98100001 | 2 | 154 | 5,611 | 5,599 | 1.00 | 0.12 | |
| 98100047 | 3 | 504 | 5,990 | 7,568 | 1.26 | 0.12 | |
| 98100456 | 6 | 56,839,860 | 102,604,595 | 75,732,301 | 0.74 | 124–140 | 407,000–460,000 |
| 98100404 | 6 | 551,712,000 | 3,304,669,435 | 619,047,607 | 0.19 | 2,552 | 216,000 |

- `census-s2a` and `census-s2b` matched on all 18 Parquet hashes (12 catalogue, 6 obs).
- Rows/s depends on value columns per CSV row (5 in 98100456, 3 in 98100404). CSV bytes/s is steadier: 17–19 MB/s and 14.8 MB/s. Worker peak RSS was 2.4 GB on 98100404.
- In 98100456, `coordinate` is 37.7 MB of the 75.7 MB file and `row_index` 13.1 MB. Each Census coordinate has one row, so the string does not compress like in time series. Dropping it (it equals the joined `member_id_k`) would roughly halve Census Parquet; that is a contract change and is not done.

### Projection for all 525

Row counts per file were originally estimated from bytes per row in the first 4 MB of each CSV (estimate / actual on the 194 fully read files: median 1.00, range 0.97–1.76; 98100404: 0.97). The completed `census-full-1` Clean build has 49,923,588,701 rows. At the measured 15–19 MB of CSV per second per worker:

- one worker: 25–32 h;
- `--jobs 4`: about 6–8 h, if each worker keeps its rate (measured while another 4-worker build ran); the longest single table (98100404, 37.7 GB CSV) takes about 43 min, and largest-first ordering keeps it off the tail;
- Parquet: 1.1–1.3 bytes per row, so about 60–70 GB; the tmp folder stays small because nothing is sorted;
- memory: about 2.4 GB per worker.

Normalized profiling on the 6-table `census-s2a` sample (56,841,442 cells, including 56,839,860 in 98100456) found an avoidable second sort of already ordered Census cells. Under concurrent `statcan-n6` load, the sorted `c-prof-1` run took 992.5 s and spilled over 8 GiB; the earlier `n4-estimate` took 548.5 s without the same load. The optimized `c-fast-4` took 37.0 s, and the repeat `c-fast-5` took 31.7 s: 26.8–31.3× faster than `c-prof-1`. `c-fast-4` spent 2.0 s on catalogue/code sets, 0.7 s on the period/series scan, 0.3 s on place/member_place, 33.1 s on series writes, 0.4 s on table, and 0.4 s on cleanup/manifest. Re-reading and hashing its 43.9 MB series output took 0.03 s from cache, so further scan/hash tuning would not address the bottleneck. No worker processes or Parquet setting changes were needed.

The optimized output has 56,841,442 series rows, 43,851,527 bytes (0.77 bytes/series), and zero warnings. All 22 Parquet hashes match between `c-fast-4` and `c-fast-5`. All 121 WDS `v0` manifest file entries (105 series parts, 15 other files, and the series directory summary) matched `n4` on SHA-256 in `n4-check-2`. The previous sorted Census output differs in one large part's Parquet row-group boundaries (13,672 more bytes in the optimized `series/`), but all 56,839,860 rows of that part match in physical order and every column; the five smaller series files match by SHA-256. Its logical contract is unchanged. Scaling the 37.0 s sample to 49,923,588,701 cells projected about 9.0 h and 35.9 GiB for Census Normalized series. The full `n7` run measured 6.74 h of Census PID writes and 35.24 GiB, faster and slightly smaller than projected. At launch, 248 GiB was free against a 150 GiB reserve; at completion, 207 GiB remained.

### Known limits

- No sort fallback: a file with rows out of coordinate order fails. Adding `ORDER BY` for that table (and the multi-threaded sort cost) is the fix if it ever happens.
- Units, scale, and decimals are empty (see Units).
- `vector` is empty, so any Normalized step keyed on `(pid, vector)` must use `(pid, coordinate)` for Census tables.
- `...` cells with `VALUE` `0` are stored as written; `value_num` is 0.0 for them.
- French ZIPs are not captured.
