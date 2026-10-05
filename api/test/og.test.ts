import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { openFromEnv } from "../src/config.ts";
import { chartSvg, ogRoutes } from "../src/og.ts";
import { pageRoutes } from "../src/pages.ts";
import { chartRoutes } from "../src/chart_api.ts";
import { apiRoutes } from "../src/api.ts";
import { encodeSpec, type ViewSpec } from "../src/spec.ts";
import { runView } from "../src/view.ts";
import { ownPoints, parts, periodText } from "../public/render.js";
import type { Db } from "../src/db.ts";

const mounted = existsSync(process.env.STATCAN_BUILD ?? "");
const options = { skip: !mounted && "build is not mounted" };
let db: Db;
let captureDir: string | undefined;
before(async () => { if (mounted) ({ db, captureDir } = await openFromEnv()); });
after(() => { if (mounted) db.close(); });

const chart: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
  "1": { use: "series", members: { in: ["Calgary, Alberta", "Alberta"] } },
  "2": { use: "fixed", members: { eq: "Food" } },
} }], time: { preset: "1Y" }, transform: "level", chart: { type: "line" } };
const encoded = encodeSpec(chart);
const property = (document: string, key: string, attribute = "property") =>
  document.match(new RegExp(`<meta ${attribute}="${key}" content="([^"]*)"`))?.[1];
const published = (process.env.PUBLIC_ORIGIN || "https://statcan2.ca").replace(/\/+$/, "");

function assertPng(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  assert.ok(bytes.length < 300_000, `OG image is ${bytes.length} bytes`);
}

test("OG cards render 1200×630 PNGs and invalid chart links use the site card", options, async () => {
  const app = ogRoutes({ db });
  const get = async (path: string) => {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
    const bytes = Buffer.from(await response.arrayBuffer());
    assertPng(bytes);
    return bytes;
  };
  const site = await get("/site.png");
  assert.deepEqual(await get("/chart.png"), site);
  assert.deepEqual(await get("/chart.png?s=invalid"), site);
  const actual = await get(`/chart.png?s=${encoded}`);
  assert.notDeepEqual(actual, site);
  assert.deepEqual(await get(`/chart.png?s=${encoded}`), actual);
  for (const type of ["area", "bar", "stacked_bar", "stacked_bar_100", "stacked_area"] as const) {
    const other = encodeSpec({ ...chart, chart: { type } });
    const rendered = await get(`/chart.png?s=${other}`);
    assert.notDeepEqual(rendered, site, `${type} should resolve the chart instead of falling back`);
    assert.notDeepEqual(rendered, actual, `${type} should render its own plot`);
  }
  const missing = encodeSpec({ ...chart, layers: [{ ...chart.layers[0], dims: {
    ...chart.layers[0].dims, "1": { use: "series", members: { eq: "Calgary, Alberta" } },
  } }] });
  assert.notDeepEqual(await get(`/chart.png?s=${missing}`), site, "an unpublished selection still has its own explanatory card");
  assert.notDeepEqual(await get("/text.png?title=Developers"), site);
});

test("OG line bridges unpublished-frequency periods but breaks at a missing quarter", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [
    { pid: "17100009", dims: { "1": { use: "fixed", members: { eq: 1 } } } },
    { pid: "18100004", dims: { "1": { use: "fixed", members: { eq: 2 } },
      "2": { use: "fixed", members: { eq: 2 } } } },
  ], time: { preset: "max", from: "2018" }, transform: "index_first", index_base: "2015", chart: { type: "line" } };
  const outcome = await runView(db, spec);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  const view = outcome.result;
  const population = view.series.find((series) => series.pid === "17100009")!;
  const published = population.points.filter((point) => point[2] !== null);
  assert.ok(published.length > 20);
  assert.ok(ownPoints(population, true).length < population.points.length);
  const line = (svg: string) => svg.match(/<path d="([^"]+)" fill="none" stroke="#D80621" stroke-width="/)?.[1] ?? "";
  assert.equal(line(chartSvg(view)).match(/M/g)?.length, 1, "quarterly population is one continuous line");
  const gap = published.find((point) => point[1].startsWith("2020"))!;
  const missing = { ...population, points: population.points.map((point) =>
    point === gap ? [point[0], point[1], null, "x"] as typeof point : point) };
  assert.ok(ownPoints(missing, true).some((point) => point[1] === gap[1] && point[2] === null));
  const svg = chartSvg({ ...view, series: view.series.map((series) => series === population ? missing : series) });
  assert.equal(line(svg).match(/M/g)?.length, 2, "a null on the quarterly cadence breaks the line");
});

