#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { parseHostMode, HOST_MODES, type HostMode } from "./config/host.js";
import { handleEvalCommand } from "./eval/cli.js";
import { Indexer } from "./indexer/index.js";
import { createMcpServer } from "./mcp-server.js";
import { loadConfigFile, loadMergedConfig } from "./config/merger.js";
import { getIndexerForProject } from "./tools/operations.js";
import { hasProjectMarker } from "./utils/files.js";
import { startAutoIndex } from "./utils/auto-index.js";
import { createWatcherWithIndexer, type CombinedWatcher } from "./watcher/index.js";
import { attachRecentActivity } from "./tools/visualize/activity.js";
import { generateVisualizationHtml, transformForVisualization } from "./tools/visualize/index.js";

export interface CliArgs {
  project: string;
  config?: string;
  host: HostMode;
}

interface VisualizeArgs {
  directory?: string;
  includeOrphans: boolean;
  maxNodes: number;
  project: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let project = process.cwd();
  let config: string | undefined;
  let host: HostMode = "opencode";

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config = path.resolve(argv[++i]);
    } else if (argv[i] === "--host" && argv[i + 1]) {
      host = parseHostMode(argv[++i]);
    } else if (argv[i] === "--host") {
      host = parseHostMode(undefined);
    }
  }

  return { project, config, host };
}

export function loadCliRawConfig(args: CliArgs): unknown {
  return args.config ? loadConfigFile(args.config) : loadMergedConfig(args.project, args.host);
}

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}

function parseVisualizeArgs(argv: string[], cwd: string): VisualizeArgs {
  let project = cwd;
  let directory: string | undefined;
  let includeOrphans = false;
  let maxNodes = 5000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (arg === "--max" && argv[i + 1]) {
      maxNodes = Number(argv[++i]);
    } else if (arg.startsWith("--max=") || arg.startsWith("max=")) {
      maxNodes = Number(arg.split("=")[1]);
    } else if (arg === "--orphans" || arg === "orphans" || arg === "--include-orphans" || arg === "include-orphans") {
      includeOrphans = true;
    } else if (!arg.startsWith("-") && directory === undefined) {
      directory = arg;
    }
  }

  if (!Number.isFinite(maxNodes) || maxNodes < 1) {
    throw new Error("max must be a positive number");
  }

  return { directory, includeOrphans, maxNodes, project };
}

async function handleVisualizeCommand(argv: string[], cwd: string): Promise<number> {
  try {
    const args = parseVisualizeArgs(argv, cwd);
    const config = parseConfig(loadMergedConfig(args.project));
    const indexer = new Indexer(args.project, config);
    const rawData = await indexer.getVisualizationData({
      directory: args.directory,
    });

    if (rawData.symbols.length === 0) {
      console.error("No call graph data found. Run /index in OpenCode first, then retry npm run visualize.");
      return 1;
    }

    const vizData = attachRecentActivity(transformForVisualization(rawData.symbols, rawData.edges, {
      includeOrphans: args.includeOrphans,
      directory: args.directory,
      maxNodes: args.maxNodes,
    }), args.project);

    if (vizData.nodes.length === 0) {
      console.error("No connected symbols found. Retry with: npm run visualize -- orphans");
      return 1;
    }

    const outputPath = path.join(os.tmpdir(), `call-graph-${Date.now()}.html`);
    writeFileSync(outputPath, generateVisualizationHtml(vizData), "utf-8");
    console.log(`Temporal call graph visualization generated: ${outputPath}`);
    console.log(`Nodes: ${vizData.nodes.length} | Edges: ${vizData.edges.length}`);
    console.log(`Recent change lenses: ${vizData.changes?.length ?? 0}`);
    if (vizData.metadata.truncated) {
      console.log(`Graph truncated to ${args.maxNodes} most-connected nodes.`);
    }
    return 0;
  } catch {
    console.error("Failed to generate visualization. Check the project, config, and arguments, then retry.");
    return 1;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const exitCode = await handleEvalCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
  }
  if (process.argv[2] === "visualize") {
    const exitCode = await handleVisualizeCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
  }

  const args = parseArgs(process.argv);
  const rawConfig = loadCliRawConfig(args);
  const config = parseConfig(rawConfig);

  const server = createMcpServer(args.project, config, args.host);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  let watcher: CombinedWatcher | null = null;
  const isHomeDir = path.resolve(args.project) === path.resolve(os.homedir());
  const isValidProject = !isHomeDir && (!config.indexing.requireProjectMarker || hasProjectMarker(args.project));

  if (config.indexing.autoIndex && isValidProject) {
    const indexer = getIndexerForProject(args.project, args.host);
    startAutoIndex(indexer, args.project);
  }

  if (config.indexing.watchFiles && isValidProject) {
    watcher = createWatcherWithIndexer(
      () => getIndexerForProject(args.project, args.host),
      args.project,
      config,
      args.host,
      args.config ? { configPath: args.config } : {},
    );
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await watcher?.stop();
      await server.close();
      process.exit(0);
    } catch (error) {
      console.error("Failed to stop MCP server cleanly:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

function handleMainError(error: unknown): never {
  if (error instanceof Error && error.message.startsWith("Invalid host mode")) {
    console.error(`Invalid host mode. Allowed values: ${HOST_MODES.join(", ")}.`);
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error("Failed to start MCP server. Check config and network.");
    process.exit(1);
  }

  console.error("Fatal: failed to start MCP server");
  process.exit(1);
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main().catch(handleMainError);
}
