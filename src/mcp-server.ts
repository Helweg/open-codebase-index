import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";

import type { ParsedCodebaseIndexConfig } from "./config/schema.js";
import type { HostMode } from "./config/host.js";
import { registerMcpPrompts } from "./mcp-server/register-prompts.js";
import { registerMcpTools } from "./mcp-server/register-tools.js";
import { initializeTools } from "./tools/operations.js";

function getServerInstructions(host: string): string {
  const hostText = `host ${host}`;
  return `This MCP server helps navigate indexed code for ${hostText}. For best results, verify freshness with index_status first if you suspect stale results. Start discovery with codebase_peek for conceptual matches, then call implementation_lookup for concrete definitions. Use codebase_search for semantic content matches and grep for exact/exhaustive string matches. After you have symbol names, use call_graph and call_graph_path to trace dependencies.`;
}

function getPackageVersion(): string {
  const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as unknown;
  if (raw && typeof raw === "object" && "version" in raw && typeof raw.version === "string") {
    return raw.version;
  }

  return "0.0.0";
}

export function createMcpServer(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode = "opencode",
): McpServer {
  const server = new McpServer({
    name: "opencode-codebase-index",
    version: getPackageVersion(),
  }, {
    instructions: getServerInstructions(host),
  });

  initializeTools(projectRoot, config, host);

  registerMcpTools(server, {
    projectRoot,
    host,
  });

  registerMcpPrompts(server);

  return server;
}
