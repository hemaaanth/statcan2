import { test } from "node:test";
import assert from "node:assert/strict";
import { orderMembersByQuery, parseCues, relativeMembers, tablePid } from "../src/planner.ts";

// These tests make no network or database calls.
test("table numbers require a complete, valid printed suffix", () => {
  assert.equal(tablePid("18-10-0006"), "18100006");
  assert.equal(tablePid("18-10-0006-01"), "18100006");
  assert.equal(tablePid("18100006"), "18100006");
  assert.equal(tablePid("18-10-0006-02"), undefined);
  assert.equal(tablePid("18-10-000"), undefined);
});

test("explicit years override time presets", () => {
  assert.deepEqual(parseCues("unemployment since 2015").time, { preset: "max", from: "2015" });
  assert.deepEqual(parseCues("unemployment since2020").time, { preset: "max", from: "2020" });
  assert.deepEqual(parseCues("joblessness starting in 2020").time, { preset: "max", from: "2020" });
  assert.deepEqual(parseCues("cattle 2010–2020").time, { preset: "max", from: "2010", to: "2020" });
  assert.deepEqual(parseCues("cattle in 2021").time, { preset: "max", from: "2021", to: "2021" });
  assert.deepEqual(parseCues("cattle by class 2021").time, { preset: "max", from: "2021", to: "2021" });
  assert.deepEqual(parseCues("food inflation past 5 years").time, { preset: "5Y" });
  assert.deepEqual(parseCues("prices past year").time, { preset: "1Y" });
  assert.deepEqual(parseCues("gasoline 1y change").time, { preset: "1Y" });
  assert.equal(parseCues("jobs past 6 months").relativeMonths, 6);
  const year = String(new Date().getUTCFullYear());
  assert.deepEqual(parseCues("population this year").time, { preset: "1Y" });
  assert.deepEqual(parseCues(`population in ${year}`).time, { preset: "1Y" });
  assert.deepEqual(parseCues("gasoline over the last 12 months").time, { preset: "1Y" });
  assert.deepEqual(parseCues("gasoline last12months").time, { preset: "1Y" });
  assert.equal(parseCues("how much did prices go up this year").transform, "pct_change_yoy");
});

test("geography cues distinguish named places and role scopes", () => {
  assert.equal(parseCues("unemployment in the territories").geography, "territories");
  assert.equal(parseCues("population provinces vs territories").geography, "regions");
  assert.deepEqual(parseCues("jobs ON vs QC").places, ["Ontario", "Quebec"]);
  assert.equal(parseCues("gas vs food by province").geography, "provinces");
});

test("region aliases keep comparison order and province adjacency", () => {
  const comparison = parseCues("population prairies vs atlantic vs central");
  assert.deepEqual(comparison.groups?.map((group) => group.label),
    ["Prairies", "Atlantic provinces", "Central Canada"]);
  assert.deepEqual(parseCues("Ontario vs the Maritimes population").groups?.map((group) => group.label),
    ["Ontario", "Maritimes"]);
  assert.deepEqual(parseCues("median income by region").groups?.map((group) => group.label),
    ["Atlantic", "Quebec", "Ontario", "Prairies", "BC", "Territories"]);
  assert.equal(parseCues("Canadian Shield population").physiographic?.region_id, "canadian_shield");
  assert.equal(parseCues("population Ontario vs Quebec").groups, undefined);
});

test("time ranges and geographic comparisons retain the requested chart intent", () => {
  const trend = parseCues("population Ontario and Quebec since 2015");
  assert.equal(trend.range, true);
  assert.deepEqual(trend.concepts, ["population Ontario and Quebec since 2015"]);
  const mixed = parseCues("gas vs food cost by province, past year");
  assert.equal(mixed.range, true);
  assert.equal(mixed.concepts.length, 2);
  const snapshot = parseCues("population by province latest");
  assert.equal(snapshot.latest, true);
  assert.equal(snapshot.range, false);
});

test("explicit member lists follow query order instead of catalogue order", () => {
  const provinces = [{ id: 6, label: "Quebec" }, { id: 7, label: "Ontario" }];
  assert.deepEqual(orderMembersByQuery("unemployment rate Ontario vs Quebec", provinces).map((m) => m.id), [7, 6]);
  assert.deepEqual(orderMembersByQuery("unemployment rate Quebec vs Ontario", provinces).map((m) => m.id), [6, 7]);
  assert.deepEqual(orderMembersByQuery("unemployment rate QC vs ON", provinces).map((m) => m.id), [6, 7]);
  const products = [{ id: 3, label: "Food" }, { id: 184, label: "Gasoline" }];
  assert.deepEqual(orderMembersByQuery("gas vs food", products).map((m) => m.id), [184, 3]);
});

test("growth words request year-on-year change", () => {
  assert.equal(parseCues("CPI % change").transform, "pct_change_yoy");
  assert.equal(parseCues("inflation").transform, "pct_change_yoy");
});

test("time windows never request a percent-change transform on their own", () => {
  assert.equal(parseCues("gas vs food cost over time past 1yr").transform, undefined);
  assert.equal(parseCues("gas vs food cost over time past 2yr").transform, undefined);
  assert.equal(parseCues("gas vs food cost by province, past year").transform, undefined);
  assert.equal(parseCues("CPI % change over 1 year").transform, "pct_change_yoy");
  assert.equal(parseCues("food vs shelter inflation past 3yr").relativeMonths, 36);
});

test("explicit chart forms, snapshots, and full history retain their intent", () => {
  assert.equal(parseCues("population by province line chart").requestedChart, "line");
  assert.deepEqual([parseCues("population by province as a horizontal bar chart").requestedChart,
    parseCues("population by province as a horizontal bar chart").horizontal], ["bar", true]);
  assert.deepEqual([parseCues("population by province as a column chart").requestedChart,
    parseCues("population by province as a column chart").horizontal], ["bar", false]);
  assert.equal(parseCues("population by province as a stacked area chart").requestedChart, "stacked_area");
  assert.equal(parseCues("population by province as a pie chart").requestedChart, "pie");
  assert.equal(parseCues("population by province as a table").requestedChart, "table");
  assert.equal(parseCues("population by province ranking").latest, true);
  assert.equal(parseCues("cpi all time").fullHistory, true);
});

test("member selection stops at a real gap, not a flat 0.5", () => {
  assert.deepEqual(relativeMembers([{ id: 1, score: .89 }, { id: 2, score: .84 }, { id: 3, score: .60 }, { id: 4, score: .48 }]), [1, 2]);
  assert.deepEqual(relativeMembers([{ id: 1, score: .75 }, { id: 2, score: .70 }, { id: 3, score: .29 }]), [1, 2]);
  assert.deepEqual(relativeMembers([{ id: 1, score: .49 }, { id: 2, score: .46 }]), []);
});
