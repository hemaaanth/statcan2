import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { Hono } from "hono";
import * as render from "../public/render.js";
// @ts-expect-error Browser-owned pure-JS layout has no TypeScript declaration; fields are typed below.
import * as exportLayout from "../public/export-layout.js";
import type { Db } from "./db.ts";
import { BRAND_MARK } from "./pages.ts";
import { decodeSpec, type ViewResult, type ViewSeries } from "./spec.ts";
import { runView } from "./view.ts";

const { esc, seriesShades, methodLines, ownPoints, isHorizontal } = render as unknown as {
  esc: (value: unknown) => string;
  seriesShades: (view: ViewResult) => { slot: number; pct: number }[];
  methodLines: (view: ViewResult) => string[];
  ownPoints: (series: ViewSeries, isTime: boolean) => ViewSeries["points"];
  isHorizontal: (view: ViewResult) => boolean;
};
const sans = fileURLToPath(new URL("../node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf", import.meta.url));
const regular = fileURLToPath(new URL("../node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf", import.meta.url));
const mono = fileURLToPath(new URL("../node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf", import.meta.url));
const monoMedium = fileURLToPath(new URL("../node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.ttf", import.meta.url));
type Layout = {
  width: number; height: number; margin: number; scale: number;
  title: { y: number; size: number; minSize: number };
  subtitle: { y: number; size: number };
  note: { gap: number; size: number }; ruleGap: number;
  plot: { top: number; bottom: number; lineWidth: number; markerRadius: number; axisLabel: number; axisTitle: number; gridWidth: number };
  directLabel: { size: number; gap: number; minSpacing: number; maxSeries: number; maxWidth: number };
  legend: { size: number; swatch: number; itemGap: number; rowHeight: number; maxRows: number; maxSeries: number; top: number };
  footer: { size: number; ruleGap: number; bottom: number };
};
const { scaled, LAYOUT, COLORS, FONTS, PUBLIC_HOST, headText, footerText, legendMode, lastValue, spreadLabels, isOrdinal } = exportLayout as unknown as {
  scaled: (width: number, height: number) => Layout;
  LAYOUT: { legend: { maxSeries: number; maxRows: number } };
  COLORS: { ink: string; muted: string; quiet: string; rule: string; grid: string; paper: string; accent: string; palette: string[] };
  FONTS: { sans: string; mono: string };
  PUBLIC_HOST: string;
  headText: (view: ViewResult, methods: string[]) => { title: string; subtitle: string; notes: string[] };
  footerText: (view: ViewResult) => { left: string; right: string };
  legendMode: (view: ViewResult, options: { kind: "bar" | "line" }) => "none" | "direct" | "row";
  lastValue: (series: ViewSeries) => { value: number; at: number } | null;
  spreadLabels: <T extends { y: number; ly?: number }>(items: T[], bounds: { top: number; bottom: number; minSpacing: number }) => T[];
  isOrdinal: (labels: string[]) => boolean;
};
const L = scaled(1200, 630);
const { ink, muted, quiet, rule, grid: gridColor, paper, accent, palette } = COLORS;
const valueLabel = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 });
const monthYear = new Intl.DateTimeFormat("en-CA", { month: "short", year: "numeric", timeZone: "UTC" });
const text = (value: unknown) => esc(String(value ?? ""));
const short = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const number = (value: number) => valueLabel.format(value);
function ticks({ top, bottom }: { top: number; bottom: number }) {
  const span = (top - bottom) / 4;
  const order = 10 ** Math.floor(Math.log10(span));
  const step = [1, 2, 5, 10].reduce((best, part) =>
    Math.abs(part * order - span) < Math.abs(best * order - span) ? part : best, 1) * order;
  const first = Math.ceil(bottom / step) * step;
  const values: number[] = [];
  for (let value = first; value <= top + step * 1e-9; value += step) values.push(Number(value.toPrecision(12)));
  return values;
}

