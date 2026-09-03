import type { SharedIndexCodebaseArgs } from "../../tools/contracts.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "../../config/schema.js";
import { parseHostMode, HOST_MODES, type HostMode } from "../../config/host.js";
import { handleEvalCommand } from "../../eval/cli.js";
import { Indexer } from "../../indexer/index.js";
import {
  attachMcpBackgroundWatcher,
  createMcpServer,
  markMcpServerOrderedShutdown,
} from "../../mcp-server.js";
import { loadConfigFile, loadMergedConfig } from "../../config/merger.js";
import { getIndexerForProject } from "../../tools/operations.js";
import { initializeTools } from "../../tools/operation-runtime.js";
import { executeIndexCodebase } from "../../tools/execute-common.js";
import { hasProjectMarker } from "../../utils/files.js";
import { BackgroundWorkerStopError, stopBackgroundWorker } from "../../utils/background-worker.js";
import { isHomeDirectory } from "../../utils/auto-index.js";
import { createWatcherWithIndexer } from "../../watcher/index.js";
import { attachRecentActivity } from "../../tools/visualize/activity.js";
import { generateVisualizationHtml, transformForVisualization } from "../../tools/visualize/index.js";

export interface CliArgs {
  project: string;
  config?: string;
  host: HostMode;
}

export interface CliIndexArgs {
  project: string;
  host: HostMode;
  config?: string;
  force: boolean;
  estimateOnly: boolean;
  dryRun: boolean;
  verbose: boolean;
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

export function parseIndexArgs(argv: string[], cwd: string): CliIndexArgs {
  let project = cwd;
  let host: HostMode = "opencode";
  let config: string | undefined;
  let force = false;
  let estimateOnly = false;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--project" || arg.startsWith("--project=")) {
      const value = arg.startsWith("--project=") ? arg.slice("--project=".length) : next;
      if (!value || (!arg.includes("=") && value.startsWith("--"))) {
        throw new Error("--project requires a value.");
      }
      if (!arg.startsWith("--project=")) {
        i += 1;
      }
      project = path.resolve(cwd, value);
      continue;
    }

    if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg.startsWith("--config=") ? arg.slice("--config=".length) : next;
      if (!value || (!arg.includes("=") && value.startsWith("--"))) {
        throw new Error("--config requires a value.");
      }
      if (!arg.startsWith("--config=")) {
        i += 1;
      }
      config = path.resolve(cwd, value);
      continue;
    }

    if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg.startsWith("--host=") ? arg.slice("--host=".length) : next;
      if (!value || (!arg.includes("=") && value.startsWith("--"))) {
        throw new Error("--host requires a value.");
      }
      if (!arg.startsWith("--host=")) {
        i += 1;
      }
      host = parseHostMode(value);
      continue;
    }

    if (arg === "--force" || arg === "--estimate-only" || arg === "--dry-run" || arg === "--verbose") {
      if (arg === "--force") {
        force = true;
      }
      if (arg === "--estimate-only") {
        estimateOnly = true;
      }
      if (arg === "--dry-run") {
        dryRun = true;
      }
      if (arg === "--verbose") {
        verbose = true;
      }
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error("help-requested");
    }

    throw new Error(`Unknown index option: ${arg}`);
  }

  return { project, host, config, force, estimateOnly, dryRun, verbose };
}

export function loadCliRawConfig(args: CliArgs): unknown {
  return args.config ? loadConfigFile(args.config) : loadMergedConfig(args.project, args.host);
}