test("OG category bars rank the largest causes, label their ends, and show remaining count", options, async () => {
  const causes = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 45, 46, 47, 48, 51, 52, 53, 54,
    76, 77, 80, 83, 88, 89, 90, 91, 92, 93, 94, 97, 98, 103, 104, 105, 106, 109, 110, 111, 112, 113, 125, 128, 131, 132, 135, 136, 137, 140];
  const spec: ViewSpec = { v: 1, layers: [{ pid: "13100932", dims: {
    "1": { use: "fixed", members: { eq: 7 } }, "2": { use: "fixed", members: { eq: 1 } },
    "3": { use: "x", members: { in: causes } }, "4": { use: "fixed", members: { eq: 1 } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } };
  const outcome = await runView(db, spec);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  const svg = chartSvg(outcome.result);
  assert.ok(svg.indexOf(">Malignant neoplasms</text>") < svg.indexOf(">Major cardiovascular diseases</text>"));
  assert.ok(svg.includes(">31,381</text>") && svg.includes(">29,030</text>"));
  assert.match(svg, /\+35 more \(smaller values\)/);
  assert.equal((svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="#D80621"/g) ?? []).length, 20);
});

test("income distribution OG keeps every Canada bracket in published order", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "98100065", dims: {
    "1": { use: "fixed", members: { eq: 1 } }, "2": { use: "fixed", members: { eq: 1 } },
    "3": { use: "fixed", members: { eq: 1 } },
    "4": { use: "x", members: { in: Array.from({ length: 18 }, (_, i) => i + 5) } },
    "5": { use: "fixed", members: { eq: 1 } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } };
  const outcome = await runView(db, spec);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  const svg = chartSvg(outcome.result);
  const labels = [...svg.matchAll(/<text[^>]*transform="rotate\(-65 [^"]+\)"[^>]*>([^<]+)<\/text>/g)].map((match) => match[1]);
  assert.equal(labels.length, 18);
  assert.match(labels[0]!, /^Under \$5,000/);
  assert.match(labels[4]!, /^\$20,000 to \$24,999/);
  assert.match(labels[16]!, /^\$100,000 and over/);
  assert.match(labels[17]!, /^Median after-tax/);
  assert.doesNotMatch(svg, /\+\d+ more \(smaller values\)/);
  assert.equal((svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="#D80621"/g) ?? []).length, 18);
  const extra = Array.from({ length: 7 }, (_, i) => `$${110 + i * 10},000 to $${119 + i * 10},999`);
  const extended = chartSvg({ ...outcome.result, categories: [...outcome.result.categories!, ...extra],
    series: outcome.result.series.map((series) => ({ ...series,
      points: [...series.points, ...extra.map((_, i) => ["2021", "2021-01-01", i + 1, ""] as typeof series.points[number])] })) });
  assert.doesNotMatch(extended, /rotate\(-65|\+\d+ more \(smaller values\)/);
  assert.equal((extended.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="#D80621"/g) ?? []).length, 25);
  assert.ok(extended.indexOf(">Under $5,000") < extended.indexOf(">$110,000 to $119,999"));
});

test("annual and census period labels use years while Cite retains its capture date", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "98100065", dims: {
    "1": { use: "fixed", members: { eq: 1 } }, "2": { use: "fixed", members: { eq: 1 } },
    "3": { use: "fixed", members: { eq: 1 } }, "4": { use: "x", members: { in: [5, 6] } },
    "5": { use: "fixed", members: { eq: 1 } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } };
  const outcome = await runView(db, spec);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  const view = outcome.result;
  const svg = chartSvg(view);
  assert.match(svg, />Table 98-10-0065-01<\/text>/);
  assert.match(svg, />statcan2\.ca<\/text>/);
  assert.match(view.subtitle, /(?:^| · )2021(?: · |$)/);
  assert.doesNotMatch(view.subtitle, /\bJan 2021\b/);
  const rendered = parts({ q: "", plan: null, spec, view, error: null });
  assert.match(rendered.head, /<div class="sub">[^<]*2021/);
  assert.doesNotMatch(rendered.head, /\bJan 2021\b/);
  assert.match(rendered.cite, /captured \d{1,2} [A-Z][a-z]{2} \d{4}/);
  assert.doesNotMatch(rendered.cite, /\bJan 2021\b/);
  const annual = { ...view, x: { kind: "time" as const },
    sources: view.sources.map((source) => ({ ...source, family: "wds", frequency: "Annual" })),
    series: view.series.map((series) => ({ ...series, points: series.points.slice(0, 1) })) };
  assert.equal(periodText(annual), "2021");
});

