import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ParsedCodebaseIndexConfig } from "../../config/schema.js";
import type { HostMode } from "../../config/host.js";
import { getPackageVersion } from "../../package-metadata.js";
import { registerMcpPrompts } from "./register-prompts.js";
import { registerMcpTools } from "./register-tools.js";
import { initializeTools } from "../../tools/operations.js";
import { startAutoIndex, stopAutoIndex } from "../../utils/auto-index.js";

function getServerInstructions(host: string): string {
  const hostText = `host ${host}`;
  return `This MCP server is the preferred codebase-understanding path for ${hostText}. Start a repository task with index_status when index readiness or freshness is unknown. Use codebase_context as the preferred first entry point because it returns a token-budgeted location pack and routes to definitions or call-graph helpers when symbol intent is present. Keep the default tokenBudget for normal discovery, then use implementation_lookup, codebase_search, or a targeted file read only for selected locations that need source content. Use codebase_peek for direct conceptual location lookup. For exact identifiers or exhaustive matches, use grep. After identifying symbols, use call_graph or call_graph_path to trace dependencies. If the index is unavailable, run index_codebase, then retry the retrieval tool.`;
}

export function createMcpServer(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): McpServer {
  const server = new McpServer({
    name: "opencode-codebase-index",
    version: getPackageVersion(),
  }, {
    instructions: getServerInstructions(host),
  });

  initializeTools(projectRoot, config, host);
  startAutoIndex(projectRoot, host, "startup");

  let stopCoordinationPromise: Promise<void> | null = null;
  const stopCoordination = (): Promise<void> => {
    stopCoordinationPromise ??= stopAutoIndex(projectRoot, host);
    return stopCoordinationPromise;
  };
  const closeProtocol = server.server.close.bind(server.server);
  server.server.close = async (): Promise<void> => {
    await stopCoordination();
    await closeProtocol();
  };
  const closeServer = server.close.bind(server);
  server.close = async (): Promise<void> => {
    await stopCoordination();
    await closeServer();
  };
  const onServerClose = server.server.onclose;
  server.server.onclose = () => {
    onServerClose?.();
    void stopCoordination();
  };

  registerMcpTools(server, {
    projectRoot,
    host,
  });

  registerMcpPrompts(server);

  return server;
}
