# WDS ZIP layout: observations from a 10-table sample

Inspected 2026-09-30 UTC from the English baseline capture on the Kingston SSD (UUID `72D0-2131` verified before every read). ZIPs were opened read-only with Python `zipfile`. Nothing was extracted. Only `baseline/zips/<PID>-en.zip` and, for archive/frequency joins, `baseline/inventory.json` were read. Manifests, logs, partials, and the downloader were not touched. No network access.

**This is a sample of 10, not a survey.** Every "always" below means "in these 10". At inspection time 1,880 `*-en.zip` files existed; their PIDs ran from `10100001` to `18100006`, mostly subjects 10–14 (one each from 17 and 18). No Census-layout ZIP (`98…`) had been acquired yet. **Census layout: pending, not inspected.** French: deferred, not inspected.

Observation CSVs were read only through a bounded streaming reader: header plus the **first 20,000 data rows** (fewer if the file is shorter). Tail rows, full row counts, and whole-file value distributions are **unknown**. Metadata CSVs (4–23 KB each) were read in full.

## Sample

| PID | ZIP bytes | Obs CSV bytes (uncompressed, from ZIP directory) | Dims | Inventory `archived` | Metadata frequency (inventory code) | Why chosen |
|---|---:|---:|---:|---|---|---|
| 10100139 | 3,378,957 | 95,914,476 | 2 | `2` current | Daily (1) | Blank values with `..`; 40 members, many terminated |
| 17100009 | 30,842 | 418,418 | 1 | `2` current | Occasional Daily (21) | 1 dimension; frequency label anomaly |
| 18100006 | 29,957 | 601,320 | 2 | `2` current | Monthly (6) | Simple index; notes contain HTML |
| 13100096 | 4,926,835 | 73,869,672 | 5 | `1` archived | Occasional (18) | Archived; `E`, `F`, `..` statuses; Number and Percent rows |
| 11100053 | 8,336,467 | 143,794,307 | 5 | `2` current | Annual (12) | 2 corrections; `x`; thousands scalar |
| 12100146 | 41,234 | 878,746 | 8 | `2` current | Annual (12) | 8 dimensions; no CANSIM ID; millions scalar |
| 12100087 | 16,738,146 | 210,989,806 | 7 | `1` archived | Monthly (6) | Older writer style; largest sampled; correction record |
| 10100004 | 881,842 | 11,158,306 | 4 | `2` current | Quarterly (9) | Quarterly, `YYYY-MM` dates |
| 10100146 | 4,803 | 77,515 | 2 | `2` current | Quarterly (9) | Tiny; no CANSIM ID; empty Notes section |
| 14100179 | 439,010 | 7,463,159 | 2 | `1` archived | Monthly (6) | Oldest writer style; CRLF data; 10-column member table |

Every ZIP had exactly two members and an empty ZIP comment:

- `<PID>.csv`: observations.
- `<PID>_MetaData.csv`: cube metadata.

Both members were deflate-compressed. Member timestamps range from 2020-01-20 (14100179) to 2026-09-29 (10100139), so they reflect when each table was last generated, not the reference period.

## Observation CSV (`<PID>.csv`)

- UTF-8 with BOM in all 10. Comma-delimited, quoted fields. Parse with `encoding="utf-8-sig"` and `newline=""`. Line endings were LF in nine files; `14100179.csv` is CRLF in its first 4 KiB. Mixed endings inside a file are unknown.
- Row-per-observation ("long"). Row width equals header width in all sampled rows.
- **Columns vary by table.** Shape is:
  `REF_DATE, GEO, DGUID, <dimension 2..N names>, UOM, UOM_ID, SCALAR_FACTOR, SCALAR_ID, VECTOR, COORDINATE, VALUE, STATUS, SYMBOL, TERMINATED, DECIMALS`
  Dimension-column count is `Dims − 1` (Geography is `GEO` + `DGUID`). Widths seen: 14 (1 dim), 15 (2 dims), 17 (4), 18 (5), 20 (7), 21 (8).
- Dimension column names match `Dimension name` in the metadata file exactly (Geography ↔ `GEO`) for all 10.
- `COORDINATE` is a dot-joined list of member IDs, one per dimension in metadata order (e.g. `1.1.1.1.2`). Part count equalled `Dims` in every sampled row. For every sampled row of every table, part *k* plus dimension *k* resolved to a Member ID whose name equalled the row's label (0 mismatches over the rows read; see limits above). So `(dimension ID, member ID)` is a usable join key to the metadata member table.
- `VECTOR` (e.g. `v41690914`) identifies a series; `COORDINATE` identifies the cell. Uniqueness of either across the whole file was not checked.
- `VALUE` is text. Trailing zeros are meaningful as written (`83.1`, `82.0`, `4.30`, `3.00`). `DECIMALS` gives the declared precision. No non-numeric non-blank `VALUE` appeared in the sampled rows. Keep the raw string; derive numbers separately.
- `REF_DATE` widths seen: `2015` (annual), `1992-01` / `1978-04` (monthly/quarterly), `1960-07-22` (daily). **It does not follow the frequency label:** 17100009 is labelled "Occasional Daily" but its `REF_DATE` values are `YYYY-MM-DD` at quarterly steps (`1946-01-01`, `1946-04-01`). Store as text with the table's frequency; do not derive frequency from date shape.
- `UOM`, `UOM_ID`, `SCALAR_FACTOR`, `SCALAR_ID` **vary per row within a table**:
  - 13100096: `Number` (UOM_ID 223) and `Percent` (239).
  - 11100053: `Dollars` with `units` (scalar ID 0) and `Number` with `thousands` (scalar ID 3).
  Unit and scale therefore belong on the observation (or on the series), not the table.
