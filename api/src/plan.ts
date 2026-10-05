import { Hono } from "hono";
import type { Db } from "./db.ts";
import { planQuery } from "./planner.ts";

export function planRoutes({ db }: { db: Db }) {
  return new Hono().get("/plan", async (c) => {
    const start = performance.now();
    const q = c.req.query("q") ?? "";
    try {
      const plan = await planQuery(db, q, { view: c.req.query("view") === "1", signal: c.req.raw.signal });
      console.log(`plan ${plan.status} ${Math.round(performance.now() - start)}ms`);
      return c.json(plan);
    } catch (error) {
      if (c.req.raw.signal.aborted) throw error;
      console.log(`plan no_match ${Math.round(performance.now() - start)}ms`);
      return c.json({ status: "no_match", q, alternatives: [], steps: [], planner: "heuristic",
        ms: Math.round(performance.now() - start), build_id: db.manifest.build_id, normalized_build_id: db.normalized.build_id });
    }
  });
}
