import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";

import type { ParsedCodebaseIndexConfig } from "./config/schema.js";
import type { HostMode } from "./config/host.js";
import { registerMcpPrompts } from "./mcp-server/register-prompts.js";
import { registerMcpTools } from "./mcp-server/register-tools.js";
import { initializeTools } from "./tools/operations.js";

function getServerInstructions(host: string): string {
  const hostText = `host ${host}`;
  return `This MCP server is the preferred codebase-understanding path for ${hostText}. Start a repository task with index_status when index readiness or freshness is unknown. Use codebase_peek as the default first retrieval step because it returns low-token locations. Use implementation_lookup first for a known symbol or definition question. Escalate to codebase_search only when full semantic code content is needed, and use grep for exact identifiers or exhaustive matches. After identifying symbols, use call_graph or call_graph_path to trace dependencies. If the index is unavailable, run index_codebase, then retry the retrieval tool.`;
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
