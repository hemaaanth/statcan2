# Live Statistics Canada data survey

Observed 2026-09-29 EDT / 2026-09-30 UTC. This is a small empirical survey, not a complete corpus inventory or a storage estimate. The catalogue and format checks were read-only research; their downloaded responses and ZIPs have **not** been preserved in this repository.

## WDS table inventory

The official [`getAllCubesList`](https://www150.statcan.gc.ca/t1/wds/rest/getAllCubesList) returned **8,271 distinct table PIDs** in an approximately **9 MB JSON response**. [`getAllCubesListLite`](https://www150.statcan.gc.ca/t1/wds/rest/getAllCubesListLite) returned the same PIDs in approximately **5 MB** without the `dimensions` arrays. Both responses were top-level arrays, not the `status/object` wrapper used by other WDS methods.

- `archived` returned string codes: **5,082 `"2"`**, **3,189 `"1"`**. Recent releases use `"2"`, and related WDS metadata labels `"2"` as current, but validate the inventory-field mapping before offering a public active/archived filter.
- **29,885 dimension objects** across the full inventory; tables have **1–9 dimensions**.
- **744 tables** have correction records with bilingual notes.
- **3,509 tables** lack a CANSIM ID. Use the numeric PID as the stable table identity.
- **22 normalized English title-collision groups** cover 52 PIDs. Titles alone are not identifiers. Example: `14100385`, `14100391`, and `14100393` share the title “Labour force characteristics, annual, inactive.”
- No traffic, download-count, or PID-level popularity field was observed. “Most popular” cannot be inferred from this inventory.

The inventory describes WDS tables, **not all public content on statcan.ca**. Metadata for all 8,271 looks practical to ingest early. It does not imply the values in all 8,271 files are small or use one format. See the [WDS guide](https://www.statcan.gc.ca/en/developers/wds/user-guide) for methods and rate limits.

## Twenty-four measured table ZIPs

Sizes are English ZIP `Content-Length` responses observed in this survey, **not** extracted size, query-store size, French size, or future size. Years are reference-period coverage, not a publication-version archive. † = the worker opened the ZIP and inspected the CSVs; the other rows were metadata/HEAD checks only. Re-measure before acquisition.

| PID | Variation represented | ZIP bytes |
|---|---|---:|
| [10100004†](https://www150.statcan.gc.ca/n1/tbl/csv/10100004-eng.zip) | Quarterly, four dimensions | 881,842 |
| [10100139†](https://www150.statcan.gc.ca/n1/tbl/csv/10100139-eng.zip) | Daily rates, missing observations | 3,378,957 |
| [11100190](https://www150.statcan.gc.ca/n1/tbl/csv/11100190-eng.zip) | Annual income | 3,264,030 |
| [13100096](https://www150.statcan.gc.ca/n1/tbl/csv/13100096-eng.zip) | Archived health estimates | 4,926,835 |
| [13100113](https://www150.statcan.gc.ca/n1/tbl/csv/13100113-eng.zip) | Larger archived health table | 28,278,082 |
| [14100287](https://www150.statcan.gc.ca/n1/tbl/csv/14100287-eng.zip) | Six-dimensional monthly labour | 60,439,477 |
| [14100017](https://www150.statcan.gc.ca/n1/tbl/csv/14100017-eng.zip) | Large unadjusted labour table | 55,122,774 |
| [17100005](https://www150.statcan.gc.ca/n1/tbl/csv/17100005-eng.zip) | Population by age and gender | 3,880,235 |
| [17100009†](https://www150.statcan.gc.ca/n1/tbl/csv/17100009-eng.zip) | Small population table; frequency-code anomaly | 30,842 |
| [18100004](https://www150.statcan.gc.ca/n1/tbl/csv/18100004-eng.zip) | Long-running detailed CPI | 15,307,935 |
| [18100005](https://www150.statcan.gc.ca/n1/tbl/csv/18100005-eng.zip) | Annual CPI | 1,262,462 |
| [18100006†](https://www150.statcan.gc.ca/n1/tbl/csv/18100006-eng.zip) | Small monthly CPI | 29,957 |
| [20100010†](https://www150.statcan.gc.ca/n1/tbl/csv/20100010-eng.zip) | Archived retail table; quality flags | 885,207 |
| [22100008†](https://www150.statcan.gc.ca/n1/tbl/csv/22100008-eng.zip) | Suppressed/qualified values | 9,880 |
| [23100066†](https://www150.statcan.gc.ca/n1/tbl/csv/23100066-eng.zip) | Scalar factors | 20,293 |
| [32100001](https://www150.statcan.gc.ca/n1/tbl/csv/32100001-eng.zip) | Monthly agricultural data | 261,291 |
| [35100003†](https://www150.statcan.gc.ca/n1/tbl/csv/35100003-eng.zip) | Fiscal-year reference labels | 37,347 |
| [36100103†](https://www150.statcan.gc.ca/n1/tbl/csv/36100103-eng.zip) | GDP income-based | 58,217 |
| [36100104](https://www150.statcan.gc.ca/n1/tbl/csv/36100104-eng.zip) | GDP expenditure-based | 964,346 |
| [36100430†](https://www150.statcan.gc.ca/n1/tbl/csv/36100430-eng.zip) | Explicit Release dimension | 3,710,955 |
| [36100431](https://www150.statcan.gc.ca/n1/tbl/csv/36100431-eng.zip) | Larger GDP vintage table | 21,748,023 |
| [18100259](https://www150.statcan.gc.ca/n1/tbl/csv/18100259-eng.zip) | CPI with Release dimension | 2,661,578 |
| [98100001†](https://www150.statcan.gc.ca/n1/tbl/csv/98100001-eng.zip) | Transposed 2021 Census layout | 5,611 |
| [98100002†](https://www150.statcan.gc.ca/n1/tbl/csv/98100002-eng.zip) | Census metadata larger than data | 551,875 |

### Actual parsing differences observed

- A normal table has rows with `REF_DATE`, `GEO`, `COORDINATE`, `VALUE`, and `STATUS`. The sampled 2021 Census table instead has a `Coordinate` column followed by paired measure and `Symbols` columns. The [CSV guide](https://www.statcan.gc.ca/en/developers/csv/user-guide) documents that transposed layout.
- One Census metadata CSV contained **49,267 variable-width records**; it is not a single rectangular table. Its uncompressed metadata was about 4.6 MB, larger than its 0.8 MB data CSV.
- A quality flag does not always mean a missing value: a sampled `E` row retained `VALUE=6.7`; sampled `F` and `x` rows had blank values. Preserve both original fields and official code meanings.
- `REF_DATE` can be `1997/1998`, `1992-01`, or `1946-01-01`. Keep the original label and frequency rather than forcing a date type.
- Some tables have an explicit `Release` dimension. That is not a universal archive of past table files. Preserve every downloaded file as a separate capture.
- French ZIPs use semicolon-delimited CSV and translated headers. Index official English and French metadata; do not machine-translate labels.
- One table titled “Population estimates, quarterly” reported frequency code `21`, which the live [code sets](https://www150.statcan.gc.ca/t1/wds/rest/getCodeSets) label “Occasional Daily.” Keep and surface such upstream inconsistencies rather than silently correcting them.

## Beyond the WDS table inventory

- The [2021 Census Profile](https://www12.statcan.gc.ca/wds-sdw/2021profile-profil2021-eng.cfm) has a separate SDMX API. Its [download page](https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger.cfm?Lang=E) lists a small Canada/provinces CSV at 719 KB and a broad file down to dissemination areas at 2,200,674 KB. Those are page-listed sizes, not verified ZIP measurements here.
- [Boundary files](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-eng.cfm?year=21) are catalogue products with choices of geography, digital/cartographic boundaries, and format. No boundary-file size was measured.
- Despite its URL, the [microdata/API page](https://www.statcan.gc.ca/en/microdata/api) describes the **aggregate Web Data Service**, including full table downloads. It is not a public record-level microdata API. The separate [microdata access page](https://www.statcan.gc.ca/en/microdata) describes different access classes.

## Reproducible size survey: 220 WDS tables

A second survey saved the unchanged 8,964,356-byte [WDS full inventory](https://www150.statcan.gc.ca/t1/wds/rest/getAllCubesList) on 2026-09-30 at 01:54 UTC (SHA-256 `719e46cdda4f537ebbda52f027e6763f2029c42f5f7095e4df5a24714f70d6c2`). The [survey script](tools/wds_size_survey.py) selected **208 reproducible stratified-random PIDs** by raw archive code and dimension-count band, plus **12 separately labeled nonrandom edge cases**. All **220 ZIP `HEAD` requests** returned 200 and a usable `Content-Length`. No table ZIP bodies were downloaded by this survey.

| Raw archive code; dimensions | Inventory PIDs | Random sample | Edge cases |
|---|---:|---:|---:|
| `1`; 1–2 | 981 | 25 | 0 |
| `1`; 3–4 | 1,672 | 42 | 2 |
| `1`; 5+ | 536 | 14 | 0 |
| `2`; 1–2 | 660 | 17 | 2 |
| `2`; 3–4 | 3,161 | 78 | 2 |
| `2`; 5+ | 1,261 | 32 | 6 |

Measured English ZIP sizes ranged from **2,064 bytes** to **1,005,365,746 bytes**. The median was **71,969 bytes**; p75 was **1,035,412 bytes**. The measured lengths sum to **6,238,925,133 bytes** across these 220 URLs. That sum is *not* bytes downloaded and is *not* a corpus total. The largest sampled files include [43100029](https://www150.statcan.gc.ca/n1/tbl/csv/43100029-eng.zip) at ~1.0 GB and [98100193](https://www150.statcan.gc.ca/n1/tbl/csv/98100193-eng.zip) at ~0.8 GB. Three spot-checked `HEAD` responses, including those two, had `application/zip` content type; the script did not record the content type for all 220.

For a **rough planning signal only**, a stratum-weighted calculation (excluding the 12 edge cases from random means, then adding their measured lengths once) gives **about 188 GiB / 202 GB** for *one English ZIP per WDS inventory PID*. Within-stratum resampling gave a conditional ~**96–301 GiB** interval. This is **not a safe capacity bound**: the `2`; 5+-dimension stratum dominates, a few very large files dominate its mean, and a subject-mix sensitivity check moves the estimate to ~**163 GiB**. No past publication versions, French ZIPs, extracted CSVs, query store, backups, Census Profile downloads, geography files, microdata, or publications are included. Measure those separately before choosing hosting capacity.

Local artifacts (ignored by Git) are in `data/local/wds-size-survey/20260930T015419Z/`: `inventory.json`, `inventory.json.sha256`, `results.json`, `summary.md`, and `manifest.json`. They are **local survey evidence, not a backed-up production archive**. Reproduce with `python3 tools/wds_size_survey.py --self-check` and `python3 tools/wds_size_survey.py`. The 220-response sample is time-dependent; a new run creates a new dated directory.

## What this changes

The original 24 PIDs are **format-validation anchors**, not the production scope. The first release should index the full WDS catalogue and ingest a much wider, stratified set of table files, with clear progress and exceptions. The [roadmap](ROADMAP.md) sets a provisional 250-table queryable floor for v1, not a cap. The broad sample shows why size-aware acquisition, backup planning, and separate handling for large Census tables matter. Queryable coverage and source-download coverage may advance at different rates; show both.
