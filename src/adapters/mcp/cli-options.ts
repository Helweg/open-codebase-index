import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHostMode, type HostMode } from "../../config/host.js";
import { loadConfigFile, loadMergedConfig } from "../../config/merger.js";

export interface CliArgs {
  project: string;
  config?: string;
  host: HostMode;
  mcpIdleTimeout?: number;
}

export function parseArgs(argv: string[]): CliArgs {
  let project = process.cwd();
  let mcpIdleTimeout: number | undefined;
  let config: string | undefined;
  let host: HostMode = "opencode";

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--mcp-idle-timeout") {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--mcp-idle-timeout requires a non-negative integer number of seconds.");
      }
      mcpIdleTimeout = Number(value);
    } else if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config = path.resolve(argv[++i]);
    } else if (argv[i] === "--host" && argv[i + 1]) {
      host = parseHostMode(argv[++i]);
    } else if (argv[i] === "--host") {
      host = parseHostMode(undefined);
    }
  }

  return { project, config, host, ...(mcpIdleTimeout === undefined ? {} : { mcpIdleTimeout }) };
}

export function loadCliRawConfig(args: CliArgs): unknown {
  return args.config ? loadConfigFile(args.config) : loadMergedConfig(args.project, args.host);
}

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath || !moduleUrl) return false;
  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}
