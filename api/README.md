# API and website

One Node process serves the public JSON API and the server-rendered site. It reads two builds: a Clean build from [`tools/wds_build.py`](../tools/wds_build.py) and its Normalized build from [`tools/wds_normalize.py`](../tools/wds_normalize.py) (see [BUILD.md](../BUILD.md) and [SCHEMA.md](../SCHEMA.md)). It reads Parquet through DuckDB. No database service.

- From Normalized, loaded into memory at startup: `table` (the search and browse record), `place`, `member_place`, `unit_family`, and the code sets `frequency`, `subject`, `survey`, `uom`, `scalar`, `status`, `symbol`.
- From Normalized, read per request: `series.parquet`. It is not loaded (5.9 M rows in `n3`, far more in a full build). The file is sorted by `pid`, so a `pid` filter lets DuckDB skip row groups.
- From Clean, loaded at startup: the catalogue tables that Normalized does not copy (dimensions, members, notes, corrections, symbols, cube metadata). Exact duplicate rows are dropped, as the normalizer does (the `v0` catalogue holds 10100139's metadata twice).
- From Clean, read per request: `obs/<PID>.parquet`.

The only client-side JavaScript is the chart (Highcharts from a pinned CDN URL); every other page works without JavaScript. A second entry point, `src/mcp.ts`, exposes the same data to AI agents over MCP (see below).

```bash
cd api && npm install
STATCAN_BUILD=/run/media/hemanth/Kingston/statcan-derived/v0 \
STATCAN_NORMALIZED=/run/media/hemanth/Kingston/statcan-derived/v0/normalized/n3 \
STATCAN_CAPTURE=/run/media/hemanth/Kingston/statcan-wds/baseline \
STATCAN_CODESETS=/run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json \
STATCAN_UUID=72D0-2131 PORT=3000 npm start
npm run check   # tsc --noEmit
```

- `STATCAN_BUILD` (required): Clean build directory. Its `build_manifest.json` decides which tables are queryable.
- `STATCAN_NORMALIZED` (required): a `normalized/<id>/` directory. The server refuses to start unless its `normalize_manifest.json` names this Clean build ID and the SHA-256 of this `build_manifest.json`.
- `STATCAN_CODESETS` (required): the captured WDS `getCodeSets` response (`codeSets.json`). A `codeSets.json.sha256` file must sit next to it. The server checks that hash at startup, and it must equal the code-set hash in `normalize_manifest.json`. The file is still needed because Normalized does not write the `securityLevel` set, which holds the `x` mark.
- `STATCAN_CAPTURE` (optional): capture directory. Enables `/source.zip` downloads of the unchanged original ZIPs (read-only) and the capture numbers on `/coverage`.
- `STATCAN_UUID` (optional): refuse to start unless the builds, code sets, and capture are on this filesystem, same rule as the downloader.
- `HOST` defaults to `127.0.0.1`; `PORT` to `3000` (HTTP server only).

DuckDB runs with 4 threads and a 2 GB memory limit. It spills to `<STATCAN_BUILD>/tmp`. Stop the server with SIGTERM or SIGINT so DuckDB deletes its spill files.

Node 26 runs the TypeScript directly; no build step. Dependencies: `hono`, `@hono/node-server`, `@duckdb/node-api`, `@modelcontextprotocol/sdk`, `zod`.

## Endpoints (`/api/v1`, spec at `/api/v1/openapi.json`)

| Path | Result |
|---|---|
| `GET /build` | Clean build ID, capture, inventory SHA-256, code-set ID and SHA-256 (`code_sets`), tool versions, queryable and failed PIDs, and `normalized` (build ID, Clean build and manifest hash, code-set hash, reference CSV hashes, files, stats, warning count) |
| `GET /coverage` | Inventory count, captured count, built and queryable counts, the same per `family` (`wds`, `census_2021`), failed tables with their build errors, upstream gaps (inventory PIDs with no captured ZIP, with the downloader's last error from `failures.jsonl`, attempt count, and bytes received from a `.part.json`), and the Normalized build warnings |
| `GET /tables?q=&archived=&kind=&family=&queryable=&limit=&offset=` | Search over all 8,271 Normalized `table` records. Every term must equal the PID or CANSIM ID or appear in `search_text` (title, dimension names, member names, notes). Results carry `kind`, `family`, `frequency_en`, `subject_en`, `period_min`, `period_max`, `series_count`, `unit_families`, `place_levels`, and `title_hits`, `text_hits` (terms found in the title, in `search_text`). Ranked by title hits, then queryable first. |
| `GET /tables/{pid}` | `cube` (the Normalized table record without `search_text`), metadata blocks (dimensions with members; dimension 1 members carry `place_id` and `place_match`), notes, corrections, symbols, survey, subject, official names for the inventory's code lists (`subject_labels`, `survey_labels`), build report, links |
| `GET /tables/{pid}/observations?from=&to=&vector=&m1..m9=&limit=&offset=` | Filtered, paginated rows with member labels, `status_en`, `symbol_en`, and from Normalized: `period_start`, `period_end`, `period_kind`, `place_id` (dimension 1), `unit_family`. Max 1,000 rows per page. `409` with the build errors if the table failed the build, `404` if not built. |
| `GET /tables/{pid}/series?from=&to=&vector=&m1..m9=` | One series per coordinate (equal to the vector in WDS tables; Census tables have no vector) for the same filters: `vector`, `coordinate`, `name`, `labels`, `unit`, `scale`, `period_kind`, `points: [[ref_date, value_num, status, period_start, period_end], …]`. At most 50 series and 200,000 points; `413` above that. |
| `GET /tables/{pid}/observations.parquet` | The build's Parquet file, `X-Content-SHA256` header |
| `GET /tables/{pid}/source.zip` | The unchanged Statistics Canada ZIP, `X-Content-SHA256` from the capture manifest |
| `GET /series?q=&pid=&place_id=&unit_family=&limit=&offset=` | Series search over Normalized `series`. Every word must appear in the table title or a member label; a term like `v41690915` must equal the vector. `pid`, `place_id`, `unit_family` are exact. Each result: `pid`, `vector`, `coordinate`, `title_en`, `kind`, `labels`, `place_id`, `place_name`, `uom_code`, `uom_en`, `unit_family`, `scalar_code`, `scalar_en`, `decimals`, `period_kind`, `period_min`, `period_max`, `n_obs`, `n_published`, `terminated`, `last_status`, `title_hits`, `links`. Ranked by title hits, then current before terminated, then table and member order. |
| `GET /series/{pid}/{vector}` | One series: its Normalized row, `labels` (dimension, member ID, member name), `place`, unit (`uom_en`, `unit_family`, `unit_symbol`, `unit_base_year`, `unit_note`), `scalar_en`, a `citation`, and every point with `ref_date`, `period_start`, `period_end`, `period_kind`, `value`, `value_num`, `status`, `status_en`, `symbol`, `symbol_en` |
| `GET /series/{pid}/c/{coordinate}` | The same, by coordinate. This is the key for Census tables, which have no vector; it also works for WDS tables. `409` when the Normalized row does not match the observations (see "Missing from the Normalized layer"). |
| `GET /places?q=&limit=&offset=` | Places whose name holds every term, or whose `place_id`, DGUID, or `geo_code` equals one. Countries first, then provinces and territories, then other schemas. Each row adds `n_tables`. |
| `GET /places/{place_id}` | The place, its `parent`, its `vintages` (every `place` row with the same `schema` and `geo_code`, for example Ontario `2011A000235`, `2016A000235`, `2021A000235`, `code:0002:35`), and `subjects`: every table that maps a geography member to any vintage, grouped by the table's first subject. Each table lists its matching `members` (`member_id`, `member_name`, `place_id`, `vintage`, `match`), `n_series`, a `citation`, and `series_search` links. |

Every response carries the headers `X-Statcan-Build` and `X-Statcan-Normalized-Build`. Every JSON body carries `build_id`, `normalized_build_id`, `capture_id`, `language`. Observation and series responses add `source_sha256` and `parquet_sha256`. A developer who pins both build IDs and re-runs the same query against the same directories gets the same rows.

Values stay as published: `value`, `status`, `symbol`, `ref_date`, `uom`, `scalar_factor` are the raw strings; `value_num` is derived and null when nothing was published. A blank value is not zero. Member labels come from the official member table, not from the observation file.

### Periods

Normalized stores periods only as series `period_min` and `period_max`, so the API derives `period_start`, `period_end`, `period_kind` per `ref_date` with `period()` in `src/db.ts`. It is a copy of `period()` in `tools/wds_normalize.py` (rules in BUILD.md "Period rules"), and the two must change together. Checked on `v0`: for all 105 tables, the copy gives the same earliest start, latest end, and set of period kinds as `n3`.

## Official labels

Labels come from the Normalized code-set files. The response never replaces a code with a label: the raw code stays and an `_en` field sits next to it.

- Frequency: `frequency_code` and `frequency_en` (a column of the Normalized `table`).
- Subject and survey: `cube.subject_codes` and `cube.survey_codes` stay; `subject_labels` and `survey_labels` list `{subject_code, subject_en}` and `{survey_code, survey_en}`. A code missing from the code set gives `null` and the page shows `code <n>`. `cube.subject_en` and `cube.survey_en` are the Normalized lists in inventory order.
- Status and symbol: observation rows carry the printed mark (`E`, `F`, `..`, `x`, `p`), not the numeric code, so `status_en` and `symbol_en` are looked up by the code set's `representation`. `x` is in the `securityLevel` set, read from `codeSets.json`. Blank marks have `null` labels. The site shows the label as a `title` tooltip on the cell.
- Unit and scale: series responses carry `uom_en` and `scalar_en` next to `uom_code` and `scalar_code`. Observation rows keep the unit and scale text from the file.
- `archived` has no WDS code set. The site maps 1 to "archived" and 2 to "current" from a constant in `db.ts`; the API returns the raw code only.

## Site

- `/` search, with a kind filter.
- `/tables/{pid}` metadata, provenance, downloads. Dimension 1 members link to their place.
- `/tables/{pid}/observations` filter form (a `<select>` per dimension up to 300 members, otherwise a member-ID field), a chart when it fits, and a paginated table. The geography label links to its place; the vector links to its series page.
- `/series/{pid}/{vector}` and `/series/{pid}/c/{coordinate}` series metadata, a line chart, and every point.
- `/places/{place_id}` place, vintages, and tables by subject.
- `/coverage` the `/api/v1/coverage` numbers.

Notes are shown as escaped text, so upstream HTML links appear literally rather than being rendered. Pages are plain structure; styling will come from `DESIGN.md`.

### Charts

The table's Normalized `kind` decides the chart.

- `time_series`: a Highcharts line chart when the filter matches at most 12 series and 200,000 points. The x-axis is a datetime axis at each point's `period_start`; the tooltip shows the raw `ref_date`. A `ref_date` with no period (`period_kind = other`) is left off the chart and stays in the table. y is `value_num`, with a gap where nothing was published. A line is named by the members that differ between the lines; with a single line it shows all its members. The y-axis title shows the unit and the scale; different units are listed on one axis. The series page draws the same chart for one series.
- `snapshot` (one reference period): a horizontal bar chart when the filter matches at most 200 series in at most 12 bar groups. One bar per member of the "Bars across" dimension (form field `across`; default: the dimension with the most members in the match). One bar group per combination of the other members that differ. A missing bar is a value that was not published.

The chart options are JSON in `<script type="application/json" id="chart-config">` and a few inline lines mount them. Highcharts 13.1.1 loads from jsDelivr with a Subresource Integrity hash. Its licence is free for non-commercial use, which covers this personal, non-profit project; check the [Highcharts licence](https://www.highcharts.com/license) before any commercial use. If the script does not load, the page shows a one-line message and the table still works.

## Measured

Startup loads the Clean catalogue and the Normalized in-memory files (8,271 tables, 2,451 places, 8,280 member places) and listens after about 1.5 s, Node startup included.

Observation files are written pre-sorted by member IDs, `ref_date`, `row_index`, and DuckDB keeps file order for scans without `ORDER BY`, so paging is applied to the bare scan and only the page is joined to labels. Verified earlier: zero out-of-order rows in scan order across 65 M rows, and filtered pages equal to an explicit `ORDER BY`. On 17100146 (64.9 M rows, 9 dimensions, build `v0`): `offset=60000000&limit=1000` 77 ms; one series by nine member IDs 43 ms. On 24100055 (202 M rows, build `big1`): one series 0.7–3.2 s. The `total` count still scans every row matching the filter. The series endpoint counts matching rows first and answers `413` above 200,000 points without grouping.

Normalized reads on `v0` + `n3`, median of 7 warm requests on the same machine while two builds ran:

| Request | Matches | Median |
|---|---:|---:|
| `/api/v1/series?q=consumer+price+food+ontario` | 34 | 24 ms |
| `/api/v1/series?q=unemployment+rate` | 5,024 | 25 ms |
| `/api/v1/series?q=v41690915` | 1 | 27 ms |
| `/api/v1/series?place_id=2021A000235` | 8,899 | 18 ms |
| `/api/v1/series?q=ontario` | 1,498,810 | 253 ms |
| `/api/v1/series` (no filter) | 5,904,721 | 342 ms |
| `/api/v1/places/2021A000235` | 55 tables | 14 ms |
| `/places/2021A000235` (HTML) | 55 tables | 15 ms |
| `/api/v1/series/18100006/v41690915` | 416 points | 12 ms |

The first series or place request in a fresh process took 0.8–0.9 s (MCP smoke run), while DuckDB read the `series.parquet` footer. Series search first picks candidate tables in memory (a series whose title or labels hold every word belongs to a table whose `search_text` holds them) and passes their PIDs as a list, so DuckDB skips row groups of other tables. The label test is one `ILIKE` per label column joined by `OR`; one `ILIKE` over `concat_ws` of the labels was 30 times slower. Not measured: concurrent load, a full-build `series.parquet`.

## Missing from the Normalized layer

- **Census series collapse.** `series` is grouped by `(pid, vector)`, and Census tables have an empty vector, so each Census table would get one series row. The coordinate endpoints answer `409` when a row's `n_obs` differs from the observations for its coordinate. The normalizer needs to group Census tables by `(pid, coordinate)`.
- **No per-row period.** Only series min/max are stored. The API re-implements the period rule (see Periods).
- **No `securityLevel` code set.** The `x` label still comes from `codeSets.json`.
- **No per-field search text.** `table.search_text` is one string, so search results can say "title" or "somewhere in the text", not "dimension", "member", or "note" as before.

## MCP server

`src/mcp.ts` is a stdio [MCP](https://modelcontextprotocol.io) server over the same `Db` class as the HTTP server. It does not call HTTP. It needs the same environment variables as the HTTP server (`STATCAN_BUILD`, `STATCAN_NORMALIZED`, `STATCAN_CODESETS`, and optionally `STATCAN_CAPTURE`, `STATCAN_UUID`; not `PORT`). It writes only to stderr apart from protocol messages.

| Tool | Arguments | Result |
|---|---|---|
| `search_tables` | `q`, `archived?` (`"1"`/`"2"`), `queryable?`, `limit?` (max 100, default 25) | Matching table records with `kind`, `frequency_en`, hit counts, and a `citation` for each |
| `get_table` | `pid` | Metadata, dimensions with all member IDs (dimension 1 with `place_id`), notes, symbols, build report, `subject_labels`, `survey_labels`, `time_series` |
| `get_series` | `pid`, `from?`, `to?`, `vector?`, `m1..m9?` | Same series as `/tables/{pid}/series`, points with `period_start` and `period_end`; error above 50 series |
| `get_observations` | `pid`, `from?`, `to?`, `vector?`, `m1..m9?`, `limit?` (max 1000, default 100), `offset?` | Same rows as `/observations`, with `total` |
| `search_series` | `q`, `pid?`, `place_id?`, `unit_family?`, `limit?` (max 100, default 25) | Same results as `/series`, with a `citation` for each |
| `get_place` | `place_id` | Same as `/places/{place_id}`: place, parent, vintages, tables by subject, a `citation` for each table |

Every result has `build_id`, `normalized_build_id`, and a `citation` such as `Statistics Canada, Table 18-10-0006-01, Consumer Price Index, monthly, seasonally adjusted, captured 2026-09-30, build v0, normalized n3`. The date is the capture date of the source ZIP. Tool descriptions say the data is not official and that a blank value is not zero. Errors come back with `isError: true` and a message.

Sample client config (the common `mcpServers` shape; I checked the server with the SDK's own stdio client, not with a desktop client):

```json
{
  "mcpServers": {
    "statcan": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/home/hemanth/Projects/statcan/api",
      "env": {
        "STATCAN_BUILD": "/run/media/hemanth/Kingston/statcan-derived/v0",
        "STATCAN_NORMALIZED": "/run/media/hemanth/Kingston/statcan-derived/v0/normalized/n3",
        "STATCAN_CODESETS": "/run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json",
        "STATCAN_UUID": "72D0-2131"
      }
    }
  }
}
```

Some clients ignore `cwd`. Then use `"command": "node"` with `"args": ["/home/hemanth/Projects/statcan/api/src/mcp.ts"]`.
