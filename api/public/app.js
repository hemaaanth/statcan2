// The app screen: type → GET /api/v1/plan → chart; builder edits → POST /api/v1/view. First paint is server-rendered from the same state.
import { initBuilder } from "./builder.js";
import { chartPng, clearChart, drawChart } from "./chart.js";
import { PUBLIC_ORIGIN } from "./export-layout.js";
import { typingDemo } from "./demo.js";
import { decodeSpec, encodeSpec, parts, portableSpec } from "./render.js";

const $ = (id) => document.getElementById(id);
const els = { q: $("q"), head: $("head"), chart: $("chart"), blank: $("blank"), rail: $("rail"), builder: $("builder"), toggle: $("builder-toggle"),
  panels: { table: $("p-table"), notes: $("p-notes"), download: $("p-download"), cite: $("p-cite"), api: $("p-api") } };
const state = JSON.parse($("app-state").textContent);

let planTimer, planCtrl, viewTimer, viewCtrl, seq = 0, inflight = 0;
const busy = (d) => { inflight = Math.max(0, inflight + d); document.body.classList.toggle("loading", inflight > 0); };

/**
 * The URL names the exact chart: `s` is the resolved spec the server returned (ViewResult.spec: member ids, chart type,
 * horizontal, sort, colours, hidden series, transform, time), so a link never re-runs the planner. `q` only refills the
 * box. Before a view arrives (a builder edit in flight) the spec as edited stands in. Blank states carry only `q`.
 */
function url() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q);
  // A builder edit in flight: its spec, as edited. Otherwise the resolved spec of the chart on screen.
  const spec = state.pending ? state.spec : state.view?.spec;
  if (spec) p.set("s", encodeSpec(portableSpec(spec)));
  const s = p.toString();
  return `${s ? `/?${s}` : "/"}${location.hash.startsWith("#p-") ? location.hash : ""}`;
}

function paint() {
  const p = parts(state);
  document.body.dataset.status = p.status;
  els.head.innerHTML = p.head;
  if (p.status === "ok" && !p.blank) {
    els.blank.hidden = true;
    els.blank.innerHTML = "";
    drawChart(els.chart, state.view, `${state.view.title}. ${state.view.subtitle}`);
  } else {
    clearChart();
    els.chart.removeAttribute("aria-label");
    els.blank.innerHTML = p.blank;
    els.blank.hidden = false;
    if (p.status === "idle") demo.start();
  }
  for (const k of Object.keys(els.panels)) els.panels[k].querySelector(".panel-body").innerHTML = p[k];
  els.rail.querySelector('[data-tab="notes"] .count').textContent = p.counts.notes || "";
  els.rail.querySelector('[data-tab="cite"] .count').textContent = p.counts.cite > 1 ? p.counts.cite : "";
  document.title = `${p.status === "ok" ? state.view.title : state.q.trim() || "Home"} · statcan(2)`;
  // The builder lives with a chart: the planner's blank states close it. "error" keeps it, so a bad edit can be undone there.
  if (p.status !== "ok" && p.status !== "error" && !els.builder.hidden) setBuilder(false, false);
  else if (!els.builder.hidden) builder.render();
  // A popover belongs to the chart it describes: blank states close it; a new chart keeps it open, re-anchored.
  if (p.status !== "ok" && openTab) setPopover(null, { focus: false });
  else placePopover();
}

// ---------------------------------------------------------------- typing → plan

/**
 * `push`: true on submit (Enter) so Back returns to the previous chart; typing replaces the current entry.
 * The entry is written twice: at once with only `q` (the old chart's `s` would be wrong now), then with the resolved
 * spec when the view lands (setView).
 */
