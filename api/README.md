# API and website

One Node process serves the public JSON API and the server-rendered site from one build directory produced by [`tools/wds_build.py`](../tools/wds_build.py) (see [BUILD.md](../BUILD.md)). It reads Parquet through DuckDB; the catalogue tables are loaded into memory at startup, observations are read from `obs/<PID>.parquet` per request. No database service. The only client-side JavaScript is the series chart on the observations page (Highcharts from a pinned CDN URL); every other page works without JavaScript. A second entry point, `src/mcp.ts`, exposes the same data to AI agents over MCP (see below).

```bash
cd api && npm install
STATCAN_BUILD=/run/media/hemanth/Kingston/statcan-derived/v0 \
STATCAN_CAPTURE=/run/media/hemanth/Kingston/statcan-wds/baseline \
STATCAN_CODESETS=/run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json \
STATCAN_UUID=72D0-2131 PORT=3000 npm start
npm run check   # tsc --noEmit
```

- `STATCAN_BUILD` (required): build directory. Its `build_manifest.json` decides which tables are queryable.
- `STATCAN_CODESETS` (required): the captured WDS `getCodeSets` response (`codeSets.json`). A `codeSets.json.sha256` file must sit next to it. The server checks the SHA-256 at startup and refuses to start on a missing or different hash.
- `STATCAN_CAPTURE` (optional): capture directory; enables `/source.zip` downloads of the unchanged original ZIPs, read-only.
- `STATCAN_UUID` (optional): refuse to start unless the build, code sets, and capture are on this filesystem, same rule as the downloader.
- `HOST` defaults to `127.0.0.1`; `PORT` to `3000` (HTTP server only).

Node 26 runs the TypeScript directly; no build step. Dependencies: `hono`, `@hono/node-server`, `@duckdb/node-api`, `@modelcontextprotocol/sdk`, `zod`.

## Endpoints (`/api/v1`, spec at `/api/v1/openapi.json`)

| Path | Result |
|---|---|
| `GET /build` | Build ID, capture, inventory SHA-256, code-set ID and SHA-256 (`code_sets`), tool versions, queryable and failed PIDs |
| `GET /tables?q=&archived=&queryable=&limit=&offset=` | Search over all 8,271 inventory records. Every term must match PID, CANSIM ID, title, dimension names, member names, or notes. Results carry `title_hits`, `dimension_hits`, `member_hits`, `note_hits` so a client can show why a table matched, and `frequency_code` with `frequency_en`. |
| `GET /tables/{pid}` | Inventory record (`cube.frequency_code` with `cube.frequency_en`), metadata blocks (dimensions with members, notes, corrections, symbols, survey, subject), official names for the inventory's code lists (`subject_labels`, `survey_labels`), build report, links |
| `GET /tables/{pid}/observations?from=&to=&vector=&m1..m9=&limit=&offset=` | Filtered, paginated rows with member labels joined, and `status_en`, `symbol_en` next to the raw `status`, `symbol`. Max 1,000 rows per page. `409` with the build errors if the table failed the build, `404` if not built. |
| `GET /tables/{pid}/series?from=&to=&vector=&m1..m9=` | One series per vector for the same filters: `vector`, `name`, `labels` (dimension, member ID, member name), `unit`, `scale`, `points: [[ref_date, value_num, status], …]`. At most 50 series and 200,000 points; `413` above that, with a message to add filters. |
| `GET /tables/{pid}/observations.parquet` | The build's Parquet file, `X-Content-SHA256` header |
| `GET /tables/{pid}/source.zip` | The unchanged Statistics Canada ZIP, `X-Content-SHA256` from the capture manifest |

Every response carries `X-Statcan-Build` and, for JSON, `build_id`, `capture_id`, `language`. Observation responses add `source_sha256` and `parquet_sha256`. A developer who pins a build ID and re-runs the same query against the same build directory gets the same rows.

Values stay as published: `value`, `status`, `symbol`, `ref_date`, `uom`, `scalar_factor` are the raw strings; `value_num` is derived and null when nothing was published. A blank value is not zero. Member labels come from the official member table, not from the observation file.

## Official labels

Labels come from the captured WDS code sets (`STATCAN_CODESETS`), loaded at startup into DuckDB tables `code_frequency`, `code_subject`, `code_survey`, `code_uom`, `code_scalar`, `code_status`, `code_symbol`, `code_securityLevel` (English and French). The response never replaces a code with a label: the raw code stays and an `_en` field sits next to it.

- Frequency: `frequency_code` and `frequency_en` in search results and in `cube` on the table endpoint.
- Subject and survey: `cube.subject_codes` and `cube.survey_codes` stay; `subject_labels` and `survey_labels` list `{subject_code, subject_en}` and `{survey_code, survey_en}`. A code missing from the code set gives `null` and the page shows `code <n>`.
- Status and symbol: observation rows carry the printed mark (`E`, `F`, `..`, `x`, `p`), not the numeric code, so `status_en` and `symbol_en` are looked up by that mark. `x` is in the `securityLevel` set, not the `status` set. Blank marks have `null` labels. The site shows the label as a `title` tooltip on the cell.
- `archived` has no WDS code set. The site maps 1 to "archived" and 2 to "current" from a constant in `db.ts`; the API returns the raw code only.
- `code_uom` and `code_scalar` are loaded but not used: each observation already carries its unit and scale as English text.

