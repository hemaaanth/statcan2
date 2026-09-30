# StatCan data, easier to find and use

An independent, open-source project to make Statistics Canada data easier for researchers and developers to discover, understand, query, and use.

## Goal

Cover public Statistics Canada data over time, including historical tables and census data. Keep downloaded source files unmodified. Any cleaned or queryable representation must be separate and traceable to its source, version, and metadata.

The first release aims to index the full WDS table catalogue and make hundreds of varied tables queryable. Coverage will expand by product family; a WDS table inventory is not the same as every StatsCan product.

## Priorities

- Find relevant datasets without knowing a table number or exact title.
- Understand definitions, dimensions, units, geography, time coverage, and revisions.
- Download original files and query the data through documented APIs.
- Keep hosting and maintenance costs small.
- Let people connect their own tools and AI clients through an API and, eventually, MCP.

Built-in AI chat is not a priority. This is not an official Statistics Canada service.

## Status

A [reproducible size survey](tools/wds_size_survey.py) measured 220 English table ZIP sizes with `HEAD`. An English-only WDS full-table capture began on 2026-09-30 UTC on a separate USB SSD. The [resumable downloader](tools/wds_download.py) preserves original ZIPs and records checksums; this local capture is **not yet backed up**. French ZIPs are deferred. A [build tool](tools/wds_build.py) turns captured ZIPs into reproducible Parquet query files plus a manifest; it has run on a 10-table sample, see [BUILD.md](BUILD.md). A [Node API and site](api/README.md) serve any build directory: catalogue search over the whole inventory, metadata, filtered observations, Parquet and original-ZIP downloads, every response pinned to a build ID. See the [acquisition runbook](ACQUISITION.md), [source coverage ledger](SOURCE_COVERAGE.md), [roadmap](ROADMAP.md), and [live data survey](DATA_SURVEY.md).