export function printUsage(output: (text: string) => void = (text) => console.error(text)): void {
  output(`
Usage:
  ${process.argv[1]} index [options]

Options:
  --project <path>       Project root (default: cwd)
  --host <mode>          opencode, codex, claude, pi, or jcode
  --config <path>        Explicit JSON config path
  --force                Rebuild index even if already up to date
  --estimate-only        Estimate indexing cost only
  --dry-run              Parse only; report the exact embedding token total without indexing
  --verbose              Include detailed final index statistics
  --help                 Show this message

Run '${process.argv[1]} eval' and '${process.argv[1]} visualize' for existing behavior.
Progress and diagnostics are written to stderr. Final index output is written to stdout.`
  );
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
    const config = parseConfig(loadMergedConfig(args.project, "opencode"));
    const indexer = new Indexer(args.project, config, "opencode");
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

export async function runMcpCli(argv: string[]): Promise<void> {
  if (argv[2] === "index") {
    const exitCode = await handleIndexCommand(argv.slice(3), process.cwd());
    process.exit(exitCode);
  }
  if (argv[2] === "eval") {
    const exitCode = await handleEvalCommand(argv.slice(3), process.cwd());
    process.exit(exitCode);
  }
  if (argv[2] === "visualize") {
    const exitCode = await handleVisualizeCommand(argv.slice(3), process.cwd());
    process.exit(exitCode);
  }

  const args = parseArgs(argv);
  const rawConfig = loadCliRawConfig(args);
  const config = parseConfig(rawConfig);

  const server = createMcpServer(args.project, config, args.host);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<number> | undefined;
  const onServerClose = server.server.onclose;

  const shutdown = (): Promise<number> => {
    if (shutdownPromise) return shutdownPromise;
    process.stdin.removeListener("end", requestShutdown);
    process.stdin.removeListener("close", requestShutdown);
    process.removeListener("SIGHUP", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    server.server.onclose = onServerClose;
    const inFlightShutdown = (async (): Promise<number> => {
      let exitCode = 0;
      try {
        await markMcpServerOrderedShutdown(server);
      } catch (error: unknown) {
        exitCode = 1;
        console.error("Failed to persist MCP shutdown diagnostics:", error);
      }
      try {
        await stopBackgroundWorker(args.project, args.host, true);
      } catch (error) {
        exitCode = 1;
        if (error instanceof BackgroundWorkerStopError) {
          if (error.watcherError !== undefined) {
            console.error("Failed to stop MCP file watcher cleanly:", error.watcherError);
          }
          if (error.autoIndexError !== undefined) {
            console.error("Failed to stop automatic indexing cleanly:", error.autoIndexError);
          }
        } else {
          console.error("Failed to stop automatic indexing cleanly:", error);
        }
      }
      try {
        await server.close();
      } catch (error) {
        exitCode = 1;
        console.error("Failed to close MCP server cleanly:", error);
      }
      return exitCode;
    })();
    shutdownPromise = inFlightShutdown;
    return inFlightShutdown;
  };

  const requestShutdown = (): void => {
    void shutdown().then((exitCode) => process.exit(exitCode));
  };

  server.server.onclose = () => {
    try {
      onServerClose?.();
    } finally {
      requestShutdown();
    }
  };

  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  process.once("SIGINT", requestShutdown);
  if (process.platform !== "win32") {
    process.once("SIGHUP", requestShutdown);
    process.once("SIGTERM", requestShutdown);
  }

  const isHomeDir = isHomeDirectory(args.project);
  const isValidProject = !isHomeDir && (!config.indexing.requireProjectMarker || hasProjectMarker(args.project));

  const watcherFactoryForConfig = (refreshedConfig: typeof config) => (
    refreshedConfig.indexing.watchFiles
      && !isHomeDirectory(args.project)
      && (!refreshedConfig.indexing.requireProjectMarker || hasProjectMarker(args.project))
      ? () => createWatcherWithIndexer(
        () => getIndexerForProject(args.project, args.host),
        args.project,
        refreshedConfig,
        args.host,
        args.config ? { configPath: args.config } : {},
      )
      : null
  );
  try {
    await server.connect(transport);
    if (shutdownPromise) return;

    await attachMcpBackgroundWatcher(
      args.project,
      config,
      args.host,
      config.indexing.watchFiles && isValidProject ? watcherFactoryForConfig(config) : null,
      watcherFactoryForConfig,
    );
    if (shutdownPromise) return;
  } catch (error: unknown) {
    await shutdown();
    throw error;
  }
}

interface CliIndexCommandDeps {
  runIndex?: (
    projectRoot: string | undefined,
    host: HostMode,
    args: SharedIndexCodebaseArgs,
    onProgress?: (title: string, metadata: Record<string, unknown>) => void,
  ) => Promise<{ text: string; isError?: boolean }>;
  initializeRuntimeForConfig?: (projectRoot: string, parsedConfig: ReturnType<typeof parseConfig>, host: HostMode) => void;
  readCliConfigFile?: (filePath: string) => unknown;
  printStdout?: (text: string) => void;
  printStderr?: (text: string) => void;
}

function printIndexProgress(onProgress: (text: string) => void, title: string, metadata: Record<string, unknown>): void {
  const details = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${isSensitiveKey(key) ? "[REDACTED]" : String(value)}`)
    .join(" ");
  onProgress(details.length === 0 ? title : `${title} ${details}`);
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[-_]?key|token|password|secret|authorization)/i.test(key);
}

export function redactSensitiveText(text: string): string {
  return text.replace(
    /((?:api[-_]?key|token|password|secret|authorization)\s*[=:]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
}

export async function handleIndexCommand(
  argv: string[],
  cwd: string,
  deps: CliIndexCommandDeps = {},
): Promise<number> {
  const runIndex = deps.runIndex ?? executeIndexCodebase;
  const initializeRuntimeForConfig = deps.initializeRuntimeForConfig ?? initializeTools;
  const readCliConfigFile = deps.readCliConfigFile ?? loadConfigFile;
  const printStdout = deps.printStdout ?? ((text) => console.log(text));
  const printStderr = deps.printStderr ?? ((text) => console.error(redactSensitiveText(text)));

  let parsedArgs: CliIndexArgs;
  try {
    parsedArgs = parseIndexArgs(argv, cwd);
  } catch (error) {
    if (error instanceof Error && error.message === "help-requested") {
      printUsage(printStderr);
      return 0;
    }
    printStderr(error instanceof Error ? error.message : String(error));
    printUsage(printStderr);
    return 1;
  }

  try {
    if (parsedArgs.config !== undefined) {
      const rawConfig = readCliConfigFile(parsedArgs.config);
      if (rawConfig === null) {
        throw new Error(`Config file not found: ${parsedArgs.config}`);
      }
      initializeRuntimeForConfig(parsedArgs.project, parseConfig(rawConfig), parsedArgs.host);
    }

    const indexArgs: SharedIndexCodebaseArgs = {
      force: parsedArgs.force,
      estimateOnly: parsedArgs.estimateOnly,
      dryRun: parsedArgs.dryRun,
      verbose: parsedArgs.verbose,
    };

    const result = await runIndex(parsedArgs.project, parsedArgs.host, indexArgs, (title, metadata) => {
      printIndexProgress(printStderr, title, metadata);
    });

    if (result.isError) {
      printStderr(result.text);
      return 1;
    }

    printStdout(result.text);
    return 0;
  } catch (error) {
    printStderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function handleMainError(error: unknown): never {
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