`GET /build` reports `code_sets.sha256`, the hash the server verified.

## Site

`/` search; `/tables/{pid}` metadata, provenance, downloads; `/tables/{pid}/observations` filter form (a `<select>` per dimension up to 300 members, otherwise a member-ID field), a series chart when it fits, and a paginated table. Notes are shown as escaped text, so upstream HTML links appear literally rather than being rendered.

### Series chart

On `/tables/{pid}/observations` the page draws a Highcharts line chart above the table when the table is a time series (inventory `cube_start_date` differs from `cube_end_date`) and the current filter matches at most 12 vectors and 200,000 points. The filter is the same as the table's, but ignores paging. One line per vector; x is the raw `ref_date` string used as a category (dates are not parsed); y is `value_num`, with a gap where nothing was published. A line is named by the members that differ between the lines; with a single line it shows all its members. The y-axis title shows the unit and the scale. If the lines have different units, the title lists them all on one axis.

The page stays server-rendered. The chart options are JSON in `<script type="application/json" id="chart-config">` and a few inline lines mount them. Highcharts 13.1.1 loads from jsDelivr with a Subresource Integrity hash. Its licence is free for non-commercial use, which covers this personal, non-profit project; check the [Highcharts licence](https://www.highcharts.com/license) before any commercial use. If the script does not load, the page shows a one-line message and the table still works.

## Measured

Startup loads the catalogue (8,271 cubes, 29,885 inventory dimensions, 105 tables' metadata) in about one second. Each `obs/<PID>.parquet` is written pre-sorted by member IDs, `ref_date`, `row_index`, and DuckDB keeps file order for scans without `ORDER BY`, so paging is applied to the bare scan and only the page is joined to labels. Verified: zero out-of-order rows in scan order across 65 M rows, and filtered pages equal to an explicit `ORDER BY`.

On 17100146 (64.9 M rows, 9 dimensions, build `v0`): `offset=60000000&limit=1000` 77 ms; one series by nine member IDs 43 ms; a filtered page at offset 20,000 43 ms. On 24100055 (202 M rows, build `big1`, measured before this change while a build ran on the same SSD): one series 0.7–3.2 s, a date-range count 1.2 s, one vector 0.4 s. The `total` count still scans every row matching the filter. Not measured: concurrent load, cold-cache reads.

The series endpoint counts matching rows first and answers `413` above 200,000 points without grouping vectors. Before that check, the unfiltered observations page of 17100146 took 6.5 s to count vectors; after it, 0.12 s (measured while a build ran on the same SSD). Of the 105 tables in `v0`, an unfiltered `/series` call succeeds for 26 and gives `413` for 79.

## MCP server

`src/mcp.ts` is a stdio [MCP](https://modelcontextprotocol.io) server over the same `Db` class as the HTTP server. It does not call HTTP. It needs the same environment variables as the HTTP server (`STATCAN_BUILD`, `STATCAN_CODESETS`, and optionally `STATCAN_CAPTURE`, `STATCAN_UUID`; not `PORT`). It writes only to stderr apart from protocol messages.

| Tool | Arguments | Result |
|---|---|---|
| `search_tables` | `q`, `archived?` (`"1"`/`"2"`), `queryable?`, `limit?` (max 100, default 25) | Matching inventory records with hit counts, `frequency_en`, and a `citation` for each |
| `get_table` | `pid` | Metadata, dimensions with all member IDs, notes, symbols, build report, `subject_labels`, `survey_labels` |
| `get_series` | `pid`, `from?`, `to?`, `vector?`, `m1..m9?` | Same series as `/series`; error above 50 series |
| `get_observations` | `pid`, `from?`, `to?`, `vector?`, `m1..m9?`, `limit?` (max 1000, default 100), `offset?` | Same rows as `/observations`, with `total` |

Every result has `build_id` and a `citation` such as `Statistics Canada, Table 18-10-0006-01, Consumer Price Index, monthly, seasonally adjusted, captured 2026-09-30, build v0`. The date is the capture date of the source ZIP. Tool descriptions say the data is not official and that a blank value is not zero. Errors come back with `isError: true` and a message.

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
        "STATCAN_CODESETS": "/run/media/hemanth/Kingston/statcan-ref/codesets/20260930T182041Z/codeSets.json",
        "STATCAN_UUID": "72D0-2131"
      }
    }
  }
}
```

Some clients ignore `cwd`. Then use `"command": "node"` with `"args": ["/home/hemanth/Projects/statcan/api/src/mcp.ts"]`.
