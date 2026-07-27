import * as childProcess from "child_process";

export type MacOsPowerSource = "ac" | "battery" | "unknown";

export interface BackgroundIndexingPolicy {
  readonly recheckDelayMs: number;
  isPaused(): Promise<boolean>;
}

type PowerSourceReader = () => Promise<MacOsPowerSource>;
type CommandRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<string>;

interface BackgroundIndexingPolicyOptions {
  platform?: NodeJS.Platform;
  readPowerSource?: PowerSourceReader;
  recheckDelayMs?: number;
}

const POWER_SOURCE_RECHECK_DELAY_MS = 60_000;
const PMSET_TIMEOUT_MS = 5_000;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(
  file: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      { encoding: "utf8", timeout: options.timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function parseMacOsPowerSource(output: string): MacOsPowerSource {
  const match = output.match(/Now drawing from '([^']+)'/i);
  if (!match) {
    return "unknown";
  }

  const source = match[1].toLowerCase();
  if (source === "battery power") {
    return "battery";
  }
  if (source === "ac power") {
    return "ac";
  }
  return "unknown";
}

export async function readMacOsPowerSource(
  commandRunner: CommandRunner = runCommand,
): Promise<MacOsPowerSource> {
  const output = await commandRunner(
    "/usr/bin/pmset",
    ["-g", "batt"],
    { timeoutMs: PMSET_TIMEOUT_MS },
  );
  return parseMacOsPowerSource(output);
}

class MacOsBackgroundIndexingPolicy implements BackgroundIndexingPolicy {
  private lastPaused: boolean | null = null;
  private reportedFailure = false;

  constructor(
    private readonly readPowerSource: PowerSourceReader,
    readonly recheckDelayMs: number,
  ) {}

  isPaused(): Promise<boolean> {
    return this.checkPowerSource();
  }

  private async checkPowerSource(): Promise<boolean> {
    try {
      const source = await this.readPowerSource();
      if (source === "unknown") {
        throw new Error("pmset returned an unrecognized power source");
      }

      this.reportedFailure = false;
      const paused = source === "battery";
      if (paused && this.lastPaused !== true) {
        console.warn("[codebase-index] Background indexing paused while macOS is using battery power.");
      } else if (!paused && this.lastPaused === true) {
        console.warn("[codebase-index] AC power detected; resuming pending background indexing.");
      }
      this.lastPaused = paused;
      return paused;
    } catch (error) {
      if (!this.reportedFailure) {
        console.error(
          `[codebase-index] Failed to determine the macOS power source; background indexing will continue: ${getErrorMessage(error)}`,
        );
        this.reportedFailure = true;
      }
      this.lastPaused = false;
      return false;
    }
  }
}

export function createBackgroundIndexingPolicy(
  pauseOnBattery: boolean,
  options: BackgroundIndexingPolicyOptions = {},
): BackgroundIndexingPolicy | null {
  const platform = options.platform ?? process.platform;
  if (!pauseOnBattery || platform !== "darwin") {
    return null;
  }

  return new MacOsBackgroundIndexingPolicy(
    options.readPowerSource ?? readMacOsPowerSource,
    options.recheckDelayMs ?? POWER_SOURCE_RECHECK_DELAY_MS,
  );
}
