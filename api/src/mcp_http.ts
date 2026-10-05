import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Db } from "./db.ts";
import { createMcpServer } from "./mcp_tools.ts";

/** Each POST owns its server and transport; no session or build state is stored per client. */
export function mcpRoutes(db: Db) {
  const api = new Hono();
  api.post("/mcp", async (c) => {
    const server = createMcpServer(db);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  // The SDK's stateless example does not open a GET event stream or retain DELETE sessions.
  api.on(["GET", "DELETE"], "/mcp", (c) => c.json({
    jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
  }, 405));
  return api;
}
