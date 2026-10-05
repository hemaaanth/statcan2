import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { encodeSpec, type ViewSpec } from "./spec.ts";
import { runView } from "./view.ts";

type Headline = "yoy" | "mom" | "qoq" | "mom_pts";
type CardDefinition = { id: string; label: string; q: string; pid: string; members: string; headline: Headline; order: number };
export interface HighlightCard {
  id: string; label: string; q: string; s: string; value: number; unit: string; scale: string; period_label: string;
  change: { value: number; unit: "%" | "pts" | ""; kind: "12-month change" | "monthly change" | "quarterly change" | "period-to-period change" };
  direction: "up" | "down" | "flat"; spark: [string, number][]; source: string;
}
export interface Highlights { build_id: string; cards: HighlightCard[] }

const definitions: CardDefinition[] = readFileSync(new URL("../../data/ref/highlights.csv", import.meta.url), "utf8")
  .trim().split(/\r?\n/).slice(1).map((line) => {
    const fields = line.split(",");
    if (fields.length !== 7) throw new Error(`Invalid highlight row: ${line}`);
    const [id, label, q, pid, members, headline, order] = fields;
    return { id: id!, label: label!, q: q!, pid: pid!, members: members!, headline: headline as Headline, order: Number(order) };
  }).sort((a, b) => a.order - b.order);

const monthYear = new Intl.DateTimeFormat("en-CA", { month: "short", year: "numeric", timeZone: "UTC" });

export async function loadHighlights(db: Db): Promise<Highlights> {
  const cards: HighlightCard[] = [];
  for (const row of definitions) {
    const dims = Object.fromEntries(row.members.split(";").map((selection) => {
      const [dimension, member] = selection.split("=");
      return [dimension, { use: "fixed" as const, members: { eq: Number(member) } }];
    }));
    const spec: ViewSpec = { v: 1, layers: [{ pid: row.pid, dims }], time: { preset: "5Y" },
      transform: "level", chart: { type: "line" } };
    const outcome = await runView(db, spec);
    if (outcome.kind !== "ok") throw new Error(`Highlight ${row.id}: ${outcome.error}`);
    const { result } = outcome;
    const series = result.series[0];
    if (result.series.length !== 1 || !series) throw new Error(`Highlight ${row.id}: expected one series`);
    const points = series.points.filter((point) => point[2] != null);
    const latest = points.at(-1);
    if (!latest) throw new Error(`Highlight ${row.id}: no published points`);
    const earlier = row.headline === "yoy"
      ? series.points.find((point) => point[1] === `${Number(latest[1].slice(0, 4)) - 1}${latest[1].slice(4)}`)
      : series.points[series.points.findIndex((point) => point[1] === latest[1]) - 1];
    if (earlier?.[2] == null || (row.headline !== "mom_pts" && earlier[2] === 0))
      throw new Error(`Highlight ${row.id}: no published comparison period`);
    const change = row.headline === "mom_pts" ? latest[2]! - earlier[2]
      : (latest[2]! / earlier[2] - 1) * 100;
    const quarter = row.headline === "qoq" || result.sources[0].frequency === "Quarterly";
    const period_label = quarter ? `Q${Math.floor(Number(latest[1].slice(5, 7)) / 3) + 1} ${latest[1].slice(0, 4)}`
      : monthYear.format(new Date(`${latest[1].slice(0, 7)}-01T00:00:00Z`));
    cards.push({ id: row.id, label: row.label, q: row.q, s: encodeSpec(result.spec), value: latest[2]!,
      unit: series.unit, scale: series.scale, period_label,
      change: { value: change, unit: row.headline === "mom_pts" ? "pts" as const : "%" as const,
        kind: row.headline === "yoy" ? "12-month change" as const : row.headline === "qoq" ? "quarterly change" as const : "monthly change" as const },
      direction: change > 0 ? "up" as const : change < 0 ? "down" as const : "flat" as const,
      spark: points.slice(-60).map((point) => [point[1], point[2]!] as [string, number]),
      source: result.sources[0].table_number });
  }
  return { build_id: db.manifest.build_id, cards };
}
