import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { HostMode } from "../config/host.js";

import { parseHostMode } from "../config/host.js";
import { loadConfigFile } from "../config/merger.js";
import { parseConfig } from "../config/schema.js";
import {
  executeCallGraph,
  executeImplementationLookup,
  executeIndexStatus,
} from "../tools/execute-common.js";
import { initializeTools } from "../tools/operation-runtime.js";
import { searchCodebase } from "../tools/operations.js";
import { formatSearchResults } from "../tools/utils.js";
import { handleIndexCommand } from "./mcp/cli.js";

type TextSink = (text: string) => void;
type Result = { text: string; isError?: boolean };
type GraphDirection = "callers" | "callees";

export interface CbiDeps {
  runIndex?: typeof handleIndexCommand;
  runStatus?: (projectRoot: string | undefined, host: HostMode) => Promise<Result>;
  runDefinition?: (projectRoot: string | undefined, host: HostMode, query: string) => Promise<Result>;
  runSearch?: (projectRoot: string | undefined, host: HostMode, query: string, limit: number) => Promise<Result>;
  runCallGraph?: (
    projectRoot: string | undefined,
    host: HostMode,
    symbol: string,
    direction: GraphDirection,
    filePath?: string,
  ) => Promise<Result>;
  initializeRuntimeForConfig?: (projectRoot: string, config: ReturnType<typeof parseConfig>, host: HostMode) => void;
  readConfigFile?: (filePath: string) => unknown;
  printStdout?: TextSink;
  printStderr?: TextSink;
}

export interface CbiCommandArgs {
  project: string;
  host: HostMode;
  config?: string;
  limit: number;
  filePath?: string;
  positionals: string[];
}

function printUsage(output: TextSink): void {
  output(`Usage: cbi <command> [options]

Commands:
  status                          Show index status
  index [options]                 Create or refresh the index
  search <query> [--limit <n>]    Full-content semantic search
  definition <symbol>             Find authoritative definitions
  graph <callers|callees> <symbol> Inspect direct call-graph edges

Global options:
  --project <path>  Project root, default: current directory
  --host <mode>     opencode, codex, claude, pi, or jcode
  --config <path>   Explicit JSON config path
  --help            Show this message
`);
}

function printCommandUsage(output: TextSink, command: string): void {
  const usage: Record<string, string> = {
    status: "Usage: cbi status [--project <path>] [--host <mode>] [--config <path>]",
    index: "Usage: cbi index [--project <path>] [--host <mode>] [--config <path>] [--force] [--estimate-only] [--dry-run] [--verbose]",
    search: "Usage: cbi search <query> [--limit <n>] [--project <path>] [--host <mode>] [--config <path>]",
    definition: "Usage: cbi definition <symbol> [--project <path>] [--host <mode>] [--config <path>]",
    graph: "Usage: cbi graph <callers|callees> <symbol> [--file <path>] [--project <path>] [--host <mode>] [--config <path>]",
  };
  output(usage[command] ?? "Usage: cbi <command> [options]");
}

