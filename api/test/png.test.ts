import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { mcpRoutes } from "../src/mcp_http.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chartRoutes } from "../src/chart_api.ts";
import { createMcpServer, mcpTools } from "../src/mcp_tools.ts";
import { renderPng, closePngRenderer, RenderBusy } from "../src/png.ts";
import { openapi } from "../src/openapi.ts";
import type { Db } from "../src/db.ts";
import type { ViewResult } from "../src/spec.ts";

// Published /api/v1/view response, including its spec, sources and build IDs.
const view = JSON.parse(await readFile(new URL("./fixtures/sharing-view.json", import.meta.url), "utf8")) as ViewResult;
after(closePngRenderer);
const db = { provenance: { build_id: "local", normalized_build_id: "local" }, manifest: { build_id: "local" }, one: async () => undefined, parquetPath: () => undefined } as unknown as Db;
function assertPng(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 3200);
  assert.equal(bytes.readUInt32BE(20), 1800);
}

test("sharing PNG preserves screenshot size, caches per build and respects hidden series", async () => {
  const first = await renderPng(view);
  assertPng(first.bytes);
  assert.ok(first.bytes.length > 10_000);
  assert.strictEqual(await renderPng(view), first);
  assert.notStrictEqual(await renderPng({ ...view, normalized_build_id: "next-build" }), first);
  const hidden = await renderPng({ ...view, spec: { ...view.spec, chart: { ...view.spec.chart, hidden: [view.series[0].key] } }, series: view.series.map((s) => ({ ...s, hidden: true })) });
  assertPng(hidden.bytes);
  assert.notEqual(hidden.etag, first.etag);
  for (const type of ["area", "bar", "stacked_bar", "stacked_bar_100", "stacked_area"] as const) {
    const result = await renderPng({ ...view, spec: { ...view.spec, chart: { type } } });
    assertPng(result.bytes);
    assert.notEqual(result.etag, first.etag, `${type} must render its own chart`);
  }
});

test("category bars and unpublished selections render their real data and gap notes", async () => {
  for (const name of ["category-view", "missing-view"]) {
    const fixture = JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ViewResult;
    const result = await renderPng(fixture);
    assertPng(result.bytes);
    assert.notEqual(result.etag, (await renderPng(view)).etag);
  }
});

test("renderer rejects excess work instead of growing an unbounded queue", async () => {
  const results = await Promise.allSettled([1, 2, 3].map((i) => renderPng({ ...view, spec: { ...view.spec, title: `Concurrency ${i}` } })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof RenderBusy);
});

test("PNG API rejects invalid specs and unknown tables instead of returning a generic OG card", async () => {
  const app = chartRoutes({ db });
  assert.equal((await app.request("/view.png?s=invalid")).status, 400);
  assert.equal((await app.request("/view.png", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 400);
  assert.equal((await app.request("/view.png", { method: "POST", body: JSON.stringify(view.spec), headers: { "Content-Type": "application/json" } })).status, 404);
  const oversized = await app.request("/view.png", { method: "POST", body: " ".repeat(65 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Object.keys(openapi.paths["/view.png"]), ["get", "post"]);
});

test("MCP delegates to the PNG API and returns image content, URLs and the API build IDs", async () => {
  const png = await renderPng(view);
  let fail = false;
  const server = createMcpServer(db, async (spec) => {
    assert.deepEqual(spec, view.spec);
    if (fail) return Response.json({ error: "busy" }, { status: 503 });
    return new Response(png.bytes as unknown as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "image/png", "X-Statcan-Build": view.build_id, "X-Statcan-Normalized-Build": view.normalized_build_id } });
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "png-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), mcpTools.map((t) => t.name));
    assert.deepEqual(tools.map((t) => t.description), mcpTools.map((t) => t.description));
    const result = await client.callTool({ name: "render_chart", arguments: { spec: view.spec } });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent?.build_id, view.build_id);
    assert.match(String(result.structuredContent?.url), /\/api\/v1\/view.png\?s=/);
    const content = result.content as { type: string; data?: string }[];
    assertPng(Buffer.from(content.find((c) => c.type === "image")!.data!, "base64"));
    fail = true;
    assert.equal((await client.callTool({ name: "render_chart", arguments: { spec: view.spec } })).isError, true);
  } finally { await client.close(); await server.close(); }
});


test("remote MCP returns sharing images through stateless Streamable HTTP", async () => {
  const png = await renderPng(view);
  const app = new Hono();
  app.route("/api", mcpRoutes(db, async () => new Response(png.bytes as unknown as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": "image/png", "X-Statcan-Build": view.build_id, "X-Statcan-Normalized-Build": view.normalized_build_id },
  })));
  const listener = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!listener.listening) await once(listener, "listening");
  const client = new Client({ name: "png-http-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/mcp`)));
    const result = await client.callTool({ name: "render_chart", arguments: { spec: view.spec } });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent?.build_id, view.build_id);
    assert.ok((result.content as { type: string }[]).some((part) => part.type === "image"));
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
