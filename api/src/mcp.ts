import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openFromEnv } from "./config.ts";
import { createMcpServer } from "./mcp_tools.ts";

// stdout belongs to the MCP protocol. Anything else goes to stderr.
const { db } = await openFromEnv();
await createMcpServer(db).connect(new StdioServerTransport());
console.error(`statcan MCP server: build ${db.manifest.build_id}, normalized ${db.normalized.build_id}, code sets ${db.codeSets.sha256.slice(0, 12)}, on stdio`);
