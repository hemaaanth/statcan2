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