test("home, query, chart, reference pages, and redirects have specific absolute social metadata", options, async () => {
  const app = pageRoutes({ db, captureDir });
  const headers = { "X-Forwarded-Proto": "http", "X-Forwarded-Host": "injected.example" };
  const check = async (path: string, title: string, image: string) => {
    const response = await app.request(path, { headers });
    assert.equal(response.status, 200);
    const document = await response.text();
    assert.equal(property(document, "og:title"), title);
    assert.ok(property(document, "og:description"));
    assert.equal(property(document, "og:image"), `${published}${image}`);
    assert.equal(property(document, "og:image:width"), "1200");
    assert.equal(property(document, "og:image:height"), "630");
    assert.equal(property(document, "og:type"), "website");
    assert.equal(property(document, "twitter:card", "name"), "summary_large_image");
    assert.equal(property(document, "twitter:title", "name"), title);
    assert.equal(property(document, "twitter:description", "name"), property(document, "og:description"));
    assert.equal(property(document, "twitter:image", "name"), property(document, "og:image"));
    assert.ok(property(document, "og:url")?.startsWith(`${published}${path.split("?")[0]}`));
    assert.equal(document.match(/<link rel="canonical" href="([^"]+)"/)?.[1], property(document, "og:url"));
    return document;
  };
  await check("/", "statcan(2)", "/og/site.png");
  await check("/?q=cpi", "cpi", "/og/site.png");
  const chartPage = await check(`/?q=food&s=${encoded}`, "Food: Calgary vs Alberta", `/og/chart.png?s=${encoded}`);
  assert.ok(chartPage.includes(`Independent copy: ${published}/tables/18100004`));
  assert.match(property(chartPage, "og:description") ?? "", /Statistics Canada 18-10-0004-01/);
  const apiDoc = await check("/api", "API · statcan2", "/og/text.png?title=API");
  assert.match(apiDoc, /\/api\/v1\/view\.csv/);
  assert.doesNotMatch(apiDoc, /\/api\/v2/);
  assert.match(apiDoc, /rel="manifest" href="\/static\/brand\/site\.webmanifest"/);
  const mcpDoc = await check("/mcp", "MCP · statcan2", "/og/text.png?title=MCP");
  assert.match(mcpDoc, /https:\/\/statcan2\.ca\/api\/mcp/);
  assert.equal(mcpDoc.match(/class="tool-row"/g)?.length, 9);
  assert.match(mcpDoc, /plan_chart/);
  const developers = await app.request("/developers", { headers });
  assert.equal(developers.status, 301);
  assert.equal(developers.headers.get("location"), "/api");
  const table = await app.request("/tables/18100004", { headers });
  assert.equal(table.status, 301);
  assert.equal(table.headers.get("location"), "/?q=18-10-0004-01");
  for (const path of ["/series/18100004/c/23.3", "/series/18100004/v41690914", "/places/2021A00052653"]) {
    const response = await app.request(path, { headers });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "/");
  }
});

test("API view, Cite, and OpenAPI advertise the public origin", options, async () => {
  const document = await (await apiRoutes({ db, captureDir }).request("/openapi.json")).json();
  const api = chartRoutes({ db });
  assert.equal(document.servers[0].url, `${published}/api/v1`);
  assert.ok(document.paths["/tables/{pid}"] && document.paths["/view"] && document.paths["/plan"]);
  assert.equal(document.paths["/og/chart.png"].servers[0].url, published);
  const result = await (await api.request(`/view?s=${encoded}`)).json();
  assert.ok(result.links.self.startsWith(`${published}/api/v1/view?s=`));
  assert.ok(result.links.page.startsWith(`${published}/?s=`));
  assert.ok(result.sources[0].citation.includes(`Independent copy: ${published}/tables/18100004`));
});

test("PUBLIC_ORIGIN overrides proxy headers for OG image and URL", options, async () => {
  const previous = process.env.PUBLIC_ORIGIN;
  const normalCard = Buffer.from(await (await ogRoutes({ db }).request(`/chart.png?s=${encoded}`)).arrayBuffer());
  const normalSite = Buffer.from(await (await ogRoutes({ db }).request("/site.png")).arrayBuffer());
  process.env.PUBLIC_ORIGIN = "https://public.example/";
  try {
    const document = await (await pageRoutes({ db, captureDir }).request("/api",
      { headers: { "X-Forwarded-Proto": "http", "X-Forwarded-Host": "internal.local" } })).text();
    assert.equal(property(document, "og:image"), "https://public.example/og/text.png?title=API");
    assert.equal(property(document, "og:url"), "https://public.example/api");
    assert.equal(document.match(/<link rel="canonical" href="([^"]+)"/)?.[1], "https://public.example/api");
    const chartView = await (await chartRoutes({ db }).request(`/view?s=${encoded}`)).json();
    assert.ok(chartView.links.page.startsWith("https://public.example/?s="));
    assert.ok(chartView.sources[0].citation.includes("Independent copy: https://public.example/tables/18100004"));
    assert.deepEqual(Buffer.from(await (await ogRoutes({ db }).request(`/chart.png?s=${encoded}`)).arrayBuffer()), normalCard);
    assert.deepEqual(Buffer.from(await (await ogRoutes({ db }).request("/site.png")).arrayBuffer()), normalSite);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
  }
  const host = await (await pageRoutes({ db, captureDir }).request("/api",
    { headers: { Host: "plain.example:8080" } })).text();
  assert.equal(property(host, "og:image"), `${published}/og/text.png?title=API`);
});
