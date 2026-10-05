import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { openFromEnv } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { mcpRoutes } from "../src/mcp_http.ts";
import { mcpTools } from "../src/mcp_tools.ts";

const mounted = existsSync(process.env.STATCAN_BUILD ?? "");
let db: Db;
before(async () => { if (mounted) ({ db } = await openFromEnv()); });
after(() => { if (mounted) db.close(); });

test("remote MCP initializes and lists the same nine tools before planning a chart", { skip: !mounted && "build is not mounted" }, async () => {
  const app = new Hono();
  app.route("/api", mcpRoutes(db));
  const listener = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!listener.listening) await once(listener, "listening");
  const endpoint = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/mcp`);
  const client = new Client({ name: "statcan-http-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), mcpTools.map(({ name }) => name));
    assert.deepEqual(tools.map(({ description }) => description), mcpTools.map(({ description }) => description));
    assert.deepEqual(tools.map(({ inputSchema }) => Object.keys(inputSchema.properties ?? {})), mcpTools.map(({ args }) => args));
    assert.equal(tools.length, 9);
    const response = await client.callTool({ name: "plan_chart", arguments: { q: "food price inflation" } });
    assert.equal(response.isError, undefined);
    assert.ok(response.structuredContent && typeof response.structuredContent === "object" && "status" in response.structuredContent);
    assert.equal(response.structuredContent.status, "ok");
    for (const method of ["GET", "DELETE"]) {
      const rejected = await fetch(endpoint, { method });
      assert.equal(rejected.status, 405);
      const error: unknown = await rejected.json();
      assert.ok(error && typeof error === "object" && "error" in error);
      assert.deepEqual(error.error, { code: -32000, message: "Method not allowed." });
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
