import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { apiRoutes } from "../src/api.ts";
import { chartRoutes } from "../src/chart_api.ts";
import { openFromEnv } from "../src/config.ts";
import { getCube } from "../src/cube.ts";
import type { Db, NormalizeManifest } from "../src/db.ts";
import { pageRoutes } from "../src/pages.ts";
import { runView, suggestViews } from "../src/view.ts";

const normalized = path.join(process.env.STATCAN_NORMALIZED ?? "", "normalize_manifest.json");
const manifest = existsSync(normalized) ? JSON.parse(readFileSync(normalized, "utf8")) as NormalizeManifest : null;
const combined = ["wds", "census_2021"].every((family) => manifest?.cleans?.some((input) => input.family === family));
const options = { skip: !combined && "needs a combined WDS and Census build" };
let db: Db;
let captureDir: string | undefined;
before(async () => { if (combined) ({ db, captureDir } = await openFromEnv()); });
after(() => { if (combined) db.close(); });

async function headline(pid: string) {
  const spec = (await suggestViews(db, pid))![0].spec;
  const outcome = await runView(db, spec);
  assert.equal(outcome.kind, "ok", outcome.kind === "invalid" ? outcome.error : "");
  return { spec, result: outcome.result };
}

test("combined build serves both Clean inputs' observations and sources", options, async () => {
  assert.deepEqual(db.normalized.cleans?.map((input) => input.family), ["wds", "census_2021"]);
  const app = apiRoutes({ db, captureDir });
  const detail = await (await app.request("/tables/98100001")).json();
  assert.equal(detail.build.parquet.sha256, db.manifest.tables["98100001"].parquet?.sha256);
  assert.equal(detail.links.source_zip, "/api/v1/tables/98100001/source.zip");
  const censusBuild = db.normalized.cleans!.find((input) => input.family === "census_2021")!.build_id;
  assert.ok(db.citation("98100001").endsWith(`build ${censusBuild}, normalized ${db.normalized.build_id}`));
  for (const pid of ["98100001", "18100006"]) {
    const zip = await app.request(`/tables/${pid}/source.zip`);
    assert.equal(zip.status, 200);
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), db.manifest.tables[pid].source_sha256);
    assert.equal(zip.headers.get("x-content-sha256"), db.manifest.tables[pid].source_sha256);
  }
  // Without the capture (the public server), source.zip sends clients to Statistics Canada.
  const uncaptured = apiRoutes({ db });
  const redirect = await uncaptured.request("/tables/98100001/source.zip");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://www150.statcan.gc.ca/n1/tbl/csv/98100001-eng.zip");
  assert.equal((await (await uncaptured.request("/tables/98100001")).json()).links.source_zip, "/api/v1/tables/98100001/source.zip");
  assert.equal((await uncaptured.request("/tables/99999999/source.zip")).status, 404);
  const parquet = await app.request("/tables/98100001/observations.parquet");
  assert.equal(parquet.status, 200);
  assert.equal(parquet.headers.get("x-content-sha256"), db.manifest.tables["98100001"].parquet?.sha256);
  assert.equal((await parquet.arrayBuffer()).byteLength, db.manifest.tables["98100001"].parquet?.bytes);
});

test("Census snapshots default to category bars and export the displayed cells", options, async () => {
  const cube = await getCube(db, "98100001");
  assert.equal(cube?.kind, "snapshot");
  assert.deepEqual(cube?.units, []);
  const { spec, result } = await headline("98100001");
  assert.equal(spec.chart.type, "bar");
  assert.equal(spec.layers[0].dims["1"].use, "x");
  assert.equal(result.categories?.length, 13);
  assert.equal(result.series[0].vectors.length, 0);
  assert.deepEqual(result.series[0].points.map((point) => point[0]), Array(13).fill("2021"));
  const first = (await db.observations("98100001", { members: [2, 1], limit: 1, offset: 0 }))!.rows[0];
  assert.equal(result.series[0].points[0][2], first.value_num);
  const csv = await chartRoutes({ db }).request("/view.csv", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /98100001/);
  assert.match(text, new RegExp(`,${first.value_num},`));
});

