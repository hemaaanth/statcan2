import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
// @ts-expect-error Shared browser layout is plain JavaScript.
import { COLORS } from "../public/export-layout.js";
import type { ViewResult } from "./spec.ts";

const ORIGIN = "https://statcan-render.invalid";
const TIMEOUT = 25_000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const cache = new Map<string, { bytes: Buffer; etag: string }>();
let cacheBytes = 0;
let active = 0;
let browser: Promise<Browser> | undefined;

export class RenderBusy extends Error {}

export async function closePngRenderer() {
  const current = browser;
  browser = undefined;
  if (current) await (await current.catch(() => undefined))?.close();
}

async function getBrowser() {
  if (!browser) {
    browser = chromium.launch({ headless: true, timeout: 15_000 }).then((instance) => {
      instance.on("disconnected", () => { browser = undefined; });
      return instance;
    }).catch((error) => { browser = undefined; throw error; });
  }
  return browser;
}

// Only packaged assets are available to the renderer. Chart text cannot make network or filesystem requests.
const assetPaths = new Map([
  ...["chart.js", "render.js", "export-layout.js"].map((name) => [`/${name}`, new URL(`../public/${name}`, import.meta.url)] as const),
  ["/highcharts.js", new URL("../node_modules/highcharts/highcharts.js", import.meta.url)],
]);
const assets = Promise.all([...assetPaths].map(async ([name, url]) => [name, await readFile(url)] as const)).then((pairs) => new Map(pairs));
const fonts = Promise.all([
  ["Geist", 400, "geist-sans/Geist-Regular.ttf"],
  ["Geist", 600, "geist-sans/Geist-SemiBold.ttf"],
  ["Geist Mono", 400, "geist-mono/GeistMono-Regular.ttf"],
].map(async ([family, weight, file]) => `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/ttf;base64,${(await readFile(new URL(`../node_modules/geist/dist/fonts/${file}`, import.meta.url))).toString("base64")}) format('truetype')}`)).then((rules) => rules.join("\n"));

export async function renderPng(view: ViewResult) {
  const key = createHash("sha256").update(JSON.stringify([view.build_id, view.normalized_build_id, view.spec])).digest("hex");
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  if (active >= 2) throw new RenderBusy("Chart image renderer is busy; retry shortly.");
  active++;
  try {
    const instance = await getBrowser();
    const context = await instance.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-CA", timezoneId: "UTC", serviceWorkers: "block" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const page = await context.newPage();
          const files = await assets;
          const html = `<!doctype html><meta charset="utf-8"><style data-export-fonts>${await fonts}</style><style>:root{--sans:Geist;--mono:'Geist Mono';--grid:${COLORS.grid};--muted:${COLORS.muted};--quiet:${COLORS.quiet};--ink:${COLORS.ink};--band:#f4f5f6;${COLORS.palette.map((color: string, i: number) => `--c${i}:${color}`).join(";")}}</style><script src="/highcharts.js"></script><script type="module">import {chartPng} from '/chart.js';window.renderChart=async(view)=>{const blob=await chartPng(view);return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob)})}</script>`;
          await context.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== ORIGIN) return route.abort();
            if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
            const body = files.get(url.pathname);
            if (!body) return route.abort();
            return route.fulfill({ contentType: "application/javascript; charset=utf-8", body });
          });
          await page.goto(ORIGIN, { waitUntil: "load", timeout: TIMEOUT });
          await page.waitForFunction("typeof window.renderChart === 'function'", { timeout: TIMEOUT });
          const encoded = await page.evaluate((data) => (window as unknown as { renderChart: (view: unknown) => Promise<string> }).renderChart(data), view);
          const bytes = Buffer.from(encoded, "base64");
          const result = { bytes, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
          if (bytes.length <= MAX_CACHE_BYTES) {
            while (cache.size && (cache.size >= 64 || cacheBytes + bytes.length > MAX_CACHE_BYTES)) {
              const oldest = cache.keys().next().value!;
              cacheBytes -= cache.get(oldest)!.bytes.length;
              cache.delete(oldest);
            }
            // Concurrent requests for the same spec may finish together.
            cacheBytes -= cache.get(key)?.bytes.length ?? 0;
            cache.set(key, result); cacheBytes += bytes.length;
          }
          return result;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Chart image rendering timed out")), TIMEOUT); }),
      ]);
    } finally { clearTimeout(timer); await context.close(); }
  } finally { active--; }
}
