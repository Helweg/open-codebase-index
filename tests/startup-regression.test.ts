import { afterEach, describe, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import * as os from "node:os";
import * as path from "node:path";

const STARTUP_TIMEOUT_MS = 4_000;
const STARTUP_SENTINEL = "PLUGIN_STARTUP_READY";
const HARNESS_PATH = path.resolve(process.cwd(), "tests", "startup-regression-harness.mjs");

function makeIsolatedEnv(): { root: string; home: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), "codebase-index-startup-home-"));
  const nestedHome = path.join(home, "home");
  mkdirSync(nestedHome, { recursive: true });
  return { root: home, home: nestedHome };
}

function verifyReadyOutput(output: string): void {
  if (!output.includes(STARTUP_SENTINEL)) {
    throw new Error(
      `Expected startup sentinel ${STARTUP_SENTINEL} but got output:\n${output}`,
    );
  }
}

function runStartupHarness(
  projectRoot: string,
  scenario: "empty" | "runtime-state-only" | "package-marked",
): void {
  const harnessDir = path.dirname(HARNESS_PATH);
  if (!existsSync(harnessDir)) {
    throw new Error(`Missing harness script directory: ${harnessDir}`);
  }

  const isolatedHome = makeIsolatedEnv();
  const result = spawnSync(
    process.execPath,
    [HARNESS_PATH, projectRoot, scenario],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: isolatedHome.home,
        USERPROFILE: isolatedHome.home,
      },
      timeout: STARTUP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      killSignal: "SIGKILL",
    },
  );

  rmSync(isolatedHome.root, { recursive: true, force: true });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`Startup subprocess timed out or was killed by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `Startup subprocess exited with ${result.status}: ${result.stderr?.trim() || "no stderr"}`,
    );
  }

  verifyReadyOutput(result.stdout ?? "");
}

function createEmptyScenarioDir(): string {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "startup-regression-empty-"));

  return projectDir;
}

function createRuntimeStateScenarioDir(): string {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "startup-regression-runtime-state-"));

  mkdirSync(path.join(projectDir, ".opencode"), { recursive: true });
  mkdirSync(path.join(projectDir, ".codebase-index"), { recursive: true });

  return projectDir;
}

describe("plugin startup regression", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts in an empty non-git directory", () => {
    const projectDir = createEmptyScenarioDir();
    tempDirs.push(projectDir);

    runStartupHarness(projectDir, "empty");
  });

  it("starts in a package-marked non-git directory", () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "startup-regression-package-"));
    tempDirs.push(projectDir);

    writeFileSync(path.join(projectDir, "package.json"), "{}", "utf-8");
    runStartupHarness(projectDir, "package-marked");
  });

  it("starts with only runtime state in a non-git directory", () => {
    const projectDir = createRuntimeStateScenarioDir();
    tempDirs.push(projectDir);

    runStartupHarness(projectDir, "runtime-state-only");
  });
});