function frame(title: string, subtitle: string, plot: string, footer: string) {
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= 50) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  const headings = lines.slice(0, 2).map((line, i) => `<text x="64" y="${92 + i * 48}" font-family="Geist" font-size="40" font-weight="600" fill="${ink}">${text(short(line, 54))}</text>`).join("");
  const subtitleY = lines.length > 1 ? 185 : 140;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="${paper}"/><path d="M64 46H1136" stroke="${rule}"/>
    ${headings}<text x="64" y="${subtitleY}" font-family="${FONTS.mono}" font-size="17" fill="${muted}">${text(short(subtitle, 105))}</text>
    ${plot}<path d="M64 562H1136" stroke="${rule}"/>
    <text x="64" y="594" font-family="${FONTS.mono}" font-size="15" fill="${quiet}">${text(short(footer, 82))}</text>
    <text x="1136" y="594" text-anchor="end" font-family="${FONTS.mono}" font-size="15" fill="${quiet}">${text(PUBLIC_HOST)}</text>
  </svg>`;
}

function shade(hex: string, percent: number) {
  if (percent === 100) return hex;
  return `#${[1, 3, 5].map((i) => Math.round(255 - (255 - Number.parseInt(hex.slice(i, i + 2), 16)) * percent / 100)
    .toString(16).padStart(2, "0")).join("")}`;
}

type Shaded = { series: ViewSeries; color: string };
type Plot = { x: number; y: number; width: number; height: number; mode: "none" | "direct" | "row" };
const horizontalCategory = (view: ViewResult) => view.x.kind === "category" && view.spec.chart.type.includes("bar")
  && (view.spec.chart.horizontal ?? (isOrdinal(view.categories ?? []) ? (view.categories?.length ?? 0) > 24 : isHorizontal(view)));

function shaded(view: ViewResult): Shaded[] {
  const selections = seriesShades(view);
  const occupied = new Set(view.series.flatMap((series, i) =>
    series.hidden || series.unpublished || selections[i].slot === 1 ? [] : [selections[i].slot]));
  return view.series.flatMap((series, i) => {
    if (series.hidden) return [];
    const { slot, pct } = selections[i];
    const colorSlot = slot === 1 && !series.unpublished
      ? [0, 2, 3, 4, 5, 6, 7, 8, 9].find((candidate) => !occupied.has(candidate)) ?? 0 : slot;
    occupied.add(colorSlot);
    return [{ series, color: shade(palette[colorSlot] ?? palette[0], pct) }];
  });
}

function horizontalBars(view: ViewResult, visible: Shaded[], { x, y, width, height }: Plot) {
  const categories = view.categories ?? [];
  const stacked = view.spec.chart.type.startsWith("stacked");
  const ordinal = isOrdinal(categories);
  const lead = visible.find(({ series }) => !series.unpublished)?.series;
  const order = categories.map((_, i) => i);
  if (!ordinal && !stacked && !view.spec.chart.sort && lead)
    order.sort((a, b) => (lead.points[b]?.[2] ?? -Infinity) - (lead.points[a]?.[2] ?? -Infinity) || a - b);
  const rowHeight = Math.max(16, visible.length * (L.plot.axisLabel + 3));
  const count = ordinal ? order.length : Math.min(order.length, 20, Math.max(1, Math.floor((height - 28) / rowHeight)));
  const shown = order.slice(0, count);
  const totals = shown.map((i) => visible.reduce((n, { series }) => n + Math.max(0, series.points[i]?.[2] ?? 0), 0));
  const negatives = shown.map((i) => visible.reduce((n, { series }) => n + Math.min(0, series.points[i]?.[2] ?? 0), 0));
  const domains = view.axes.map((_, axis) => {
    const values = visible.filter(({ series }) => series.axis === axis).flatMap(({ series }) =>
      shown.map((i) => series.points[i]?.[2]).filter((v): v is number => v != null));
    const percent = view.spec.chart.type === "stacked_bar_100" && axis === 0;
    const min = percent ? negatives.some((n) => n < 0) ? -100 : 0 : stacked && axis === 0 ? Math.min(0, ...negatives) : Math.min(0, ...values);
    const max = percent ? 100 : stacked && axis === 0 ? Math.max(0, ...totals) : Math.max(0, ...values);
    const range = max - min || 1;
    return { bottom: min - (min < 0 ? range * .12 : 0), top: max + range * .17 };
  });
  if (!visible.some(({ series }) => shown.some((i) => series.points[i]?.[2] != null))) return "";
  const position = (v: number, axis: number) => {
    const { top, bottom } = domains[axis] ?? domains[0];
    return x + (v - bottom) / (top - bottom) * width;
  };
  const plotHeight = height - 22 - (!ordinal && order.length > count ? 22 : 0);
  const slot = plotHeight / count;
  let plot = ticks(domains[0]).map((value) => {
    const xx = position(value, 0);
    return `<path d="M${xx} ${y}V${y + plotHeight}" stroke="${gridColor}" stroke-width="${L.plot.gridWidth}"/><text x="${xx}" y="${y + plotHeight + L.plot.axisLabel + 4}" text-anchor="middle" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${quiet}">${text(number(value))}</text>`;
  }).join("");
  shown.forEach((i, row) => {
    const mid = y + (row + .5) * slot;
    const labelSize = ordinal ? Math.min(L.plot.axisLabel, slot * .8) : L.plot.axisLabel;
    const valueSize = ordinal ? Math.min(12, slot * .8) : Math.min(12, L.plot.axisLabel);
    plot += `<text x="${x - 14}" y="${mid + labelSize * .36}" text-anchor="end" font-family="${FONTS.mono}" font-size="${labelSize}" fill="${muted}">${text(short(categories[i], Math.floor((x - L.margin - 14) / (labelSize * .61))))}</text>`;
    let positive = 0, negative = 0;
    visible.forEach(({ series, color }, j) => {
      const v = series.points[i]?.[2];
      if (v == null) return;
      const amount = view.spec.chart.type === "stacked_bar_100"
        ? v / (v < 0 ? -negatives[row] || 1 : totals[row] || 1) * 100 : v;
      const base = stacked ? amount < 0 ? negative : positive : 0;
      const end = base + amount;
      if (stacked) { if (amount < 0) negative = end; else positive = end; }
      const x0 = position(base, series.axis), x1 = position(end, series.axis);
      const barHeight = stacked ? slot * .65 : slot * .7 / visible.length;
      const barY = mid - (stacked ? barHeight / 2 : slot * .35) + (stacked ? 0 : j * barHeight);
      plot += `<rect x="${Math.min(x0, x1)}" y="${barY}" width="${Math.max(1, Math.abs(x1 - x0))}" height="${barHeight}" fill="${color}"/>`;
      if (!stacked)
        plot += `<text x="${x1 + (end < 0 ? -6 : 6)}" y="${barY + barHeight / 2 + valueSize * .34}" text-anchor="${end < 0 ? "end" : "start"}" font-family="${FONTS.mono}" font-size="${valueSize}" fill="${color}">${text(number(v))}</text>`;
    });
    if (stacked) for (const total of [positive, negative]) if (total)
      plot += `<text x="${position(total, 0) + (total < 0 ? -6 : 6)}" y="${mid + valueSize * .34}" text-anchor="${total < 0 ? "end" : "start"}" font-family="${FONTS.mono}" font-size="${valueSize}" fill="${ink}">${text(number(total))}</text>`;
  });
  if (!ordinal && order.length > count)
    plot += `<text x="${x - 14}" y="${y + height - 2}" text-anchor="end" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${quiet}">+${order.length - count} more (smaller values)</text>`;
  return plot;
}