async function plan(q, { push = false } = {}) {
  planCtrl?.abort();
  viewCtrl?.abort();
  clearTimeout(viewTimer);
  const id = ++seq;
  state.q = q;
  state.edited = false;
  state.pending = false;
  // Write only `q` now (the old chart's `s` would be wrong); setView adds the new chart's `s` when it lands.
  const shown = state.view;
  state.view = null;
  history[push ? "pushState" : "replaceState"](null, "", url());
  state.view = shown; // the old chart stays on screen until the new one arrives
  if (!q.trim()) { Object.assign(state, { plan: null, spec: null, view: null, error: null }); return paint(); }
  planCtrl = new AbortController();
  let body;
  busy(1);
  try {
    const r = await fetch(`/api/v1/plan?q=${encodeURIComponent(q)}&view=1`, { signal: planCtrl.signal });
    body = await r.json();
    if (!r.ok) throw new Error(body.error || `plan failed (${r.status})`);
  } catch (e) {
    if (e.name !== "AbortError" && id === seq) { state.error = e.message; paint(); }
    return;
  } finally { busy(-1); }
  if (id !== seq) return;
  state.plan = body;
  state.spec = body.spec ?? null;
  state.error = null;
  // The old chart stays up while the spec runs, if the planner did not attach a view.
  if (body.status === "ok" && body.spec && !body.view) return runView(id);
  setView(body.view ?? null);
}

/** A new chart (or none): show it and write its resolved spec into the current history entry. */
function setView(view) {
  state.view = view;
  state.pending = false;
  // The builder edits this spec and posts it back, so it must be one the server accepts (no empty `in`).
  if (view) state.spec = portableSpec(view.spec);
  history.replaceState(null, "", url());
  paint();
}

els.q.addEventListener("input", () => {
  clearTimeout(planTimer);
  const q = els.q.value;
  planTimer = setTimeout(() => plan(q), 250);
});
els.q.form.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(planTimer); plan(els.q.value, { push: true }); });

// ---------------------------------------------------------------- home: highlights and the typing demo

// The home page plays the demo only in the idle state. Tab or → takes the query on show and plans it at once.
const demo = typingDemo(els.q, {
  canRun: () => document.body.dataset.status === "idle",
  take: (q) => { els.q.value = q; clearTimeout(planTimer); plan(q, { push: true }); },
});

/** GET the twelve build-backed home cards once. */
async function loadHighlights() {
  try {
    const response = await fetch("/api/v1/highlights");
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
if (!state.highlights) loadHighlights().then((h) => { state.highlights = h; if (document.body.dataset.status === "idle") paint(); });
// The centre card points at the search: a click (or Enter / Space on it) focuses the box.
els.blank.addEventListener("click", (e) => { if (e.target.closest("[data-focus-q]")) els.q.focus(); });
els.blank.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-focus-q]")) { e.preventDefault(); els.q.focus(); } });

// ---------------------------------------------------------------- builder edits → view

async function runView(id = ++seq) {
  viewCtrl?.abort();
  viewCtrl = new AbortController();
  busy(1);
  let body;
  try {
    const r = await fetch("/api/v1/view", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.spec), signal: viewCtrl.signal });
    body = await r.json();
    if (!r.ok) {
      const d = body.details?.[0];
      throw new Error(`${body.error ?? `view failed (${r.status})`}${d ? `: ${d.path?.join(".") ?? ""} ${d.message}` : ""}`);
    }
  } catch (e) {
    if (e.name === "AbortError" || id !== seq) return;
    state.error = e.message; // the last good chart stays; the error shows in the header band
    return paint();
  } finally { busy(-1); }
  if (id !== seq) return;
  state.error = null;
  setView(body);
}

function onSpec(spec) {
  planCtrl?.abort();
  clearTimeout(planTimer);
  state.spec = spec;
  state.edited = true;
  state.pending = true;
  history.pushState(null, "", url());
  clearTimeout(viewTimer);
  const id = ++seq;
  viewTimer = setTimeout(() => runView(id), 200);
}

const builder = initBuilder({ el: els.builder, getState: () => state, onSpec });

function setBuilder(open, focus = true) {
  els.builder.hidden = !open;
  els.toggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("builder-open", open);
  if (open) builder.render().then(() => focus && $("builder-title")?.focus());
  else if (focus) els.toggle.focus();
}
els.toggle.addEventListener("click", () => setBuilder(els.builder.hidden));
els.builder.addEventListener("builder-close", () => setBuilder(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.builder.hidden) setBuilder(false, document.activeElement !== els.q); });

/** Back/forward: an entry with `s` re-runs exactly that spec (no planner); one with only `q` plans again. */
window.addEventListener("popstate", () => {
  const p = new URLSearchParams(location.search);
  const s = p.get("s");
  els.q.value = p.get("q") ?? "";
  state.q = els.q.value;
  if (!s) { state.plan = null; return plan(els.q.value); }
  try { state.spec = decodeSpec(s); } catch { state.error = "The chart link is damaged."; return paint(); }
  state.plan = null; // the planner's steps and alternatives belonged to another entry
  state.edited = true;
  runView();
});

