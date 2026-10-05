// The search placeholder's typing demo. The home page and the document pages (API, MCP) share it.

/**
 * Queries the search placeholder types, one at a time. They show off breadth: change, an index
 * with a base year, groups, stacked bars, time windows, comparisons. The planner thread owns the final list
 * (home-index-design.md §5); keep it in this one array.
 */
export const DEMO_QUERIES = [
  "cost of living by province, past 10 years",
  "gas vs. food inflation, ontario, rate of change",
  "population vs inflation since 2018 indexed to 2015",
  "unemployment rate, provinces vs. territories",
  "population growth, prairies vs. atlantic, since 2000",
  "employment in goods producing vs service producing industries by province as stacked bars",
  "rent inflation Toronto vs Montreal",
  "real gdp, year-over-year change, past 20 years",
  "deaths by cause in ontario",
  "average weekly earnings by industry",
];

/**
 * The placeholder types a query a character at a time, holds it, deletes it, and types the next. It runs only while
 * the box is empty, not focused, and `canRun()` says yes: focus or any keystroke stops it (the real placeholder
 * returns); leaving an empty box starts it again. With prefers-reduced-motion it shows whole queries, one every 3 s.
 * Tab or → in an empty box calls `take` with the query shown at that moment.
 */
export function typingDemo(input, { canRun = () => true, take }) {
  const PLACEHOLDER = input.placeholder;
  let timer = 0, i = 0, shown = "", on = false;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const TYPE = 55, ERASE = 22, HOLD = 1800, GAP = 450;
  const set = (t) => { shown = t; input.placeholder = t || " "; };
  const step = (q, n, dir) => {
    if (!on) return;
    if (still.matches) { set(q); timer = setTimeout(() => step(DEMO_QUERIES[i = (i + 1) % DEMO_QUERIES.length], 0, 1), 3000); return; }
    set(q.slice(0, n));
    if (dir > 0 && n < q.length) timer = setTimeout(() => step(q, n + 1, 1), TYPE);
    else if (dir > 0) timer = setTimeout(() => step(q, n - 1, -1), HOLD);
    else if (n > 0) timer = setTimeout(() => step(q, n - 1, -1), ERASE);
    else timer = setTimeout(() => step(DEMO_QUERIES[i = (i + 1) % DEMO_QUERIES.length], 1, 1), GAP);
  };
  const demo = {
    start() {
      if (on || !canRun() || input.value || document.activeElement === input) return;
      on = true;
      step(DEMO_QUERIES[i], still.matches ? 0 : 1, 1);
    },
    stop() { on = false; clearTimeout(timer); shown = ""; input.placeholder = PLACEHOLDER; },
    /** The query on show (whole, even mid-typing), or "" when the demo is off. */
    current() { return on || shown ? DEMO_QUERIES[i] : ""; },
  };
  // The demo stops on focus, so read the query on show before it stops.
  let onFocus = "";
  input.addEventListener("pointerdown", () => { onFocus = demo.current(); });
  input.addEventListener("focus", () => { onFocus ||= demo.current(); demo.stop(); });
  input.addEventListener("blur", () => { onFocus = ""; if (!input.value) setTimeout(() => demo.start(), 300); });
  input.addEventListener("keydown", (e) => {
    if (!input.value && onFocus && (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey))) {
      e.preventDefault();
      const q = onFocus;
      onFocus = "";
      take(q);
      return;
    }
    if (e.key.length === 1 || e.key === "Backspace") onFocus = "";
  });
  return demo;
}