function plotView(view: ViewResult, visible: Shaded[], { x, y, width, height, mode }: Plot) {
  if (horizontalCategory(view))
    return horizontalBars(view, visible, { x, y, width, height, mode });
  const bounds = view.axes.map(() => ({ min: Infinity, max: -Infinity }));
  for (const { series } of visible) for (const point of series.points) if (point[2] !== null) {
    const bound = bounds[series.axis] ?? bounds[0];
    bound.min = Math.min(bound.min, point[2]);
    bound.max = Math.max(bound.max, point[2]);
  }
  if (bounds.every((bound) => bound.min === Infinity)) return "";
  const bar = view.spec.chart.type.includes("bar");
  const stacked = view.spec.chart.type.startsWith("stacked");
  const len = Math.max(1, ...visible.map(({ series }) => series.points.length));
  const totals = stacked ? Array.from({ length: len }, (_, i) => visible.reduce((total, { series }) => total + Math.max(0, series.points[i]?.[2] ?? 0), 0)) : [];
  const negativeTotals = stacked ? Array.from({ length: len }, (_, i) => visible.reduce((total, { series }) => total + Math.min(0, series.points[i]?.[2] ?? 0), 0)) : [];
  const fallback = bounds.find((bound) => bound.min !== Infinity)!;
  const domains = bounds.map((axisBound, axis) => {
    const bound = axisBound.min === Infinity ? fallback : axisBound;
    const min = stacked && axis === 0 ? view.spec.chart.type === "stacked_bar_100" && negativeTotals.some((total) => total < 0)
      ? -100 : negativeTotals.reduce((smallest, total) => Math.min(smallest, total), 0)
      : bar ? Math.min(0, bound.min) : view.spec.chart.type.includes("area") ? 0 : bound.min;
    const max = view.spec.chart.type === "stacked_bar_100" ? 100
      : stacked && axis === 0 ? totals.reduce((largest, total) => Math.max(largest, total), 0) : bar ? Math.max(0, bound.max) : bound.max;
    const span = max - min || 1;
    return { top: max + span * .09, bottom: bar ? Math.min(0, min) : min - span * .09 };
  });
  // Long value labels ("80,000,000") move the plot right so they stay inside the margin.
  const labelWidth = Math.max(...ticks(domains[0]).map((value) => number(value).length)) * L.plot.axisLabel * .6 + 12;
  const shift = Math.max(0, L.margin + labelWidth - x);
  x += shift; width -= shift;
  const py = (v: number, axis = 0) => {
    const { top, bottom } = domains[axis] ?? domains[0];
    return y + height - (v - bottom) / (top - bottom) * height;
  };
  const px = (i: number) => x + (len < 2 ? width / 2 : i / (len - 1) * width);
  let plot = domains.length === 2 ? view.axes.map((axis, i) =>
    `<text x="${i ? x + width : x}" y="${y - 5}" text-anchor="${i ? "end" : "start"}" font-family="${FONTS.mono}" font-size="${L.plot.axisTitle}" fill="${muted}">${text(short(axis.unit, 38))}</text>`).join("") : "";
  plot += ticks(domains[0]).map((value) => {
    const yy = py(value);
    return `<path d="M${x} ${yy}H${x + width}" stroke="${gridColor}" stroke-width="${L.plot.gridWidth}"/><text x="${x - 12}" y="${yy + 4}" text-anchor="end" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${quiet}">${text(number(value))}</text>`;
  }).join("");
  if (domains.length === 2) plot += ticks(domains[1]).map((value) =>
    `<text x="${x + width + 12}" y="${py(value, 1) + 4}" text-anchor="start" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${quiet}">${text(number(value))}</text>`).join("");
  if (bar) {
    const ordinal = view.x.kind === "category" && isOrdinal(view.categories ?? []);
    const count = ordinal ? len : Math.min(len, 10), start = len - count, slot = width / count;
    for (let i = start; i < len; i++) {
      let positive = 0, negative = 0;
      visible.forEach(({ series, color }, j) => {
        const v = series.points[i]?.[2];
        if (v === null || v === undefined) return;
        const w = stacked ? slot * .66 : slot * .72 / visible.length;
        const xx = x + (i - start + .14) * slot + (stacked ? 0 : j * w);
        const amount = view.spec.chart.type === "stacked_bar_100"
          ? v / (v < 0 ? -negativeTotals[i] || 1 : totals[i] || 1) * 100 : v;
        const base = stacked ? amount < 0 ? negative : positive : 0;
        const end = base + amount;
        const startY = py(base, series.axis), endY = py(end, series.axis);
        plot += `<rect x="${xx}" y="${Math.min(startY, endY)}" width="${w}" height="${Math.max(1, Math.abs(endY - startY))}" fill="${color}"/>`;
        if (stacked) { if (amount < 0) negative = end; else positive = end; }
      });
    }
    if (view.x.kind === "category") plot += Array.from({ length: count }, (_, i) => {
      const label = view.categories?.[start + i] ?? "";
      const xx = x + (i + .5) * slot, yy = y + height + L.plot.axisLabel + 5;
      return ordinal
        ? `<text x="${xx}" y="${yy}" transform="rotate(-65 ${xx} ${yy})" text-anchor="end" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel * .85}" fill="${muted}">${text(short(label, 20))}</text>`
        : `<text x="${xx}" y="${yy}" text-anchor="middle" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${muted}">${text(short(label, 15))}</text>`;
    }).join("");
  } else {
    const area = view.spec.chart.type.includes("area");
    const cumulative = stacked ? Array<number>(len).fill(0) : undefined;
    const below = stacked ? Array<number>(len).fill(0) : undefined;
    const ordinate = (i: number, v: number) => stacked ? v < 0 ? below![i] : cumulative![i] : v;
    const labels: { name: string; value: number; color: string; y: number; ly?: number }[] = [];
    visible.forEach(({ series, color }) => {
      let path = "", connected = false, markers = "";
      let upperRun: string[] = [], lowerRun: string[] = [];
      const flushArea = () => {
        if (area && upperRun.length > 1) plot += `<path d="M${upperRun.join("L")}L${lowerRun.reverse().join("L")}Z" fill="${color}" fill-opacity=".27"/>`;
        upperRun = []; lowerRun = [];
      };
      const points = ownPoints(series, view.x.kind === "time");
      const every = Math.ceil(points.length / 500);
      let i = 0;
      for (let j = 0; j < points.length; j++) {
        while (series.points[i] !== points[j]) i++;
        const v = points[j][2];
        if (v === null) { connected = false; flushArea(); i++; continue; }
        const base = stacked ? v < 0 ? below![i] : cumulative![i] : 0;
        const upper = base + v;
        if (cumulative) { if (v < 0) below![i] = upper; else cumulative[i] = upper; }
        if (j % every === 0 || j === points.length - 1 || points[j - 1]?.[2] === null || points[j + 1]?.[2] === null) {
          const xx = px(i).toFixed(1), yy = py(upper, series.axis).toFixed(1);
          path += `${connected ? "L" : "M"}${xx} ${yy}`;
          if (area) { upperRun.push(`${xx} ${yy}`); lowerRun.push(`${xx} ${py(base, series.axis).toFixed(1)}`); }
          connected = true;
        }
        if (points[j - 1]?.[2] == null && points[j + 1]?.[2] == null)
          markers += `<circle cx="${px(i)}" cy="${py(ordinate(i, v), series.axis)}" r="${L.plot.markerRadius}" fill="${color}"/>`;
        i++;
      }
      flushArea();
      plot += `<path d="${path}" fill="none" stroke="${color}" stroke-width="${L.plot.lineWidth}" stroke-linejoin="round"/>${markers}`;
      const last = lastValue(series);
      if (mode === "direct" && last) labels.push({ name: series.name, value: last.value, color,
        y: py(ordinate(last.at, last.value), series.axis) });
    });
    if (mode === "direct") {
      const positioned = spreadLabels(labels, { top: y + L.directLabel.size, bottom: y + height - L.directLabel.size,
        minSpacing: L.directLabel.minSpacing });
      const labelX = x + width + (domains.length === 2 ? 60 : L.directLabel.gap);
      plot += positioned.map((label) => {
        const space = L.width - L.margin - labelX - (number(label.value).length + 1) * L.directLabel.size * .6;
        const name = short(label.name, Math.max(1, Math.floor(space / (L.directLabel.size * .57))));
        return `<text x="${labelX}" y="${label.ly! + 5}" font-family="${FONTS.sans}" font-size="${L.directLabel.size}" fill="${label.color}">${text(name)} <tspan font-weight="600">${text(number(label.value))}</tspan></text>`;
      }).join("");
    }
    if (view.x.kind === "time") {
      const points = visible.find(({ series }) => !series.unpublished)?.series.points;
      const date = (value: string) => /^\d{4}-\d{2}/.test(value)
        ? monthYear.format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`))
        : value.slice(0, 4);
      if (points?.length && points.length > 1) plot += `<text x="${x}" y="${y + height + L.plot.axisLabel + 5}" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${muted}">${text(date(points[0][1]))}</text><text x="${x + width}" y="${y + height + L.plot.axisLabel + 5}" text-anchor="end" font-family="${FONTS.mono}" font-size="${L.plot.axisLabel}" fill="${muted}">${text(date(points.at(-1)![1]))}</text>`;
    }
  }
  return plot;
}

