# API and website

One Node process serves the public JSON API and the server-rendered site from one build directory produced by [`tools/wds_build.py`](../tools/wds_build.py) (see [BUILD.md](../BUILD.md)). It reads Parquet through DuckDB; the catalogue tables are loaded into memory at startup, observations are read from `obs/<PID>.parquet` per request. No database service, no client-side JavaScript.

```bash
cd api && npm install
STATCAN_BUILD=/run/media/hemanth/Kingston/statcan-derived/v0 \
STATCAN_CAPTURE=/run/media/hemanth/Kingston/statcan-wds/baseline \
STATCAN_UUID=72D0-2131 PORT=3000 npm start
npm run check   # tsc --noEmit
```

- `STATCAN_BUILD` (required): build directory. Its `build_manifest.json` decides which tables are queryable.
- `STATCAN_CAPTURE` (optional): capture directory; enables `/source.zip` downloads of the unchanged original ZIPs, read-only.
- `STATCAN_UUID` (optional): refuse to start unless both directories are on this filesystem, same rule as the downloader.
- `HOST` defaults to `127.0.0.1`; `PORT` to `3000`.

Node 26 runs the TypeScript directly; no build step. Dependencies: `hono`, `@hono/node-server`, `@duckdb/node-api`.

## Endpoints (`/api/v1`, spec at `/api/v1/openapi.json`)

| Path | Result |
|---|---|
| `GET /build` | Build ID, capture, inventory SHA-256, tool versions, queryable and failed PIDs |
| `GET /tables?q=&archived=&queryable=&limit=&offset=` | Search over all 8,271 inventory records. Every term must match PID, CANSIM ID, title, dimension names, member names, or notes. Results carry `title_hits`, `dimension_hits`, `member_hits`, `note_hits` so a client can show why a table matched. |
| `GET /tables/{pid}` | Inventory record, metadata blocks (dimensions with members, notes, corrections, symbols, survey, subject), build report, links |
| `GET /tables/{pid}/observations?from=&to=&vector=&m1..m9=&limit=&offset=` | Filtered, paginated rows with member labels joined. Max 1,000 rows per page. `409` with the build errors if the table failed the build, `404` if not built. |
| `GET /tables/{pid}/observations.parquet` | The build's Parquet file, `X-Content-SHA256` header |
| `GET /tables/{pid}/source.zip` | The unchanged Statistics Canada ZIP, `X-Content-SHA256` from the capture manifest |

Every response carries `X-Statcan-Build` and, for JSON, `build_id`, `capture_id`, `language`. Observation responses add `source_sha256` and `parquet_sha256`. A developer who pins a build ID and re-runs the same query against the same build directory gets the same rows.

Values stay as published: `value`, `status`, `symbol`, `ref_date`, `uom`, `scalar_factor` are the raw strings; `value_num` is derived and null when nothing was published. Member labels come from the official member table, not from the observation file.

## Site

`/` search; `/tables/{pid}` metadata, provenance, downloads; `/tables/{pid}/observations` filter form (a `<select>` per dimension up to 300 members, otherwise a member-ID field) and a paginated table. Notes are shown as escaped text, so upstream HTML links appear literally rather than being rendered.

## Measured

Startup loads the catalogue (8,271 cubes, 29,885 inventory dimensions, 105 tables' metadata) in about one second. Each `obs/<PID>.parquet` is written pre-sorted by member IDs, `ref_date`, `row_index`, and DuckDB keeps file order for scans without `ORDER BY`, so paging is applied to the bare scan and only the page is joined to labels. Verified: zero out-of-order rows in scan order across 65 M rows, and filtered pages equal to an explicit `ORDER BY`.

On 17100146 (64.9 M rows, 9 dimensions, build `v0`): `offset=60000000&limit=1000` 77 ms; one series by nine member IDs 43 ms; a filtered page at offset 20,000 43 ms. On 24100055 (202 M rows, build `big1`, measured before this change while a build ran on the same SSD): one series 0.7–3.2 s, a date-range count 1.2 s, one vector 0.4 s. The `total` count still scans every row matching the filter. Not measured: concurrent load, cold-cache reads.