- `SCALAR_FACTOR` has a **trailing space** (`units `) in 12100087 and 14100179 (the two oldest-style files); `units` in all others. Preserve raw; trim in a derived column.
- `DGUID` empty in 13100096 for `Canada (excluding territories)` and in all sampled 14100179 rows (archived tables). Other tables carry values like `2016A000011124`, `2021A11124`, `2016S0503001`. The vintage prefix differs (2016 vs 2021) between tables. GEO labels are therefore not enough to identify geography.
- `TERMINATED` is `t` or empty per row; seen in 10100139, 17100009, 13100096, 11100053, 14100179. Meaning of the row-level flag beyond "series terminated" is not documented in these files; the metadata member table has a `Terminated` column with the same `t`.

## Status, symbols, and missing values (sampled rows only)

Symbol legend in every metadata file (same fixed list): `..` not available for a reference period; `<LOD`; `0s` rounded to zero; `A`–`D` quality grades; `E` use with caution; `F` too unreliable to be published; `...` not applicable; `p` preliminary; `r` revised; `x` suppressed for confidentiality; `t` terminated.

| PID | `STATUS` values in first ≤20,000 rows | Relation to blank `VALUE` |
|---|---|---|
| 10100139 | `..` (16,000), empty (4,000) | `..` ⇔ blank `VALUE` (16,000 of 16,000) |
| 13100096 | empty, `E` (4,378), `F` (2,224), `..` (616) | `F` and `..` ⇒ blank; `E` rows kept a `VALUE` |
| 11100053 | empty, `x` (371) | `x` ⇒ blank (371 of 371) |
| others (7) | only empty | no blank `VALUE` in the sample |

- `SYMBOL` was **empty in all 10 sampled files' sampled rows**. Its role versus `STATUS` is unknown; do not drop it.
- Blank `VALUE` was always accompanied by a non-empty `STATUS` in this sample. The converse is false (`E`). Unknown: other codes (`p`, `r`, `A`–`D`, `<LOD`, `0s`, `...`) in unread rows or other tables.
- Blank means no number was published. It is not zero. Keep `VALUE` raw, `STATUS`, and `SYMBOL`; expose the legend text.
- 10100139: the first rows (1960) are blank with `..` because series exist in the table before they started. Unread rows may differ.

## Metadata CSV (`<PID>_MetaData.csv`)

UTF-8 with BOM, LF. It is **not one rectangular CSV.** It is eight blocks separated by a blank line. Each block has its own header (the legend block starts with a bare `Symbol Legend` line, then `Description,Symbol`). Blocks appeared in this order in all 10:

1. **Cube**: header `Cube Title, Product Id, CANSIM Id, URL, Cube Notes, Archive Status, Frequency, Start Reference Period, End Reference Period, Total number of dimensions`; one data row. `Cube Notes` is a `;`-joined list of Note IDs (e.g. `1;2;3;4;6;7;10`) or empty. `CANSIM Id` empty for 12100146 and 10100146. `Archive Status` was `CURRENT - a cube available to the public and that is current` or `ARCHIVED -  a cube publicly available but no longer being updated` (two spaces after the hyphen). In all 10 it agreed with the inventory (`2` ⇒ CURRENT, `1` ⇒ ARCHIVED). Frequency is a text label in the file (Daily, Monthly, Quarterly, Annual, Occasional, Occasional Daily).
2. **Dimensions**: `Dimension ID, Dimension name, Dimension Notes, Dimension Definitions` (one row per dimension).
3. **Members**: `Dimension ID, Member Name, Classification Code, Member ID, Parent Member ID, Terminated, Member Notes, Member Definitions`. `Parent Member ID` encodes hierarchy (18100006: "Food" has parent `1` "All-items"). `Classification Code` holds values like `[11124]` for Canada. Member counts seen: 7 to 217 rows.
4. **Symbol legend**: 14 description/symbol pairs (identical text across the 10).
5. **Survey**: `Survey Code, Survey Name` (12100146 has 2 rows).
6. **Subject**: `Subject Code, Subject Name`.
7. **Notes**: `Note ID, Note`. Values may contain HTML (`<a href=…>`) and multi-line text. 10100146 has an empty Notes block.
8. **Corrections**: `Correction ID, Correction Date, Correction Note`. Empty in 8 of 10. Non-empty: 11100053 (2 rows), 12100087 (1 row, dated 2013-07-12). These agree with the inventory `corrections` counts read for those PIDs.

