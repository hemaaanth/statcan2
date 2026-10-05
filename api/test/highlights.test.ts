import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { openFromEnv } from "../src/config.ts";
import { chartRoutes } from "../src/chart_api.ts";
import { decodeSpec } from "../src/spec.ts";
import type { Db } from "../src/db.ts";
import type { Highlights } from "../src/highlights.ts";

const mounted = existsSync(process.env.STATCAN_BUILD ?? "");
let db: Db;
before(async () => { if (mounted) ({ db } = await openFromEnv()); });
after(() => { if (mounted) db.close(); });

test("home highlights pin current headline values and open their exact published series", { skip: !mounted && "build is not mounted" }, async () => {
  const api = chartRoutes({ db });
  const response = await api.request("/highlights");
  assert.equal(response.status, 200);
  const { build_id, cards } = await response.json() as Highlights;
  assert.equal(build_id, db.manifest.build_id);
  assert.deepEqual(cards.map((card) => card.id), ["population", "cpi", "unemployment", "real_gdp", "wages", "housing", "retail", "gasoline", "food", "vacancies", "employment", "shelter"]);
  const population = cards[0];
  assert.equal(population.value, 41798407);
  assert.equal(population.period_label, "Q3 2026");
  const cpi = cards[1];
  assert.equal(cpi.value, 169.3);
  assert.equal(cpi.source, "18-10-0006-01");
  assert.equal(cpi.change.kind, "12-month change");
  assert.ok(Math.abs(cpi.change.value - (169.3 / 164.3 - 1) * 100) < 1e-10);
  const unemployment = cards[2];
  assert.equal(unemployment.value, 6.4);
  assert.equal(unemployment.change.unit, "pts");
  assert.equal(cards[3].value, 2568800);
  assert.equal(cards[7].value, 173.8);
  assert.equal(cards[10].value, 21173.1);
  assert.equal(cards[10].period_label, "Aug 2026");
  assert.equal(cards[10].source, "14-10-0287-01");
  assert.ok(Math.abs(cards[10].change.value - (21173.1 / 21214.8 - 1) * 100) < 1e-10);
  assert.equal(cards[11].value, 190.9);
  assert.equal(cards[11].source, "18-10-0006-01");
  assert.ok(Math.abs(cards[11].change.value - (190.9 / 188 - 1) * 100) < 1e-10);
  for (const card of cards) {
    assert.deepEqual(card.spark.at(-1), [card.spark.at(-1)![0], card.value]);
    assert.ok(card.spark.length <= 60);
    const spec = decodeSpec(card.s);
    assert.equal(spec.layers[0].pid, card.source.replaceAll("-", "").slice(0, 8));
  }
  const chartResponse = await api.request(`/view?s=${cpi.s}`);
  assert.equal(chartResponse.status, 200);
  const chart = await chartResponse.json();
  assert.equal(chart.series[0].points.at(-1)[2], cpi.value);
});
