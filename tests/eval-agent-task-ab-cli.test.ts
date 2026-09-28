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

function writeFixture(overrides: { remote?: boolean; badPin?: boolean; sleep?: boolean; breakGit?: boolean } = {}) {
  const first = createRepository("repo-one");
  const second = createRepository("repo-two");
  const fakeAgent = path.join(tempDir, "fake-agent.mjs");
  const verifier = path.join(tempDir, "verifier.mjs");
  const marker = path.join(tempDir, "shell-marker");
  fs.writeFileSync(fakeAgent, `
    import * as fs from "node:fs";
    const repos = JSON.parse(process.env.AGENT_EVAL_REPOSITORIES_JSON);
    if (!process.env.HOME.startsWith(process.cwd()) || Object.keys(repos).length !== 2) process.exit(7);
    if (process.argv[2].startsWith("sleep")) await new Promise(r => setTimeout(r, 5000));
    const first = Object.values(repos)[0];
    fs.writeFileSync(first + "/README.md", "PRIVATE_DIFF:" + "d".repeat(10000));
    fs.writeFileSync(first + "/untracked.txt", "PRIVATE_UNTRACKED");
    if (process.argv[2].startsWith("break-git")) fs.rmSync(first + "/.git", { recursive: true, force: true });
    process.stdout.write("PRIVATE_TRANSCRIPT:" + "x".repeat(10000));
    process.stderr.write("PRIVATE_STDERR:" + "y".repeat(10000));
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
  const controlArg = overrides.sleep ? "sleep" : overrides.breakGit ? "break-git" : `;touch ${marker}`;
  fs.writeFileSync(noOcbiArgv, JSON.stringify([process.execPath, fakeAgent, controlArg]));
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

function writeArmAudit(mismatch = false): string {
  const file = path.join(tempDir, "arm-audit.json");
  const sharedAgent = { argv: ["reviewed-agent", "--model", "fixed-test-model"], model: "fixed-test-model" };
  const commonServer = { name: "other-tool", argv: ["other-mcp", "--stdio"] };
  fs.writeFileSync(file, JSON.stringify({
    control: { agent: sharedAgent, mcpServers: [commonServer] },
    treatment: {
      agent: mismatch ? { ...sharedAgent, model: "different-model" } : sharedAgent,
      mcpServers: [commonServer, { name: "codebase-index", argv: ["ocbi-mcp", "--host", "jcode"] }],
    },
  }));
  return file;
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
      expect(result.stdout).toContain("[--prepare-argv FILE]");
      expect(result.stdout).toContain("non-empty JSON array of non-empty argv strings");
      expect(result.stdout).toContain("Preparation output is not persisted");
    }
  });

  it("prints help when invoked through a symlinked entrypoint", () => {
    const target = path.resolve("src/eval/agent-task-ab-cli.ts");
    const symlink = path.join(tempDir, "agent-task-ab-link.ts");
    fs.symlinkSync(target, symlink);
    const result = spawnSync(process.execPath, ["--import", "tsx", symlink, "--help"], {
      cwd: path.resolve("."), encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: ocbi-agent-task-ab");
  });

  it("runs end to end against pinned local Git repositories and writes protected metadata only", () => {
    const fixture = writeFixture();
    const artifacts = path.join(tempDir, "artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers"]);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(fixture.marker)).toBe(false);
    const resultPath = path.join(artifacts, "result.json");
    const raw = fs.readFileSync(resultPath, "utf8");
    const parsed = JSON.parse(raw) as { armConfigDigests: Record<string, string>; trials: Array<{ success: boolean; agent: { toolUseCounts: Record<string, number> } }>; comparison: { taskCount: number } };
    expect(parsed.trials).toHaveLength(2);
    expect(parsed.trials.every((trial) => trial.success)).toBe(true);
    expect(parsed.trials.every((trial) => Object.keys(trial.agent.toolUseCounts).length === 0)).toBe(true);
    expect(parsed.comparison.taskCount).toBe(1);
    expect(parsed.armConfigDigests["no-ocbi"]).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.armConfigDigests.ocbi).not.toBe(parsed.armConfigDigests["no-ocbi"]);
    expect(raw).not.toContain("PRIVATE_TRANSCRIPT");
    expect(raw).not.toContain(fakePathFragment(fixture.manifest));
    expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
    expect(fs.statSync(resultPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(artifacts, "workspaces", "task-one--no-ocbi"))).toBe(false);
  });

  it("counts OpenCode tool events beyond transcript truncation without retaining names or values", () => {
    const fixture = writeFixture();
    const agent = path.join(tempDir, "events.mjs");
    fs.writeFileSync(agent, `
      process.stdout.write("PRIVATE_PREFIX:" + "x".repeat(10000) + "\\n");
      const emit = (tool) => process.stdout.write(JSON.stringify({type:"tool_use",part:{tool,state:{input:"PRIVATE_SECRET"}}}) + "\\n");
      emit("codebase_context"); emit("codebase_context"); emit("codebase_edit_context"); emit("PRIVATE_TOOL_NAME");
      process.stdout.write(JSON.stringify({type:"text",part:{tool:"codebase_search"}}) + "\\n");
      process.stdout.write("{malformed\\n");
      process.stdout.write(JSON.stringify({type:"tool_use",part:{tool:"index_status"}}));
    `);
    fs.writeFileSync(fixture.noOcbiArgv, JSON.stringify([process.execPath, agent]));
    fs.writeFileSync(fixture.ocbiArgv, JSON.stringify([process.execPath, agent, "treatment"]));
    const artifacts = path.join(tempDir, "events-out");
    const result = invoke(fixture, artifacts, ["--allow-verifiers"]);
    expect(result.status, result.stderr).toBe(0);
    const raw = fs.readFileSync(path.join(artifacts, "result.json"), "utf8");
    const parsed = JSON.parse(raw) as { trials: Array<{ agent: { toolUseCounts: Record<string, number> } }> };
    for (const trial of parsed.trials) {
      expect(trial.agent.toolUseCounts).toEqual({ codebase_context: 2, codebase_edit_context: 1, other: 1, index_status: 1 });
    }
    expect(raw).not.toMatch(/PRIVATE_SECRET|PRIVATE_TOOL_NAME|PRIVATE_PREFIX/);
  });

  it("runs optional preparation after clones with isolated trial metadata and does not persist output", () => {
    const fixture = writeFixture();
    const prepare = path.join(tempDir, "prepare.mjs");
    const log = path.join(tempDir, "prepare-log.jsonl");
    fs.writeFileSync(prepare, `import * as fs from "node:fs"; const repos=JSON.parse(process.env.AGENT_EVAL_REPOSITORIES_JSON); if (!process.env.HOME.startsWith(process.cwd()) || !process.env.TMPDIR.startsWith(process.cwd()) || Object.keys(repos).length!==2) process.exit(9); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({task:process.env.AGENT_EVAL_TASK_ID,variant:process.env.AGENT_EVAL_VARIANT,repo:Object.values(repos).every(p=>fs.existsSync(p+"/.git"))})+"\\n"); console.log("PRIVATE_PREP_OUTPUT");`);
    const argvFile = path.join(tempDir, "prepare-argv.json");
    fs.writeFileSync(argvFile, JSON.stringify([process.execPath, prepare]));
    const artifacts = path.join(tempDir, "prepare-artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--prepare-argv", argvFile]);
    expect(result.status, result.stderr).toBe(0);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { task: string; variant: string; repo: boolean });
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.task === "task-one" && line.repo)).toBe(true);
    expect(new Set(lines.map((line) => line.variant))).toEqual(new Set(["no-ocbi", "ocbi"]));
    const raw = fs.readFileSync(path.join(artifacts, "result.json"), "utf8");
    expect(raw).not.toContain("PRIVATE_PREP_OUTPUT");
    expect(raw).not.toContain("AGENT_EVAL_REPOSITORIES_JSON");
  });

  it("fails closed and cleans the workspace when preparation exits nonzero", () => {
    const fixture = writeFixture();
    const prepare = path.join(tempDir, "prepare-fail.mjs");
    fs.writeFileSync(prepare, `console.log("PRIVATE_PREP_OUTPUT"); process.exit(17);`);
    const argvFile = path.join(tempDir, "prepare-fail-argv.json");
    fs.writeFileSync(argvFile, JSON.stringify([process.execPath, prepare]));
    const artifacts = path.join(tempDir, "prepare-failure-artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--prepare-argv", argvFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Preparation command exited with status 17");
    expect(fs.existsSync(path.join(artifacts, "workspaces", "task-one--no-ocbi"))).toBe(false);
    expect(fs.existsSync(path.join(artifacts, "result.json"))).toBe(false);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_PREP_OUTPUT");
  });

  it("fails closed and cleans the workspace when preparation times out", () => {
    const fixture = writeFixture();
    const prepare = path.join(tempDir, "prepare-timeout.mjs");
    fs.writeFileSync(prepare, `await new Promise(r => setTimeout(r, 3000));`);
    const argvFile = path.join(tempDir, "prepare-timeout-argv.json");
    fs.writeFileSync(argvFile, JSON.stringify([process.execPath, prepare]));
    const artifacts = path.join(tempDir, "prepare-timeout-artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--prepare-argv", argvFile, "--prepare-timeout-ms", "1000"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Preparation command timed out");
    expect(fs.existsSync(path.join(artifacts, "workspaces", "task-one--no-ocbi"))).toBe(false);
    expect(fs.existsSync(path.join(artifacts, "result.json"))).toBe(false);
  });

  it("accepts an explicit matching arm-audit file and persists only its safe summary", () => {
    const fixture = writeFixture();
    const auditFile = writeArmAudit();
    const artifacts = path.join(tempDir, "audited-artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--arm-audit", auditFile]);
    expect(result.status, result.stderr).toBe(0);
    const raw = fs.readFileSync(path.join(artifacts, "result.json"), "utf8");
    const parsed = JSON.parse(raw) as { armAudit: { equivalentExceptOcbi: boolean; mismatchCategories: string[]; structuralDigest: string } };
    expect(parsed.armAudit).toEqual({ equivalentExceptOcbi: true, mismatchCategories: [], structuralDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(raw).not.toContain("reviewed-agent");
    expect(raw).not.toContain("other-mcp");
    expect(raw).not.toContain("ocbi-mcp");
  });

  it("rejects mismatched arm-audit descriptors before creating artifacts", () => {
    const fixture = writeFixture();
    const auditFile = writeArmAudit(true);
    const artifacts = path.join(tempDir, "rejected-artifacts");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--arm-audit", auditFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Arm audit rejected: agent_settings_mismatch");
    expect(fs.existsSync(artifacts)).toBe(false);
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

  it("captures bounded protected audit evidence only with explicit consent", () => {
    const fixture = writeFixture();
    const artifacts = path.join(tempDir, "evidence-out");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--capture-audit-evidence"]);
    expect(result.status, result.stderr).toBe(0);

    const resultRaw = fs.readFileSync(path.join(artifacts, "result.json"), "utf8");
    const parsed = JSON.parse(resultRaw) as { auditEvidenceFiles: Record<string, string> };
    expect(Object.keys(parsed.auditEvidenceFiles)).toHaveLength(2);
    expect(resultRaw).not.toContain("PRIVATE_TRANSCRIPT");
    expect(resultRaw).not.toContain(process.execPath);
    expect(resultRaw).not.toContain("AGENT_EVAL_");

    const evidenceDirectory = path.join(artifacts, "audit-evidence");
    expect(fs.statSync(evidenceDirectory).mode & 0o777).toBe(0o700);
    for (const relative of Object.values(parsed.auditEvidenceFiles)) {
      const evidencePath = path.join(artifacts, relative);
      const evidenceRaw = fs.readFileSync(evidencePath, "utf8");
      const evidence = JSON.parse(evidenceRaw) as {
        agent: { stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean } };
        repositories: Record<string, { status: { text: string }; diff: { text: string; truncated: boolean } }>;
      };
      expect(fs.statSync(evidencePath).mode & 0o777).toBe(0o600);
      expect(Buffer.byteLength(evidence.agent.stdout.text)).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(evidence.agent.stderr.text)).toBeLessThanOrEqual(64);
      expect(evidence.agent.stdout.truncated).toBe(true);
      expect(evidence.agent.stderr.truncated).toBe(true);
      expect(Object.values(evidence.repositories).some((repo) => repo.status.text.includes("README.md"))).toBe(true);
      expect(Object.values(evidence.repositories).some((repo) => repo.diff.text.includes("diff --git"))).toBe(true);
      expect(Object.values(evidence.repositories).some((repo) => repo.diff.truncated)).toBe(true);
      expect(evidenceRaw).not.toContain(process.execPath);
      expect(evidenceRaw).not.toContain("AGENT_EVAL_");
    }
  });

  it("fails closed when requested repository evidence cannot be collected", () => {
    const fixture = writeFixture({ breakGit: true });
    const artifacts = path.join(tempDir, "broken-evidence-out");
    const result = invoke(fixture, artifacts, ["--allow-verifiers", "--capture-audit-evidence"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/failed while collecting audit evidence/);
    expect(fs.existsSync(path.join(artifacts, "result.json"))).toBe(false);
    expect(fs.existsSync(path.join(artifacts, "audit-evidence"))).toBe(false);
  });
});

function fakePathFragment(file: string): string {
  return path.dirname(file);
}
