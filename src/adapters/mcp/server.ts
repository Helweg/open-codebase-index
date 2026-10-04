import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ParsedCodebaseIndexConfig } from "../../config/schema.js";
import type { HostMode } from "../../config/host.js";
import { resolveProjectIndexPath } from "../../config/paths.js";
import { MCP_SERVER_CURRENT_NAME } from "../../identity-catalog.js";
import { getPackageVersion } from "../../package-metadata.js";
import { getRuntimeConfigForProject } from "../../tools/operation-runtime.js";
import { registerMcpPrompts } from "./register-prompts.js";
import { registerMcpTools } from "./register-tools.js";
import { McpRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { initializeTools } from "../../tools/operations.js";
import {
  attachBackgroundWorkerWatcher,
  type BackgroundWorkerWatcher,
  configureBackgroundWorker,
  getBackgroundWorkerProjectKey,
  isBackgroundWorkerManaged,
  isBackgroundWorkerStopping,
  requestBackgroundWorker,
  stopBackgroundWorker,
  waitForBackgroundWorkerStart,
} from "../../utils/background-worker.js";
import {
  getProjectSafety,
  startAutoIndexForBackgroundWorker,
  stopAutoIndexForBackgroundWorker,
} from "../../utils/auto-index.js";

const mcpWorkerReferences = new Map<string, number>();
const mcpWorkerTeardowns = new Map<string, Promise<void>>();
const mcpOrderedShutdownMarkers = new WeakMap<McpServer, () => Promise<void>>();

export function markMcpServerOrderedShutdown(server: McpServer): Promise<void> {
  return mcpOrderedShutdownMarkers.get(server)?.() ?? Promise.resolve();
}

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
  const teardown = stopBackgroundWorker(projectRoot, host);
  mcpWorkerTeardowns.set(key, teardown);
  try {
    await teardown;
  } finally {
    if (mcpWorkerTeardowns.get(key) === teardown) {
      mcpWorkerTeardowns.delete(key);
    }
  }
}

function getServerInstructions(host: string): string {
  const hostText = `host ${host}`;
  return `This MCP server is the preferred codebase-understanding path for ${hostText}. Check index_status when index readiness or freshness is unknown. Use codebase_context only when repository orientation is needed (layout, relevant symbols, or cross-file intent), not mechanically before every task or search. Request a compact first pass (tokenBudget: 600, limit: 5) and inspect returned evidence before broad reads or searches. Use implementation_lookup directly for known definitions and call_graph or call_graph_path directly for relationships once endpoints are identified. For a change with a known or suspected symbol, optionally use codebase_edit_context for bounded target source plus direct callers and callees. Use codebase_peek for metadata-only semantic locations, codebase_search when matching source content is needed, targeted file reads for known paths, and grep for exact or exhaustive literal matches. Do not repeat retrieval or broad reads when existing evidence already answers the question.`;
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
    if ((mcpWorkerReferences.get(key) ?? 0) === 0 && !mcpWorkerTeardowns.has(key)) {
      return { managesWorker: false };
    }
    if (watcherFactory !== undefined) {
      attachBackgroundWorkerWatcher(projectRoot, host, watcherFactory, watcherFactoryForConfig);
    }
    if (mcpWorkerTeardowns.has(key) || isBackgroundWorkerStopping(projectRoot, host)) {
      requestBackgroundWorker(projectRoot, host);
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
  const diagnostics = new McpRuntimeDiagnostics(() => resolveProjectIndexPath(
    projectRoot,
    getRuntimeConfigForProject(projectRoot, host).scope,
    host,
  ));
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
  const markOrderedShutdown = (): Promise<void> => diagnostics.markOrderedShutdown();
  mcpOrderedShutdownMarkers.set(server, markOrderedShutdown);
  const closeProtocol = server.server.close.bind(server.server);
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= (async (): Promise<void> => {
      const preparationResults = await Promise.allSettled([
        markOrderedShutdown(),
        stopCoordination(),
      ]);
      let protocolError: unknown;
      try {
        await closeProtocol();
      } catch (error: unknown) {
        protocolError = error;
      }
      const errors = preparationResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as unknown);
      if (protocolError !== undefined) errors.push(protocolError);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to close the MCP server cleanly.");
    })();
    return closePromise;
  };
  server.server.close = close;
  server.close = close;
  const onServerClose = server.server.onclose;
  server.server.onclose = () => {
    onServerClose?.();
    void Promise.allSettled([markOrderedShutdown(), stopCoordination()]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[codebase-index] Failed to stop MCP background worker after transport close:", result.reason);
        }
      }
    });
  };

  registerMcpTools(server, {
    projectRoot,
    host,
    diagnostics,
  });

  registerMcpPrompts(server);

  return server;
}
