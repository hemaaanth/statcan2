import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { parts } from "../public/render.js";
import type { Config } from "./api.ts";
import { planQuery } from "./planner.ts";
import { decodeSpec, type PlanResult, type ViewResult, type ViewSpec } from "./spec.ts";
import { runView } from "./view.ts";
import { publicOrigin } from "./config.ts";
import { mcpTools } from "./mcp_tools.ts";
import { clientIcons } from "./client_icons.ts";

// Pinned Highcharts build from a CDN; non-commercial licence applies (personal, non-profit project). SRI protects against CDN tampering.
const HIGHCHARTS = { src: "https://cdn.jsdelivr.net/npm/highcharts@13.1.1/highcharts.js", integrity: "sha384-FXT8Mj1JsVEsCNEB3qjrU1JPYJ94Ku7uMe0eopjumL2jEkPl1O9YeAZJn+qsOFVW" };
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));


function logo() {
  // The favicon's mark (brand/build.mjs concept e, small drawing), then the wordmark.
  return html`<a class="brand" data-pp="pp_mury6rk1a84x" href="/" aria-label="statcan(2) home"><svg class="brand-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="18" fill="#0E0F11"/><path d="M18 72L40 52L56 60L74 32" fill="none" stroke="#fff" stroke-width="11" stroke-linejoin="round" stroke-linecap="round"/><circle cx="74" cy="32" r="11" fill="#D80621"/></svg><span class="brand-word">statcan<span class="brand-version">(2)</span></span></a>`;
}