function optionValue(args: string[], index: number, name: string): { value: string; consumed: number } {
  const arg = args[index];
  const equalsPrefix = `--${name}=`;
  if (arg.startsWith(equalsPrefix)) return { value: arg.slice(equalsPrefix.length), consumed: 0 };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value.`);
  return { value, consumed: 1 };
}

export function parseCbiCommandArgs(command: string, args: string[], cwd: string): CbiCommandArgs {
  let project = cwd;
  let host: HostMode = "opencode";
  let config: string | undefined;
  let limit = 5;
  let filePath: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error("help-requested");

    if (arg === "--project" || arg.startsWith("--project=")) {
      const parsed = optionValue(args, index, "project");
      project = path.resolve(cwd, parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = optionValue(args, index, "host");
      host = parseHostMode(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const parsed = optionValue(args, index, "config");
      config = path.resolve(cwd, parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (command === "search" && (arg === "--limit" || arg.startsWith("--limit="))) {
      const parsed = optionValue(args, index, "limit");
      limit = Number(parsed.value);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
      index += parsed.consumed;
      continue;
    }
    if (command === "graph" && (arg === "--file" || arg.startsWith("--file="))) {
      const parsed = optionValue(args, index, "file");
      filePath = path.resolve(cwd, parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return { project, host, config, limit, filePath, positionals };
}

async function initializeFromConfig(args: CbiCommandArgs, deps: CbiDeps): Promise<void> {
  if (!args.config) return;
  const rawConfig = (deps.readConfigFile ?? loadConfigFile)(args.config);
  if (rawConfig === null) throw new Error(`Config file not found: ${args.config}`);
  (deps.initializeRuntimeForConfig ?? initializeTools)(args.project, parseConfig(rawConfig), args.host);
}

const defaultSearch = async (projectRoot: string | undefined, host: HostMode, query: string, limit: number): Promise<Result> => {
  const results = await searchCodebase(projectRoot, host, query, { limit });
  return results.length === 0
    ? { text: "No matching code found. Try a different query or run `cbi index` first." }
    : { text: `Found ${results.length} results for "${query}":\n\n${formatSearchResults(results, "score")}` };
};

function requirePositionals(args: CbiCommandArgs, command: string, count: number): string[] {
  if (args.positionals.length !== count) {
    throw new Error(`${command} requires ${count === 1 ? "exactly one argument" : "a direction and a symbol"}.`);
  }
  return args.positionals;
}

export async function runCbiCli(argv: string[], cwd: string, deps: CbiDeps = {}): Promise<number> {
  const stdout = deps.printStdout ?? ((text) => console.log(text));
  const stderr = deps.printStderr ?? ((text) => console.error(text));
  const command = argv[2];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage(stdout);
    return 0;
  }

  if (!["status", "index", "search", "definition", "graph"].includes(command)) {
    stderr(`Unknown command: ${command}`);
    printUsage(stderr);
    return 1;
  }

  try {
    if (command === "index") {
      return await (deps.runIndex ?? handleIndexCommand)(argv.slice(3), cwd, {
        printStdout: stdout,
        printStderr: stderr,
      });
    }

    const args = parseCbiCommandArgs(command, argv.slice(3), cwd);
    await initializeFromConfig(args, deps);

    if (command === "status") {
      requirePositionals(args, command, 0);
      const result = await (deps.runStatus ?? executeIndexStatus)(args.project, args.host);
      if (result.isError) { stderr(result.text); return 1; }
      stdout(result.text);
      return 0;
    }
    if (command === "search") {
      const [query] = requirePositionals(args, command, 1);
      const result = await (deps.runSearch ?? defaultSearch)(args.project, args.host, query, args.limit);
      if (result.isError) { stderr(result.text); return 1; }
      stdout(result.text);
      return 0;
    }
    if (command === "definition") {
      const [query] = requirePositionals(args, command, 1);
      const result = await (deps.runDefinition ?? ((root, hostMode, symbol) =>
        executeImplementationLookup(root, hostMode, { query: symbol, limit: 5 })))(args.project, args.host, query);
      if (result.isError) { stderr(result.text); return 1; }
      stdout(result.text);
      return 0;
    }

    const [direction, symbol] = requirePositionals(args, command, 2);
    if (direction !== "callers" && direction !== "callees") throw new Error("graph direction must be callers or callees.");
    const result = await (deps.runCallGraph ?? ((root, hostMode, name, graphDirection, file) =>
      executeCallGraph(root, hostMode, { name, direction: graphDirection, filePath: file })))(args.project, args.host, symbol, direction, args.filePath);
    if (result.isError) { stderr(result.text); return 1; }
    stdout(result.text);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === "help-requested") {
      printCommandUsage(stderr, command);
      return 0;
    }
    stderr(error instanceof Error ? error.message : String(error));
    printCommandUsage(stderr, command);
    return 1;
  }
}

export function isCbiEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}
