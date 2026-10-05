#!/usr/bin/env node
/**
 * Builds every statcan2 brand asset from code: the marks, the site icons (api/public/brand/), the social images
 * (brand/) and a contact sheet. Text is converted to paths with resvg, so no output SVG depends on a font.
 * Run: node brand/build.mjs  (needs api/node_modules installed and ImageMagick `magick` for favicon.ico).
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "api/package.json"));
const { Resvg } = require("@resvg/resvg-js");
const fonts = join(root, "api/node_modules/geist/dist/fonts");
// Each face: its file plus the family and weight resvg matches it by.
const FONT = {
  semibold: { file: join(fonts, "geist-sans/Geist-SemiBold.ttf"), family: "Geist", weight: 600 },
  bold: { file: join(fonts, "geist-sans/Geist-Bold.ttf"), family: "Geist", weight: 700 },
  regular: { file: join(fonts, "geist-sans/Geist-Regular.ttf"), family: "Geist", weight: 400 },
  monoMedium: { file: join(fonts, "geist-mono/GeistMono-Medium.ttf"), family: "Geist Mono", weight: 500 },
  mono: { file: join(fonts, "geist-mono/GeistMono-Regular.ttf"), family: "Geist Mono", weight: 400 },
};
// Same values as api/public/export-layout.js COLORS.
const C = { ink: "#0E0F11", muted: "#5A5F66", quiet: "#9AA0A6", rule: "#E6E7E9", lineStrong: "#C9CBCE", paper: "#FFFFFF", accent: "#D80621" };

const SITE = join(root, "api/public/brand");
const SOCIAL = join(root, "brand");
const CONCEPTS = join(SOCIAL, "concepts");
for (const dir of [SITE, SOCIAL, CONCEPTS]) mkdirSync(dir, { recursive: true });

/** Text as outlines: resvg lays it out at baseline (0,0); returns the path data and its ink box. */
function glyphs(str, face, size, letterSpacing = 0) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000" viewBox="0 -500 4000 1000"><text x="0" y="0" font-family="${face.family}" font-weight="${face.weight}" font-size="${size}" letter-spacing="${letterSpacing}">${str}</text></svg>`;
  const r = new Resvg(svg, { font: { fontFiles: [face.file], loadSystemFonts: false, defaultFontFamily: face.family } });
  const out = r.toString();
  const d = [...out.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).join(" ");
  // resvg emits absolute M/L/Q/Z only, so the ink box is the box of all coordinates (Q control points sit on or
  // just outside the curve; close enough for layout).
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { d, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A path placed so its ink box has height `h` and its left/top at (x, y). */
function place(g, x, y, h, cls) {
  const s = h / g.h;
  return `<path class="${cls}" transform="translate(${r2(x - g.x * s)} ${r2(y - g.y * s)}) scale(${r2(s, 5)})" d="${g.d}"/>`;
}
const r2 = (n, p = 3) => +n.toFixed(p);

// .ti is the tile and .tw/.sw draw on it; in dark mode the tile turns white and they turn ink.
const style = (dark) => `<style>.i,.ti{fill:${C.ink}}.tw{fill:#fff}.sw{fill:none;stroke:#fff}.a{fill:${C.accent}}.si{fill:none;stroke:${C.ink}}.sa{fill:none;stroke:${C.accent}}${dark ? `@media (prefers-color-scheme:dark){.i,.ti{fill:#fff}.tw{fill:${C.ink}}.sw{stroke:${C.ink}}.si{stroke:#fff}.a{fill:#FF3B4E}.sa{stroke:#FF3B4E}}` : ""}</style>`;

/** Parentheses drawn as strokes, so their weight can be set per size (font parens are too thin at 16 px). */
function parens(cx, cy, halfGap, h, bow, w, cls) {
  const t = cy - h / 2, b = cy + h / 2;
  const L = cx - halfGap, R = cx + halfGap;
  return `<path class="${cls}" stroke-width="${w}" stroke-linecap="butt" d="M${L} ${t}Q${L - bow} ${cy} ${L} ${b}M${R} ${t}Q${R + bow} ${cy} ${R} ${b}"/>`;
}

/** The three concept marks on a 100×100 box. `small` is the drawing for 16 and 32 px: heavier, tighter. */
const two = { semibold: glyphs("2", FONT.semibold, 400), bold: glyphs("2", FONT.bold, 400) };
const s2 = glyphs("s2", FONT.semibold, 400, -12);
const s2b = glyphs("s2", FONT.bold, 400, -8);
const sOnly = { semibold: glyphs("s", FONT.semibold, 400), bold: glyphs("s", FONT.bold, 400) };
const concepts = {
  // a. "(2)": red parentheses, a heavy ink 2. The site's "(2)" made into an icon.
  a(small) {
    const h2 = small ? 60 : 50;
    const g = small ? two.bold : two.semibold;
    const w2 = (g.w / g.h) * h2;
    return parens(50, 50, small ? 31 : 32, small ? 90 : 80, small ? 10 : 13, small ? 12 : 7, "sa")
      + place(g, 50 - w2 / 2, 50 - h2 / 2, h2, "i");
  },
  // b. "s2" monogram: ink s, red 2.
  b(small) {
    const g = small ? s2b : s2;
    const h = small ? 58 : 50;
    const s = h / g.h, w = g.w * s, x = 50 - w / 2, y = 50 - h / 2 + (small ? 0 : 0);
    const ss = small ? sOnly.bold : sOnly.semibold;
    // Draw "s" and "2" separately but positioned from the joint layout, so the red sits on the 2 only.
    const sW = ss.w * s;
    const tw = small ? two.bold : two.semibold;
    const tWidth = tw.w * s;
    const sH = ss.h * s;
    return place(ss, x, y + h - sH, sH, "i") + place(tw, x + w - tWidth, y, tw.h * s, "a");
  },
  // c. A rising line ending in a red dot, inside ink parentheses.
  c(small) {
    const w = small ? 10 : 6;
    const pts = small ? [[30, 68], [44, 54], [54, 60], [68, 36]] : [[30, 66], [40, 56], [50, 60], [60, 44], [68, 38]];
    const line = `<path class="si" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" d="M${pts.map((p) => p.join(" ")).join("L")}"/>`;
    const [ex, ey] = pts.at(-1);
    return parens(50, 50, small ? 38 : 36, small ? 88 : 80, small ? 10 : 11, small ? 10 : 6, "si")
      + line + `<circle class="a" cx="${ex}" cy="${ey}" r="${small ? 10 : 8}"/>`;
  },
  // d. Three rising bars on an ink tile; the last bar is red, the latest value.
  d(small) {
    const r = small ? 18 : 22;
    const bars = small ? [[18, 58], [42, 40], [66, 20]] : [[22, 58], [44, 44], [66, 26]];
    const bw = small ? 18 : 14, base = small ? 82 : 76;
    return `<rect class="ti" width="100" height="100" rx="${r}"/>` + bars.map(([x, top], i) =>
      `<rect class="${i === bars.length - 1 ? "a" : "tw"}" x="${x}" y="${top}" width="${bw}" height="${base - top}"/>`).join("");
  },
  // e. A rising line ending in a red dot, on an ink tile: the site's chart motif.
  e(small) {
    const r = small ? 18 : 22;
    const pts = small ? [[18, 72], [40, 52], [56, 60], [74, 32]] : [[22, 70], [38, 54], [52, 62], [66, 42], [76, 34]];
    const [ex, ey] = pts.at(-1);
    return `<rect class="ti" width="100" height="100" rx="${r}"/>`
      + `<path class="sw" stroke-width="${small ? 11 : 7}" stroke-linejoin="round" stroke-linecap="round" d="M${pts.map((p) => p.join(" ")).join("L")}"/>`
      + `<circle class="a" cx="${ex}" cy="${ey}" r="${small ? 11 : 9}"/>`;
  },
  // f. The maple leaf as an area chart: the leaf's top edge is the line, filled red to the bottom of a square ink tile.
  // An area chart runs to the edges, so padding (`inset`) only moves the top point down; the fill stays full-bleed.
  f(small, inset = 0) {
    return `<rect class="ti" width="100" height="100"/><path class="a" d="${leafArea(1400, 14 + inset * 70)}"/>`;
  },
};

/**
 * The top edge of the Flag of Canada leaf (its vertices, arcs dropped), half from the left lobe to the top point,
 * in flag units: x -1860..1860, y -2000 (top) down. Each lobe's tip moves just right of its notch, so x only ever
 * increases: a line chart, not a drawing.
 */
const LEAF_HALF = [[-1860, 65], [-1790, -685], [-1258, -570], [-1080, -855], [-700, -401], [-620, -1510], [-400, -1250], [0, -2000]];
const LEAF = [...LEAF_HALF, ...LEAF_HALF.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
/** The leaf cut to |x| <= crop and scaled to the 100 box with its top point at `top`, filled down to y 100. */
function leafArea(crop, top) {
  const pts = [];
  LEAF.forEach(([x, y], i) => {
    const prev = LEAF[i - 1];
    if (prev) for (const edge of [-crop, crop]) if ((prev[0] - edge) * (x - edge) < 0)
      pts.push([edge, prev[1] + (y - prev[1]) * (edge - prev[0]) / (x - prev[0])]);
    if (Math.abs(x) <= crop) pts.push([x, y]);
  });
  const k = 100 / (2 * crop);
  const xy = pts.map(([x, y]) => `${r2((x + crop) * k, 1)} ${r2(top + (y + 2000) * k, 1)}`);
  return `M0 100L${xy.join("L")}L100 100Z`;
}

// f: the leaf says Canada, the area chart says statistics. Square, like everything else on the site.
const CHOSEN = "f";
// Tile marks fill a full-bleed background with ink (app icons and avatars are cropped by the platform).
const TILE = new Set(["d", "e", "f"]);

/** A mark as a complete SVG. `inset` is the padding on each side as a fraction of the size. */
function markSvg(concept, { small = false, bg = C.paper, inset = 0, dark = false, size = 100 } = {}) {
  const k = 1 - 2 * inset;
  const body = concept === "f" ? concepts.f(small, inset)
    : `<g transform="translate(${r2(inset * 100)} ${r2(inset * 100)}) scale(${r2(k, 4)})">${concepts[concept](small)}</g>`;
  const fill = bg && TILE.has(concept) ? C.ink : bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${style(dark)}${fill ? `<rect width="100" height="100" fill="${fill}"/>` : ""}${body}</svg>`;
}

function png(svg, width) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } }).render().asPng();
}

// ---------- Concepts and the size test ----------
for (const k of Object.keys(concepts)) {
  writeFileSync(join(CONCEPTS, `concept-${k}.svg`), markSvg(k, { size: 180 }));
  writeFileSync(join(CONCEPTS, `concept-${k}-small.svg`), markSvg(k, { small: true, size: 32 }));
}

// ---------- Site icons ----------
// favicon.svg is shown at 16-32 px: the small drawing, transparent, light/dark aware.
writeFileSync(join(SITE, "favicon.svg"), markSvg(CHOSEN, { small: true, bg: null, dark: true, size: 32 }));
const tmp = mkdtempSync(join(tmpdir(), "statcan2-ico-"));
const icoParts = [16, 32, 48].map((s) => {
  const f = join(tmp, `${s}.png`);
  // 48 is still small enough for the heavy drawing; white so it reads on dark tab bars too.
  writeFileSync(f, png(markSvg(CHOSEN, { small: true, bg: null }), s));
  return f;
});
execFileSync("magick", [...icoParts, join(SITE, "favicon.ico")]);
rmSync(tmp, { recursive: true });
writeFileSync(join(SITE, "apple-touch-icon.png"), png(markSvg(CHOSEN, { inset: 0.12 }), 180));
writeFileSync(join(SITE, "icon-192.png"), png(markSvg(CHOSEN, { inset: 0.1 }), 192));
writeFileSync(join(SITE, "icon-512.png"), png(markSvg(CHOSEN, { inset: 0.1 }), 512));
// Maskable: the safe zone is a centred circle of 80 % diameter; a 24 % inset keeps the mark's corners inside it.
writeFileSync(join(SITE, "icon-maskable-512.png"), png(markSvg(CHOSEN, { inset: 0.24 }), 512));
writeFileSync(join(SITE, "site.webmanifest"), JSON.stringify({
  name: "statcan2",
  short_name: "statcan2",
  icons: [
    { src: "/static/brand/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/static/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/static/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  theme_color: C.paper,
  background_color: C.paper,
  display: "standalone",
  start_url: "/",
}, null, 2) + "\n");

// ---------- Logos (paths, no fonts) ----------
writeFileSync(join(SOCIAL, "logo-mark.svg"), markSvg(CHOSEN, { bg: null, size: 512 }));
writeFileSync(join(SOCIAL, "logo-mark-small.svg"), markSvg(CHOSEN, { small: true, bg: null, size: 32 }));

/** The wordmark as on the site: "statcan" Geist 600 ink, then "(2)" Geist Mono 500 red, baselines shared. */
const word = glyphs("statcan", FONT.semibold, 190, -190 * 0.03);
const ver = glyphs("(2)", FONT.monoMedium, 150, -150 * 0.05);
function wordmark(x, baseline, scale = 1) {
  // Glyph boxes are relative to baseline 0, so translate by the baseline directly.
  const gap = 2 * (190 / 19); // the site's 2 px margin at 19 px type
  const vx = word.x + word.w + gap - ver.x;
  return `<g transform="translate(${x} ${baseline}) scale(${scale})"><path class="i" d="${word.d}"/><path class="a" transform="translate(${r2(vx)} 0)" d="${ver.d}"/></g>`;
}
const wmW = word.x + word.w + 20 + ver.w;
const wmTop = Math.min(word.y, ver.y), wmBottom = Math.max(word.y + word.h, ver.y + ver.h);
{
  const pad = 20, w = Math.ceil(wmW + 2 * pad), h = Math.ceil(wmBottom - wmTop + 2 * pad);
  writeFileSync(join(SOCIAL, "logo-wordmark.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${style(false)}${wordmark(pad - word.x, pad - wmTop)}</svg>`);
}

// ---------- Social ----------
// Profile: the mark sits inside the inscribed circle (corners of the parentheses stay > 8 % from the circle).
writeFileSync(join(SOCIAL, "profile-1000.png"), png(markSvg(CHOSEN, { inset: 0.2 }), 1000));
writeFileSync(join(SOCIAL, "profile-400.png"), png(markSvg(CHOSEN, { inset: 0.2 }), 400));

const tagA = glyphs("Every Statistics Canada table, charted.", FONT.regular, 40);
const tagB = glyphs("statcan2.ca", FONT.mono, 30);

/** A faint thin-line chart across the banner, ending in a red dot. Deterministic. */
function chart(W, H, top, bottom, left) {
  const n = 48, pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v = 0.15 + 0.6 * t + 0.08 * Math.sin(i * 1.3) + 0.05 * Math.sin(i * 0.37 + 1);
    pts.push([left + t * (W - left - 60), bottom - v * (bottom - top)]);
  }
  const grid = [0, 1, 2, 3].map((k) => { const y = r2(top + (k / 3) * (bottom - top)); return `<path d="M${left} ${y}H${W - 60}" stroke="${C.rule}" stroke-width="1"/>`; }).join("");
  const [ex, ey] = pts.at(-1);
  return grid + `<path d="M${pts.map((p) => p.map((n) => r2(n, 1)).join(" ")).join("L")}" fill="none" stroke="${C.lineStrong}" stroke-width="1.5" stroke-linejoin="round"/>`
    + `<circle cx="${r2(ex, 1)}" cy="${r2(ey, 1)}" r="6" fill="${C.accent}"/>`;
}

function header(W, H, { textX, wmScale, wmBaseline, tagY, chartBox }) {
  const s = wmScale;
  const tagScale = s * 1.35;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style(false)}
<rect width="${W}" height="${H}" fill="${C.paper}"/>
${chart(W, H, ...chartBox)}
${wordmark(textX - word.x * s, wmBaseline, s)}
<g transform="translate(${textX} ${tagY}) scale(${tagScale})"><path fill="${C.ink}" transform="translate(${-tagA.x} 0)" d="${tagA.d}"/></g>
<g transform="translate(${textX} ${tagY + 52 * tagScale}) scale(${tagScale})"><path fill="${C.muted}" transform="translate(${-tagB.x} 0)" d="${tagB.d}"/></g>
</svg>`;
}
// X: the avatar covers roughly x < 400, y > 300 at the bottom left; mobile crops the top and bottom ~60 px.
const xHeader = header(1500, 500, { textX: 520, wmScale: 0.62, wmBaseline: 205, tagY: 280, chartBox: [350, 445, 440] });
writeFileSync(join(SOCIAL, "header-x-1500x500.png"), png(xHeader, 1500));
// LinkedIn: the avatar covers the bottom left; the banner is short, so text sits left of centre on one block.
const liHeader = header(1584, 396, { textX: 520, wmScale: 0.55, wmBaseline: 150, tagY: 210, chartBox: [285, 350, 440] });
writeFileSync(join(SOCIAL, "header-linkedin-1584x396.png"), png(liHeader, 1584));

// ---------- Contact sheet ----------
{
  const img = (svg, s, x, y, scale = 1) => {
    const b64 = Buffer.from(png(svg, s)).toString("base64");
    return `<image x="${x}" y="${y}" width="${s * scale}" height="${s * scale}" image-rendering="optimizeSpeed" href="data:image/png;base64,${b64}"/>`;
  };
  const label = (t, x, y, color = C.muted) => { const g = glyphs(t, FONT.mono, 14); return `<path fill="${color}" transform="translate(${x - g.x} ${y})" d="${g.d}"/>`; };
  // The favicon's dark-mode rules, applied unconditionally.
  const darkStyle = `<style>.i,.ti{fill:#fff}.tw{fill:${C.ink}}.sw{fill:none;stroke:${C.ink}}.a{fill:#FF3B4E}.si{fill:none;stroke:#fff}.sa{fill:none;stroke:#FF3B4E}</style>`;
  let out = "", y = 30;
  out += label("concept   16px   16px x6       32px   32px x3       180px", 30, y);
  y += 20;
  for (const k of Object.keys(concepts)) {
    const sm = markSvg(k, { small: true }), lg = markSvg(k, { inset: 0.12 });
    out += label(k === CHOSEN ? `${k} (chosen)` : k, 30, y + 60, k === CHOSEN ? C.accent : C.muted);
    out += img(sm, 16, 130, y + 50) + img(sm, 16, 180, y, 6) + img(sm, 32, 310, y + 40) + img(sm, 32, 370, y, 3) + img(lg, 180, 500, y);
    // Dark tab check for the favicon.
    out += `<rect x="700" y="${y}" width="96" height="96" fill="#202124"/>` + img(markSvg(k, { small: true, bg: null }).replace(/<style>.*?<\/style>/, darkStyle), 32, 732, y + 32);
    y += 200;
  }
  // Circle crop check for the profile picture.
  out += label("profile, circle crop", 130, y - 8);
  const prof = Buffer.from(png(markSvg(CHOSEN, { inset: 0.2 }), 200)).toString("base64");
  out += `<defs><clipPath id="c"><circle cx="230" cy="${y + 100}" r="100"/></clipPath></defs><rect x="128" y="${y - 2}" width="204" height="204" fill="#eee"/><image clip-path="url(#c)" x="130" y="${y}" width="200" height="200" href="data:image/png;base64,${prof}"/>`;
  out += label("maskable, safe zone", 400, y - 8);
  const mask = Buffer.from(png(markSvg(CHOSEN, { inset: 0.24 }), 200)).toString("base64");
  out += `<image x="400" y="${y + 30}" width="200" height="200" href="data:image/png;base64,${mask}"/><circle cx="500" cy="${y + 130}" r="80" fill="none" stroke="#2A5DB0" stroke-dasharray="4 4"/>`;
  y += 250;
  out += `<image x="30" y="${y}" width="750" height="250" href="data:image/png;base64,${Buffer.from(png(xHeader, 750)).toString("base64")}"/>`;
  out += `<rect x="30" y="${y}" width="750" height="250" fill="none" stroke="${C.rule}"/><circle cx="130" cy="${y + 250}" r="75" fill="#eee" stroke="${C.lineStrong}"/>`;
  y += 280;
  out += `<image x="30" y="${y}" width="792" height="198" href="data:image/png;base64,${Buffer.from(png(liHeader, 792)).toString("base64")}"/><rect x="30" y="${y}" width="792" height="198" fill="none" stroke="${C.rule}"/>`;
  y += 230;
  writeFileSync(join(CONCEPTS, "contact-sheet.png"), png(`<svg xmlns="http://www.w3.org/2000/svg" width="860" height="${y}" viewBox="0 0 860 ${y}"><rect width="860" height="${y}" fill="#fff"/>${style(false)}${out}</svg>`, 860));
}
// The site top bar draws the small mark inline (api/src/pages.ts logo()); this is its path.
console.log(`built brand assets\ntop bar leaf: ${leafArea(1400, 14)}`);