/** Shared top bar for the app and reference pages. */
function appHeader(q = "", active = "") {
  return html`<header class="topbar">
    ${logo()}
    <form class="ask" method="get" action="/" role="search"><span class="prompt">›</span><input name="q" value="${q}" placeholder="What do you want to understand?" aria-label="What do you want to understand?" autocomplete="off" spellcheck="false"></form>
    <nav><a class="${active === "api" ? "active" : ""}" href="/api">API</a><a class="${active === "mcp" ? "active" : ""}" href="/mcp">MCP</a></nav>
  </header>`;
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap');
:root{color-scheme:light;--ink:#0e0f11;--muted:#5a5f66;--quiet:#9aa0a6;--line:#e6e7e9;--line-strong:#c9cbce;--hot:#d80621;--ok:#0a7f42;--bad:#b42318;--paper:#fff;--mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Geist,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 var(--sans)}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit;color:inherit}button{cursor:pointer}.mono,kbd,code,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.quiet{color:var(--quiet)}
.topbar{height:56px;display:flex;align-items:center;gap:24px;padding:0 24px 0 48px;border-bottom:1px solid transparent;background:#fff}.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:19px;line-height:22px;letter-spacing:-.03em;white-space:nowrap}.brand-mark{width:20px;height:20px;flex:none}.brand-word{display:flex;align-items:baseline}.brand-version{color:var(--hot);font:500 15px/22px var(--mono);letter-spacing:-.05em;margin-left:2px}.topbar nav{margin-left:auto;display:flex;gap:28px}.topbar nav a{color:var(--muted);font-weight:500}.topbar nav a.active{color:var(--ink);font-weight:600}.search-count{color:var(--muted);font:12px/16px var(--mono);white-space:nowrap}.search-count:empty{display:none}.prompt{color:var(--hot);font:500 14px/18px var(--mono)}kbd{border:1px solid var(--line);font:11px/14px var(--mono);padding:2px 6px;color:var(--muted);background:#fff}
main{width:100%;margin:0}.footbar{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 24px 0 48px;color:var(--quiet);font:12px/16px var(--mono)}
.section-head{display:flex;align-items:baseline;gap:10px;padding-bottom:12px}.section-head h2{margin:0;font:600 17px/22px var(--sans)}.section-head .count,.count{font:12px/16px var(--mono);color:var(--quiet)}
.note-row{display:flex;gap:16px;border-top:1px solid var(--line);padding:14px 0}.note-row .id{width:24px;color:var(--quiet);font:11px/16px var(--mono)}.note-row p{margin:0;font-size:13px;line-height:18px}
.btn{height:32px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--line-strong);background:#fff;font:500 13px/16px var(--sans)}.btn.primary{background:var(--ink);border-color:var(--ink);color:#fff}
.doc-shell{height:calc(100svh - 56px);display:grid;grid-template-rows:minmax(0,1fr) 48px;max-width:none}.doc-scroll{min-height:0;overflow:auto}.doc{width:min(960px,calc(100vw - 96px));margin:0 auto;padding:56px 0 80px}.doc-hero{padding-bottom:8px}.doc-kicker{margin:0 0 12px;color:var(--hot);font:500 12px/16px var(--mono);text-transform:uppercase;letter-spacing:.06em}.doc h1{max-width:720px;margin:0 0 16px;font:600 40px/44px var(--sans);letter-spacing:-.025em}.doc-hero>p:not(.doc-kicker){max-width:680px;margin:0 0 8px;color:var(--muted);font-size:16px;line-height:24px}.doc .base{font:12px/18px var(--mono)!important;color:var(--quiet)!important}.doc section{margin-top:48px}.doc h2{margin:0 0 18px;font:600 22px/28px var(--sans)}.doc h3{margin:0 0 8px;font:600 15px/20px var(--sans)}.doc p{margin:0 0 12px}.doc a{text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px}.example{margin-top:28px}.code-block{position:relative;background:#f6f7f8;padding:16px 88px 16px 18px}.code-block pre,.response{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/18px var(--mono)}.code-block .copy{position:absolute;top:10px;right:10px;width:64px;height:28px;border:1px solid var(--line-strong);background:#fff;font:500 11px/16px var(--mono)}.response{padding:12px 18px;color:var(--muted);border:1px solid var(--line);border-top:0;background:#fff}.endpoint-group{margin-top:28px}.endpoint-group h3{padding-bottom:8px;border-bottom:1px solid var(--ink)}.endpoint-row{min-height:48px;display:grid;grid-template-columns:72px 340px minmax(0,1fr);gap:4px 16px;align-items:start;padding:12px 0;border-bottom:1px solid var(--line)}.endpoint-row .method{font:500 11px/18px var(--mono);color:var(--quiet)}.endpoint-row>code{font:12px/18px var(--mono);overflow-wrap:anywhere}.endpoint-row>span:not(.method){line-height:18px}.endpoint-row small{grid-column:3;color:var(--quiet);font:11px/16px var(--mono)}.sep{margin:0 10px;color:var(--quiet)}.doc ul{margin:0;padding-left:20px}.doc li{margin:8px 0}.tool-row{display:grid;grid-template-columns:200px minmax(0,1fr);gap:4px 20px;padding:12px 0;border-bottom:1px solid var(--line)}.tool-row:first-of-type{border-top:1px solid var(--ink)}.tool-row code{font:500 12px/18px var(--mono)}.tool-row small{grid-column:2;color:var(--quiet);font:12px/18px var(--sans)}.tool-row small code{color:var(--muted);font:500 11px/18px var(--mono)}.prompts{font-size:16px;line-height:24px}.client-row{display:grid;grid-template-columns:200px minmax(0,1fr);gap:4px 20px;padding:16px 0;border-bottom:1px solid var(--line)}.clients{margin-top:24px;border-top:1px solid var(--ink)}.client-row h3{display:flex;align-items:center;gap:10px;margin:0;line-height:28px}.client-row h3 svg{width:18px;height:18px;flex:none}.client-row p{margin:0 0 8px;line-height:28px}.client-row p:last-child{margin:0}
@media(max-width:900px){.footbar{padding:0 16px}.doc{width:auto;padding:36px 16px 64px}.doc h1{font-size:34px;line-height:40px}.endpoint-row{grid-template-columns:64px minmax(0,1fr)}.endpoint-row>span:not(.method),.endpoint-row small{grid-column:2}.tool-row{grid-template-columns:1fr}.tool-row small{grid-column:1}}
`;

type PageMeta = { title: string; description: string; image: string; url: string };
function metadata(c: Context, title: string, description: string, image: string): PageMeta {
  const request = new URL(c.req.url);
  const origin = publicOrigin();
  return { title, description, image: new URL(image, origin).toString(),
    url: new URL(request.pathname + request.search, origin).toString() };
}
function metaTags(meta: PageMeta) {
  return html`<link rel="canonical" href="${meta.url}"><meta name="description" content="${meta.description}">
    <meta name="theme-color" content="#ffffff"><link rel="icon" href="/static/brand/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/static/brand/favicon.ico" sizes="32x32"><link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
    <link rel="manifest" href="/static/brand/site.webmanifest">
    <meta property="og:title" content="${meta.title}"><meta property="og:description" content="${meta.description}">
    <meta property="og:image" content="${meta.image}"><meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630"><meta property="og:url" content="${meta.url}">
    <meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${meta.title}"><meta name="twitter:description" content="${meta.description}">
    <meta name="twitter:image" content="${meta.image}">`;
}

function layout(title: string, meta: PageMeta, body: HtmlEscapedString | Promise<HtmlEscapedString>, q = "", pageClass = "page", active = "") {
  const footer = active === "mcp" ? "Streamable HTTP · /api/mcp" : "JSON over HTTPS · /api/v1";
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · statcan2</title>${metaTags(meta)}<style>${raw(CSS)}</style><link rel="stylesheet" href="/static/topbar.css"><script type="module" src="/static/docs.js"></script></head>
<body class="doc-body">${appHeader(q, active)}<main class="${pageClass}"><div class="doc-scroll">${body}</div><footer class="footbar"><span>Independent. Not affiliated with Statistics Canada.</span><span>${footer}</span></footer></main></body></html>`;
}



/** What the app screen needs; embedded as JSON so app.js starts from the server's answer. */
type AppState = { q: string; plan: PlanResult | null; spec: ViewSpec | null; view: ViewResult | null; edited: boolean; error: string | null; hasZip: boolean };
const TABS = [["table", "Table"], ["notes", "Notes"], ["download", "Download"], ["cite", "Cite"], ["api", "API"]] as const;

/** The one app screen: question box, chart header band, plot, panel tabs, and the (collapsed) chart builder. */
function appPage(state: AppState, meta: PageMeta) {
  const p = parts(state);
  const title = p.status === "ok" && state.view ? state.view.title : state.q.trim() || "Home";
  const count = (k: string) => k === "notes" ? p.counts.notes || "" : k === "cite" && p.counts.cite > 1 ? p.counts.cite : "";
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · statcan2</title>${metaTags(meta)}<script>document.documentElement.classList.add("js")</script>
<style>${raw(CSS)}</style><link rel="stylesheet" href="/static/app.css">
<script src="${HIGHCHARTS.src}" integrity="${HIGHCHARTS.integrity}" crossorigin="anonymous" defer></script><script type="module" src="/static/app.js"></script></head>
<body class="app-body" data-status="${p.status}">
<header class="topbar app-top">${logo()}
  <form class="ask" method="get" action="/" role="search"><span class="prompt">›</span><input id="q" name="q" value="${state.q}" placeholder="What do you want to understand?" aria-label="What do you want to understand?" autocomplete="off" spellcheck="false"></form>
  <nav><a href="/api">API</a><a href="/mcp">MCP</a></nav>
  <div class="progress" aria-hidden="true"></div>
</header>
<main class="app">
  <div class="app-main">
    <div class="screen">
    <section class="view-head"><div id="head">${raw(p.head)}</div>
      <button type="button" id="builder-toggle" class="btn" aria-expanded="false" aria-controls="builder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12M5 2.5v3M11 6.5v3M7 10.5v3"/></svg>Chart builder</button></section>
    <div class="stage"><div id="chart" class="chart-box"></div><div id="blank" class="blank" ${p.blank ? "" : "hidden"} aria-live="polite">${raw(p.blank)}</div></div>
    <nav id="rail" class="rail" aria-label="Chart details">${TABS.map(([k, l]) => html`<a href="#p-${k}" data-tab="${k}" role="button" aria-expanded="false" aria-controls="p-${k}">${l}<span class="count">${count(k)}</span></a>`)}
      <span class="rail-acts"><button type="button" class="act" id="act-png" title="Download a PNG of this chart"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h2.5l1-1.5h5l1 1.5H14v8H2z"/><circle cx="8" cy="8.75" r="2.25"/></svg>Screenshot</button><button type="button" class="act primary" id="act-share" title="Copy a link to this exact chart"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M5 5l3-3 3 3M3 9v5h10V9"/></svg>Share</button></span>
      <span class="rail-note">Independent. Not affiliated with Statistics Canada.</span><span id="act-status" class="act-status" role="status" aria-live="polite"></span></nav>
    </div>
    <div class="panels">${TABS.map(([k, l]) => html`<section id="p-${k}" class="panel pop-${k}" role="dialog" aria-label="${l}" tabindex="-1"><h2 class="panel-title">${l}</h2><a class="panel-close" href="#" data-close aria-label="Close ${l}">×</a><div class="panel-body">${raw(p[k])}</div></section>`)}</div>
  </div>
  <aside id="builder" class="builder" hidden aria-labelledby="builder-title"></aside>
</main>
<script type="application/json" id="app-state">${raw(JSON.stringify(state).replaceAll("<", "\\u003c"))}</script>
</body></html>`;
}


export function pageRoutes({ db, captureDir }: Config) {
  const site = new Hono();
  const hasZip = captureDir !== undefined;
  // no-cache = revalidate every load (304 via Last-Modified), so an edited module is never served stale; the files are a few KB.
  site.use("/static/*", serveStatic({ root: PUBLIC_DIR, rewriteRequestPath: (p) => p.slice("/static".length), onFound: (_path, c) => { c.header("Cache-Control", "no-cache"); } }));
  type Endpoint = { method: string; path: string; description: string; params?: string };
  const endpointGroups: [string, Endpoint[]][] = [
    ["Charts", [
      { method: "GET", path: "/api/v1/plan", description: "Turn plain text into a chart spec and alternatives.", params: "q · view=1" },
      { method: "GET POST", path: "/api/v1/view", description: "Run an encoded or JSON ViewSpec.", params: "s (GET) · ViewSpec body (POST)" },
      { method: "GET POST", path: "/api/v1/view.parquet", description: "Download the resolved view as Parquet.", params: "s (GET) · ViewSpec body (POST)" },
      { method: "GET POST", path: "/api/v1/view.csv", description: "Download the resolved view as CSV.", params: "s (GET) · ViewSpec body (POST)" },
      { method: "GET", path: "/api/v1/highlights", description: "Twelve build-pinned headline indicators for the home page." },
      { method: "GET", path: "/api/v1/regions", description: "Named Canadian region definitions used in chart specs." },
      { method: "GET", path: "/api/v1/cubes", description: "Search chartable tables.", params: "q · limit" },
      { method: "GET", path: "/api/v1/cubes/{pid}", description: "Dimensions, members, roles, defaults, units and periods." },
      { method: "GET", path: "/api/v1/cubes/{pid}/views", description: "Starter chart specs for one table." },
    ]],
    ["Tables", [
      { method: "GET", path: "/api/v1/tables", description: "Search table titles, dimensions, members and notes.", params: "q · archived · kind · family · queryable · limit · offset" },
      { method: "GET", path: "/api/v1/tables/{pid}", description: "Table metadata, dimensions, members, notes and corrections." },
      { method: "GET", path: "/api/v1/tables/{pid}/observations", description: "Filtered published observation rows.", params: "from · to · vector · m1…m9 · limit · offset" },
      { method: "GET", path: "/api/v1/tables/{pid}/series", description: "Series grouped by vector or coordinate.", params: "from · to · vector · m1…m9" },
    ]],
    ["Series", [
      { method: "GET", path: "/api/v1/series", description: "Search series by table title and member labels.", params: "q · pid · place_id · unit_family · limit · offset" },
      { method: "GET", path: "/api/v1/series/{pid}/{vector}", description: "One WDS vector with metadata and every point." },
      { method: "GET", path: "/api/v1/series/{pid}/c/{coordinate}", description: "One coordinate-keyed series, including Census cells." },
    ]],
    ["Places", [
      { method: "GET", path: "/api/v1/places", description: "Search places by name, DGUID, place ID or code.", params: "q · limit · offset" },
      { method: "GET", path: "/api/v1/places/{place_id}", description: "A place, its vintages, parent and covering tables." },
    ]],
    ["Files", [
      { method: "GET", path: "/api/v1/tables/{pid}/observations.parquet", description: "Whole-table Parquet for the current build." },
      { method: "GET", path: "/api/v1/tables/{pid}/source.zip", description: "Original Statistics Canada ZIP when captured." },
    ]],
    ["Build", [
      { method: "GET", path: "/api/v1/build", description: "Build, capture, manifest and code-set provenance." },
      { method: "GET", path: "/api/v1/coverage", description: "Inventory, capture and queryable coverage." },
      { method: "GET", path: "/api/v1/openapi.json", description: "OpenAPI document for every route above." },
    ]],
  ];
  const codeBlock = (code: string, label = "Copy") => html`<div class="code-block"><button type="button" class="copy" data-copy>${label}</button><pre><code>${code}</code></pre></div>`;
  const apiPage = () => html`<article class="doc">
    <header class="doc-hero"><p class="doc-kicker">API</p><h1>Statistics Canada data, ready to use.</h1>
      <p>Free, read-only JSON over HTTPS for every Statistics Canada table, with values as published.</p>
      <p class="base">Base URL <code>https://statcan2.ca/api</code></p></header>
    <section id="quick-start"><h2>Quick start</h2>
      <div class="example"><h3>Plan a chart from text</h3>${codeBlock(`curl -s 'https://statcan2.ca/api/v1/plan?q=unemployment%20rate%20in%20Canada'`)}
        <pre class="response"><code>{"status":"ok","q":"unemployment rate in Canada","spec":{"v":1,"layers":[{"pid":"14100287",…}]},"build_id":"wds-full-1+census-full-1","normalized_build_id":"n8"}</code></pre></div>
      <div class="example"><h3>Run a view</h3>${codeBlock(`curl -s 'https://statcan2.ca/api/v1/view?s=eyJ2IjoxLCJsYXllcnMiOlt7InBpZCI6IjE0MTAwMjg3IiwiZGltcyI6eyIxIjp7InVzZSI6ImZpeGVkIiwibWVtYmVycyI6eyJlcSI6MX19LCIyIjp7InVzZSI6ImZpeGVkIiwibWVtYmVycyI6eyJlcSI6N319LCIzIjp7InVzZSI6ImZpeGVkIiwibWVtYmVycyI6eyJlcSI6MX19LCI0Ijp7InVzZSI6ImZpeGVkIiwibWVtYmVycyI6eyJlcSI6MX19LCI1Ijp7InVzZSI6ImZpeGVkIiwibWVtYmVycyI6eyJlcSI6MX19LCI2Ijp7InVzZSI6ImZpeGVkIiwibWVtYmVycyI6eyJlcSI6MX19fX1dLCJ0aW1lIjp7InByZXNldCI6IjVZIn0sInRyYW5zZm9ybSI6ImxldmVsIiwiY2hhcnQiOnsidHlwZSI6ImxpbmUifX0'`)}
        <pre class="response"><code>{"title":"Unemployment rate","subtitle":"Canada · 15 years and over · Estimate · Seasonally adjusted · Sep 2021 – Aug 2026 · Percent","series":[{"name":"Unemployment rate","points":[…]}]}</code></pre></div>
      <div class="example"><h3>Get table observations</h3>${codeBlock(`curl -s 'https://statcan2.ca/api/v1/tables/18100004/observations?limit=2'`)}
        <pre class="response"><code>{"pid":"18100004","total":1152913,"limit":2,"rows":[{"ref_date":"1914-01","value":"6.0","status":""},{"ref_date":"1914-02","value":"6.0","status":""}]}</code></pre></div>
    </section>
    <section id="reference"><h2>Endpoint reference</h2>
      ${endpointGroups.map(([name, endpoints]) => html`<div class="endpoint-group"><h3>${name}</h3>${endpoints.map((endpoint) => html`<div class="endpoint-row"><span class="method">${endpoint.method}</span><code>${endpoint.path}</code><span>${endpoint.description}</span>${endpoint.params ? html`<small>${endpoint.params}</small>` : ""}</div>`)}</div>`)}
    </section>
    <section id="schemas"><h2>Machine-readable schemas</h2><p><a href="/api/v1/openapi.json">OpenAPI ↗</a></p></section>
    <section id="notes"><h2>Notes</h2><ul><li>Values and status marks stay as published. A blank value is not zero.</li><li>Every response includes build provenance.</li><li>No API key is needed.</li><li>Please cache repeat requests and keep request rates polite.</li></ul></section>
  </article>`;
  const MCP_URL = "https://statcan2.ca/api/mcp";
  // Setup for each MCP client. Remote clients all speak Streamable HTTP to MCP_URL.
  const mcpClients: { name: string; icon: string; steps?: string; code?: string }[] = [
    { name: "Claude", icon: "claude", steps: "Settings → Connectors → Add custom connector. Paste the server URL." },
    { name: "Claude Code", icon: "claudecode", code: `claude mcp add --transport http statcan2 ${MCP_URL}` },
    { name: "ChatGPT", icon: "openai", steps: "Settings → Apps → Advanced settings → turn on Developer mode. Create an app, paste the server URL and choose No authentication. Needs a paid plan, on the web." },
    { name: "Codex", icon: "codex", code: `codex mcp add statcan2 --url ${MCP_URL}` },
    { name: "Gemini CLI", icon: "gemini", code: `gemini mcp add --transport http statcan2 ${MCP_URL}` },
    { name: "Grok", icon: "grok", steps: "In the xAI Responses API, add this remote MCP tool.", code: `{"type":"mcp","server_url":"${MCP_URL}","server_label":"statcan2"}` },
    { name: "Le Chat", icon: "mistral", steps: "Intelligence → Connectors → Add connector → Custom MCP connector. Paste the server URL and choose no authentication." },
    { name: "Cursor", icon: "cursor", steps: "Add to ~/.cursor/mcp.json.", code: `{"mcpServers":{"statcan2":{"url":"${MCP_URL}"}}}` },
    { name: "VS Code · Copilot", icon: "githubcopilot", code: `code --add-mcp '{"name":"statcan2","type":"http","url":"${MCP_URL}"}'` },
    { name: "Windsurf", icon: "windsurf", steps: "Add to ~/.codeium/windsurf/mcp_config.json.", code: `{"mcpServers":{"statcan2":{"serverUrl":"${MCP_URL}"}}}` },
    { name: "OpenCode", icon: "opencode", steps: "Add to opencode.json.", code: `{"mcp":{"statcan2":{"type":"remote","url":"${MCP_URL}"}}}` },
  ];
  // Plain words for each MCP tool argument; m1–m9 collapse to one entry.
  const ARG_LABELS: Record<string, string> = {
    q: "search words", archived: "archived or current", queryable: "only tables with data", limit: "page size", offset: "rows to skip",
    pid: "table ID", place_id: "place ID", unit_family: "unit type", from: "start date", to: "end date", vector: "series ID", spec: "chart spec",
  };
  const toolInputs = ({ name, args }: { name: string; args: string[] }): [string, string][] => {
    const members = args.filter((a) => /^m\d+$/.test(a));
    const out: [string, string][] = [];
    for (const a of args) {
      if (members.includes(a)) { if (a === members[0]) out.push([`${members[0]}–${members.at(-1)}`, "member ID per dimension"]); }
      else out.push([a, a === "q" && name === "plan_chart" ? "question" : ARG_LABELS[a] ?? ""]);
    }
    return out;
  };
  const mcpPage = () => html`<article class="doc">
    <header class="doc-hero"><p class="doc-kicker">MCP</p><h1>Give an AI agent the tables.</h1>
      <p>Connect an AI agent to every Statistics Canada table.</p></header>
    <section id="connect"><h2>Connect</h2>
      <p>Every client uses one server URL. No key or sign-in is needed.</p>${codeBlock(MCP_URL)}
      <div class="clients">${mcpClients.map((client) => html`<div class="client-row"><h3>${raw(clientIcons[client.icon])}${client.name}</h3><div>${client.steps ? html`<p>${client.steps}</p>` : ""}${client.code ? codeBlock(client.code) : ""}</div></div>`)}
      <div class="client-row"><h3>Run locally</h3><div><p>Run the server over stdio from a checkout of this repo, with your own data build.</p>${codeBlock(`{"mcpServers":{"statcan2":{"command":"npm","args":["run","--silent","mcp"],"cwd":"<repo>/api","env":{"STATCAN_BUILD":"<data>/build","STATCAN_NORMALIZED":"<data>/normalized","STATCAN_CODESETS":"<data>/codeSets.json"}}}}`)}</div></div></div>
    </section>
    <section id="tools"><h2>Tools <span class="count">${mcpTools.length}</span></h2>
      ${mcpTools.map((tool) => html`<div class="tool-row"><code>${tool.name}</code><span>${tool.description.split(/(?<!\be\.g\.|\bi\.e\.)(?<=\.)\s+(?=[A-Z])/)[0]}</span><small>${toolInputs(tool).map(([name, label], i) => html`${i ? " · " : ""}<code>${name}</code> ${label}`)}</small></div>`)}
    </section>
    <section id="prompts"><h2>Example prompts</h2><ul class="prompts"><li>Compare food and gasoline inflation in Ontario over the past five years.</li><li>Show unemployment rates for the Prairies and Atlantic Canada.</li><li>Which Statistics Canada tables cover housing in Toronto?</li></ul></section>
  </article>`;

  site.get("/", async (c) => {
    const q = c.req.query("q") ?? "";
    const s = c.req.query("s");
    const origin = publicOrigin();
    const state: AppState = { q, plan: null, spec: null, view: null, edited: false, error: null, hasZip };
    if (s) {
      // `s` names the exact chart: run it as is, never re-plan. `q` only refills the box.
      state.edited = true;
      try { state.spec = decodeSpec(s); } catch { state.error = "The chart link is damaged."; }
    } else if (q.trim()) {
      state.plan = await planQuery(db, q, { view: true, origin, signal: c.req.raw.signal });
      state.spec = state.plan.spec ?? null;
      state.view = state.plan.view ?? null;
    }
    if (state.spec && !state.view && (state.edited || state.plan?.status === "ok")) {
      const outcome = await runView(db, state.spec, { origin });
      if (outcome.kind === "ok") state.view = outcome.result;
      else state.error = outcome.error;
    }
    // app.js rewrites a `q`-only URL to `?q=…&s=<resolved spec>` on load, so the link in the bar is exact from then on.
    const meta = metadata(c, s && state.view ? state.view.title : q.trim() || "statcan(2)",
      s && state.view ? [state.view.subtitle, state.view.sources.map((source) => `Statistics Canada ${source.table_number}`).join(", "),
        state.view.gap_note].filter(Boolean).join(" · ") : "Explore and chart published Statistics Canada data.",
      s && state.view ? `/og/chart.png?s=${encodeURIComponent(s)}` : "/og/site.png");
    return c.html(appPage(state, meta), state.error && state.edited ? 400 : 200);
  });

  site.get("/search", (c) => c.redirect(`/?q=${encodeURIComponent(c.req.query("q") ?? "")}`, 302));

  site.get("/developers", (c) => c.redirect("/api", 301));
  site.get("/api", (c) => c.html(layout("API",
    metadata(c, "API · statcan2", "Free, read-only JSON for every Statistics Canada table.", "/og/text.png?title=API"),
    apiPage(), "", "doc-shell", "api")));
  site.get("/mcp", (c) => c.html(layout("MCP",
    metadata(c, "MCP · statcan2", "Connect an AI agent to every Statistics Canada table.", "/og/text.png?title=MCP"),
    mcpPage(), "", "doc-shell", "mcp")));

  site.get("/tables/:pid", (c) => {
    const rawPid = c.req.param("pid").replaceAll("-", "");
    const pid = rawPid.length === 10 && rawPid.endsWith("01") ? rawPid.slice(0, -2) : rawPid;
    const table = /^\d{8}$/.test(pid) ? `${pid.slice(0, 2)}-${pid.slice(2, 4)}-${pid.slice(4)}-01` : c.req.param("pid");
    return c.redirect(`/?q=${encodeURIComponent(table)}`, 301);
  });
  site.get("/series/*", (c) => c.redirect("/", 301));
  site.get("/places/*", (c) => c.redirect("/", 301));
  site.get("/favicon.ico", (c) => c.redirect("/static/brand/favicon.ico", 301));


  return site;
}
