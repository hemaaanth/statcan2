# Public source coverage ledger

Observed 2026-09-30 UTC. This is a **source map and size survey**, not a claim that all public Statistics Canada products have been found. The checks below used official pages, API documentation, `HEAD` requests, and header-only `GET` probes. No non-WDS file bodies were saved. The English WDS download continues separately on the USB SSD; see [ACQUISITION.md](ACQUISITION.md).

**Coverage states:** *discovered* means an official entry point exists; *enumerated* means we have a product list; *sized* means a specific file has a measured HTTP length or an explicitly labeled page estimate; *captured* means its original bytes and SHA-256 are saved; *queryable* needs a separate parser and API. These states are not interchangeable.

| Source family | What is known | Size evidence | Acquisition state / gap |
|---|---|---|---|
| [WDS full tables](https://www150.statcan.gc.ca/t1/wds/rest/getAllCubesList) | 8,271 PIDs in a dated inventory. This is **not** an inventory of all public data. | [220 English ZIP `HEAD` results](DATA_SURVEY.md); rough 188 GiB total estimate, not a capacity bound. | English baseline in progress on SSD. French deferred. Not backed up or queryable. |
| [2021 Census Profile](https://www150.statcan.gc.ca/n1/en/catalogue/98-401-X) | 29 catalogue products, distinct from WDS Census cubes. The [download page](https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger.cfm?Lang=E) lists 29 ordinary CSV ZIPs and 29 separate confidence-interval ZIPs, plus other formats and regional splits. | English CSV page totals: 3,294,755 KB ordinary + 2,783,936 KB confidence intervals. `HEAD` reports zero; these totals are **not measured bytes**. | Enumerated at catalogue level; no Profile ZIPs captured. |
| [2021 Census boundary files](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-eng.cfm?year=21) | Digital and cartographic types; 17 levels; Shapefile, GML, and FileGDB. The **up-to-102** product/format matrix is *not* a verified all-format archive count. | All 34 English Shapefile selections returned `HEAD` lengths. Two ecumene selections share ZIPs, leaving **32 unique archives, 2,682,200,246 bytes**. | Shapefile URLs and lengths enumerated; none captured. GML, FileGDB, and reference companions remain unsized. |
| Selected [public-use microdata files](https://www.statcan.gc.ca/en/microdata/pumf) | Some product-series pages offer direct public ZIPs, including [General Social Survey PUMFs](https://www150.statcan.gc.ca/n1/pub/45-25-0001/index-eng.htm). No collection-wide bulk manifest was found. | Three direct GSS ZIPs measured with `HEAD` at 110–187 MB. Not a corpus estimate. | Discovered only. The paid/subscription collection and confidential microdata are **not** public bulk downloads. Check terms for each file. |
| [Reference Data as a Service](https://www.statcan.gc.ca/en/developers/rdaas) | Paginated public [classification](https://api.statcan.gc.ca/rdaas/search/classifications) and [concordance](https://api.statcan.gc.ca/rdaas/search/concordances) inventories; detail APIs return JSON/JSON-LD. | No full inventory or payload-byte total measured. | Good candidate for a separate adapter; nothing captured. |
| [Open Government catalogue](https://open.canada.ca/en/access-our-application-programming-interface-api) | CKAN records may link to StatCan resources. Some will overlap other sources and have resource-specific terms. | No deduplicated resource list or size total measured. | Discovery path only, not a canonical all-products inventory. |
| [Historical resources](https://www.statcan.gc.ca/en/library/historical) | The 1918–1980 historical publications catalogue, Library [MARC/Z39.50](https://www.statcan.gc.ca/en/library/marc), and product-specific archives are starting points. | No defensible whole-archive size or complete downloadable-file inventory. | Targeted discovery only. Digitization, availability, and rights vary by item. |

## 2021 Census Profile: sizes and transport

The [2021 Profile catalogue](https://www150.statcan.gc.ca/n1/en/catalogue/98-401-X) lists 29 products (`98-401-X2021001` through `...029`). The [download UI](https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger.cfm?Lang=E) supplies the `GEONO` values. It serves ZIP-named downloads through `GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=...`. One product may have multiple formats; confidence intervals are separate artifacts.

The English CSV URL is `https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO={code}`. For confidence intervals, use the `CI` code in the last column. The rows and sizes below are listed on the official download page. Product `022` is [98-401-X2021022](https://www150.statcan.gc.ca/n1/en/catalogue/98-401-X2021022), not the shorter mistyped ID `98-401-X2022`.

| `GEONO` | 2021 catalogue ID | Geography | Standard CSV KB | CI code / CSV KB |
|---|---|---|---:|---:|
| `001` | `98-401-X2021001` | Canada, provinces, territories | 719 | `001CI` / 787 |
| `002` | `98-401-X2021002` | CMAs and CAs | 6,796 | `002CI` / 6,866 |
| `003` | `98-401-X2021003` | CMAs, CAs, CSDs | 44,387 | `003CI` / 40,612 |
| `004` | `98-401-X2021004` | Census divisions | 12,317 | `004CI` / 12,219 |
| `005` | `98-401-X2021005` | Canada through CSDs | 192,261 | `005CI` / 159,964 |
| `006` | `98-401-X2021006` | Canada through dissemination areas | 2,200,674 | `006CI` / 1,812,022 |
| `007` | `98-401-X2021007` | CMAs, tracted CAs, census tracts | 243,868 | `007CI` / 225,759 |
| `008` | `98-401-X2021008` | Economic regions | 4,112 | `008CI` / 4,398 |
| `009` | `98-401-X2021009` | Population centres | 38,782 | `009CI` / 35,081 |
| `010` | `98-401-X2021010` | 2013-order federal electoral districts | 15,866 | `010CI` / 16,724 |
| `011` | `98-401-X2021011` | Designated places | 54,961 | `011CI` / 42,000 |
| `012` | `98-401-X2021012` | Aggregate dissemination areas | 206,714 | `012CI` / 187,518 |
| `013` | `98-401-X2021013` | Forward sortation areas | 66,580 | `013CI` / 65,282 |
| `014` | `98-401-X2021014` | Dissolved census subdivisions | 4,736 | `014CI` / 3,695 |
| `015` | `98-401-X2021015` | Health regions | 6,059 | `015CI` / 6,528 |
| `016` | `98-401-X2021016` | Newfoundland and Labrador CSDs | 12,451 | `016CI` / 9,797 |
| `017` | `98-401-X2021017` | Prince Edward Island CSDs | 3,427 | `017CI` / 2,789 |
| `018` | `98-401-X2021018` | Nova Scotia CSDs | 3,515 | `018CI` / 3,034 |
| `019` | `98-401-X2021019` | New Brunswick CSDs | 9,528 | `019CI` / 7,974 |
| `020` | `98-401-X2021020` | Quebec CSDs | 45,450 | `020CI` / 37,698 |
| `021` | `98-401-X2021021` | Ontario CSDs | 21,388 | `021CI` / 18,852 |
| `022` | `98-401-X2021022` | Manitoba CSDs | 8,499 | `022CI` / 7,035 |
| `023` | `98-401-X2021023` | Saskatchewan CSDs | 31,420 | `023CI` / 24,281 |
| `024` | `98-401-X2021024` | Alberta CSDs | 14,918 | `024CI` / 12,447 |
| `025` | `98-401-X2021025` | British Columbia CSDs | 25,563 | `025CI` / 20,662 |
| `026` | `98-401-X2021026` | Yukon CSDs | 1,192 | `026CI` / 921 |
| `027` | `98-401-X2021027` | Northwest Territories CSDs | 1,407 | `027CI` / 1,095 |
| `028` | `98-401-X2021028` | Nunavut CSDs | 1,097 | `028CI` / 866 |
| `029` | `98-401-X2021029` | 2023-order federal electoral districts | 16,068 | `029CI` / 17,030 |
| **29 files per column** | | **Page-listed total** | **3,294,755 KB** | **2,783,936 KB** |

The 29 ordinary and 29 confidence-interval English CSV ZIPs total **6,078,691 KB of page-listed sizes**, not a measured byte count. The six regional `006_*` ordinary alternatives sum to 2,200,899 KB; their six `006CI_*` alternatives sum to 1,812,196 KB. They split the national DA hierarchy and are **excluded** from the numbered totals. Do not download both national and regional alternatives by default or treat their slightly different totals as a validation failure.

`HEAD` returning `Content-Length: 0` does **not** mean an empty archive. A one-byte `Range` request was ignored (`200`, not `206`) for [English `001`](https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=001), so do not assume Profile downloads support partial-byte resume. Its header-only `GET` reported `Content-Length: 736546` bytes, consistent with the listed 719 KB. Header-only `GET` probes for `002`, `006`, and `006CI` gave no length; no file bodies were read. The large-file sizes remain page claims. Extracted sizes were not measured. The [Profile SDMX API](https://www12.statcan.gc.ca/wds-sdw/2021profile-profil2021-eng.cfm) exposes 14 documented geography dataflows, but its guide directs whole-flow users to bulk files instead.

The same [catalogue](https://www150.statcan.gc.ca/n1/en/catalogue/98-401-X) includes 2016 products. A separate [2011 Profile series](https://www150.statcan.gc.ca/n1/en/catalogue/98-316-X) exists. Earlier years need their own product-by-product discovery; neither WDS Census cubes nor the 2021 API enumerate all Profile releases.

## 2021 Census boundaries: measured ZIPs

The [boundary reference guide](https://www150.statcan.gc.ca/n1/pub/92-160-g/92-160-g2021002-eng.htm) distinguishes **digital** boundaries, which retain the full geographic extent, from **cartographic** boundaries, which omit some water-only areas. They are not identical copies. The official [catalogue form](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-eng.cfm?year=21) returned the following URLs for all 17 levels in each English Shapefile selection. All 34 selections returned `200` `HEAD` responses with usable `Content-Length` values between 03:26:55 and 03:27:18 UTC on 2026-09-30. No ZIP bodies were fetched.

| Level | Digital Shapefile ZIP / `HEAD` bytes | Cartographic Shapefile ZIP / `HEAD` bytes |
|---|---|---|
| PR | [`lpr_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lpr_000a21a_e.zip) — 2,777,186 | [`lpr_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lpr_000b21a_e.zip) — 133,730,024 |
| CD | [`lcd_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcd_000a21a_e.zip) — 10,837,545 | [`lcd_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcd_000b21a_e.zip) — 139,871,865 |
| FED | [`lfed000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lfed000a21a_e.zip) — 10,911,971 | [`lfed000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lfed000b21a_e.zip) — 139,449,505 |
| CSD | [`lcsd000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcsd000a21a_e.zip) — 40,389,252 | [`lcsd000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcsd000b21a_e.zip) — 155,981,521 |
| DPL | [`ldpl000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ldpl000a21a_e.zip) — 2,936,993 | [`ldpl000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ldpl000b21a_e.zip) — 4,682,551 |
| FSA | [`lfsa000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lfsa000a21a_e.zip) — 21,725,887 | [`lfsa000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lfsa000b21a_e.zip) — 162,038,215 |
| ER | [`ler_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ler_000a21a_e.zip) — 7,021,635 | [`ler_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ler_000b21a_e.zip) — 136,666,559 |
| CAR | [`lcar000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcar000a21a_e.zip) — 6,623,754 | [`lcar000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcar000b21a_e.zip) — 136,732,193 |
| CCS | [`lccs000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lccs000a21a_e.zip) — 19,935,382 | [`lccs000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lccs000b21a_e.zip) — 145,746,798 |
| CMA/CA | [`lcma000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcma000a21a_e.zip) — 2,199,298 | [`lcma000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcma000b21a_e.zip) — 13,397,176 |
| CT | [`lct_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lct_000a21a_e.zip) — 9,642,335 | [`lct_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lct_000b21a_e.zip) — 13,403,271 |
| POPCTR | [`lpc_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lpc_000a21a_e.zip) — 4,775,991 | [`lpc_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lpc_000b21a_e.zip) — 7,964,528 |
| DA | [`lda_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lda_000a21a_e.zip) — 97,683,595 | [`lda_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lda_000b21a_e.zip) — 197,042,003 |
| DB | [`ldb_000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ldb_000a21a_e.zip) — 296,295,170 | [`ldb_000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ldb_000b21a_e.zip) — 317,391,964 |
| ADA | [`lada000a21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lada000a21a_e.zip) — 36,195,161 | [`lada000b21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lada000b21a_e.zip) — 154,789,922 |
| ECU | [`lecu000e21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lecu000e21a_e.zip) — 251,650,570 | Same ZIP, **not a second download** |
| ECA | [`leca000e21a_e.zip`](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/leca000e21a_e.zip) — 1,710,426 | Same ZIP, **not a second download** |

The 17 digital selection ZIPs total **823,312,151 bytes**. The 17 cartographic selections total **2,112,249,091 bytes**, but ECU and ECA return the same URLs as the digital selections. Deduplicating those two shared archives leaves **32 distinct English Shapefile ZIPs totaling 2,682,200,246 bytes (~2.50 GiB)**. This is a measured compressed-size total for *this format and census year only*. It excludes GML, FileGDB, reference companions, other census years, French, extracted files, and backups.

Two separate FileGDB samples were also measured: [digital DB](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ldb_000a21f_e.zip) at 185,342,106 bytes and [cartographic DB](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/ldb_000b21f_e.zip) at 254,535,304 bytes. They are **not included** in the Shapefile total.

Other geography artifacts include the [2021 Geographic Attribute File](https://www150.statcan.gc.ca/n1/en/catalogue/92-151-X), [2021 correspondence files](https://www150.statcan.gc.ca/n1/en/catalogue/92-156-X), and [2021 dissemination-geographies relationship file](https://www150.statcan.gc.ca/n1/en/catalogue/98260004). They are reference companions, not boundary geometry; they were not sized. [2016](https://www12.statcan.gc.ca/census-recensement/2011/geo/bound-limit/bound-limit-2016-eng.cfm) and [2011](https://www12.statcan.gc.ca/census-recensement/2011/geo/bound-limit/bound-limit-2011-eng.cfm) have separate catalogues. No dedicated 2026 Census boundary release was found in the [boundary series catalogue](https://www150.statcan.gc.ca/n1/en/catalogue/92-160-X) as of this survey.

## Other measured public files and rights

These three selected [General Social Survey PUMF](https://www150.statcan.gc.ca/n1/pub/45-25-0001/index-eng.htm) ZIPs returned `200` `HEAD` responses with ZIP content type and byte lengths on 2026-09-30 UTC. They do not establish a PUMF total.

| Public file | HEAD bytes |
|---|---:|
| [2019 Canadian Safety](https://www150.statcan.gc.ca/n1/pub/45-25-0001/cat1/c34_2019.zip) | 110,758,306 |
| [2023 Giving, Volunteering and Participating](https://www150.statcan.gc.ca/n1/pub/45-25-0001/cat5/GVP_DBP_2023.zip) | 148,153,520 |
| [2022 Time Use](https://www150.statcan.gc.ca/n1/pub/45-25-0001/cat7/TU_ET_2022.zip) | 187,277,431 |

The [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence) generally covers non-confidential StatCan information. It requires attribution and prohibits attempts to identify people or businesses. Check each product and third-party source before redistribution. Open Government catalogue resources have their own licence fields. **Do not collect confidential microdata** from [Research Data Centres or restricted services](https://www.statcan.gc.ca/en/microdata/data-centres) as if it were a public download.

## Next acquisition gates

1. Save a dated **2021 Profile artifact manifest** and the source catalogue/download pages on the SSD. The table above maps the 29 numbered English CSV files and their 29 CI files. Record other formats and six regional alternatives separately.
2. The English 2021 Shapefile URLs and sizes are now surveyed. Recheck each `HEAD` before acquisition and retain dated headers. The first batch can take 17 digital ZIPs; a later cartographic batch adds **15 distinct** ZIPs, not 17, because the two ecumene URLs are shared. GML/FileGDB and reference companions remain separate work.
3. Build a separate Profile downloader before starting large files. The current WDS downloader requires a valid `Content-Length` and a WDS PID; Profile's server does not reliably give either a length or byte-range resume. Keep a free-space reserve during streaming and record actual length and hash.
4. Leave enough SSD space for the running English WDS baseline and its 100 GiB reserve. Obtain a second copy and test a restore before calling these captures preserved. French ZIPs remain deferred by choice.
