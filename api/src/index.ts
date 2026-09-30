import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { apiRoutes } from "./api.ts";
import { openFromEnv } from "./config.ts";
import { pageRoutes } from "./pages.ts";

const { db, captureDir } = await openFromEnv();
const app = new Hono();
app.route("/api/v1", apiRoutes({ db, captureDir }));
app.route("/", pageRoutes({ db, captureDir }));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error", build_id: db.manifest.build_id }, 500);
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
console.log(`build ${db.manifest.build_id}: ${db.manifest.inventory.records} inventory records, ${db.manifest.summary.ok ?? 0} queryable tables, listening on ${port}`);
