// Chart builder sidebar. It edits state.spec (the spec as written, roles and childrenOf kept) and hands every edit to onSpec.
import { isHorizontal } from "./chart.js";
import { METHOD_WORD, TRANSFORMS, esc, seriesName, seriesShades, swatch } from "./render.js";

const PRESETS = [["latest", "Latest"], ["1Y", "1Y"], ["2Y", "2Y"], ["5Y", "5Y"], ["10Y", "10Y"], ["20Y", "20Y"], ["max", "Max"]];
const BARS = new Set(["bar", "stacked_bar", "stacked_bar_100"]);
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
// Same form as spec.ts index_base: YYYY, YYYY-MM, YYYY-Qn or YYYY-MM-DD.
const INDEX_BASE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|-Q[1-4])?$/;
const MAX_LAYERS = 4;
const MAX_TREE = 200; // rows rendered per dimension; the filter searches every member, so a 63,404-member geography stays fast
const NOTHING = { not: { all: true } }; // `in` needs 1+ ids; this resolves to none (all members moved into groups)

const ICON = {
  line: "M1 12 5 7l3 3 6-7", area: "M1 13V9l4-4 3 3 6-6v11z", bar: "M2 13V7h3v6M7 13V3h3v10M12 13V9h3v4",
  stacked_bar: "M2 13V8h3v5M2 8V5h3v3M7 13V7h3v6M7 7V3h3v4M12 13V10h3v3M12 10V7h3v3",
  stacked_bar_100: "M2 13V2h3v11M2 7h3M7 13V2h3v11M7 9h3M12 13V2h3v11M12 5h3", stacked_area: "M1 13V10l5-3 4 2 5-5v9zM1 10l5-5 4 2 5-5",
};
const CHART_NAMES = { line: "Line", area: "Area", bar: "Bars", stacked_bar: "Stacked bars", stacked_bar_100: "Stacked bars, 100%", stacked_area: "Stacked area" };

