import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { apiRoutes } from "./api.ts";
import { Db, requireMount } from "./db.ts";
import { pageRoutes } from "./pages.ts";

const buildDir = process.env.STATCAN_BUILD;
if (!buildDir) throw new Error("STATCAN_BUILD must point at a build directory (see BUILD.md)");
const captureDir = process.env.STATCAN_CAPTURE || undefined;
const uuid = process.env.STATCAN_UUID;
if (uuid) {
  requireMount(buildDir, uuid);
  if (captureDir) requireMount(captureDir, uuid);
}

const db = await Db.open(buildDir);
const app = new Hono();
app.route("/api/v1", apiRoutes({ db, captureDir }));
app.route("/", pageRoutes({ db, captureDir }));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error", build_id: db.manifest.build_id }, 500);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" });
console.log(`build ${db.manifest.build_id}: ${db.manifest.inventory.records} inventory records, ${db.manifest.summary.ok ?? 0} queryable tables, listening on ${port}`);
