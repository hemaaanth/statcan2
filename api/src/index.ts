import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { apiRoutes } from "./api.ts";
import { openFromEnv } from "./config.ts";
import { pageRoutes } from "./pages.ts";

const { db, captureDir } = await openFromEnv();
const app = new Hono();
// After the handler, so streamed file responses and HTML pages carry the build IDs too.
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Statcan-Build", db.manifest.build_id);
  c.res.headers.set("X-Statcan-Normalized-Build", db.normalized.build_id);
});
app.route("/api/v1", apiRoutes({ db, captureDir }));
app.route("/", pageRoutes({ db, captureDir }));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error", ...db.provenance }, 500);
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
console.log(`build ${db.manifest.build_id}, normalized ${db.normalized.build_id}: ${db.info.size} inventory records, ${db.manifest.summary.ok ?? 0} queryable tables, listening on ${port}`);