### Two writer dialects seen

| Property | Newer (8 files, incl. 13100096 generated 2024-10) | Older (12100087 gen. 2021, 14100179 gen. 2020) |
|---|---|---|
| Cube row | quoted, trailing empty field (11 cells) | mostly unquoted, no trailing field (10 cells) |
| Symbol legend rows | trailing comma (3 cells) | 2 cells |
| Dimension header | 4 columns | 12100087: 4 columns; **14100179: 5 columns, adds `Dimension Correction Notes`** |
| Member header | 8 columns | 12100087: 8 columns; **14100179: 10 columns, adds `Member Correction Notes` and `Member Geo Attribute Keys`** |

The dialect is not tied to archive status: 13100096 is archived but uses the newer style. Parse each block by **header names, not positions**, and tolerate optional columns.

### Parse hazards seen

- **Notes are not safe for a strict CSV parser.** In 18100006 and 13100096 some notes contain unescaped `"` inside quoted text (HTML attributes). Python `csv` (non-strict) returned 2–12 fields for some Note rows and merged neighbours; `strict=True` raised `',' expected after '"'`. Treat the Notes block as: record starts on a line matching `^\d+,`; text is the remainder, trimmed of one outer quote pair. Store raw block text as well. Unknown: whether any note contains a blank line, which would break the block split.
- Cube, Dimensions, Members, Symbols, Survey, Subject: standard `csv` parsing gave uniform row widths in all 10.
- Metadata files can end with an extra blank block (11100053, 12100087, 14100179).
- `Cube Title` and dimension names can contain commas; quoting handles it.

## Differences across table shapes (observed)

- Dimension count 1 to 8, so the observation column set differs per table. A fixed wide schema will not fit; use the long form `(pid, coordinate, ref_date, vector, value, status, …)`, with labels resolved through the metadata member table.
- Archived vs current: three archived (`1`) and seven current (`2`) tables. Archived ones had earlier end dates (2010-12, 2018-09, 2022) and empty `DGUID` in two of three. No structural observation-CSV difference beyond the metadata dialect and empty DGUID.
- Reference date width and frequency label (see above), with the 17100009 anomaly also present in the embedded metadata (`Occasional Daily` for code 21), so it is upstream, not our inventory join.
- Unit/scale per row, not per table.
- Correction notes exist in the metadata in some tables (`Corrections` block), and the inventory also lists them.
- Explicit `Release` dimension: none of the 10 has one (18100259 and 36100430 from the earlier survey were not yet acquired).

## Implications for a first queryable cohort

- Use PID as identity. Two of ten lack CANSIM IDs.
- Join on `(dimension ID, member ID)` from `COORDINATE`; it held on all sampled rows.
- Keep as stored text: `REF_DATE`, `VALUE`, `STATUS`, `SYMBOL`, `UOM`, `SCALAR_FACTOR`, `DGUID`. Add derived columns (numeric value, trimmed scalar, parsed date) separately.
- Do not equate blank `VALUE` with a specific status; `..`, `F`, `x` all produced blanks; `E` did not.
- The metadata parser must handle two dialects and unsafe Notes. Fail on an unrecognized block header rather than skipping it.
- The catalogue search text can come from inventory titles plus metadata dimension names, member names, survey, and subject, plus note text (HTML) if wanted. Member lists were small in this sample (≤218 rows); the size in large Census tables is unknown.
- For a cohort with large tables, stream the CSV; 12100087 is 211 MB uncompressed from a 16.7 MB ZIP (about 12.6:1), 10100139 is 96 MB from 3.4 MB (about 28:1).

## Unknowns

Full-file row counts, `STATUS`/`SYMBOL` distributions, and `VECTOR`/`COORDINATE` uniqueness for these 10 were later checked by [`tools/wds_build.py`](tools/wds_build.py); see [BUILD.md](BUILD.md). Still unknown:

- Census-layout ZIPs (`98…`): not yet acquired; layout described in DATA_SURVEY.md is unverified here.
- Tables with an explicit `Release` dimension, French ZIPs, and very large tables.
- Whether the two metadata dialects and CRLF appear at a specific generation date or per subject.

## Minimal next step

1. Ingest `inventory.json` into a `cube` catalogue table (PID, titles, frequency code, archived code, start/end dates, survey/subject codes, correction count). This covers all 8,271 PIDs without opening any ZIP.
2. Write one `read_metadata(zip_path)` returning the eight blocks by header name, with the raw Notes text kept. Load acquired ZIPs into `dimension`, `member`, `symbol`, `note`, `correction`. Search over titles, dimensions, members, and notes.
3. Write one streaming `read_observations(zip_path)` yielding raw string fields, then split `COORDINATE` into member IDs. Check header names, row width, coordinate part count, and unseen `STATUS` values; log rather than skip.
4. Run both over these 10 PIDs plus a wider stratified batch, and record per-PID failures. Add a Census-layout reader only after a `98…` ZIP is acquired.