export function chartSvg(view: ViewResult) {
  const M = L.margin, inner = L.width - M * 2;
  const head = headText(view, methodLines(view)), foot = footerText(view);
  const notes = head.notes.slice(0, 2);
  const headRule = L.subtitle.y + notes.length * L.note.gap + L.ruleGap;
  const footY = L.height - L.footer.bottom, footRule = footY - L.footer.ruleGap;
  const all = shaded(view);
  const chosen = all.length > LAYOUT.legend.maxSeries
    ? new Set([...all].sort((a, b) => (lastValue(b.series)?.value ?? -Infinity) - (lastValue(a.series)?.value ?? -Infinity))
      .slice(0, LAYOUT.legend.maxSeries - 1)) : undefined;
  const visible = chosen ? all.filter((item) => chosen.has(item)) : all;
  const more = all.length - visible.length;
  const mode = legendMode(view, { kind: view.spec.chart.type.includes("bar") ? "bar" : "line" });
  const entries = mode === "row" ? [...visible, ...(more ? [{ series: null, color: "" }] : [])] : [];
  const columns = Math.ceil(LAYOUT.legend.maxSeries / LAYOUT.legend.maxRows);
  const rows = Math.ceil(entries.length / columns);
  const legendBottom = footRule - 15, legendTop = legendBottom - rows * L.legend.rowHeight;
  const plotTop = headRule + L.plot.top;
  const plotBottom = (rows ? legendTop - L.legend.top : footRule - 15) - L.plot.bottom;
  const horizontal = horizontalCategory(view);
  const plotX = M + (horizontal ? 380 : 60) * L.scale;
  const directWidth = mode === "direct" ? Math.max(0, ...visible.map(({ series }) => {
    const last = lastValue(series);
    return last ? Math.min(L.directLabel.maxWidth, (series.name.length * .57 + (number(last.value).length + 1) * .6) * L.directLabel.size)
      + (view.axes.length === 2 ? 60 : L.directLabel.gap) + 24 : 0;
  })) : 0;
  const reserve = horizontal ? 40 : mode === "direct"
    ? Math.min(L.width - plotX - M - 260, Math.max(view.axes.length === 2 ? 230 : 170, directWidth))
    : view.axes.length === 2 ? 80 : 20;
  const plot = plotView(view, visible, { x: plotX, y: plotTop, width: L.width - plotX - M - reserve,
    height: Math.max(80, plotBottom - plotTop - (view.x.kind === "category" && !horizontal && isOrdinal(view.categories ?? []) ? 140 : 0)), mode });
  let titleSize = L.title.size;
  while (titleSize > L.title.minSize && head.title.length * titleSize * .54 > inner) titleSize -= 1.5;
  const title = short(head.title, Math.max(1, Math.floor(inner / (titleSize * .54))));
  const noteLines = notes.map((note, i) => `<text x="${M}" y="${L.subtitle.y + (i + 1) * L.note.gap}" font-family="${FONTS.mono}" font-size="${L.note.size}" fill="${muted}">${text(short(note, Math.floor(inner / (L.note.size * .61))))}</text>`).join("");
  const legend = entries.map((entry, i) => {
    const x = M + i % columns * inner / columns, y = legendTop + (Math.floor(i / columns) + 1) * L.legend.rowHeight - 6;
    if (!entry.series) return `<text x="${x}" y="${y}" font-family="${FONTS.mono}" font-size="${L.legend.size - 3}" fill="${quiet}">+${more} more</text>`;
    if (entry.series.unpublished) return `<text x="${x}" y="${y}" font-family="${FONTS.sans}" font-size="${L.legend.size}" fill="${quiet}">${text(short(entry.series.name, 13))} <tspan font-family="${FONTS.mono}" font-size="${L.legend.size - 4}">not published</tspan></text>`;
    return `<rect x="${x}" y="${y - L.legend.swatch + 2}" width="${L.legend.swatch}" height="${L.legend.swatch}" fill="${entry.color}"/><text x="${x + L.legend.swatch + 6}" y="${y}" font-family="${FONTS.sans}" font-size="${L.legend.size}" fill="${ink}">${text(short(entry.series.name, 18))}</text>`;
  }).join("");
  const rightWidth = foot.right.length * L.footer.size * .61;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">
    <rect width="${L.width}" height="${L.height}" fill="${paper}"/>
    <text x="${M}" y="${L.title.y}" font-family="${FONTS.sans}" font-size="${titleSize}" font-weight="600" fill="${ink}">${text(title)}</text>
    <text x="${M}" y="${L.subtitle.y}" font-family="${FONTS.sans}" font-size="${L.subtitle.size}" fill="${muted}">${text(short(head.subtitle, Math.floor(inner / (L.subtitle.size * .54))))}</text>
    ${noteLines}<path d="M${M} ${headRule}H${L.width - M}" stroke="${rule}"/>
    ${plot}${legend}<path d="M${M} ${footRule}H${L.width - M}" stroke="${rule}"/>
    <text x="${M}" y="${footY}" font-family="${FONTS.mono}" font-size="${L.footer.size}" fill="${muted}">${text(short(foot.left, Math.max(1, Math.floor((inner - rightWidth - 30) / (L.footer.size * .61)))))}</text>
    <text x="${L.width - M}" y="${footY}" text-anchor="end" font-family="${FONTS.mono}" font-size="${L.footer.size}" fill="${muted}">${text(foot.right)}</text>
  </svg>`;
}

// The site card: the top bar's mark and wordmark at 72 px, one line on what the site is, a sample line drawn like an
// export's series line, and the domain at bottom right, level with the line's lowest point. Sizes and spacing scale
// the top bar's CSS (19 px wordmark) by 72/19; the mark's x axis sits on the wordmark's baseline, as in the top bar.
function siteSvg() {
  const size = 72, k = size / 19, baseline = 128;
  const mark = 20 * k, markY = baseline - mark;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="${paper}"/>
    <svg x="64" y="${markY.toFixed(1)}" width="${mark.toFixed(1)}" height="${mark.toFixed(1)}" viewBox="0 0 100 100">${BRAND_MARK}</svg>
    <text x="${(64 + mark + 8 * k).toFixed(1)}" y="${baseline}" font-family="${FONTS.sans}" font-size="${size}" font-weight="600" letter-spacing="${(-.03 * size).toFixed(2)}" fill="${ink}">statcan<tspan dx="${(2 * k).toFixed(1)}" font-family="${FONTS.mono}" font-size="${(15 * k).toFixed(1)}" font-weight="500" letter-spacing="${(-.05 * 15 * k).toFixed(2)}" fill="${palette[0]}">(2)</tspan></text>
    <text x="64" y="186" font-family="${FONTS.sans}" font-size="28" fill="${muted}">Explore and chart published Statistics Canada data.</text>
    <path d="${SITE_LINE}" fill="none" stroke="${palette[0]}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="1136" y="566" text-anchor="end" font-family="${FONTS.mono}" font-size="22" fill="${muted}">${text(PUBLIC_HOST)}</text>
  </svg>`;
}

