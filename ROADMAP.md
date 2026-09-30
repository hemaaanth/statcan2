# Roadmap

## North star

Make public Statistics Canada data easy for researchers and developers to find, understand, download, and query. Aim for broad coverage across product families without pretending that every item on statcan.ca comes from one feed.

**Preservation rule:** keep every acquired source file byte-for-byte unchanged. Search indexes, parsed records, and query tables are separate, reproducible representations. Always show which source file, language, version, and official metadata a result came from. A present-day download containing old observations is not evidence of what the file said in an earlier release.

**Coverage rule:** maintain a public ledger of what we found, what we can acquire, what we indexed, what can be queried, what failed, and what cannot be republished. Never equate the WDS table inventory with all StatsCan products. Confidential microdata is outside a public platform; other files require product-level access and rights checks.

## Work packages

Each package has a result we can verify. The first release indexes the entire observed WDS table catalogue and makes hundreds of varied tables queryable. The [live data survey](DATA_SURVEY.md) records the first measurements; its 24 table PIDs are validation anchors, not the production limit.

| # | Package | Deliverable / exit check |
|---|---|---|
| 1 | **Source map and coverage ledger** | List official acquisition paths for WDS tables, Census, geospatial products, openly available microdata, publications, and archives. Record format, inventory method, licence/access class, known gaps, and counts by state. Publish a clear definition of “covered.” |
| 2 | **Coverage and cohort design** | Ingest the whole WDS inventory into the catalogue. Use the 24 measured PIDs as format-validation anchors; select a broader production cohort across subjects, frequencies, dimensions, active/archived status, corrections, flags, size classes, and Census layouts. Target **at least 250 queryable WDS tables in v1**, subject to a measured storage/backup budget; keep growing after launch. Cite first-party references or user demand for high-value tables, not an invented popularity ranking. |
| 3 | **Immutable acquisition** | Download official full-table files and metadata in English and French where offered, in byte-capped batches with a separate large-table lane. Retain original ZIPs; record URL, PID, language, retrieval time, release information where provided, SHA-256, and rights notice. Re-downloads never overwrite a captured version. Measure extracted sizes and backup cost before scaling; verify a restore from backup. |
| 4 | **Meaning and discovery** | Index official titles, descriptions, dimensions, members, units, geography, periods, notes, status codes, and related identifiers in both languages. Build a small browse/search experience that distinguishes similarly named tables and shows why a result matches. Check the UI with real researcher/developer search tasks. |
| 5 | **Query representation and HTTP API** | Parse a broad cohort into a versioned query store without changing source files. Handle ordinary and Census layouts separately; preserve raw values, labels, and statuses. Provide search across the full catalogue plus metadata, source download, and filtered, paginated observations for queryable tables. Every response identifies the exact captured version; test that results can be recreated from source. |
| 6 | **Reliable updates** | Capture daily changes, reconcile them with periodic full-table downloads, and report missing or failed updates. Store every acquired version. Detect deletions by reconciliation because the Delta File does not report them. Never silently substitute “latest” when a versioned result is requested. |
| 7 | **Complete table backfill** | Continue from the v1 cohort toward every public WDS table, current and archived, in measured batches. Track discovered → acquired → validated → indexed → queryable by PID and language, including errors and freshness. Expand only after measuring bytes, row counts, processing time, query latency, and backup cost; publish exceptions rather than silently skipping large tables. |
| 8 | **Other product families** | Add adapters and quality checks separately for Census layouts, geography/boundaries, reference classifications, openly downloadable microdata, and publications/archives. Each needs its own inventory and rights review. Do not force documents or confidential data into the table model. |
| 9 | **MCP and ecosystem** | Expose the same documented search, metadata, citation, and query operations to MCP clients. Avoid a second data engine or built-in AI chat. Provide examples of clients using the API without requiring our own model service. |

Packages 1–2 can run together. Packages 3–5 form v1, alongside coverage tracking and a basic update path from package 6. Complete table backfill and the remaining product families continue after launch. The 250-table floor is a launch target, not a ceiling or an estimate that the full corpus is small; revise it upward after the size survey if the hosting budget permits.

The first raw-file acquisition pass targets every PID in a dated WDS inventory, **English only**, on a separate USB SSD. French ZIPs are deferred by choice, not counted as acquired. This pass does not cover Census Profile downloads, boundary files, publications, or other non-WDS products. The [acquisition runbook](ACQUISITION.md) describes its checks and status.

## First-release acceptance test

A researcher can search all WDS inventory records without a PID, tell two similar tables apart, read the official definitions and units, choose a geography and time range for a queryable table, download the unchanged original, and request the same records via API. At least 250 varied WDS tables are queryable, including active and archived records and sampled Census layouts; the 24 format anchors pass ingestion checks. A developer can pin a captured version and reproduce the response. Both can see missing coverage or an ingestion failure instead of a misleading success.

## Provisional technical choices

- Use official downloads and APIs before considering web scraping. WDS provides a table inventory and full-table download URLs; the Delta File provides recent daily changes. Neither is an inventory of the entire website.
- For v1, keep original ZIPs in backed-up file storage and use Postgres for catalogue search and initially queryable rows. Plan a move to object storage if the archive grows toward the full WDS inventory; add ClickHouse only if measured query workloads outgrow the simpler store. Never store large raw ZIPs inside the query database by default.
- A capture manifest and stable source hashes are mandatory. A specific cloud provider, deployment stack, and normalized observation schema are **not decided yet**.
- A 220-table stratified `HEAD` survey suggests an **order-of-hundreds-of-GiB** English ZIP baseline for the WDS inventory, with heavy-tail uncertainty. The rough 188 GiB point estimate is not a safe capacity bound. French, extracted, query, backup, historical versions, and other product families add more. Obtain a dated size ledger and use byte-capped acquisition batches before committing to full-corpus hosting.

## Open questions to test, not guess

1. What percentage of public product families has an official enumerable download path?
2. How do full-table downloads, changes, and corrections reconcile over time? Can we detect removals?
3. Which identifiers connect Census profiles, tables, and the correct year's geography without changing meaning?
4. Which search tasks best distinguish a useful discovery experience from another catalogue?
5. How much raw storage, query storage, update processing, and backup capacity does representative coverage require?

## Official starting points

- [Statistics Canada Developers portal](https://www.statcan.gc.ca/en/developers)
- [Web Data Service User Guide](https://www.statcan.gc.ca/en/developers/wds/user-guide)
- [Full Table Download CSV User Guide](https://www.statcan.gc.ca/en/developers/csv/user-guide)
- [Delta File User Guide](https://www.statcan.gc.ca/en/developers/df/user-guide)
- [Microdata access](https://www.statcan.gc.ca/en/microdata)
- [Historical resources](https://www.statcan.gc.ca/en/library/historical)
- [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence)
