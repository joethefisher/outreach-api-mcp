#!/usr/bin/env node
// outreach-api-mcp — MCP server for the Outreach v2 REST API (stdio transport).
//
// Tool registrations land here once the api/, auth/, and tools/ modules are
// in place. This file is currently a placeholder so the build pipeline can
// validate end-to-end before code lands on top.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "outreach-api-mcp",
  version: "0.1.0",
});

const transport = new StdioServerTransport();
await server.connect(transport);