// ---------------------------------------------------------------- detail popovers (Table, Notes, Download, Cite, API), copy

let openTab = null; // key of the open popover, or null

/** Place the open popover above its button: centred on it, clamped to the window, caret pointing at the button. */
function placePopover() {
  if (!openTab) return;
  const btn = els.rail.querySelector(`[data-tab="${openTab}"]`), panel = els.panels[openTab];
  const b = btn.getBoundingClientRect();
  panel.style.setProperty("--pop-x", `${b.left + b.width / 2}px`);
  panel.style.setProperty("--pop-bottom", `${innerHeight - b.top + 8}px`);
  // The Table popover is as wide as its table: measure it (with no clamp applied) so centring and the window clamp use
  // its real width. On phones every popover is a full-width sheet, so there is nothing to measure.
  if (openTab === "table" && innerWidth > 900) {
    panel.style.removeProperty("--pop-w");
    panel.style.setProperty("--pop-w", `${panel.getBoundingClientRect().width}px`);
  }
  const p = panel.getBoundingClientRect();
  panel.style.setProperty("--caret-x", `${Math.min(Math.max(b.left + b.width / 2 - p.left, 14), p.width - 14)}px`);
}

/** Open the popover for `tab`, or close the open one (`tab` null). One at a time; focus moves in, and back to its button. */
function setPopover(tab, { focus = true } = {}) {
  const was = openTab;
  if (was === tab) return;
  if (was) {
    els.panels[was].classList.remove("open");
    els.rail.querySelector(`[data-tab="${was}"]`).setAttribute("aria-expanded", "false");
  }
  openTab = tab;
  // The open popover is part of what is shown, so the hash names it (no new history entry; Back still steps charts).
  const hash = tab ? `#p-${tab}` : "";
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
  if (!tab) { if (focus && was) els.rail.querySelector(`[data-tab="${was}"]`).focus({ preventScroll: true }); return; }
  const panel = els.panels[tab];
  panel.classList.add("open");
  els.rail.querySelector(`[data-tab="${tab}"]`).setAttribute("aria-expanded", "true");
  placePopover();
  panel.querySelector(".panel-body").scrollTop = 0;
  if (focus) panel.focus({ preventScroll: true });
}

els.rail.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (!tab) return;
  e.preventDefault();
  setPopover(openTab === tab.dataset.tab ? null : tab.dataset.tab);
});

document.addEventListener("click", (e) => {
  if (!openTab) return;
  if (e.target.closest("[data-close]")) { e.preventDefault(); return setPopover(null); }
  // Outside click closes; clicks on the open popover or on the rail (handled above) do not.
  if (!e.target.closest(".panel.open, #rail")) setPopover(null, { focus: false });
});

document.addEventListener("keydown", (e) => {
  if (!openTab) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); return setPopover(null); }
  if (e.key !== "Tab") return;
  // Keep Tab inside the popover: wrap from the last focusable to the first and back.
  const panel = els.panels[openTab];
  const items = [...panel.querySelectorAll("a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}, true);

addEventListener("resize", placePopover);

/** `#p-<tab>` opens that popover; any other hash closes it. Old links keep working. */
function openFromHash() {
  const tab = location.hash.match(/^#p-(table|notes|download|cite|api)$/)?.[1];
  if (tab && document.body.dataset.status === "ok") setPopover(tab);
  else if (!tab && openTab) setPopover(null, { focus: false });
}
addEventListener("hashchange", openFromHash);

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const label = b.textContent;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; }
  catch { b.textContent = "Copy failed"; }
  setTimeout(() => { b.textContent = label; }, 1600);
});

// ---------------------------------------------------------------- Screenshot (PNG) and Share (link)

let statusTimer;
/** A short line above the rail's right end ("Link copied"); gone after 2 s. */
function notice(text) {
  const el = $("act-status");
  el.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ""; }, 2000);
}

/** "Gas vs Food by province, % change over 1 year" → "gas-vs-food-by-province-change-over-1-year.png". */
const pngName = (title) => `${(title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "chart")}.png`;