test("Census views use selected places and categories, keeping official source titles", options, async () => {
  const show = async (pid: string, dims: Record<string, { use: "fixed" | "x"; members: { eq: string } | { in: (number | string)[] } }>) => {
    const outcome = await runView(db, { v: 1, layers: [{ pid, dims }], time: { preset: "latest" },
      transform: "level", chart: { type: "bar" } });
    assert.equal(outcome.kind, "ok", outcome.kind === "invalid" ? outcome.error : "");
    return outcome.result;
  };
  const language = await show("98100227", {
    "1": { use: "fixed", members: { eq: "Montréal (CMA), Que." } },
    "3": { use: "x", members: { in: [2, 3, 4, 5] } },
  });
  assert.equal(language.title, "Language spoken most often at home, Montréal");
  assert.equal(language.x.kind, "category");
  if (language.x.kind === "category") assert.equal(language.x.dimension, "Language");
  assert.equal(language.subtitle, "Montréal (CMA), Que. · Counts · 2021");
  assert.deepEqual(language.series.map((series) => series.name), ["Counts"]);
  assert.match(language.sources[0].title, /by age: Canada, provinces and territories/);
  assert.ok(language.sources[0].citation.includes(language.sources[0].title));

  const tenure = await show("98100239", { "7": { use: "x", members: { in: ["Renter", "Owner"] } } });
  assert.equal(tenure.title, "Structural type of dwelling, Renter vs Owner");
  assert.equal(tenure.x.kind, "category");
  if (tenure.x.kind === "category") assert.equal(tenure.x.dimension, "Tenure");
  assert.deepEqual(tenure.series.map((series) => series.name), ["Number of private households"]);
  assert.match(tenure.subtitle, /Canada/);
  assert.match(tenure.sources[0].title, /by tenure: Canada, provinces and territories/);

  const age = await show("98100034", { "2": { use: "x", members: { in: [2, 3, 4] } } });
  assert.equal(age.title, "Broad age groups and sex, 0 to 14 years vs 15 to 64 years vs 65 years and over");
  assert.equal(age.x.kind, "category");
  if (age.x.kind === "category") assert.equal(age.x.dimension, "Broad age groups");
  assert.deepEqual(age.series.map((series) => series.name), ["Total"]);
  assert.match(age.sources[0].title, /sex: Canada, provinces and territories/);
});

