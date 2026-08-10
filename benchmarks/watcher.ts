import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { FileWatcher, type FileChange, type FileChangeType } from "../src/watcher/file-watcher.js";

interface BenchmarkOptions {
  directories: number;
  filesPerDirectory: number;
}

interface EventMeasurement {
  expected: FileChangeType;
  latencyMs: number;
  observed: FileChangeType;
}

interface WatcherBenchmarkResult {
  platform: NodeJS.Platform;
  node: string;
  tree: {
    directories: number;
    files: number;
  };
  startup: {
    cpuMs: number;
    durationMs: number;
    fileDescriptorDelta: number | null;
    fileDescriptorDeltaAfterStop: number | null;
  };
  events: EventMeasurement[];
}

const DEFAULT_DIRECTORIES = 250;
const DEFAULT_FILES_PER_DIRECTORY = 8;
const EVENT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received ${value}`);
  }
  return parsed;
}

function parseOptions(args: string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--directories" && option !== "--files-per-directory") {
      throw new Error(`Unknown option: ${option}`);
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${option}`);
    }
    values.set(option, value);
  }
  return {
    directories: parsePositiveInteger("--directories", values.get("--directories"), DEFAULT_DIRECTORIES),
    filesPerDirectory: parsePositiveInteger(
      "--files-per-directory",
      values.get("--files-per-directory"),
      DEFAULT_FILES_PER_DIRECTORY,
    ),
  };
}

function countOpenFileDescriptors(): number | null {
  if (process.platform === "linux") {
    return fs.readdirSync("/proc/self/fd").length;
  }

  if (process.platform === "darwin") {
    const result = spawnSync("lsof", ["-Fn", "-p", String(process.pid)], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return result.stdout.split("\n").filter((line) => line.startsWith("f")).length;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).HandleCount`],
      { encoding: "utf8" },
    );
    const handles = Number.parseInt(result.stdout.trim(), 10);
    return result.status === 0 && Number.isSafeInteger(handles) ? handles : null;
  }

  return null;
}

function cpuDurationMs(start: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1_000;
}

function createFixture(root: string, options: BenchmarkOptions): void {
  for (let directoryIndex = 0; directoryIndex < options.directories; directoryIndex += 1) {
    const directory = path.join(root, "src", `directory-${directoryIndex}`);
    fs.mkdirSync(directory, { recursive: true });
    for (let fileIndex = 0; fileIndex < options.filesPerDirectory; fileIndex += 1) {
      fs.writeFileSync(path.join(directory, `file-${fileIndex}.ts`), `export const value = ${fileIndex};\n`);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForChange(
  changes: FileChange[],
  targetPath: string,
  expected: FileChangeType,
): Promise<EventMeasurement> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < EVENT_TIMEOUT_MS) {
    const change = changes.find((candidate) => candidate.path === targetPath);
    if (change) {
      if (change.type !== expected) {
        throw new Error(`Expected ${expected} for ${targetPath}, observed ${change.type}`);
      }
      return {
        expected,
        observed: change.type,
        latencyMs: performance.now() - startedAt,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${expected} event for ${targetPath}`);
}

async function run(options: BenchmarkOptions): Promise<WatcherBenchmarkResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-benchmark-"));
  const changes: FileChange[] = [];
  let watcher: FileWatcher | undefined;

  try {
    createFixture(root, options);
    watcher = new FileWatcher(root, parseConfig({ include: ["**/*.ts"] }), "codex");

    const descriptorsBefore = countOpenFileDescriptors();
    const startupCpu = process.cpuUsage();
    const startupStartedAt = performance.now();
    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();
    const startupDurationMs = performance.now() - startupStartedAt;
    const descriptorsAfter = countOpenFileDescriptors();

    const eventDirectory = path.join(root, "src", "events");
    fs.mkdirSync(eventDirectory, { recursive: true });
    const eventPath = path.join(eventDirectory, "observed.ts");

    fs.writeFileSync(eventPath, "export const version = 1;\n");
    const add = await waitForChange(changes, eventPath, "add");

    changes.length = 0;
    fs.writeFileSync(eventPath, "export const version = 2;\n");
    const change = await waitForChange(changes, eventPath, "change");

    changes.length = 0;
    fs.rmSync(eventPath);
    const unlink = await waitForChange(changes, eventPath, "unlink");

    await watcher.stop();
    watcher = undefined;
    const descriptorsAfterStop = countOpenFileDescriptors();

    return {
      platform: process.platform,
      node: process.version,
      tree: {
        directories: options.directories + 3,
        files: options.directories * options.filesPerDirectory,
      },
      startup: {
        cpuMs: cpuDurationMs(startupCpu),
        durationMs: startupDurationMs,
        fileDescriptorDelta: descriptorsBefore === null || descriptorsAfter === null
          ? null
          : descriptorsAfter - descriptorsBefore,
        fileDescriptorDeltaAfterStop: descriptorsBefore === null || descriptorsAfterStop === null
          ? null
          : descriptorsAfterStop - descriptorsBefore,
      },
      events: [add, change, unlink],
    };
  } finally {
    await watcher?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function printResult(result: WatcherBenchmarkResult): void {
  const resourceLabel = process.platform === "win32" ? "Process handle delta" : "File descriptor delta";
  console.log(
    `Watcher fixture: ${result.tree.files} TypeScript files in ${result.tree.directories} directories `
      + `on ${result.platform} (${result.node})`,
  );
  console.log("| Measurement | Result |");
  console.log("|---|---:|");
  console.log(`| Startup duration | ${result.startup.durationMs.toFixed(1)} ms |`);
  console.log(`| Startup CPU | ${result.startup.cpuMs.toFixed(1)} ms |`);
  console.log(
    `| ${resourceLabel} | ${result.startup.fileDescriptorDelta === null ? "unavailable" : result.startup.fileDescriptorDelta} |`,
  );
  console.log(
    `| ${resourceLabel} after stop | ${result.startup.fileDescriptorDeltaAfterStop === null
      ? "unavailable"
      : result.startup.fileDescriptorDeltaAfterStop} |`,
  );
  for (const event of result.events) {
    console.log(`| ${event.expected} event latency | ${event.latencyMs.toFixed(1)} ms (${event.observed}) |`);
  }
  console.log(JSON.stringify(result));
}

const options = parseOptions(process.argv.slice(2));
run(options)
  .then(printResult)
  .catch(() => {
    console.error("Watcher benchmark failed");
    process.exitCode = 1;
  });
