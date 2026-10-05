import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openFromEnv } from "../src/config.ts";
import { getCube } from "../src/cube.ts";
import { chartRoutes } from "../src/chart_api.ts";
import { runView, suggestViews } from "../src/view.ts";
import { tableHtml } from "../public/render.js";
import type { Db } from "../src/db.ts";
import type { ViewResult, ViewSpec } from "../src/spec.ts";
import { encodeSpec } from "../src/spec.ts";

const mounted = existsSync(process.env.STATCAN_BUILD ?? "");
let db: Db;
before(async () => { if (mounted) ({ db } = await openFromEnv()); });
after(() => { if (mounted) db.close(); });
const options = { skip: !mounted && "build is not mounted" };
const cpi = (overrides: Partial<ViewSpec> = {}): ViewSpec => ({ v: 1, layers: [{ pid: "18100006", dims: {} }], time: { preset: "max" }, transform: "level", chart: { type: "line" }, ...overrides });
const population = (dims: ViewSpec["layers"][number]["dims"]): ViewSpec => ({ v: 1, layers: [{ pid: "17100009", dims }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
async function view(spec: ViewSpec): Promise<ViewResult> {
  const result = await runView(db, spec);
  assert.equal(result.kind, "ok", result.kind === "invalid" ? result.error : "");
  return result.result;
}

async function postedView(spec: ViewSpec): Promise<ViewResult> {
  const response = await chartRoutes({ db }).request("/view", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as ViewResult;
}


test("Census View labels omit only the matching period year", options, async () => {
  const dims: ViewSpec["layers"][number]["dims"] = {
    "1": { use: "fixed", members: { eq: "Saskatoon (CMA), Sask." } },
    "3": { use: "x", members: { in: [2, 3, 4] } },
  };
  const spec: ViewSpec = { v: 1, layers: [{ pid: "98100030", dims }], time: { preset: "latest" },
    transform: "level", chart: { type: "bar" } };
  const current = await view(spec);
  assert.equal(current.subtitle, "Saskatoon (CMA), Sask. · counts · 2021");
  const earlier = await view({ ...spec, title: "Age breakdown", layers: [{ pid: "98100030",
    dims: { ...dims, "4": { use: "fixed", members: { eq: "2016 counts" } } } }] });
  assert.equal(earlier.subtitle, "Saskatoon (CMA), Sask. · 2016 counts · 2021");
});

test("gasoline defaults pick a recent published fuel without changing CPI defaults", options, async () => {
  const gasoline = await getCube(db, "18100001");
  assert.deepEqual(gasoline?.dimensions.map((d) => d.default_member_id), [20, 2]);
  const cpiCube = await getCube(db, "18100006");
  assert.deepEqual(cpiCube?.dimensions.map((d) => d.default_member_id), [1, 1]);

  const headline = (await suggestViews(db, "18100001"))?.find((suggestion) => suggestion.label === "Headline");
  assert.ok(headline);
  const result = await view(headline.spec);
  assert.deepEqual(result.spec.layers[0].dims["1"].members, { eq: 20 });
  assert.deepEqual(result.spec.layers[0].dims["2"].members, { eq: 2 });
  assert.ok(result.series[0].points.some((point) => point[1] >= "2025-09-01" && point[2] !== null));
});

test("CPI headline uses defaults and preserves published latest value", options, async () => {
  const result = await view(cpi());
  assert.equal(result.title, "Consumer Price Index");
  assert.deepEqual(result.spec.layers[0].dims["1"].members, { eq: 1 });
  assert.deepEqual(result.spec.layers[0].dims["2"].members, { eq: 1 });
  assert.equal(result.series.length, 1);
  assert.deepEqual(result.series[0].points.at(-1), ["2026-08", "2026-08-01", 169.3, ""]);
  assert.equal(result.sources[0].table_number, "18-10-0006-01");
  assert.equal(result.series[0].name, "All-items");
  assert.equal(result.sources[0].title, "Consumer Price Index, monthly, seasonally adjusted");
  assert.match(result.subtitle, /Canada · .* · 2002=100$/);
  assert.doesNotMatch(result.subtitle, /All-items/);
  const custom = await view(cpi({ title: "My CPI chart", transform: "pct_change_yoy", time: { preset: "1Y" } }));
  assert.equal(custom.title, "My CPI chart");
});

test("products form independent series with stable member IDs", options, async () => {
  const result = await view(cpi({ layers: [{ pid: "18100006", dims: { "2": { use: "series", members: { in: ["food", "Shelter"] } } } }] }));
  assert.deepEqual(result.spec.layers[0].dims["2"].members, { in: [2, 3] });
  assert.deepEqual(result.series.map((s) => s.key), ["L0:2=2", "L0:2=3"]);
  assert.deepEqual(result.series.map((s) => s.name), ["Food", "Shelter"]);
});

test("LFS headline uses the fixed measure and compares Ontario with Quebec", options, async () => {
  const result = await view({ v: 1, layers: [{ pid: "14100397", dims: {
    "1": { use: "series", members: { in: ["Ontario", "Quebec"] } },
    "2": { use: "fixed", members: { eq: "Unemployment rate" } },
  } }], time: { from: "2015" }, transform: "level", chart: { type: "line" } });
  assert.equal(result.title, "Unemployment rate, Ontario vs Quebec");
  assert.deepEqual(result.series.map((s) => s.name), ["Ontario", "Quebec"]);
  assert.doesNotMatch(result.subtitle, /Unemployment rate|Ontario|Quebec/);
  assert.match(result.subtitle, /2015/);
  assert.equal(result.sources[0].title, "Labour force characteristics by family structure, monthly, unadjusted for seasonality");
  const narrowed = await view({ v: 1, layers: [{ pid: "14100397", dims: {
    "2": { use: "fixed", members: { eq: "Unemployment rate" } },
    "3": { use: "fixed", members: { eq: "25 to 54 years" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.equal(narrowed.title, "Unemployment rate · 25 to 54 years");
  assert.doesNotMatch(narrowed.subtitle, /25 to 54 years/);
});

test("a city drops its province only when that province is also compared", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
    "1": { use: "series", members: { in: ["Calgary, Alberta", "Alberta"] } },
    "2": { use: "fixed", members: { eq: "Food" } },
  } }], time: { preset: "1Y" }, transform: "level", chart: { type: "line" } };
  const paired = await view(spec);
  assert.equal(paired.title, "Food: Calgary vs Alberta");
  assert.deepEqual(paired.series.map((series) => series.name), ["Calgary, Alberta", "Alberta"]);
  const distinct = await view({ ...spec, layers: [{ ...spec.layers[0], dims: {
    ...spec.layers[0].dims, "1": { use: "series", members: { in: ["Calgary, Alberta", "Ontario"] } },
  } }] });
  assert.equal(distinct.title, "Food, Calgary, Alberta vs Ontario");
});

test("population category titles follow named selections and geography roles", options, async () => {
  const result = await view({ ...population({ "1": {
    use: "x", members: { any: [{ role: "province" }, { role: "territory" }] },
  } }), chart: { type: "bar" } });
  assert.equal(result.title, "Population estimates by province or territory");
  assert.ok(result.categories?.includes("Ontario"));
  assert.ok(result.categories?.includes("Nunavut"));
  const mixed = await view({ ...population({ "1": { use: "x", members: { in: [1, 7] } } }), chart: { type: "bar" } });
  assert.equal(mixed.title, "Population estimates, Canada vs Ontario");
  const territories = await view({ ...population({ "1": { use: "x", members: { role: "territory" } } }), chart: { type: "bar" } });
  assert.equal(territories.title, "Population estimates by territory");
  assert.deepEqual(territories.categories, ["Yukon", "Northwest Territories", "Nunavut"]);
  const provinces = await view({ ...population({ "1": { use: "x", members: { role: "province" } } }), chart: { type: "bar" } });
  assert.equal(provinces.title, "Population estimates by province");
});

test("CPI food versus shelter headline names the comparison and yoy transform", options, async () => {
  const result = await view(cpi({ layers: [{ pid: "18100006", dims: {
    "2": { use: "series", members: { in: ["Food", "Shelter"] } },
  } }], time: { preset: "1Y" }, transform: "pct_change_yoy" }));
  assert.equal(result.title, "Food vs Shelter, % change year over year");
  assert.match(result.subtitle, /Canada/);
  assert.doesNotMatch(result.subtitle, /Food|Shelter|%/);
});

test("one named WDS series leads a named place comparison", options, async () => {
  const result = await view({ v: 1, layers: [{ pid: "14100397", dims: {
    "1": { use: "x", members: { in: ["Ontario", "Quebec"] } },
    "2": { use: "series", members: { eq: "Unemployment rate" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } });
  assert.equal(result.title, "Labour force characteristics by family structure: Unemployment rate, Ontario vs Quebec");
  assert.deepEqual(result.series.map((series) => series.name), ["Unemployment rate"]);
  assert.deepEqual(result.categories, ["Ontario", "Quebec"]);
});

test("role-selected or four series keep the short table title", options, async () => {
  const role = await view({ ...population({ "1": { use: "series", members: { role: "territory" } } }), time: { preset: "latest" } });
  assert.deepEqual(role.series.map((s) => s.name), ["Yukon", "Northwest Territories", "Nunavut"]);
  assert.equal(role.title, "Population estimates");
  const four = await view(cpi({ layers: [{ pid: "18100006", dims: {
    "2": { use: "series", members: { in: ["Food", "Shelter", "Transportation", "Clothing and footwear"] } },
  } }], time: { preset: "latest" } }));
  assert.equal(four.series.length, 4);
  assert.equal(four.title, "Consumer Price Index");
});

test("bar names its fixed measure; multi-layer names identify each source", options, async () => {
  const retail = await view({ v: 1, layers: [{ pid: "20100027", dims: {
    "1": { use: "x", members: { any: [{ role: "province" }, { role: "territory" }] } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } });
  assert.equal(retail.series.length, 1);
  assert.equal(retail.series[0].name, "Total retail, all stores");
  const comparison = await view({ v: 1, layers: [
    { pid: "18100006", dims: { "1": { use: "series", members: { eq: "Canada" } } } },
    { pid: "17100009", dims: { "1": { use: "series", members: { eq: "Canada" } } } },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.deepEqual(comparison.series.map((s) => s.name), ["Consumer Price Index · Canada", "Population estimates · Canada"]);
});

test("multi-layer legends prefix distinct places and reserve table numbers for collisions", options, async () => {
  const distinct = await view({ v: 1, layers: [
    { pid: "18100004", dims: { "1": { use: "series", members: { in: ["Canada", "Quebec"] } } } },
    { pid: "17100009", dims: { "1": { use: "series", members: { in: ["Newfoundland and Labrador", "British Columbia"] } } } },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.equal(distinct.title, "Consumer Price Index vs Population estimates");
  assert.deepEqual(distinct.series.map((s) => s.name), [
    "Consumer Price Index · Canada", "Consumer Price Index · Quebec",
    "Population estimates · Newfoundland and Labrador", "Population estimates · British Columbia",
  ]);

  const tied = await view({ v: 1, layers: [
    { pid: "18100004", dims: { "1": { use: "series", members: { eq: "Canada" } } } },
    { pid: "18100006", dims: { "1": { use: "series", members: { eq: "Canada" } } } },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.equal(tied.title, "Consumer Price Index, Canada");
  assert.deepEqual(tied.series.map((s) => s.name), [
    "Canada (18-10-0004-01)", "Canada (18-10-0006-01)",
  ]);

  const subjectLabel = await view({ v: 1, layers: [
    { pid: "18100004", dims: {} },
    { pid: "14100397", dims: { "2": { use: "fixed", members: { eq: "Unemployment rate" } } } },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.deepEqual(subjectLabel.series.map((s) => s.name), [
    "Consumer Price Index · All-items", "Unemployment rate",
  ]);
});

test("multi-layer shared unemployment subject compares group labels without prefixing series", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [
    { pid: "14100287", dims: {
      "1": { use: "series", members: { not: { all: true } },
        groups: [{ label: "Provinces", members: { region: "provinces" } }] },
      "2": { use: "fixed", members: { eq: "Unemployment rate" } },
    } },
    { pid: "14100292", dims: {
      "1": { use: "series", members: { not: { all: true } },
        groups: [{ label: "Territories", members: { region: "territories" } }] },
      "2": { use: "fixed", members: { eq: "Unemployment rate" } },
    } },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const result = await postedView(spec);
  assert.equal(result.title, "Unemployment rate, Provinces vs Territories");
  assert.deepEqual(result.series.map((series) => series.name), ["Provinces", "Territories"]);
  assert.deepEqual(result.series.map((series) => series.group_method), ["published", "ratio"]);
});

test("territories add, but a missing component makes the sum null", options, async () => {
  const result = await view(population({ "1": { use: "sum", members: { role: "territory" } } }));
  assert.deepEqual(result.spec.layers[0].dims["1"].members, { in: [12, 14, 15] });
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].points[0][2], 50356 + 45904 + 43091);
  assert.equal(result.series[0].kind, "sum");
  assert.equal(result.warnings.some((w) => w.code === "sum_refused"), false);
  const missing = await view(population({ "1": { use: "sum", members: { in: [12, 13, 14, 15] } } }));
  assert.deepEqual(missing.series[0].points[0].slice(2), [null, ""]);
});

test("suppressed internal period stays null with official gap meaning and bounded coverage", options, async () => {
  const result = await postedView({ v: 1, layers: [{ pid: "14100287", dims: {
    "1": { use: "series", members: { eq: 2 } },
    "2": { use: "fixed", members: { eq: 4 } },
    "3": { use: "fixed", members: { eq: 2 } },
    "4": { use: "fixed", members: { eq: 3 } },
    "5": { use: "fixed", members: { eq: 1 } },
    "6": { use: "fixed", members: { eq: 2 } },
  } }], time: { from: "1997-10", to: "1997-12" }, transform: "level", chart: { type: "line" } });
  const series = result.series[0];
  assert.deepEqual(series.points.map((point) => [point[0], point[2], point[3]]),
    [["1997-10", 0.5, ""], ["1997-11", null, "x"], ["1997-12", 0.8, ""]]);
  assert.deepEqual(series.coverage, { first: "1997-10", last: "1997-12" });
  assert.equal(series.unpublished, false);
  assert.deepEqual(series.gaps, [{ from: "1997-11", to: "1997-11", mark: "x",
    meaning: "suppressed to meet the confidentiality requirements of the Statistics Act" }]);
  assert.match(result.gap_note ?? "", /suppressed.*1997-11/);
  assert.deepEqual(result.gap_parts, { unpublished: null, time: result.gap_note });
  assert.match(result.sources[0].citation, /suppressed.*1997-11/);
  const leading = await postedView({ ...result.spec, time: { from: "1997-11", to: "1997-12" } });
  assert.deepEqual(leading.series[0].coverage, { first: "1997-12", last: "1997-12" });
  assert.deepEqual(leading.series[0].gaps, []);
  assert.equal(leading.gap_note, null);
  assert.deepEqual(leading.gap_parts, { unpublished: null, time: null });
  const trailing = await postedView({ ...result.spec, time: { from: "1997-10", to: "1997-11" } });
  assert.deepEqual(trailing.series[0].coverage, { first: "1997-10", last: "1997-10" });
  assert.deepEqual(trailing.series[0].gaps, []);
});

test("unpublished city Food combinations remain as null series in view and exports", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
    "1": { use: "series", members: { in: ["Calgary, Alberta", "Halifax, Nova Scotia", "Alberta"] } },
    "2": { use: "fixed", members: { eq: "Food" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const result = await postedView(spec);
  assert.deepEqual(result.series.map((series) => series.unpublished), [true, true, false]);
  for (const series of result.series.slice(0, 2)) {
    assert.deepEqual(series.coverage, { first: null, last: null });
    assert.deepEqual(series.gaps, []);
    assert.equal(series.points.length, 1);
    assert.deepEqual(series.points[0].slice(2), [null, ""]);
  }
  assert.match(result.gap_note ?? "", /Calgary and Halifax Food are not published/);
  assert.deepEqual(result.gap_parts, { unpublished: result.gap_note, time: null });
  assert.match(result.sources[0].citation, /Calgary.*not published.*Halifax.*not published/);
  assert.equal(result.warnings.filter((warning) => warning.code === "no_data").length, 2);
  const solo = await postedView({ ...spec, layers: [{ ...spec.layers[0], dims: {
    ...spec.layers[0].dims, "1": { use: "series", members: { eq: "Calgary, Alberta" } },
  } }] });
  assert.equal(solo.series[0].unpublished, true);
  assert.deepEqual(solo.series[0].points[0].slice(2), [null, ""]);
  const app = chartRoutes({ db });
  for (const format of ["csv", "parquet"] as const) {
    const response = await app.request(`/view.${format}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    assert.equal(response.status, 200, await response.clone().text());
    const file = path.join(db.buildDir, "tmp", `${randomUUID()}.${format}`);
    try {
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
      const rows = await db.query(`SELECT series_name, value, status FROM ${format === "csv"
        ? "read_csv_auto($1, header=true)" : "read_parquet($1)"} ORDER BY series_name`, [file]);
      assert.equal(rows.length, 3);
      assert.equal(rows.filter((row) => row.value === null).length, 2);
      if (format === "parquet") {
        const metadata = await db.query("SELECT value FROM parquet_kv_metadata($1) WHERE key = 'statcan.gap_note'", [file]);
        assert.match(Buffer.from(metadata[0].value as Uint8Array).toString(), /Calgary and Halifax Food/);
      }
    } finally { await fs.unlink(file).catch(() => {}); }
  }
});

test("three unpublished names are explicit; four use a count", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
    "1": { use: "series", members: { in: ["Calgary, Alberta", "Edmonton, Alberta", "Toronto, Ontario"] } },
    "2": { use: "fixed", members: { eq: "Food" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const three = await postedView(spec);
  assert.equal(three.gap_parts.unpublished, "Calgary, Edmonton and Toronto Food are not published by Statistics Canada.");
  assert.equal(three.gap_parts.time, null);
  assert.equal(three.gap_note, three.gap_parts.unpublished);
  const four = await postedView({ ...spec, layers: [{ ...spec.layers[0], dims: {
    ...spec.layers[0].dims,
    "1": { use: "series", members: { in: ["Calgary, Alberta", "Edmonton, Alberta", "Toronto, Ontario", "Halifax, Nova Scotia"] } },
  } }] });
  assert.equal(four.gap_parts.unpublished, "Calgary, Edmonton and 2 more Food are not published by Statistics Canada.");
  assert.equal(four.gap_note, four.gap_parts.unpublished);
});

test("unpublished and internal time gaps stay separate but join for API readers", options, async () => {
  const result = await postedView({ v: 1, layers: [
    { pid: "18100004", dims: { "1": { use: "series", members: { eq: "Calgary, Alberta" } },
      "2": { use: "fixed", members: { eq: "Food" } } } },
    { pid: "14100287", dims: {
      "1": { use: "series", members: { eq: 2 } }, "2": { use: "fixed", members: { eq: 4 } },
      "3": { use: "fixed", members: { eq: 2 } }, "4": { use: "fixed", members: { eq: 3 } },
      "5": { use: "fixed", members: { eq: 1 } }, "6": { use: "fixed", members: { eq: 2 } },
    } },
  ], time: { from: "1997-10", to: "1997-12" }, transform: "level", chart: { type: "line" } });
  assert.match(result.gap_parts.unpublished ?? "", /Calgary.*not published/);
  assert.match(result.gap_parts.time ?? "", /suppressed.*1997-11/);
  assert.equal(result.gap_note, `${result.gap_parts.unpublished} ${result.gap_parts.time}`);
});

test("CPI index sum is refused and shown as separate series", options, async () => {
  const result = await view(cpi({ layers: [{ pid: "18100006", dims: { "2": { use: "sum", members: { in: [1, 2] } } } }] }));
  assert.deepEqual(result.series.map((s) => s.key), ["L0:2=1", "L0:2=2"]);
  assert.ok(result.warnings.some((w) => w.code === "sum_refused"));
});

test("named group combines the selected territory vectors", options, async () => {
  const result = await view(population({ "1": { use: "series", members: { in: [7] }, groups: [{ label: "Territories", members: { role: "territory" } }] } }));
  assert.equal(result.series[1].key, "L0:1=g:Territories");
  assert.equal(result.series[1].name, "Territories");
  assert.equal(result.series[1].group_method, "sum");
  assert.equal(result.series[1].points[0][2], 50356 + 45904 + 43091);
  assert.deepEqual(result.series[1].coordinate[0].member_ids, [12, 14, 15]);
});
test("LFS provinces use published Canada; forced ratio agrees within published rounding", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "14100287", dims: {
    "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Provinces", members: { region: "provinces" }, region: "provinces", agg: "auto" }] },
    "2": { use: "fixed", members: { eq: "Unemployment rate" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const published = await postedView(spec);
  assert.equal(published.series[0].group_method, "published");
  assert.equal(published.series[0].kind, "observed");
  assert.equal(published.series[0].group_of, "Provinces");
  assert.equal(published.series[0].group_members.length, 10);
  assert.match(published.sources[0].citation, /Provinces: published as Canada/);
  const ratio = await postedView({ ...spec, layers: [{ ...spec.layers[0], dims: {
    ...spec.layers[0].dims, "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Provinces", members: { region: "provinces" }, agg: "ratio" },
        { label: "Canada", members: { eq: "Canada" }, agg: "published" }] },
  } }] });
  assert.deepEqual(ratio.series.map((series) => series.group_method), ["ratio", "published"]);
  assert.equal(ratio.axes.length, 1);
  assert.ok(Math.abs(ratio.series[0].points[0][2]! - ratio.series[1].points[0][2]!) < 0.05);
  assert.equal(Number(ratio.series[0].points[0][2]!.toFixed(1)), ratio.series[1].points[0][2]);
  assert.equal(ratio.group_notes[0].formula, "Unemployment ÷ Labour force × 100");
  assert.equal(ratio.series[0].vectors.length, 20);
  const missing = await postedView({ ...spec, layers: [{ ...spec.layers[0], dims: {
    ...spec.layers[0].dims, "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Territories", members: { region: "territories" } }] },
  } }] });
  assert.equal(missing.series.length, 0);
  assert.ok(missing.warnings.some((warning) => warning.code === "group_missing"));
});

test("group-only resolved specs replay through self and export links with a missing table group", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "14100287", dims: {
    "1": { use: "series", members: { not: { all: true } }, groups: [
      { label: "Provinces", members: { region: "provinces" } },
      { label: "Territories", members: { region: "territories" } },
    ] },
    "2": { use: "fixed", members: { eq: "Unemployment rate" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const result = await postedView(spec);
  assert.deepEqual(result.spec.layers[0].dims["1"].members, { not: { all: true } });
  assert.deepEqual(result.spec.layers[0].dims["1"].groups?.[1].members, { not: { all: true } });
  assert.equal(result.spec.layers[0].dims["1"].groups?.[1].region, "territories");
  assert.deepEqual(result.warnings.find((warning) => warning.code === "group_missing"),
    { code: "group_missing", message: "Territories: this table has no territories" });
  const app = chartRoutes({ db });
  for (const format of ["self", "csv", "parquet"] as const) {
    const link = new URL(result.links[format]);
    const response = await app.request(`${link.pathname.replace(/^\/api\/v1/, "")}${link.search}`);
    assert.equal(response.status, 200, `${format}: ${await response.clone().text()}`);
    if (format === "self") {
      const replay = await response.json() as ViewResult;
      assert.deepEqual(replay.spec, result.spec);
      assert.deepEqual(replay.warnings, result.warnings);
      assert.deepEqual(replay.series, result.series);
    } else if (format === "csv") {
      assert.match(await response.text(), /Provinces/);
    } else {
      const data = Buffer.from(await response.arrayBuffer());
      assert.equal(data.toString("utf8", 0, 4), "PAR1");
      assert.equal(data.toString("utf8", data.length - 4), "PAR1");
    }
  }
});

test("curated employment and participation ratios match Canada's published rates", options, async () => {
  for (const [measure, formula] of [
    ["Employment rate", "Employment ÷ Population × 100"],
    ["Participation rate", "Labour force ÷ Population × 100"],
  ]) {
    const spec: ViewSpec = { v: 1, layers: [{ pid: "14100287", dims: {
      "1": { use: "series", members: { not: { all: true } }, groups: [
        { label: "Provinces", members: { region: "provinces" }, agg: "ratio" },
        { label: "Canada", members: { eq: "Canada" }, agg: "published" },
      ] },
      "2": { use: "fixed", members: { eq: measure } },
    } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
    const result = await postedView(spec);
    assert.equal(result.series[0].group_method, "ratio");
    assert.equal(result.group_notes[0].formula, formula);
    assert.equal(Number(result.series[0].points[0][2]!.toFixed(1)), result.series[1].points[0][2]);
  }
});

test("mixed LFS source methodology appears as one layer warning and on its group note", options, async () => {
  const difference = "Territories use three-month moving averages (14100292); provinces use monthly estimates (14100287).";
  const geography = (region: string): ViewSpec["layers"][number]["dims"] => ({
    "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: region === "provinces" ? "Provinces" : "Territories", members: { region } }] },
    "2": { use: "fixed", members: { eq: "Unemployment rate" } },
  });
  const spec: ViewSpec = { v: 1, layers: [
    { pid: "14100287", dims: geography("provinces") },
    { pid: "14100292", method_difference: difference, dims: geography("territories") },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const result = await postedView(spec);
  assert.deepEqual(result.series.map((series) => series.pid), ["14100287", "14100292"]);
  assert.deepEqual(result.warnings.filter((warning) => warning.code === "group_method_difference"),
    [{ code: "group_method_difference", message: difference }]);
  assert.equal(result.group_notes.find((note) => note.pid === "14100292")?.method_difference, difference);
  assert.equal(result.group_notes.find((note) => note.pid === "14100287")?.method_difference, undefined);
  assert.equal(result.spec.layers[1].method_difference, difference);
  const plain = await postedView({ ...spec, layers: [spec.layers[0], { pid: "14100292", dims: geography("territories") }] });
  assert.equal(plain.warnings.some((warning) => warning.code === "group_method_difference"), false);
  assert.equal(plain.group_notes.some((note) => note.method_difference !== undefined), false);
});

test("population regions sum published province and territory cells without historical NWT", options, async () => {
  const spec = population({ "1": { use: "series", members: { not: { all: true } }, groups: [
    { label: "Prairies", members: { region: "prairies" } },
    { label: "Atlantic", members: { region: "atlantic" }, agg: "auto" },
    { label: "Territories", members: { region: "territories" }, agg: "sum" },
  ] } });
  const result = await postedView(spec);
  assert.deepEqual(result.series.map((series) => series.group_method), ["sum", "sum", "sum"]);
  const individuals = await view(population({ "1": { use: "series",
    members: { any: [{ region: "prairies" }, { region: "atlantic" }, { region: "territories" }] } } }));
  const values = new Map(individuals.series.map((series) => [series.name, series.points[0][2]]));
  for (const series of result.series) {
    assert.equal(series.points[0][2], series.group_members.reduce((total, name) => total + values.get(name)!, 0));
    assert.equal(series.kind, "sum");
  }
  assert.deepEqual(result.series[2].group_members, ["Yukon", "Northwest Territories", "Nunavut"]);
  assert.match(result.sources[0].citation, /Territories: sum of Yukon, Northwest Territories, Nunavut/);
});

test("unavailable published group follows auto sum and ratio paths with a warning", options, async () => {
  const populationSpec = population({ "1": { use: "series", members: { not: { all: true } },
    groups: [{ label: "Prairies", members: { region: "prairies" }, agg: "published" }] } });
  const summed = await postedView(populationSpec);
  const auto = await postedView({ ...populationSpec, layers: [{ ...populationSpec.layers[0], dims: {
    "1": { ...populationSpec.layers[0].dims["1"], groups: [
      { label: "Prairies", members: { region: "prairies" }, agg: "auto" }] },
  } }] });
  assert.equal(summed.series[0].group_method, "sum");
  assert.equal(summed.series[0].points[0][2], auto.series[0].points[0][2]);
  assert.equal(summed.group_notes[0].method, "sum");
  assert.equal(summed.spec.layers[0].dims["1"].groups?.[0].agg, "published");
  assert.deepEqual(summed.warnings.filter((warning) => warning.code === "group_published_unavailable"),
    [{ code: "group_published_unavailable", message: "Prairies: no published aggregate; falling back to auto" }]);
  assert.equal(summed.warnings.some((warning) => warning.code === "group_not_combined"), false);

  const rate = await postedView({ v: 1, layers: [{ pid: "14100292", dims: {
    "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Territories", members: { region: "territories" }, agg: "published" }] },
    "2": { use: "fixed", members: { eq: "Unemployment rate" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.equal(rate.series[0].group_method, "ratio");
  assert.ok(rate.series[0].points[0][2] !== null);
  assert.equal(rate.group_notes[0].method, "ratio");
  assert.ok(rate.warnings.some((warning) => warning.code === "group_published_unavailable"));
});

test("CPI indexes remain separate tagged members instead of averaged regions", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
    "1": { use: "series", members: { not: { all: true } }, groups: [
      { label: "Prairies", members: { region: "prairies" } },
      { label: "Maritimes", members: { region: "maritimes" } },
    ] },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const result = await postedView(spec);
  assert.equal(result.series.length, 6);
  assert.deepEqual(result.series.map((series) => series.group), [
    "Prairies", "Prairies", "Prairies", "Maritimes", "Maritimes", "Maritimes",
  ]);
  assert.ok(result.series.every((series) => series.group_method === null && series.kind === "observed"));
  assert.equal(result.warnings.filter((warning) => warning.code === "group_not_combined").length, 2);
  assert.deepEqual(result.group_notes.map((note) => note.method), ["not_combined", "not_combined"]);
  const source = await view({ ...spec, layers: [{ pid: "18100004", dims: {
    "1": { use: "series", members: { any: [{ region: "prairies" }, { region: "maritimes" }] } },
  } }] });
  const values = new Map(source.series.map((series) => [series.name, series.points[0][2]]));
  for (const series of result.series) assert.equal(series.points[0][2], values.get(series.name));
  const categories = await postedView({ ...spec, chart: { type: "bar" }, layers: [{ pid: "18100004", dims: {
    "1": { ...spec.layers[0].dims["1"], use: "x" },
  } }] });
  assert.deepEqual(categories.category_groups, result.series.map((series) => series.group));
  assert.ok(categories.category_methods?.every((method) => method === null));
});

test("Census province groups sum count cells and keep method provenance", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "98100030", dims: {
    "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Prairies", members: { region: "prairies" } }] },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const result = await postedView(spec);
  const individuals = await view({ ...spec, layers: [{ pid: "98100030", dims: {
    "1": { use: "series", members: { region: "prairies" } },
  } }] });
  assert.equal(result.series[0].group_method, "sum");
  assert.equal(result.series[0].points[0][2], individuals.series.reduce((total, series) => total + series.points[0][2]!, 0));
  assert.equal(result.group_notes[0].method, "sum");
});


test("region catalogue and partial groups never invent missing provincial totals", options, async () => {
  const app = chartRoutes({ db });
  const regions = await (await app.request("/regions")).json();
  assert.deepEqual(regions.regions.find((region: { region_id: string }) => region.region_id === "prairies").members, ["46", "47", "48"]);
  assert.deepEqual(regions.regions.find((region: { region_id: string }) => region.region_id === "canadian_shield").members, []);
  const spec: ViewSpec = { v: 1, layers: [{ pid: "20100027", dims: {
    "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Prairies", members: { region: "prairies" } }] },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const partial = await postedView(spec);
  assert.ok(partial.warnings.some((warning) => warning.code === "group_partial" &&
    /Manitoba.*Alberta/.test(warning.message)));
  assert.ok(partial.warnings.some((warning) => warning.code === "group_not_combined"));
  assert.deepEqual(partial.series.map((series) => [series.name, series.group, series.group_method]),
    [["Saskatchewan", "Prairies", null]]);
  const physical = await postedView({ ...spec, layers: [{ ...spec.layers[0], dims: {
    "1": { use: "series", members: { not: { all: true } },
      groups: [{ label: "Canadian Shield", members: { region: "canadian_shield" } }] },
  } }] });
  assert.ok(physical.warnings.some((warning) => warning.code === "group_missing" && /province borders/.test(warning.message)));
});

test("x-category group methods and CSV/Parquet retain category-specific provenance", options, async () => {
  const spec: ViewSpec = { ...population({ "1": { use: "x", members: { not: { all: true } }, groups: [
    { label: "Prairies", members: { region: "prairies" } },
    { label: "Atlantic", members: { region: "atlantic" } },
  ] } }), chart: { type: "bar", sort: "desc" } };
  const result = await postedView(spec);
  assert.deepEqual(new Set(result.categories), new Set(["Prairies", "Atlantic"]));
  assert.deepEqual(result.category_groups, result.categories);
  assert.deepEqual(result.category_methods, ["sum", "sum"]);
  assert.equal(result.group_notes.length, 2);
  for (const format of ["csv", "parquet"] as const) {
    const response = await chartRoutes({ db }).request(`/view.${format}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    assert.equal(response.status, 200);
    const file = path.join(db.buildDir, "tmp", `${randomUUID()}.${format}`);
    try {
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
      const rows = await db.query(`SELECT category, group_method, group_members FROM ${format === "csv"
        ? "read_csv_auto($1, header=true)" : "read_parquet($1)"} ORDER BY category`, [file]);
      assert.deepEqual(rows.map((row) => [row.category, row.group_method]), [["Atlantic", "sum"], ["Prairies", "sum"]]);
      if (format === "csv") {
        assert.match(String(rows[0].group_members), /Newfoundland and Labrador/);
        assert.match(String(rows[1].group_members), /Manitoba/);
      } else {
        assert.deepEqual(rows[0].group_members, ["Newfoundland and Labrador", "Prince Edward Island", "Nova Scotia", "New Brunswick"]);
        assert.deepEqual(rows[1].group_members, ["Manitoba", "Saskatchewan", "Alberta"]);
        const metadata = await db.query("SELECT key, value FROM parquet_kv_metadata($1) WHERE key = 'statcan.group_notes'", [file]);
        assert.equal(metadata.length, 1);
        assert.match(Buffer.from(metadata[0].value as Uint8Array).toString(), /Prairies/);
      }
    } finally { await fs.unlink(file).catch(() => {}); }
  }
});

test("x-category bar uses requested period and sorts its categories", options, async () => {
  const result = await view({ ...population({ "1": { use: "x", members: { in: [7, 12, 14, 15] } } }), time: { at: "2026-07" }, chart: { type: "bar", sort: "desc" } });
  assert.equal(result.x.kind, "category");
  assert.equal(result.series[0].points.length, 4);
  assert.equal(result.categories?.[0], "Ontario");
  assert.equal(result.series[0].points[0][2], 16262121);
  assert.equal(result.series[0].points[0][0], "2026-07-01");
  assert.ok(result.series[0].points.every((p) => p[1] === "2026-07-01"));
});

test("period, annual, window, index, and share transforms use published values", options, async () => {
  const spec = cpi({ time: { from: "2025-08", to: "2026-08" } });
  const period = await view({ ...spec, transform: "pct_change_period" });
  assert.ok(Math.abs(period.series[0].points.at(-1)![2]! - (169.3 / 168.9 - 1) * 100) < 1e-10);
  const yoy = await view({ ...spec, transform: "pct_change_yoy" });
  assert.equal(yoy.title, "Consumer Price Index, % change year over year");
  assert.ok(Math.abs(yoy.series[0].points.at(-1)![2]! - (169.3 / 164.3 - 1) * 100) < 1e-10);
  const indexed = await view({ ...spec, transform: "index_first" });
  assert.equal(indexed.title, "Consumer Price Index, indexed to first = 100");
  assert.equal(indexed.series[0].points[0][2], 100);
  assert.ok(Math.abs(indexed.series[0].points.at(-1)![2]! - 169.3 / 164.3 * 100) < 1e-10);
  const window = await view({ ...spec, transform: "pct_change_window", chart: { type: "bar" } });
  assert.equal(window.series[0].points.length, 1);
  assert.ok(Math.abs(window.series[0].points[0][2]! - (169.3 / 164.3 - 1) * 100) < 1e-10);
  const share = await view({ ...population({ "1": { use: "x", members: { in: [12, 14, 15] } } }), transform: "share_of_x", chart: { type: "stacked_bar_100" } });
  assert.ok(Math.abs(share.series[0].points[0][2]! - 50356 / (50356 + 45904 + 43091) * 100) < 1e-10);
});

test("index bases outside the window use the first published month and trim all lookback rows", options, async () => {
  const spec = cpi({ transform: "index_first", index_base: "2015", time: { from: "2025-08", to: "2026-08" } });
  const levels = await view(cpi({ time: { from: "2015", to: "2015" } }));
  const first = levels.series[0].points.find((point) => point[2] != null)!;
  const result = await postedView(spec);
  assert.equal(first[1], "2015-01-01");
  assert.equal(result.spec.index_base, "2015");
  assert.equal(result.index_note, "Index uses the first published point in 2015 as 100, when available.");
  assert.equal(result.series[0].unit, "index (2015 = 100)");
  assert.match(result.title, /indexed to 2015 = 100$/);
  assert.match(result.sources[0].citation, /Indexed to 2015 = 100/);
  assert.equal(result.series[0].points.length, 13);
  assert.equal(result.series[0].points[0][1], "2025-08-01");
  assert.ok(Math.abs(result.series[0].points.at(-1)![2]! - 169.3 / first[2]! * 100) < 1e-10);
  const exported = await chartRoutes({ db }).request(`/view.csv?s=${encodeSpec(spec)}`);
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.equal(csv.trim().split("\n").length, 14);
  assert.doesNotMatch(csv, /2015-01-01/);
  const later = await view(cpi({ transform: "index_first", index_base: "2026-08", time: { from: "2025-08", to: "2025-10" } }));
  assert.deepEqual(later.series[0].points.map((point) => point[1]), ["2025-08-01", "2025-09-01", "2025-10-01"]);
  assert.ok(Math.abs(later.series[0].points[0][2]! - 164.3 / 169.3 * 100) < 1e-10);
});

test("monthly index base selects exactly the named month", options, async () => {
  const levels = await view(cpi({ time: { from: "2015-06", to: "2015-06" } }));
  const result = await view(cpi({ transform: "index_first", index_base: "2015-06", time: { preset: "1Y" } }));
  assert.equal(result.series[0].unit, "index (Jun 2015 = 100)");
  assert.equal(result.series[0].points[0][1], "2025-08-01");
  assert.ok(Math.abs(result.series[0].points.at(-1)![2]! - 169.3 / levels.series[0].points[0][2]! * 100) < 1e-10);
  const day = await view(cpi({ transform: "index_first", index_base: "2015-06-01", time: { preset: "1Y" } }));
  assert.equal(day.series[0].points.at(-1)![2], result.series[0].points.at(-1)![2]);
});

test("quarterly series indexes to the first published point of the base year", options, async () => {
  const levels = await view({ ...population({}), time: { from: "2023", to: "2023" } });
  const first = levels.series[0].points.find((point) => point[2] != null)!;
  const result = await view({ ...population({}), transform: "index_first", index_base: "2023", time: { preset: "1Y" } });
  assert.equal(first[1], "2023-01-01");
  assert.equal(result.series[0].unit, "index (2023 = 100)");
  const recent = await view({ ...population({}), time: { preset: "1Y" } });
  assert.ok(Math.abs(result.series[0].points.at(-1)![2]! - recent.series[0].points.at(-1)![2]! / first[2]! * 100) < 1e-10);
  const q2 = levels.series[0].points.find((point) => point[1] === "2023-04-01")!;
  const quarter = await view({ ...population({}), transform: "index_first", index_base: "2023-Q2", time: { preset: "1Y" } });
  assert.equal(quarter.series[0].unit, "index (Q2 2023 = 100)");
  assert.ok(Math.abs(quarter.series[0].points.at(-1)![2]! - recent.series[0].points.at(-1)![2]! / q2[2]! * 100) < 1e-10);
});

test("missing index base keeps the requested window and warns for each series", options, async () => {
  const result = await view(cpi({ transform: "index_first", index_base: "1800", time: { preset: "1Y" } }));
  assert.equal(result.series[0].points.length, 13);
  assert.ok(result.series[0].points.every((point) => point[2] === null));
  assert.ok(result.warnings.some((warning) => warning.code === "index_base_missing" && warning.message.includes(result.series[0].key)));
  assert.equal(result.index_note, "Index uses the first published point in 1800 as 100, when available.");
});

test("index without a base skips unpublished leading periods per series", options, async () => {
  const result = await view({ v: 1, layers: [{ pid: "18100006", dims: {} }, { pid: "17100009", dims: {} }],
    time: { from: "2025-06", to: "2026-07" }, transform: "index_first", chart: { type: "line" } });
  const quarterly = result.series.find((series) => series.pid === "17100009")!;
  assert.equal(quarterly.points[0][2], null);
  assert.equal(quarterly.points.find((point) => point[2] != null)?.[2], 100);
});

test("monthly YoY keeps all 37 requested periods and exports no warmup rows", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
    "2": { use: "series", members: { in: ["Food", "Shelter"] } },
  } }], time: { from: "2023-08", to: "2026-08" }, transform: "pct_change_yoy", chart: { type: "line" } };
  const result = await view(spec);
  const levels = await view({ ...spec, transform: "level", time: { from: "2022-08", to: "2023-08" } });
  assert.deepEqual(result.period, { from: "2023-08-01", to: "2026-08-01" });
  assert.match(result.subtitle, /Aug 2023 – Aug 2026/);
  for (const series of result.series) {
    assert.equal(series.points.length, 37);
    assert.equal(series.points[0][1], "2023-08-01");
    assert.equal(series.points.at(-1)![1], "2026-08-01");
    assert.ok(series.points.every((point) => point[2] !== null));
    const raw = levels.series.find((candidate) => candidate.name === series.name)!;
    const first = raw.points.find((point) => point[1] === "2023-08-01")![2]!;
    const prior = raw.points.find((point) => point[1] === "2022-08-01")![2]!;
    assert.ok(Math.abs(series.points[0][2]! - (first / prior - 1) * 100) < 1e-10);
  }
  const table = tableHtml(result);
  assert.equal((table.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length, 37);
  assert.match(table, /Aug 2023/);
  assert.doesNotMatch(table, /Aug 2022/);
  const app = chartRoutes({ db });
  for (const format of ["csv", "parquet"] as const) {
    const response = await app.request(`/view.${format}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    assert.equal(response.status, 200);
    const file = path.join(db.buildDir, "tmp", `${randomUUID()}.${format}`);
    try {
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
      const rows = await db.query(`SELECT series_name, CAST(period_start AS VARCHAR) AS period_start, value::DOUBLE AS value
        FROM ${format === "csv" ? "read_csv_auto($1, header=true)" : "read_parquet($1)"}
        ORDER BY series_name, period_start`, [file]);
      assert.equal(rows.length, 74);
      for (const series of result.series) {
        const exported = rows.filter((row) => row.series_name === series.name);
        assert.equal(exported.length, 37);
        assert.equal(exported[0].period_start, "2023-08-01");
        assert.equal(exported.at(-1)!.period_start, "2026-08-01");
        assert.ok(Math.abs(Number(exported[0].value) - series.points[0][2]!) < 1e-10);
      }
    } finally { await fs.unlink(file).catch(() => {}); }
  }
});

test("quarterly YoY and period changes use preceding source periods", options, async () => {
  const spec: ViewSpec = { ...population({}), time: { from: "2023-07", to: "2026-07" }, transform: "pct_change_yoy" };
  const yearly = await view(spec);
  const levels = await view({ ...spec, transform: "level", time: { from: "2022-07", to: "2023-07" } });
  const points = yearly.series[0].points;
  assert.equal(points.length, 13);
  assert.equal(points[0][1], "2023-07-01");
  assert.equal(points.at(-1)![1], "2026-07-01");
  assert.ok(points.every((point) => point[2] !== null));
  const first = levels.series[0].points.find((point) => point[1] === "2023-07-01")![2]!;
  const priorYear = levels.series[0].points.find((point) => point[1] === "2022-07-01")![2]!;
  assert.ok(Math.abs(points[0][2]! - (first / priorYear - 1) * 100) < 1e-10);
  const previous = await view({ ...spec, transform: "pct_change_period" });
  const priorQuarter = levels.series[0].points.find((point) => point[1] === "2023-04-01")![2]!;
  assert.ok(Math.abs(previous.series[0].points[0][2]! - (first / priorQuarter - 1) * 100) < 1e-10);
});

test("missing prehistory stays null while the shown period begins at the first value", options, async () => {
  const spec = cpi({ layers: [{ pid: "18100004", dims: {} }],
    time: { from: "1914-01", to: "1915-01" }, transform: "pct_change_yoy" });
  const result = await view(spec);
  assert.equal(result.series[0].points.length, 13);
  assert.ok(result.series[0].points.slice(0, 12).every((point) => point[2] === null));
  assert.equal(result.series[0].points.at(-1)![1], "1915-01-01");
  assert.notEqual(result.series[0].points.at(-1)![2], null);
  assert.deepEqual(result.period, { from: "1915-01-01", to: "1915-01-01" });
  assert.match(result.subtitle, /Jan 1915/);
  assert.doesNotMatch(result.subtitle, /1914/);
});

test("annual YoY uses the preceding year before the requested range", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "13100932", dims: {} }],
    time: { from: "2022", to: "2024" }, transform: "pct_change_yoy", chart: { type: "line" } };
  const result = await view(spec);
  const levels = await view({ ...spec, time: { from: "2021", to: "2022" }, transform: "level" });
  assert.deepEqual(result.series[0].points.map((point) => point[1]), ["2022-01-01", "2023-01-01", "2024-01-01"]);
  const [prior, first] = levels.series[0].points.map((point) => point[2]!);
  assert.ok(Math.abs(result.series[0].points[0][2]! - (first / prior - 1) * 100) < 1e-10);
});

test("mixed monthly and quarterly YoY retains each layer's own prior periods", options, async () => {
  const time = { from: "2025-07", to: "2026-07" };
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {} }, { pid: "17100009", dims: {} }],
    time, transform: "pct_change_yoy", chart: { type: "line" } };
  const result = await view(spec);
  const quarterly = result.series.find((series) => series.pid === "17100009")!;
  const alone = await view({ ...population({}), time, transform: "pct_change_yoy" });
  const expected = new Map(alone.series[0].points.map((point) => [point[1], point[2]]));
  assert.equal(quarterly.points.length, 13);
  for (const point of quarterly.points) {
    const value = expected.get(point[1]);
    if (value === undefined) assert.equal(point[2], null);
    else assert.ok(Math.abs(point[2]! - value!) < 1e-10);
  }
});

test("category YoY computes each province from its own prior value", options, async () => {
  const spec: ViewSpec = { ...population({ "1": { use: "x", members: { in: ["Ontario", "Quebec"] } } }),
    time: { from: "2025-07", to: "2026-07", at: "2026-07" }, transform: "pct_change_yoy", chart: { type: "bar" } };
  const result = await view(spec);
  const prior = await view({ ...spec, time: { from: "2025-07", to: "2025-07" }, transform: "level" });
  const current = await view({ ...spec, time: { from: "2026-07", to: "2026-07" }, transform: "level" });
  assert.deepEqual(result.categories, ["Ontario", "Quebec"]);
  for (let i = 0; i < 2; i++) {
    const expected = (current.series[0].points[i][2]! / prior.series[0].points[i][2]! - 1) * 100;
    assert.ok(Math.abs(result.series[0].points[i][2]! - expected) < 1e-10);
  }
});

test("category window transforms report the comparison start, not only the displayed period", options, async () => {
  const spec = { ...population({ "1": { use: "x" as const, members: { in: [7, 12, 14, 15] } } }),
    time: { from: "2025-07", to: "2026-07" }, transform: "pct_change_window" as const, chart: { type: "bar" as const } };
  const result = await view(spec);
  assert.equal(result.title, "Population estimates by province or territory, % change since 2025");
  assert.equal(result.subtitle, "Jul 1, 2025 – Jul 1, 2026");
  assert.deepEqual(result.period, { from: "2025-07-01", to: "2026-07-01" });
  const indexed = await view({ ...spec, transform: "index_first" });
  assert.deepEqual(indexed.period, result.period);
  const latest = await view({ ...spec, transform: "level", time: { preset: "latest" } });
  assert.deepEqual(latest.period, { from: "2026-07-01", to: "2026-07-01" });
});

test("Gasoline versus Food titles and windows use the selected duration", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "18100004", dims: {
    "1": { use: "x", members: { role: "province" } },
    "2": { use: "series", members: { in: ["Gasoline", "Food"] } },
  } }], time: { preset: "1Y" }, transform: "pct_change_window", chart: { type: "bar" } };
  const year = await view(spec);
  assert.equal(year.title, "Gasoline vs Food by province, % change over 1 year");
  assert.equal(year.subtitle, "Aug 2025 – Aug 2026");
  assert.deepEqual(year.period, { from: "2025-08-01", to: "2026-08-01" });
  assert.deepEqual(year.series.map((s) => s.name), ["Gasoline", "Food"]);
  assert.equal(year.sources[0].title, "Consumer Price Index, monthly, not seasonally adjusted");
  for (const [preset, first, title] of [
    ["2Y", "2024-08-01", "Gasoline vs Food by province, % change over 2 years"],
    ["5Y", "2021-08-01", "Gasoline vs Food by province, % change over 5 years"],
  ] as const) {
    const result = await view({ ...spec, time: { preset } });
    assert.equal(result.title, title);
    assert.deepEqual(result.period, { from: first, to: "2026-08-01" });
  }
  const since = await view({ ...spec, time: { from: "2020" } });
  assert.equal(since.title, "Gasoline vs Food by province, % change since 2020");
  assert.match(since.period.from ?? "", /^2020-/);
});

test("manufacturing x comparison does not repeat the table geography", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "16100048", dims: {
    "1": { use: "x", members: { in: [6, 5] } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } };
  const comparison = await view(spec);
  assert.equal(comparison.title, "Manufacturing sales by industry and province, Ontario vs Quebec");
  assert.deepEqual(comparison.categories, ["Ontario", "Quebec"]);
  const allProvinces = await view({ ...spec, layers: [{ pid: "16100048", dims: {
    "1": { use: "x", members: { role: "province" } },
  } }] });
  assert.equal(allProvinces.title, "Manufacturing sales by industry and province");
});

test("imports lead with the trade concept, not repeated partner qualifiers", options, async () => {
  const result = await view({ v: 1, layers: [{ pid: "12100178", dims: {
    "4": { use: "fixed", members: { eq: "United States, country of origin" } },
    "5": { use: "fixed", members: { eq: "United States, country of export" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.equal(result.title, "Imports from the United States");
  assert.equal(result.sources[0].title, "Canadian international merchandise trade for imports by country of origin and country of export, customs-based, monthly");
});

test("category titles stay short while source classifications keep their published case", options, async () => {
  const deaths = await view({ v: 1, layers: [{ pid: "13100932", dims: {
    "1": { use: "fixed", members: { eq: 1 } }, "2": { use: "fixed", members: { eq: 1 } },
    "3": { use: "x", members: { in: [2, 3, 4, 5] } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } });
  assert.equal(deaths.title, "Deaths by cause of death");
  assert.equal(deaths.x.dimension, "Cause of death (ICD-10)");
  assert.match(deaths.sources[0].title, /^Deaths and mortality rate/);
  const earnings = await view({ v: 1, layers: [{ pid: "14100220", dims: {
    "1": { use: "fixed", members: { eq: 1 } }, "2": { use: "fixed", members: { eq: 2 } },
    "3": { use: "x", members: { in: [10, 21, 34, 145] } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "bar" } });
  assert.equal(earnings.title, "Average weekly earnings by industry");
  assert.equal(earnings.x.dimension, "North American Industry Classification System (NAICS)");
  assert.match(earnings.sources[0].title, /^Employment and average weekly earnings/);
});

test("notes include table and dimension notes, then only selected member notes", options, async () => {
  const headline = await view(cpi());
  assert.deepEqual(headline.notes.map((n) => [n.note_id, n.scope.kind]).slice(-2), [[10, "dimension"], [9, "member"]]);
  const food = await view(cpi({ layers: [{ pid: "18100006", dims: { "2": { use: "fixed", members: { eq: "Food" } } } }] }));
  assert.equal(food.title, "Food");
  assert.equal(food.notes.some((n) => n.note_id === 9), false);
  const territories = await view(population({ "1": { use: "series", members: { in: [12, 14] } } }));
  assert.equal(territories.notes.some((n) => n.note_id === 4), false);
  assert.equal(territories.notes.some((n) => n.note_id === 5 && n.scope.kind === "member"), true);
});
test("member algebra resolves IDs and caps high-cardinality series", options, async () => {
  const result = await view(cpi({ layers: [{ pid: "18100006", dims: { "2": { use: "series", members: {
    and: [{ descendantsOf: "All-items" }, { not: { contains: "Shelter" } }],
  } } } }], time: { preset: "latest" } }));
  assert.ok(result.series.some((s) => s.name === "Food"));
  assert.equal(result.series.some((s) => s.name === "Shelter"), false);
  const capped = await view({ v: 1, layers: [{ pid: "18100007", dims: { "2": { use: "series", members: { all: true } } } }],
    time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.equal(capped.series.length, 40);
  assert.equal(capped.title, "Basket weights of the Consumer Price Index");
  assert.ok(capped.warnings.some((w) => w.code === "series_capped" && w.total === 347));
});

test("scale_values applies the official scalar exponent", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "20100027", dims: {} }], time: { preset: "latest" },
    transform: "level", chart: { type: "line" } };
  const original = await view(spec);
  const scaled = await view({ ...spec, chart: { type: "line", scale_values: true } });
  assert.equal(original.series[0].scale, "millions");
  assert.equal(scaled.series[0].scale, "units");
  assert.equal(scaled.series[0].points[0][2], original.series[0].points[0][2]! * 1_000_000);
});

test("embedded scale appears once and exports the same published or scaled value", options, async () => {
  const spec: ViewSpec = { v: 1, layers: [{ pid: "14100287", dims: {
    "2": { use: "fixed", members: { eq: "Unemployment" } },
    "4": { use: "fixed", members: { eq: "15 to 24 years" } },
  } }], time: { preset: "latest" }, transform: "level", chart: { type: "line" } };
  const app = chartRoutes({ db });
  for (const [scaled, unit, value] of [[false, "Persons in thousands", 403.2], [true, "Persons", 403200]] as const) {
    const selected: ViewSpec = { ...spec, chart: { type: "line", scale_values: scaled } };
    const result = await view(selected);
    assert.deepEqual(result.axes[0], { unit, scale: "units", unit_family: "count" });
    assert.equal(result.series[0].points[0][2], value);
    assert.match(result.subtitle, new RegExp(`${unit}$`));
    assert.doesNotMatch(result.subtitle, /thousands \(thousands\)/);
    for (const format of ["csv", "parquet"] as const) {
      const response = await app.request(`/view.${format}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(selected) });
      assert.equal(response.status, 200);
      const file = path.join(db.buildDir, "tmp", `${randomUUID()}.${format}`);
      try {
        await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
        const rows = await db.query(`SELECT value::DOUBLE AS value, unit, scale FROM ${format === "csv"
          ? "read_csv_auto($1, header=true)" : "read_parquet($1)"}`, [file]);
        assert.deepEqual(rows.map((r) => [r.value, r.unit, r.scale]), [[value, unit, "units"]]);
      } finally { await fs.unlink(file).catch(() => {}); }
    }
  }
});

test("cube suggestions, encoded GET, and CSV expose the view contract", options, async () => {
  const app = chartRoutes({ db });
  const cube = await app.request("/cubes/18100006");
  assert.equal(cube.status, 200);
  assert.equal((await cube.json()).build_id, db.manifest.build_id);
  const suggestions = await (await app.request("/cubes/18100006/views")).json();
  assert.ok(suggestions.views.some((v: { label: string }) => v.label === "Headline"));
  const spec = cpi({ time: { preset: "latest" } });
  const encoded = Buffer.from(JSON.stringify(spec)).toString("base64url");
  const response = await app.request(`/view?s=${encoded}`);
  assert.equal(response.status, 200);
  const csv = await (await app.request(`/view.csv?s=${encoded}`)).text();
  assert.match(csv, /"\[""v[0-9]+""\]"/);
  const bad = await app.request("/view", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).normalized_build_id, db.normalized.build_id);
});


test("mixed units use two axes and multi-table notes retain both sources", options, async () => {
  const units = await view({ v: 1, layers: [{ pid: "14100397", dims: { "2": { use: "series", members: { in: [1, 8] } } } }],
    time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.deepEqual(units.series.map((s) => s.axis), [0, 1]);
  assert.ok(units.warnings.some((w) => w.code === "mixed_units"));
  const mixed = await view({ v: 1, layers: [{ pid: "18100006", dims: {} }, { pid: "17100009", dims: {} }],
    time: { preset: "1Y" }, transform: "level", chart: { type: "line" } });
  assert.deepEqual(mixed.sources.map((s) => s.pid), ["18100006", "17100009"]);
  assert.equal(mixed.title, "Consumer Price Index vs Population estimates");
  assert.ok(mixed.notes.some((n) => n.pid === "18100006"));
  assert.ok(mixed.notes.some((n) => n.pid === "17100009"));
  assert.ok(mixed.warnings.some((w) => w.code === "mixed_frequency"));
});

test("empty non-fixed selection drops its layer without imposing its x axis", options, async () => {
  const result = await view({ v: 1, layers: [
    { pid: "18100006", dims: { "2": { use: "x", members: { eq: "No such CPI member" } } } },
    { pid: "17100009", dims: {} },
  ], time: { preset: "latest" }, transform: "level", chart: { type: "line" } });
  assert.deepEqual(result.x, { kind: "time" });
  assert.deepEqual(result.sources.map((s) => s.pid), ["17100009"]);
  assert.ok(result.warnings.some((w) => w.code === "member_not_found"));
  assert.ok(result.warnings.some((w) => w.code === "empty_selection"));
});

test("invalid selections and incompatible transforms return 422; unknown PID returns 404", options, async () => {
  const invalid = await runView(db, cpi({ layers: [{ pid: "18100006", dims: { "2": { use: "fixed", members: { in: [1, 2] } } } }] }));
  assert.equal(invalid.kind, "invalid"); if (invalid.kind === "invalid") assert.equal(invalid.status, 422);
  const x = await runView(db, cpi({ transform: "share_of_x", chart: { type: "bar" } }));
  assert.equal(x.kind, "invalid"); if (x.kind === "invalid") assert.equal(x.status, 422);
  const noPid = await runView(db, cpi({ layers: [{ pid: "99999999", dims: {} }] }));
  assert.equal(noPid.kind, "invalid"); if (noPid.kind === "invalid") assert.equal(noPid.status, 404);
});

test("Parquet export round trip matches JSON points and carries metadata", options, async () => {
  const spec = cpi({ layers: [{ pid: "18100006", dims: { "2": { use: "series", members: { in: [1, 2] } } } }], time: { preset: "1Y" },
    chart: { type: "line", hidden: ["L0:2=2"], colors: { "L0:2=1": 4 } } });
  const app = chartRoutes({ db });
  const response = await app.request("/view.parquet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
  assert.equal(response.status, 200);
  const file = path.join(db.buildDir, "tmp", `${randomUUID()}.parquet`);
  try {
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    const rows = await db.query("SELECT series_key, ref_date, value, hidden FROM read_parquet($1) ORDER BY series_key, period_start", [file]);
    const result = await view(spec);
    assert.deepEqual(rows.map((r) => [r.series_key, r.ref_date, r.value, r.hidden]), result.series.flatMap((s) => s.points.map((p) => [s.key, p[0], p[2], s.hidden])));
    assert.ok(rows.some((r) => r.hidden === true && r.series_key === "L0:2=2"));
    assert.equal(result.series[0].color, 4);
    const metadata = await db.query("SELECT key::VARCHAR AS key, value::VARCHAR AS value FROM parquet_kv_metadata($1) WHERE key::VARCHAR LIKE 'statcan.%'", [file]);
    assert.ok(metadata.some((r) => String(r.key) === "statcan.build_id"));
  } finally { await fs.unlink(file).catch(() => {}); }
});