/** A rising, jagged monthly-looking line across the card, 64 px in from each side, from y 566 up to y 286. */
const SITE_LINE = (() => {
  const steps = [0, -9, 14, 10, -17, 21, 7, 13, -10, 4, -7, 16, -6, -4, 11, 3, 2, 7, -1, 0, 10, -2, -4, 11, 1, 5, -4, 7,
    -6, 12, 8, 13, 0, 22, -4, -14, 10, 2, -11, 12, -6, 8, -10, 1, 11, -4, 15, 9, 12, 4, 13, 7, -8];
  let y = 0;
  const ys = steps.map((d) => (y += d));
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return ys.map((v, i) => `${i ? "L" : "M"}${(64 + i * 1072 / (ys.length - 1)).toFixed(1)} ${(566 - (v - lo) / (hi - lo) * 280).toFixed(1)}`).join("");
})();

function textSvg(title: string, description: string) {
  return frame(title, description, `<path d="M64 240H1136" stroke="${rule}"/>`, "statcan(2) · Statistics Canada data");
}

function png(svg: string) {
  return new Resvg(svg, { fitTo: { mode: "original" }, font: { fontFiles: [regular, sans, mono, monoMedium], loadSystemFonts: false,
    defaultFontFamily: "Geist" } }).render().asPng();
}

export function ogRoutes({ db }: { db: Db }) {
  const app = new Hono();
  const cache = new Map<string, Buffer>();
  async function image(key: string, makeSvg: () => Promise<string> | string) {
    const cacheKey = `${db.manifest.build_id}:${db.normalized.build_id}:${key}`;
    let data = cache.get(cacheKey);
    if (data) cache.delete(cacheKey);
    else {
      data = png(await makeSvg());
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    }
    cache.set(cacheKey, data);
    return new Response(data as unknown as BodyInit, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  }
  app.get("/site.png", () => image("site", siteSvg));
  app.get("/chart.png", (c) => image(`chart:${c.req.query("s") ?? ""}`, async () => {
    const encoded = c.req.query("s");
    if (!encoded) return siteSvg();
    let spec;
    try { spec = decodeSpec(encoded); } catch { return siteSvg(); }
    const outcome = await runView(db, spec);
    return outcome.kind === "ok" ? chartSvg(outcome.result) : siteSvg();
  }));
  app.get("/text.png", (c) => image(`text:${c.req.query("title") ?? ""}`, () =>
    textSvg(short(c.req.query("title") ?? "statcan(2)", 150), "Statistics Canada data and documentation")));
  return app;
}