test("Census subtitles retain a different Statistics year", options, async () => {
  const outcome = await runView(db, { v: 1, layers: [{ pid: "98100226", dims: {
    "3": { use: "x", members: { in: [2, 3, 4, 5] } },
    "4": { use: "fixed", members: { eq: "2016 Counts" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" }, title: "Home languages" });
  assert.equal(outcome.kind, "ok", outcome.kind === "invalid" ? outcome.error : "");
  assert.equal(outcome.result.subtitle, "Canada · 2016 Counts · 2021");
});

test("Census commuting comparison shortens only display places and names its selected mode", options, async () => {
  const places = ["Victoria (CMA), B.C.", "Ottawa - Gatineau (CMA), Ont./Que."];
  const outcome = await runView(db, { v: 1, layers: [{ pid: "98100457", dims: {
    "1": { use: "x", members: { in: places } },
    "6": { use: "series", members: { eq: "Bicycle" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } });
  assert.equal(outcome.kind, "ok", outcome.kind === "invalid" ? outcome.error : "");
  const result = outcome.result;
  assert.equal(result.title, "Main mode of commuting: Bicycle, Victoria vs Ottawa – Gatineau");
  assert.equal(result.x.kind, "category");
  if (result.x.kind === "category") assert.equal(result.x.dimension, "Geography");
  assert.deepEqual(result.categories, places);
  assert.deepEqual(result.series.map((series) => series.name), ["Bicycle"]);
  assert.deepEqual(result.spec.layers[0].dims["7"].members, { eq: 1 });
  assert.match(result.sources[0].title, /by commuting duration, time leaving for work, age and gender: Canada/);
});

test("WDS titles skip source leads but retain topical organization mentions", options, async () => {
  for (const { pid, dims, title } of [
    { pid: "34100133", dims: { "1": { use: "fixed" as const, members: { eq: "Saskatoon, Saskatchewan" } } }, title: "Average rents" },
    { pid: "10100108", dims: {}, title: "Assets and liabilities" },
    { pid: "23100094", dims: {}, title: "Number of vehicles on the registration lists" },
    { pid: "10100001", dims: {}, title: "Federal public sector employment reconciliation of Treasury Board of Canada Secretariat" },
  ]) {
    const outcome = await runView(db, { v: 1, layers: [{ pid, dims }], time: { preset: "latest" },
      transform: "level", chart: { type: "line" } });
    assert.equal(outcome.kind, "ok", outcome.kind === "invalid" ? outcome.error : "");
    assert.equal(outcome.result.title, title);
    assert.ok(outcome.result.series.some((series) => series.points.some((point) => point[2] != null)));
    if (pid === "34100133") {
      assert.match(outcome.result.subtitle, /Saskatoon/);
      assert.match(outcome.result.sources[0].citation, /Canada Mortgage and Housing Corporation, average rents/);
    }
  }
});

test("broad Census view stays bounded; table page redirects", options, async () => {
  const { spec, result } = await headline("98100404");
  assert.equal(spec.chart.type, "bar");
  assert.equal(result.series[0].points.length, 13);
  assert.equal(result.series[0].vectors.length, 0);
  const broad = await runView(db, { v: 1, layers: [{ pid: "98100404", dims: {
    "4": { use: "x", members: { all: true } }, "5": { use: "series", members: { all: true } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } });
  assert.equal(broad.kind, "invalid");
  if (broad.kind === "invalid") assert.match(broad.error, /Census coordinates/);
  const api = apiRoutes({ db, captureDir });
  assert.equal((await api.request("/tables/98100404/series")).status, 413);
  const download = await api.request("/tables/98100404/observations.parquet");
  assert.equal(download.status, 200);
  assert.equal(Number(download.headers.get("content-length")), db.manifest.tables["98100404"].parquet?.bytes);
  await download.body?.cancel();
  const geo = await getCube(db, "98100015");
  assert.ok(geo && geo.dimensions[0].members.length > 100);
  const page = await pageRoutes({ db, captureDir }).request("/tables/98100015");
  assert.equal(page.status, 301);
  assert.equal(page.headers.get("location"), "/?q=98-10-0015-01");
});

test("combined search retains both families and a mixed-source view warns", options, async () => {
  assert.equal((await db.search("", { family: "census_2021", queryable: true, limit: 1, offset: 0 })).total,
    db.normalized.cleans!.find((input) => input.family === "census_2021")!.tables_ok);
  assert.equal((await db.search("", { family: "wds", queryable: true, limit: 1, offset: 0 })).total,
    db.normalized.cleans!.find((input) => input.family === "wds")!.tables_ok);
  const series = await db.seriesSearch({ q: "inflation", limit: 5, offset: 0 });
  assert.ok(series.total > 0);
  assert.ok(series.rows.some((row) => row.pid === "18100004"));
  const mixed = await runView(db, { v: 1, layers: [{ pid: "18100006", dims: {} }, { pid: "98100001", dims: {} }],
    time: { from: "2021", to: "2021" }, transform: "level", chart: { type: "bar" } });
  assert.equal(mixed.kind, "ok", mixed.kind === "invalid" ? mixed.error : "");
  if (mixed.kind === "ok") assert.ok(mixed.result.warnings.some((warning) => warning.code === "mixed_family"));
});

test("combined broad series discovery is bounded and PID search remains exhaustive", options, async () => {
  const app = apiRoutes({ db, captureDir });
  const response = await app.request("/series?q=population&limit=5");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Statcan-Search-Scope"), "capped");
  const first = await response.json();
  assert.ok(first.total > 5 && first.total <= 5_000);
  assert.equal(first.results.length, 5);
  assert.equal(first.results[0].pid, "17100009");

  const next = await (await app.request("/series?q=population&limit=5&offset=5")).json();
  assert.equal(next.total, first.total);
  assert.notDeepEqual(next.results.map((row: { links: { self: string } }) => row.links.self),
    first.results.map((row: { links: { self: string } }) => row.links.self));

  const scopedResponse = await app.request("/series?q=population&pid=17100009&limit=5");
  assert.equal(scopedResponse.headers.get("X-Statcan-Search-Scope"), null);
  const scoped = await scopedResponse.json();
  assert.ok(scoped.total > 0);
  assert.ok(scoped.results.every((row: { pid: string }) => row.pid === "17100009"));

  const fallbackResponse = await app.request("/series?q=Ontario&limit=5");
  assert.equal(fallbackResponse.headers.get("X-Statcan-Search-Scope"), "capped");
  const fallback = await fallbackResponse.json();
  assert.ok(fallback.total > 0 && fallback.total <= 5_000);
  assert.ok(fallback.results.every((row: { title_en: string }) => row.title_en.includes("Ontario")));
});

test("combined place detail keeps series counts without scanning unrelated parts", options, async () => {
  const response = await apiRoutes({ db, captureDir }).request("/places/2021A00052653");
  assert.equal(response.status, 200);
  const place = await response.json();
  assert.equal(place.n_tables, 1);
  assert.deepEqual(place.subjects.flatMap((subject: { tables: { pid: string; n_series: number }[] }) =>
    subject.tables.map((table) => [table.pid, table.n_series])), [["15100038", 48]]);
});
