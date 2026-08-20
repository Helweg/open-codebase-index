import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ParsedCodebaseIndexConfig } from "../../config/schema.js";
import type { HostMode } from "../../config/host.js";
import { MCP_SERVER_CURRENT_NAME } from "../../identity-catalog.js";
import { getPackageVersion } from "../../package-metadata.js";
import { registerMcpPrompts } from "./register-prompts.js";
import { registerMcpTools } from "./register-tools.js";
import { initializeTools } from "../../tools/operations.js";
import {
  attachBackgroundWorkerWatcher,
  type BackgroundWorkerWatcher,
  configureBackgroundWorker,
  getBackgroundWorkerProjectKey,
  isBackgroundWorkerManaged,
  stopBackgroundWorker,
  waitForBackgroundWorkerStart,
} from "../../utils/background-worker.js";
import {
  getProjectSafety,
  startAutoIndexForBackgroundWorker,
  stopAutoIndexForBackgroundWorker,
} from "../../utils/auto-index.js";

const mcpWorkerReferences = new Map<string, number>();

function retainMcpBackgroundWorker(projectRoot: string, host: HostMode): void {
  const key = getBackgroundWorkerProjectKey(projectRoot, host);
  mcpWorkerReferences.set(key, (mcpWorkerReferences.get(key) ?? 0) + 1);
}

async function releaseMcpBackgroundWorker(projectRoot: string, host: HostMode): Promise<void> {
  const key = getBackgroundWorkerProjectKey(projectRoot, host);
  const references = mcpWorkerReferences.get(key) ?? 0;
  if (references > 1) {
    mcpWorkerReferences.set(key, references - 1);
    return;
  }
  mcpWorkerReferences.delete(key);
  await stopBackgroundWorker(projectRoot, host);
}

function getServerInstructions(host: string): string {
  const hostText = `host ${host}`;
  return `This MCP server is the preferred codebase-understanding path for ${hostText}. Start a repository task with index_status when index readiness or freshness is unknown. Use codebase_context as the preferred first entry point because it returns a token-budgeted location pack and routes to definitions or call-graph helpers when symbol intent is present. For code changes with a known or suspected symbol target, optionally call codebase_edit_context as a compact pre-edit step for bounded source plus direct callers and callees before broad file reads. Keep the default tokenBudget for normal discovery, then use implementation_lookup, codebase_search, or a targeted file read only for selected locations that need source content. Use codebase_peek for direct conceptual location lookup. For exact identifiers or exhaustive matches, use grep. After identifying symbols, use call_graph or call_graph_path to trace dependencies. If the index is unavailable, run index_codebase, then retry the retrieval tool.`;
}

interface McpBackgroundWorkerConfiguration {
  managesWorker: boolean;
}

function configureMcpBackgroundWorker(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
  watcherFactory?: (() => BackgroundWorkerWatcher) | null,
  watcherFactoryForConfig?: (
    refreshedConfig: ParsedCodebaseIndexConfig,
  ) => (() => BackgroundWorkerWatcher) | null,
): McpBackgroundWorkerConfiguration {
  if (!getProjectSafety(projectRoot, config).safeToRun) {
    // A joining transport cannot decide the lifecycle of an existing worker.
    // Its owner handles a later unsafe configuration refresh.
    return { managesWorker: false };
  }

  if (isBackgroundWorkerManaged(projectRoot, host)) {
    const key = getBackgroundWorkerProjectKey(projectRoot, host);
    if ((mcpWorkerReferences.get(key) ?? 0) === 0) {
      return { managesWorker: false };
    }
    if (watcherFactory !== undefined) {
      attachBackgroundWorkerWatcher(projectRoot, host, watcherFactory, watcherFactoryForConfig);
    }
    return { managesWorker: true };
  }

  configureBackgroundWorker(projectRoot, host, config, {
    startAutoIndex: (source, allowDisabledAutoIndex) => {
      startAutoIndexForBackgroundWorker(projectRoot, host, source, allowDisabledAutoIndex);
    },
    stopAutoIndex: () => stopAutoIndexForBackgroundWorker(projectRoot, host),
    watcherFactory,
    watcherFactoryForConfig,
  });
  return { managesWorker: true };
}

export function attachMcpBackgroundWatcher(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
  watcherFactory: (() => BackgroundWorkerWatcher) | null,
  watcherFactoryForConfig?: (
    refreshedConfig: ParsedCodebaseIndexConfig,
  ) => (() => BackgroundWorkerWatcher) | null,
): Promise<void> {
  configureMcpBackgroundWorker(projectRoot, config, host, watcherFactory, watcherFactoryForConfig);
  return waitForBackgroundWorkerStart(projectRoot, host);
}

export function createMcpServer(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_CURRENT_NAME,
    version: getPackageVersion(),
  }, {
    instructions: getServerInstructions(host),
  });

  initializeTools(projectRoot, config, host, { preserveManagedWorker: true });
  const backgroundWorker = configureMcpBackgroundWorker(projectRoot, config, host);
  if (backgroundWorker.managesWorker) {
    retainMcpBackgroundWorker(projectRoot, host);
  }

  let stopCoordinationPromise: Promise<void> | null = null;
  const stopCoordination = (): Promise<void> => {
    stopCoordinationPromise ??= backgroundWorker.managesWorker
      ? releaseMcpBackgroundWorker(projectRoot, host)
      : Promise.resolve();
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
    void stopCoordination().catch((error: unknown) => {
      console.error("[codebase-index] Failed to stop MCP background worker after transport close:", error);
    });
  };

  registerMcpTools(server, {
    projectRoot,
    host,
  });

  registerMcpPrompts(server);

  return server;
}