const cubes = new Map();
/** GET /api/v1/cubes/:pid, cached for the page (the build is immutable). */
export function cube(pid) {
  if (!cubes.has(pid)) {
    const p = fetch(`/api/v1/cubes/${pid}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(`table ${pid}: ${r.status}`)));
    p.catch(() => cubes.delete(pid));
    cubes.set(pid, p);
  }
  return cubes.get(pid);
}

/** GET /api/v1/regions, once per page, into REGIONS (region_id → { label, kind, pts: Set of PT codes }). */
let regionsLoad;
const REGIONS = new Map();
function regions() {
  regionsLoad ??= fetch("/api/v1/regions").then((r) => r.ok ? r.json() : { regions: [] }).then((j) => {
    for (const r of j.regions) REGIONS.set(r.region_id, { label: r.label, kind: r.kind, pts: new Set(r.members) });
  }).catch(() => {});
  return regionsLoad;
}

/** MemberSel → member ids in member order. Mirrors view.ts resolve(), so the tree shows what the server will use. */
export function resolveSel(dim, sel) {
  const ms = dim.members;
  const ref = (r) => ms.filter((m) => typeof r === "number" ? m.id === r : m.label.toLowerCase() === String(r).toLowerCase()).map((m) => m.id);
  const set = (s) => {
    if ("eq" in s) return new Set(ref(s.eq));
    if ("in" in s) return new Set(s.in.flatMap(ref));
    if ("role" in s) return new Set(ms.filter((m) => m.roles.includes(s.role)).map((m) => m.id));
    // A region: the members whose PT code is in the region, as view.ts matches them.
    if ("region" in s) { const pts = REGIONS.get(s.region)?.pts ?? new Set(); return new Set(ms.filter((m) => m.geo_code && pts.has(m.geo_code)).map((m) => m.id)); }
    if ("contains" in s) return new Set(ms.filter((m) => m.label.toLowerCase().includes(s.contains.toLowerCase())).map((m) => m.id));
    if ("all" in s) return new Set(ms.map((m) => m.id));
    if ("childrenOf" in s) { const p = new Set(ref(s.childrenOf)); return new Set(ms.filter((m) => p.has(m.parent_id)).map((m) => m.id)); }
    if ("descendantsOf" in s) {
      const roots = ref(s.descendantsOf), found = new Set(roots);
      for (let size = -1; size !== found.size;) { size = found.size; for (const m of ms) if (m.parent_id != null && found.has(m.parent_id)) found.add(m.id); }
      roots.forEach((id) => found.delete(id));
      return found;
    }
    if ("any" in s) return new Set(s.any.flatMap((x) => [...set(x)]));
    if ("and" in s) { const [a, ...rest] = s.and.map(set); return new Set([...a].filter((id) => rest.every((r) => r.has(id)))); }
    const out = set(s.not);
    return new Set(ms.filter((m) => !out.has(m.id)).map((m) => m.id));
  };
  const ids = set(sel);
  return ms.filter((m) => ids.has(m.id)).map((m) => m.id);
}

/** Quick sets offered for a dimension, built from member roles. */
function quickSets(dim) {
  const has = (role) => dim.members.some((m) => m.roles.includes(role));
  const out = [];
  if (has("province")) out.push(["All provinces", { role: "province" }]);
  if (has("territory")) out.push(["Territories", { role: "territory" }]);
  if (has("province") && has("territory")) out.push(["Provinces + territories", { any: [{ role: "province" }, { role: "territory" }] }]);
  for (const t of dim.members.filter((m) => m.roles.includes("total")).slice(0, 3)) out.push([`Children of ${t.label}`, { childrenOf: t.id }]);
  out.push(["All", { all: true }]);
  return out;
}

/**
 * The shortest MemberSel for a set of ids: a quick set or a childrenOf when one matches the set exactly, else {in}.
 * `{in}` keeps the order given (the order members were picked), so the selected list reads as chosen.
 */
function compress(dim, ids) {
  if (!ids.length) return NOTHING;
  const key = (list) => [...list].sort((a, b) => a - b).join(",");
  const want = key(ids);
  for (const [, sel] of quickSets(dim)) if (key(resolveSel(dim, sel)) === want) return sel;
  const parent = dim.members.find((m) => m.id === ids[0])?.parent_id;
  if (parent != null && key(resolveSel(dim, { childrenOf: parent })) === want) return { childrenOf: parent };
  return { in: ids };
}

const dimSel = (layer, cubeDim) => layer.dims[String(cubeDim.id)] ?? { use: "fixed", members: { eq: cubeDim.default_member_id } };

export function initBuilder({ el, getState, onSpec }) {
  const open = new Set(); // details keys that are open
  const filters = new Map(); // dim key → filter text
  let cubeTimer, cubeCtrl, cubeHits = [], cubeQ = "", rendering = 0, filterTimer;

  const edit = (fn) => {
    const spec = structuredClone(getState().spec);
    fn(spec);
    onSpec(spec);
    render();
  };

  async function render() {
    const { spec, view, plan } = getState();
    if (!spec) { el.innerHTML = head() + `<p class="muted b-pad">Type a question first.</p>`; return; }
    const id = ++rendering;
    let infos;
    try { infos = await Promise.all([regions(), ...spec.layers.map((l) => cube(l.pid))]); infos.shift(); }
    catch (e) { if (id === rendering) el.innerHTML = head() + `<p class="warn-line b-pad">${esc(e.message)}</p>`; return; }
    if (id !== rendering) return;
    const scroll = el.scrollTop, focus = document.activeElement?.dataset?.fk, caret = document.activeElement?.selectionStart;
    el.innerHTML = head() + chartSection(spec, view) + timeSection(spec, view) + transformSection(spec) + seriesSection(view) +
      layersSection(spec, infos) + stepsSection(plan);
    el.scrollTop = scroll;
    if (focus) {
      const f = el.querySelector(`[data-fk="${CSS.escape(focus)}"]`);
      if (f) { f.focus({ preventScroll: true }); if (caret != null && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch {} }
    }
  }

  const head = () => `<div class="b-head"><h2 id="builder-title" tabindex="-1">Chart builder</h2><button type="button" class="icon-btn" data-act="close" aria-label="Close chart builder">×</button></div>`;
  const section = (title, body, extra = "") => `<section class="b-sec"><h3>${title}${extra}</h3>${body}</section>`;
  const details = (key, summary, body) => `<details data-key="${esc(key)}" ${open.has(key) ? "open" : ""}><summary>${summary}</summary>${body}</details>`;

  function chartSection(spec, view) {
    const c = spec.chart;
    const isBar = BARS.has(c.type), hasX = view?.x.kind === "category" || spec.layers.some((l) => Object.values(l.dims).some((d) => d.use === "x"));
    return section("Chart", `<div class="type-btns" role="group" aria-label="Chart type">${Object.keys(ICON).map((t) =>
      `<button type="button" data-act="type" data-v="${t}" aria-pressed="${c.type === t}" title="${CHART_NAMES[t]}" aria-label="${CHART_NAMES[t]}"><svg viewBox="0 0 16 15" aria-hidden="true"><path d="${ICON[t]}"/></svg></button>`).join("")}</div>
      ${isBar ? `<div class="b-fields">
        <label class="b-check"><input type="checkbox" data-act="horizontal" ${view && isHorizontal(view) ? "checked" : ""}> Horizontal</label>
        ${hasX ? `<label class="b-field"><span>Sort</span><select data-act="sort">${[["none", "As published"], ["desc", "Largest first"], ["asc", "Smallest first"]].map(([v, l]) => `<option value="${v}" ${(c.sort ?? "none") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
      </div>` : ""}`);
  }

  function timeSection(spec, view) {
    const t = spec.time ?? {};
    const custom = t.from || t.to;
    const preset = custom ? "" : t.preset ?? "max";
    // From / To (and At, for x-category charts) in equal columns under the presets, labels above.
    const field = (act, label, value, placeholder) => `<label class="b-field"><span>${label}</span><input data-act="${act}" data-fk="${act}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}" inputmode="numeric" autocomplete="off"></label>`;
    const at = view?.x.kind === "category";
    return section("Time", `<div class="seg" role="group" aria-label="Time window">${PRESETS.map(([v, l]) => `<button type="button" data-act="preset" data-v="${v}" aria-pressed="${preset === v}">${l}</button>`).join("")}</div>
      <div class="b-fields${at ? " three" : ""}">${field("from", "From", t.from, view?.period.from?.slice(0, 7) ?? "2015")}${field("to", "To", t.to, view?.period.to?.slice(0, 7) ?? "2026")}${at ? field("at", "At", t.at, view.x.at.slice(0, 7)) : ""}</div>
      <p class="hint">YYYY, YYYY-MM or YYYY-MM-DD. From and To override the preset.</p>`);
  }

  /**
   * Transform select; for "Index = 100 at", a base field under it. Empty base = the first published point of each
   * series in the window; a period (2015, 2015-06, 2015-Q2) = the first published point inside it. Writes index_base.
   */
  function transformSection(spec) {
    const sel = `<select data-act="transform" aria-label="Transform">${TRANSFORMS.map(([v, l]) => `<option value="${v}" ${spec.transform === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const base = spec.transform === "index_first" ? `<div class="b-fields one"><label class="b-field"><span>Index = 100 at</span><input data-act="index-base" data-fk="index-base" value="${esc(spec.index_base ?? "")}" placeholder="First point" inputmode="numeric" autocomplete="off" aria-describedby="index-base-hint"></label></div>
      <p class="hint" id="index-base-hint">YYYY, YYYY-MM, YYYY-Qn or YYYY-MM-DD. Empty: the first published point.</p>` : "";
    return section("Transform", sel + base);
  }

  function seriesSection(view) {
    if (!view?.series.length) return "";
    // Legend order; a group that was not combined is one family, coloured by its first member (cycling it recolours them all).
    const shades = seriesShades(view);
    const order = view.series.map((s, i) => [s, shades[i]]).sort((a, b) => a[1].rank - b[1].rank);
    return section("Series", `<ul class="series-list">${order.map(([s, sh]) => {
      const name = seriesName(s);
      const sw = sh.pct < 100
        ? `<span class="sw-btn is-shade" title="A shade of the group's colour">${swatch(sh)}</span>`
        : `<button type="button" class="sw-btn" data-act="color" data-key="${esc(s.key)}" data-color="${s.color}" aria-label="Colour of ${esc(name)}: slot ${s.color + 1}, change">${swatch(sh)}</button>`;
      return `<li class="${s.hidden ? "is-hidden" : ""}">${sw}
      <button type="button" class="eye" data-act="hide" data-key="${esc(s.key)}" aria-pressed="${s.hidden}" aria-label="${s.hidden ? "Show" : "Hide"} ${esc(name)}">${s.hidden ? "Show" : "Hide"}</button>
      <span class="s-name">${esc(name)}</span></li>`;
    }).join("")}</ul>`, `<span class="count">${view.series.length}</span>`);
  }

  function layersSection(spec, infos) {
    const blocks = spec.layers.map((layer, i) => {
      const info = infos[i];
      return `<div class="layer"><div class="layer-head"><span class="mono">${esc(info.table_number)}</span><b>${esc(info.title)}</b>
        ${spec.layers.length > 1 ? `<button type="button" class="link-btn" data-act="remove-layer" data-layer="${i}" aria-label="Remove ${esc(info.table_number)}">Remove</button>` : ""}</div>
        ${info.dimensions.map((d) => dimBlock(layer, i, d)).join("")}</div>`;
    }).join("");
    const full = spec.layers.length >= MAX_LAYERS;
    const pids = new Set(spec.layers.map((l) => l.pid));
    const adder = full ? `<p class="hint">At most ${MAX_LAYERS} tables in one chart.</p>` : `<div class="add-table"><input type="search" data-act="cube-q" data-fk="cube-q" value="${esc(cubeQ)}" placeholder="Add table: search titles" aria-label="Add table: search titles">
      <ul class="cube-hits">${cubeHits.filter((h) => !pids.has(h.pid)).map((h) => `<li><button type="button" data-act="add-layer" data-pid="${esc(h.pid)}"><span class="mono">${esc(h.table_number)}</span> ${esc(h.title)}</button></li>`).join("")}</ul></div>`;
    return section("Tables", blocks + adder, `<span class="count">${spec.layers.length}</span>`);
  }

  function dimBlock(layer, li, d) {
    const key = `${li}:${d.id}`;
    const sel = dimSel(layer, d);
    const ids = resolveSel(d, sel.members);
    const checked = new Set(ids);
    const fixed = sel.use === "fixed";
    const label = (id) => d.members.find((m) => m.id === id)?.label ?? `#${id}`;
    const summaryText = fixed ? label(ids[0]) : `${ids.length} selected${sel.groups?.length ? ` + ${sel.groups.length} group${sel.groups.length > 1 ? "s" : ""}` : ""}`;
    if (!open.has(key) && !open.has(`seen:${key}`)) { open.add(`seen:${key}`); if (!fixed) open.add(key); }
    const rows = treeRows(d, key, li, fixed, checked, selOrder(d, sel.members, ids));
    const groups = sel.use === "series" || sel.use === "x" ? groupsBlock(layer, li, d, sel) : "";
    return details(key, `<span class="dim-name">${esc(d.name)}</span><span class="dim-sum">${esc(sel.use)} · ${esc(summaryText)}</span>`, `<div class="dim-body">
      <label class="b-field"><span>Use</span><select data-act="use" data-layer="${li}" data-dim="${d.id}">${[["fixed", "Fixed (one member)"], ["series", "Series"], ["x", "X axis categories"], ["sum", "Sum"]].map(([v, l]) => `<option value="${v}" ${sel.use === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${fixed ? "" : `<div class="quick">${quickSets(d).map(([l, s]) => `<button type="button" class="chip" data-act="quick" data-layer="${li}" data-dim="${d.id}" data-sel="${esc(JSON.stringify(s))}">${esc(l)}</button>`).join("")}<button type="button" class="chip" data-act="quick" data-layer="${li}" data-dim="${d.id}" data-sel="${esc(JSON.stringify(NOTHING))}">None</button></div>`}
      ${d.members.length > 8 ? `<input type="search" class="m-filter" data-fk="f-${key}" data-key="${key}" data-layer="${li}" data-dim="${d.id}" value="${esc(filters.get(key) ?? "")}" placeholder="Search ${d.members.length.toLocaleString("en-CA")} members" aria-label="Search ${esc(d.name)} members">` : ""}
      <ul class="tree" data-key="${key}">${rows}</ul>
      ${groups}</div>`);
  }

  const AGGS = [["auto", "Auto"], ["published", "Published"], ["sum", "Sum"], ["ratio", "Ratio"]];
  const regionOf = (g) => g.region ?? g.members?.region;

  /**
   * Groups on a series / x dimension. Region chips (geography only: regions with a member in this table, never a
   * physiographic one, never one already grouped), then one row per group: its name (editable), the method the last
   * view used, an Auto / Published / Sum / Ratio override and Remove, with its members under it. Last, a custom group
   * from the checked members.
   */
  function groupsBlock(layer, li, d, sel) {
    const view = getState().view;
    const at = `data-layer="${li}" data-dim="${d.id}"`;
    const used = new Set((sel.groups ?? []).map(regionOf).filter(Boolean));
    const chips = d.role === "geography" ? regionChips(d, used, at) : "";
    const rows = (sel.groups ?? []).map((g, gi) => {
      const ids = resolveSel(d, g.members);
      const note = view?.group_notes?.find((n) => n.pid === layer.pid && n.label === g.label);
      const tag = note ? METHOD_WORD[note.method] : view && !ids.length ? "not in table" : "";
      const names = ids.map((id) => d.members.find((m) => m.id === id)?.label ?? `#${id}`);
      return `<div class="group-row">
        <div class="g-top"><input class="g-label" data-act="g-rename" ${at} data-g="${gi}" data-fk="gl-${li}:${d.id}:${gi}" value="${esc(g.label)}" maxlength="80" aria-label="Group name">
          ${tag ? `<span class="m-tag m-${esc(note?.method ?? "missing")}" title="How the last chart made this group">${esc(tag)}</span>` : ""}
          <select data-act="g-agg" ${at} data-g="${gi}" aria-label="How to combine ${esc(g.label)}">${AGGS.map(([v, l]) => `<option value="${v}" ${(g.agg ?? "auto") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <button type="button" class="link-btn" data-act="ungroup" ${at} data-g="${gi}" aria-label="Remove group ${esc(g.label)}">Remove</button></div>
        <div class="g-members" title="${esc(names.join(", "))}">${ids.length} · ${esc(names.join(", ") || "no member in this table")}</div></div>`;
    }).join("");
    return `<div class="groups"><div class="g-head">Groups${sel.groups?.length ? ` <span class="count">${sel.groups.length}</span>` : ""}</div>${chips || ""}${rows}
      <div class="b-row"><input data-fk="g-${li}:${d.id}" class="g-name" placeholder="Group name" maxlength="80" aria-label="Name for a group of the checked members"><button type="button" class="btn" data-act="group" ${at}>Group checked</button></div></div>`;
  }

  function regionChips(d, used, at) {
    const list = [];
    for (const [id, r] of REGIONS) {
      if (r.kind === "physiographic" || used.has(id) || !r.pts.size) continue;
      const n = resolveSel(d, { region: id }).length;
      if (n) list.push(`<button type="button" class="chip" data-act="g-region" ${at} data-region="${esc(id)}" title="${esc(`${r.label}: ${n} of ${r.pts.size} in this table`)}">${esc(r.label)}</button>`);
    }
    return list.length ? `<div class="quick g-regions" role="group" aria-label="Add a region group">${list.join("")}</div>` : "";
  }

  function stepsSection(plan) {
    if (!plan?.steps?.length) return "";
    return `<section class="b-sec">${details("steps", "How this was chosen", `<ol class="steps">${plan.steps.map((s) => `<li><span class="mono quiet">${esc(s.question)}</span><span>${esc(s.answer)}</span><span class="mono quiet">${s.confidence == null ? "" : `${Math.round(s.confidence * 100)}%`} ${esc(s.source)}</span></li>`).join("")}</ol>
      <p class="hint">Planner: ${esc(plan.planner)} · ${plan.ms} ms</p>`)}</section>`;
  }

  /** Member index per dimension: lower-case labels and id → member, built once (the cube is cached). */
  const indexes = new WeakMap();
  const indexOf = (d) => {
    let ix = indexes.get(d);
    if (!ix) { ix = { lower: d.members.map((m) => m.label.toLowerCase()), byId: new Map(d.members.map((m) => [m.id, m])) }; indexes.set(d, ix); }
    return ix;
  };

  /**
   * At most MAX_TREE rows. With search text: the members that match, in member order, flat. Without: the checked
   * members first as a flat list in the order they were picked (so the selection is always visible), then the rest of
   * the master checklist in tree order, indented by depth.
   */
  function treeRows(d, key, li, fixed, checked, picked = [...checked]) {
    const text = (filters.get(key) ?? "").trim().toLowerCase();
    const { lower, byId } = indexOf(d);
    const shown = text ? [] : picked.map((id) => byId.get(id)).filter(Boolean).slice(0, MAX_TREE);
    const nSel = shown.length;
    const seen = new Set(shown.map((m) => m.id));
    let total = text ? 0 : d.members.length;
    for (let i = 0; i < d.members.length && (text || shown.length < MAX_TREE); i++) {
      if (text && !lower[i].includes(text)) continue;
      if (text) total++;
      if (shown.length < MAX_TREE && !seen.has(d.members[i].id)) shown.push(d.members[i]);
    }
    // Search rows lose their tree context, so name the parent (several places share a name).
    const row = (m, i) => {
      const sel = i < nSel, cls = [sel ? "is-sel" : "", sel && i === nSel - 1 && shown.length > nSel ? "sel-end" : ""].filter(Boolean).join(" ");
      return `<li${cls ? ` class="${cls}"` : ""} style="--d:${text || sel ? 0 : Math.min(m.depth, 8)}"><label><input type="${fixed ? "radio" : "checkbox"}" name="m-${key}" data-act="member" data-layer="${li}" data-dim="${d.id}" value="${m.id}" ${checked.has(m.id) ? "checked" : ""}> <span>${esc(m.label)}${text && m.parent_id != null ? `<span class="m-parent"> · ${esc(byId.get(m.parent_id)?.label ?? "")}</span>` : ""}</span></label></li>`;
    };
    const rest = total - shown.length;
    const more = rest > 0 ? `<li class="tree-more">${rest.toLocaleString("en-CA")} more ${text ? "matches; type more to narrow" : "members; search to find them"}</li>` : "";
    return shown.length ? shown.map(row).join("") + more : `<li class="tree-more">No member matches “${esc(text)}”.</li>`;
  }

  /** Checked ids in the order they were picked: an `{in: [...]}` keeps its own order; any other selection, member order. */
  function selOrder(d, members, ids) {
    if (!members || !("in" in members)) return ids;
    const set = new Set(ids), out = [];
    for (const r of members.in) for (const id of resolveSel(d, { in: [r] })) if (set.has(id) && !out.includes(id)) out.push(id);
    return [...out, ...ids.filter((id) => !out.includes(id))];
  }

  // Re-render only this dimension's list, so typing in the filter never rebuilds the sidebar.
  async function applyFilter(input) {
    filters.set(input.dataset.key, input.value);
    const li = Number(input.dataset.layer), dimId = Number(input.dataset.dim);
    const layer = getState().spec.layers[li];
    const d = (await cube(layer.pid)).dimensions.find((x) => x.id === dimId);
    const sel = dimSel(layer, d);
    const ul = el.querySelector(`.tree[data-key="${CSS.escape(input.dataset.key)}"]`);
    if (ul) ul.innerHTML = treeRows(d, input.dataset.key, li, sel.use === "fixed", new Set(resolveSel(d, sel.members)), selOrder(d, sel.members, resolveSel(d, sel.members)));
  }

  async function setDim(target, fn) {
    const li = Number(target.dataset.layer), dimId = Number(target.dataset.dim);
    const info = await cube(getState().spec.layers[li].pid);
    const d = info.dimensions.find((x) => x.id === dimId);
    edit((spec) => {
      const layer = spec.layers[li];
      const cur = structuredClone(dimSel(layer, d));
      layer.dims[String(d.id)] = fn(cur, d, spec) ?? cur;
    });
  }

  el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT" || t.tagName === "INPUT") return;
    const act = t.dataset.act;
    if (act === "close") return el.dispatchEvent(new CustomEvent("builder-close", { bubbles: true }));
    if (act === "type") return edit((s) => {
      s.chart.type = t.dataset.v;
      if (!BARS.has(s.chart.type)) { delete s.chart.horizontal; delete s.chart.sort; }
      // x categories need bars: turn an x dimension back into series when leaving bars.
      if (!BARS.has(s.chart.type)) for (const l of s.layers) for (const d of Object.values(l.dims)) if (d.use === "x") d.use = "series";
    });
    if (act === "preset") return edit((s) => { s.time = { preset: t.dataset.v, ...(s.time?.at ? { at: s.time.at } : {}) }; });
    if (act === "color") return edit((s) => { s.chart.colors = { ...s.chart.colors, [t.dataset.key]: (Number(t.dataset.color) + 1) % 10 }; });
    if (act === "hide") return edit((s) => {
      const h = new Set(s.chart.hidden ?? []);
      h.has(t.dataset.key) ? h.delete(t.dataset.key) : h.add(t.dataset.key);
      s.chart.hidden = [...h];
      if (!s.chart.hidden.length) delete s.chart.hidden;
    });
    if (act === "remove-layer") return edit((s) => { s.layers.splice(Number(t.dataset.layer), 1); });
    if (act === "add-layer") {
      const r = await fetch(`/api/v1/cubes/${t.dataset.pid}/views`);
      if (!r.ok) return;
      const layer = (await r.json()).views?.[0]?.spec.layers[0];
      if (!layer) return;
      cubeQ = ""; cubeHits = [];
      return edit((s) => { if (s.layers.length < MAX_LAYERS) s.layers.push(layer); });
    }
    if (act === "quick") return setDim(t, (cur) => { cur.members = JSON.parse(t.dataset.sel); });
    if (act === "ungroup") return setDim(t, (cur, d) => {
      const [g] = cur.groups.splice(Number(t.dataset.g), 1);
      if (!cur.groups.length) delete cur.groups;
      cur.members = compress(d, [...new Set([...resolveSel(d, cur.members), ...resolveSel(d, g.members)])].sort((a, b) => a - b));
    });
    if (act === "group") {
      const name = t.parentElement.querySelector(".g-name").value.trim();
      if (!name) return t.parentElement.querySelector(".g-name").focus();
      return setDim(t, (cur, d) => {
        const ids = resolveSel(d, cur.members);
        if (ids.length < 2) return;
        cur.groups = [...(cur.groups ?? []).filter((g) => g.label !== name), { label: name, members: compress(d, ids) }];
        cur.members = NOTHING; // grouped members are shown only as the group
      });
    }
    // A region chip: a group of that region's members (kept as {region}, so the spec says what it means). Members that
    // were checked one by one move into it, as with a custom group; Remove gives them back.
    if (act === "g-region") return setDim(t, (cur, d) => {
      const id = t.dataset.region, r = REGIONS.get(id);
      if (!r || (cur.groups?.length ?? 0) >= MAX_GROUPS) return;
      const inRegion = new Set(resolveSel(d, { region: id }));
      cur.groups = [...(cur.groups ?? []), { label: uniqueLabel(cur.groups, r.label), members: { region: id }, region: id }];
      cur.members = compress(d, resolveSel(d, cur.members).filter((m) => !inRegion.has(m)));
    });
  });

  const MAX_GROUPS = 20;
  const uniqueLabel = (groups = [], label) => {
    const taken = new Set(groups.map((g) => g.label));
    let out = label;
    for (let n = 2; taken.has(out); n++) out = `${label} ${n}`;
    return out;
  };
  /** Series keys name a group by its label (`1=g:Prairies`, `1=g:Prairies:18`); carry colours and hidden flags across a rename. */
  const renameKeys = (spec, li, dimId, from, to) => {
    const re = new RegExp(`^(L${li}:(?:.*,)?${dimId}=g:)${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[:,])`);
    const move = (k) => k.replace(re, `$1${to}`);
    if (spec.chart.colors) spec.chart.colors = Object.fromEntries(Object.entries(spec.chart.colors).map(([k, v]) => [move(k), v]));
    if (spec.chart.hidden) spec.chart.hidden = spec.chart.hidden.map(move);
  };

  el.addEventListener("change", (e) => {
    const t = e.target, act = t.dataset.act;
    if (act === "g-rename") {
      const cur = getState().spec.layers[Number(t.dataset.layer)]?.dims[t.dataset.dim]?.groups?.[Number(t.dataset.g)];
      if (!cur || !t.value.trim() || t.value.trim() === cur.label) { t.value = cur?.label ?? ""; return; }
    }
    if (act === "g-rename") return setDim(t, (cur, d, spec) => {
      const g = cur.groups?.[Number(t.dataset.g)], name = t.value.trim();
      if (!g || !name || name === g.label) { t.value = g?.label ?? ""; return; }
      const label = uniqueLabel(cur.groups.filter((x) => x !== g), name);
      renameKeys(spec, Number(t.dataset.layer), d.id, g.label, label);
      g.label = label;
    });
    if (act === "g-agg") return setDim(t, (cur) => {
      const g = cur.groups?.[Number(t.dataset.g)];
      if (!g) return;
      t.value === "auto" ? delete g.agg : g.agg = t.value;
    });
    // Explicit true/false: the chart turns horizontal by itself at MANY_CATEGORIES, so unchecking must be able to force vertical.
    if (act === "horizontal") return edit((s) => { s.chart.horizontal = t.checked; });
    if (act === "sort") return edit((s) => { t.value === "none" ? delete s.chart.sort : s.chart.sort = t.value; });
    // index_base applies only to index_first; leaving that transform drops it so the spec stays honest.
    if (act === "transform") return edit((s) => { s.transform = t.value; if (t.value !== "index_first") delete s.index_base; });
    if (act === "index-base") {
      const v = t.value.trim();
      if (v && !INDEX_BASE.test(v)) { t.setCustomValidity("Use YYYY, YYYY-MM, YYYY-Qn or YYYY-MM-DD"); t.reportValidity(); return; }
      t.setCustomValidity("");
      return edit((s) => { v ? s.index_base = v : delete s.index_base; });
    }
    if (act === "from" || act === "to" || act === "at") {
      const v = t.value.trim();
      if (v && !DATE.test(v)) { t.setCustomValidity("Use YYYY, YYYY-MM or YYYY-MM-DD"); t.reportValidity(); return; }
      t.setCustomValidity("");
      return edit((s) => { s.time = { ...s.time }; v ? s.time[act] = v : delete s.time[act]; });
    }
    if (act === "use") return setDim(t, (cur, d, spec) => {
      const ids = resolveSel(d, cur.members);
      const use = t.value;
      if (use === "fixed") return { use, members: { eq: ids[0] ?? d.default_member_id } };
      if (cur.use === "fixed") {
        const kids = d.members.some((m) => m.parent_id === ids[0]);
        cur.members = kids ? { childrenOf: ids[0] } : { in: ids };
      }
      cur.use = use;
      if (use === "sum") delete cur.groups;
      if (use === "x") {
        // One x dimension per view, and x needs bars.
        for (const l of spec.layers) for (const [k, other] of Object.entries(l.dims)) if (other.use === "x" && !(l === spec.layers[Number(t.dataset.layer)] && k === String(d.id))) other.use = "series";
        if (!BARS.has(spec.chart.type)) spec.chart.type = "bar";
      }
    });
    if (act === "member") return setDim(t, (cur, d) => {
      if (cur.use === "fixed") return { use: "fixed", members: { eq: Number(t.value) } };
      // Keep the order members were picked in (new picks go last), so the flat selected list reads as chosen.
      const picked = selOrder(d, cur.members, resolveSel(d, cur.members)).filter((id) => id !== Number(t.value));
      if (t.checked) picked.push(Number(t.value));
      cur.members = compress(d, picked);
    });
  });

  el.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("m-filter")) { clearTimeout(filterTimer); filterTimer = setTimeout(() => applyFilter(t), 120); return; }
    if (t.dataset.act !== "cube-q") return;
    cubeQ = t.value;
    clearTimeout(cubeTimer);
    cubeTimer = setTimeout(async () => {
      cubeCtrl?.abort();
      cubeCtrl = new AbortController();
      if (!cubeQ.trim()) { cubeHits = []; return render(); }
      try {
        const r = await fetch(`/api/v1/cubes?q=${encodeURIComponent(cubeQ)}&limit=8`, { signal: cubeCtrl.signal });
        cubeHits = r.ok ? (await r.json()).results : [];
        render();
      } catch (err) { if (err.name !== "AbortError") throw err; }
    }, 250);
  });

  el.addEventListener("toggle", (e) => {
    const k = e.target.dataset?.key;
    if (k) e.target.open ? open.add(k) : open.delete(k);
  }, true);

  return { render };
}
