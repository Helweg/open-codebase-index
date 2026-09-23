import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tempDir: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(name: string): { directory: string; revision: string } {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory);
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.email", "eval@example.test"]);
  git(directory, ["config", "user.name", "Eval Test"]);
  fs.writeFileSync(path.join(directory, "README.md"), `${name}\n`);
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "--quiet", "-m", "fixture"]);
  return { directory, revision: git(directory, ["rev-parse", "HEAD"]) };
}

function writeFixture(overrides: { remote?: boolean; badPin?: boolean; sleep?: boolean } = {}) {
  const first = createRepository("repo-one");
  const second = createRepository("repo-two");
  const fakeAgent = path.join(tempDir, "fake-agent.mjs");
  const verifier = path.join(tempDir, "verifier.mjs");
  const marker = path.join(tempDir, "shell-marker");
  fs.writeFileSync(fakeAgent, `
    const repos = JSON.parse(process.env.AGENT_EVAL_REPOSITORIES_JSON);
    if (!process.env.HOME.startsWith(process.cwd()) || Object.keys(repos).length !== 2) process.exit(7);
    if (process.argv[2].startsWith("sleep")) await new Promise(r => setTimeout(r, 5000));
    process.stdout.write("PRIVATE_TRANSCRIPT:" + "x".repeat(10000));
  `);
  fs.writeFileSync(verifier, `
    import * as fs from "node:fs";
    const repos = JSON.parse(process.env.AGENT_EVAL_REPOSITORIES_JSON);
    process.exit(Object.values(repos).every(p => fs.existsSync(p)) ? 0 : 8);
  `);
  const manifest = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({
    version: "1.0.0",
    name: "trusted-test-manifest",
    preregistration: { id: "test-prereg", createdAt: "2026-09-23T15:00:00Z", primaryMetric: "task-success", analysis: "paired-exact-sign-test" },
    repositories: [
      { id: "repo-one", url: overrides.remote ? "https://example.test/repo.git" : first.directory, revision: overrides.badPin ? "f".repeat(40) : first.revision },
      { id: "repo-two", url: second.directory, revision: second.revision },
    ],
    tasks: [{ id: "task-one", repositoryIds: ["repo-one", "repo-two"], prompt: "Trusted fixture task", verifier: { command: process.execPath, args: [verifier] } }],
  }));
  const noOcbiArgv = path.join(tempDir, "no-ocbi.json");
  const ocbiArgv = path.join(tempDir, "ocbi.json");
  fs.writeFileSync(noOcbiArgv, JSON.stringify([process.execPath, fakeAgent, overrides.sleep ? "sleep" : `;touch ${marker}`]));
  fs.writeFileSync(ocbiArgv, JSON.stringify([process.execPath, fakeAgent, overrides.sleep ? "sleep-treatment" : "treatment"]));
  return { manifest, noOcbiArgv, ocbiArgv, marker };
}

function invoke(fixture: ReturnType<typeof writeFixture>, artifacts: string, extra: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/eval/agent-task-ab-cli.ts",
    "--manifest", fixture.manifest,
    "--no-ocbi-argv", fixture.noOcbiArgv,
    "--ocbi-argv", fixture.ocbiArgv,
    "--artifacts", artifacts,
    "--seed", "public-test-seed",
    "--agent", "safe-fake-agent",
    "--model", "fixed-test-model",
    "--max-output-bytes", "64",
    ...extra,
  ], { cwd: path.resolve("."), encoding: "utf8", timeout: 20_000 });
}

beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-task-ab-cli-")); });
afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

describe("agent-task A/B executable", () => {
  it("prints help without requiring a manifest or verifier opt-in", () => {
    for (const flag of ["--help", "-h"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/eval/agent-task-ab-cli.ts", flag], {
        cwd: path.resolve("."), encoding: "utf8", timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: ocbi-agent-task-ab");
    }
  });

  it("runs end to end against pinned local Git repositories and writes protected metadata only", () => {
    const fixture = writeFixture();
    const artifacts = path.join(tempDir, "artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers"]);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(fixture.marker)).toBe(false);
    const resultPath = path.join(artifacts, "result.json");
    const raw = fs.readFileSync(resultPath, "utf8");
    const parsed = JSON.parse(raw) as { armConfigDigests: Record<string, string>; trials: Array<{ success: boolean }>; comparison: { taskCount: number } };
    expect(parsed.trials).toHaveLength(2);
    expect(parsed.trials.every((trial) => trial.success)).toBe(true);
    expect(parsed.comparison.taskCount).toBe(1);
    expect(parsed.armConfigDigests["no-ocbi"]).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.armConfigDigests.ocbi).not.toBe(parsed.armConfigDigests["no-ocbi"]);
    expect(raw).not.toContain("PRIVATE_TRANSCRIPT");
    expect(raw).not.toContain(fakePathFragment(fixture.manifest));
    expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
    expect(fs.statSync(resultPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(artifacts, "workspaces", "task-one--no-ocbi"))).toBe(false);
  });

  it("requires explicit verifier opt-in and refuses existing output", () => {
    const fixture = writeFixture();
    const artifacts = path.join(tempDir, "artifacts");
    const denied = invoke(fixture, artifacts);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/without --allow-verifiers/);
    fs.mkdirSync(artifacts);
    const reused = invoke(fixture, artifacts, ["--allow-verifiers"]);
    expect(reused.status).toBe(1);
    expect(reused.stderr).toMatch(/Refusing to reuse existing artifact path/);
  });

  it("rejects remote repositories, bad pins, and unsafe manifest ids", () => {
    const remote = writeFixture({ remote: true });
    expect(invoke(remote, path.join(tempDir, "remote-out"), ["--allow-verifiers"]).stderr).toMatch(/local path/);

    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-task-ab-cli-"));
    const badPin = writeFixture({ badPin: true });
    const result = invoke(badPin, path.join(tempDir, "pin-out"), ["--allow-verifiers"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/git checkout failed/);
    expect(result.stderr).not.toContain(tempDir);
  });

  it("enforces process timeout and records no captured output", () => {
    const fixture = writeFixture({ sleep: true });
    const artifacts = path.join(tempDir, "timeout-out");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--max-duration-ms", "50"]);
    expect(result.status, result.stderr).toBe(0);
    const raw = fs.readFileSync(path.join(artifacts, "result.json"), "utf8");
    const parsed = JSON.parse(raw) as { trials: Array<{ agent: { timedOut?: boolean }; success: boolean }> };
    expect(parsed.trials.every((trial) => trial.agent.timedOut && !trial.success)).toBe(true);
    expect(raw).not.toContain("stdout");
    expect(raw).not.toContain("stderr");
  });
});

function fakePathFragment(file: string): string {
  return path.dirname(file);
}