/**
 * The action buttons never change size. Each label becomes a stack of every state's word in one grid cell, so the
 * button is as wide as its widest word from the first paint; only the visible word changes ("Copied", "Saved",
 * "Failed"), for 1.5 s, then the idle word returns.
 */
function stableLabel(btn, states) {
  const label = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  if (!label) return;
  const idle = label.textContent.trim();
  const stack = document.createElement("span");
  stack.className = "act-label";
  stack.innerHTML = [idle, ...states].map((w, i) => `<span${i ? ` hidden` : ""}>${w}</span>`).join("");
  label.replaceWith(stack);
}
function flashLabel(btn, text) {
  const words = [...btn.querySelectorAll(".act-label > span")];
  if (!words.length) return;
  clearTimeout(btn.flashTimer);
  for (const w of words) w.hidden = w.textContent !== text;
  btn.flashTimer = setTimeout(() => { words.forEach((w, i) => { w.hidden = i > 0; }); }, 1500);
}

/** Download the PNG (the fallback when the clipboard cannot take an image). */
function savePng(blob, title) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: pngName(title) });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Screenshot: copy the export PNG (chartPng: the fixed 1600×900 layout) to the clipboard. ClipboardItem gets the Promise, not an awaited Blob,
 * so Safari keeps the click's user activation while the PNG renders. No ClipboardItem, an insecure context or a
 * refused write (permission, browser policy): the same PNG is downloaded instead, and the button says "Saved".
 * The status line repeats the outcome, because on phones the button shows only its icon.
 */
const pngBtn = $("act-png"), shareBtn = $("act-share");
pngBtn.title = "Copy a PNG of this chart to the clipboard";
stableLabel(pngBtn, ["Copied", "Saved", "Failed"]);
stableLabel(shareBtn, ["Copied", "Failed"]);
pngBtn.addEventListener("click", async () => {
  if (!state.view) return;
  const view = state.view;
  pngBtn.disabled = true;
  const png = chartPng(view);
  png.catch(() => {}); // awaited below; this only keeps an early rejection from being reported as unhandled
  try {
    let copied = false;
    // Any refusal falls back to the download. If the PNG itself failed, `await png` below throws its real error.
    if (window.ClipboardItem && window.isSecureContext && navigator.clipboard?.write) {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]); copied = true; } catch {}
    }
    if (!copied) savePng(await png, view.title);
    flashLabel(pngBtn, copied ? "Copied" : "Saved");
    notice(copied ? "Chart copied" : "PNG saved");
  } catch (err) { flashLabel(pngBtn, "Failed"); notice(`Screenshot failed: ${err.message}`); }
  finally { pngBtn.disabled = false; }
});

/** The published link keeps the current path, query and open popover, not the request host. */
function publicLink() {
  const here = new URL(location.href);
  here.searchParams.delete("origin");
  const hash = here.hash.startsWith("#p-") ? here.hash : "";
  return `${PUBLIC_ORIGIN}${here.pathname}${here.search}${hash}`;
}

shareBtn.addEventListener("click", async () => {
  const link = publicLink();
  // Phones and tablets: the system share sheet. Desktops: the clipboard.
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: state.view?.title ?? document.title, url: link }); return; }
    catch (err) { if (err.name === "AbortError") return; } // closed the sheet; fall back to copying otherwise
  }
  try { await navigator.clipboard.writeText(link); flashLabel(shareBtn, "Copied"); notice("Link copied"); }
  catch { flashLabel(shareBtn, "Failed"); notice("Could not copy the link"); }
});

// Highcharts follows the plot area.
const relayout = new ResizeObserver(() => { window.Highcharts?.charts.forEach((c) => c?.reflow()); });
relayout.observe(els.chart.parentElement);

paint();
// Make the link in the bar exact from the first paint: a `q`-only URL gets the resolved `s` (no new history entry).
if (state.view) history.replaceState(null, "", url());
openFromHash();
// Focus the question box on load, without scrolling. Skip it when the URL hash opens a panel, when focus is already
// elsewhere, and on the home page with an empty box: there the placeholder plays the typing demo, which focus stops.
const home = document.body.dataset.status === "idle" && !els.q.value;
if (!home && !location.hash && (document.activeElement === document.body || !document.activeElement)) {
  els.q.focus({ preventScroll: true });
  els.q.setSelectionRange(els.q.value.length, els.q.value.length);
}
