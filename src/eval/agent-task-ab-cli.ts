#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  compareAgentTaskTrials,
  parseAgentTaskDataset,
  runAgentTaskEvaluation,
  type AgentTaskExecutionRequest,
  type AgentTaskProcessResult,
  type AgentTaskRepository,
  type AgentTaskTrialResult,
} from "./agent-task-ab.js";
import { auditAgentTaskArms, type AgentTaskArmAuditResult } from "./agent-task-arm-audit.js";

interface CliOptions {
  manifest: string;
  noOcbiArgv: string;
  ocbiArgv: string;
  artifacts: string;
  seed: string;
  agent: string;
  model: string;
  maxTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxOutputBytes: number;
  allowVerifiers: boolean;
  captureAuditEvidence: boolean;
  armAudit?: string;
}

const USAGE = `Usage: ocbi-agent-task-ab --manifest FILE --no-ocbi-argv FILE --ocbi-argv FILE \\
  --artifacts NEW_DIR --seed SEED --agent NAME --model MODEL --allow-verifiers \\
  [--capture-audit-evidence] [--arm-audit FILE] [--max-tokens N] [--max-tool-calls N] \\
  [--max-duration-ms N] [--max-output-bytes N]`;

interface CapturedText {
  text: string;
  truncated: boolean;
}

interface AuditProcessResult extends AgentTaskProcessResult {
  auditOutput?: { stdout: CapturedText; stderr: CapturedText };
}

interface RepositoryAuditEvidence {
  status: CapturedText;
  diff: CapturedText;
}

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

function parsePositive(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function parseOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const valuedOptions = new Set([
    "--manifest", "--no-ocbi-argv", "--ocbi-argv", "--artifacts", "--seed", "--agent", "--model",
    "--max-tokens", "--max-tool-calls", "--max-duration-ms", "--max-output-bytes", "--arm-audit",
  ]);
  let allowVerifiers = false;
  let captureAuditEvidence = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--allow-verifiers") {
      allowVerifiers = true;
      continue;
    }
    if (flag === "--capture-audit-evidence") {
      captureAuditEvidence = true;
      continue;
    }
    if (!flag.startsWith("--")) fail(`Unexpected argument: ${flag}`);
    if (!valuedOptions.has(flag)) fail(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${flag}`);
    if (values.has(flag)) fail(`Duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const required = (name: string): string => values.get(name) ?? fail(`Missing required option: ${name}`);
  if (!allowVerifiers) fail("Refusing to execute manifest verifiers without --allow-verifiers");
  return {
    manifest: required("--manifest"),
    noOcbiArgv: required("--no-ocbi-argv"),
    ocbiArgv: required("--ocbi-argv"),
    artifacts: required("--artifacts"),
    seed: required("--seed"),
    agent: required("--agent"),
    model: required("--model"),
    maxTokens: parsePositive(values.get("--max-tokens"), "--max-tokens", 100_000),
    maxToolCalls: parsePositive(values.get("--max-tool-calls"), "--max-tool-calls", 200),
    maxDurationMs: parsePositive(values.get("--max-duration-ms"), "--max-duration-ms", 600_000),
    maxOutputBytes: parsePositive(values.get("--max-output-bytes"), "--max-output-bytes", 65_536),
    allowVerifiers,
    captureAuditEvidence,
    ...(values.has("--arm-audit") ? { armAudit: values.get("--arm-audit")! } : {}),
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function readArgv(file: string): [string, ...string[]] {
  const value = readJson(file);
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${file} must contain a non-empty JSON array of argv strings`);
  }
  return value as [string, ...string[]];
}

function readArmAudit(file: string): AgentTaskArmAuditResult {
  const value = readJson(file);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Arm audit file must be a JSON object with control, treatment, and optional ocbiServerName");
  }
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor).sort();
  const allowed = ["control", "ocbiServerName", "treatment"];
  if (!keys.includes("control") || !keys.includes("treatment") || keys.some((key) => !allowed.includes(key))) {
    throw new Error("Arm audit file must contain exactly control, treatment, and optional ocbiServerName");
  }
  if ("ocbiServerName" in descriptor && typeof descriptor.ocbiServerName !== "string") {
    throw new Error("Arm audit ocbiServerName must be a string");
  }
  const result = auditAgentTaskArms(
    descriptor.control,
    descriptor.treatment,
    typeof descriptor.ocbiServerName === "string" ? descriptor.ocbiServerName : "codebase-index",
  );
  if (!result.equivalentExceptOcbi) {
    throw new Error(`Arm audit rejected: ${result.mismatchCategories.join(", ") || "invalid_descriptor"}`);
  }
  return result;
}

function argvDigest(argv: string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

function localRepositoryPath(repository: AgentTaskRepository, manifestDirectory: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(repository.url) || /^[^/\\]+@[^:]+:/.test(repository.url)) {
    throw new Error(`Repository ${repository.id} must use a local path, not a URL`);
  }
  const candidate = path.resolve(manifestDirectory, repository.url);
  const real = fs.realpathSync(candidate);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Repository ${repository.id} is not a directory`);
  return real;
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk, 65_536); });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.toString("utf8").trim());
      else reject(new Error(`git ${args[0]} failed`));
    });
  });
}

function boundedAppend(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (current.length >= limit) return current;
  return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

function runGitEvidence(args: string[], cwd: string, limit: number): Promise<CapturedText> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = boundedAppend(stdout, chunk, limit);
    });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ text: stdout.toString("utf8"), truncated: stdoutBytes > limit });
      else reject(new Error(`git ${args[0]} failed while collecting audit evidence`));
    });
  });
}

function execute(request: AgentTaskExecutionRequest): Promise<AuditProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const home = path.join(request.cwd, ".agent-home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const inheritedPath = process.env.PATH;
    const env: NodeJS.ProcessEnv = {
      ...(inheritedPath ? { PATH: inheritedPath } : {}),
      HOME: home,
      TMPDIR: path.join(request.cwd, ".tmp"),
      ...request.env,
    };
    fs.mkdirSync(env.TMPDIR!, { recursive: true, mode: 0o700 });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = boundedAppend(stdout, chunk, request.maxTranscriptBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = boundedAppend(stderr, chunk, request.maxTranscriptBytes);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else {
        child.kill("SIGKILL");
      }
    }, request.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        auditOutput: {
          stdout: { text: stdout.toString("utf8"), truncated: stdoutBytes > request.maxTranscriptBytes },
          stderr: { text: stderr.toString("utf8"), truncated: stderrBytes > request.maxTranscriptBytes },
        },
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

function safeTrialDirectory(root: string, trialId: string): string {
  const directory = path.join(root, "workspaces", trialId.replace(":", "--"));
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe trial path: ${trialId}`);
  return directory;
}

function metadataTrial(trial: AgentTaskTrialResult): object {
  const processMetadata = (result: AgentTaskProcessResult | undefined): object | undefined => result && ({
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  });
  return {
    datasetFingerprint: trial.datasetFingerprint,
    taskId: trial.taskId,
    repositoryIds: trial.repositoryIds,
    variantId: trial.variantId,
    order: trial.order,
    trialId: trial.trialId,
    controls: trial.controls,
    agent: processMetadata(trial.agent),
    verifier: processMetadata(trial.verifier),
    success: trial.success,
  };
}

function writeAuditEvidence(root: string, trials: AgentTaskTrialResult[]): Record<string, string> {
  const directory = path.join(root, "audit-evidence");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const files: Record<string, string> = {};
  for (const trial of trials) {
    const fileName = `${trial.trialId.replace(":", "--")}.json`;
    const filePath = path.join(directory, fileName);
    const repositories = Object.fromEntries(Object.entries(trial.patches).map(([id, value]) => [
      id,
      JSON.parse(value) as RepositoryAuditEvidence,
    ]));
    const processEvidence = (result: AgentTaskProcessResult | undefined): object | undefined => {
      if (!result) return undefined;
      const output = (result as AuditProcessResult).auditOutput;
      if (!output) throw new Error(`Missing captured process evidence for ${trial.trialId}`);
      return { stdout: output.stdout, stderr: output.stderr };
    };
    const evidence = {
      formatVersion: "1.0.0",
      warning: "Explicitly captured audit evidence. It may contain secrets or private source and is not automatically redacted.",
      trialId: trial.trialId,
      agent: processEvidence(trial.agent),
      ...(trial.verifier ? { verifier: processEvidence(trial.verifier) } : {}),
      repositories,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(filePath, 0o600);
    files[trial.trialId] = path.posix.join("audit-evidence", fileName);
  }
  return files;
}

export async function runAgentTaskAbCli(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parseOptions(argv);
  const manifestPath = fs.realpathSync(options.manifest);
  const dataset = parseAgentTaskDataset(readJson(manifestPath), manifestPath);
  const noOcbi = readArgv(options.noOcbiArgv);
  const ocbi = readArgv(options.ocbiArgv);
  if (JSON.stringify(noOcbi) === JSON.stringify(ocbi)) throw new Error("A/B argv definitions must differ so treatment availability is not merely a label");
  const armAuditResult = options.armAudit ? readArmAudit(options.armAudit) : undefined;

  const manifestDirectory = path.dirname(manifestPath);
  const sources = new Map(dataset.repositories.map((repository) => [repository.id, localRepositoryPath(repository, manifestDirectory)]));
  const artifactPath = path.resolve(options.artifacts);
  if (fs.existsSync(artifactPath)) throw new Error(`Refusing to reuse existing artifact path: ${artifactPath}`);
  const parent = path.dirname(artifactPath);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("Artifact parent must not be a symbolic link");
  fs.mkdirSync(artifactPath, { mode: 0o700 });
  fs.chmodSync(artifactPath, 0o700);

  const trials = await runAgentTaskEvaluation({
    dataset,
    seed: options.seed,
    controls: {
      agent: options.agent,
      model: options.model,
      maxTokens: options.maxTokens,
      maxToolCalls: options.maxToolCalls,
      maxDurationMs: options.maxDurationMs,
      maxTranscriptBytes: options.maxOutputBytes,
    },
    variants: [
      { id: "no-ocbi", command: noOcbi[0], args: noOcbi.slice(1), env: { AGENT_EVAL_OCBI_AVAILABLE: "0" } },
      { id: "ocbi", command: ocbi[0], args: ocbi.slice(1), env: { AGENT_EVAL_OCBI_AVAILABLE: "1" } },
    ],
    execution: { execute },
    preparation: {
      async prepare({ repositories, trialId }) {
        const cwd = safeTrialDirectory(artifactPath, trialId);
        fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        try {
          const repositoryDirectories: Record<string, string> = {};
          for (const repository of repositories) {
            const destination = path.join(cwd, repository.id);
            await runGit(["clone", "--no-local", "--quiet", sources.get(repository.id)!, destination]);
            await runGit(["checkout", "--detach", "--quiet", repository.revision], destination);
            const head = await runGit(["rev-parse", "HEAD"], destination);
            if (head.toLowerCase() !== repository.revision.toLowerCase()) throw new Error(`Repository ${repository.id} did not resolve to pinned revision`);
            if (await runGit(["status", "--porcelain", "--untracked-files=all"], destination)) throw new Error(`Repository ${repository.id} checkout is not clean`);
            repositoryDirectories[repository.id] = destination;
          }
          return {
            cwd,
            repositoryDirectories,
            ...(options.captureAuditEvidence ? {
              async collectArtifacts(): Promise<Record<string, string>> {
                const evidence: Record<string, string> = {};
                for (const [repositoryId, directory] of Object.entries(repositoryDirectories)) {
                  const status = await runGitEvidence(
                    ["status", "--porcelain=v1", "--untracked-files=all"], directory, options.maxOutputBytes,
                  );
                  const diff = await runGitEvidence(
                    ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"], directory, options.maxOutputBytes,
                  );
                  evidence[repositoryId] = JSON.stringify({ status, diff } satisfies RepositoryAuditEvidence);
                }
                return evidence;
              },
            } : {}),
            async cleanup() { fs.rmSync(cwd, { recursive: true, force: true }); },
          };
        } catch (error) {
          fs.rmSync(cwd, { recursive: true, force: true });
          throw error;
        }
      },
    },
  });
  const auditEvidenceFiles = options.captureAuditEvidence ? writeAuditEvidence(artifactPath, trials) : undefined;
  const result = {
    formatVersion: "1.0.0",
    note: options.captureAuditEvidence
      ? "Metadata report. Protected audit evidence was explicitly requested; argv, environment, and workspace paths remain omitted."
      : "Metadata only. Agent/verifier output, argv, environment, patches, and workspace paths are intentionally omitted.",
    armConfigDigests: { "no-ocbi": argvDigest(noOcbi), ocbi: argvDigest(ocbi) },
    trials: trials.map(metadataTrial),
    comparison: compareAgentTaskTrials(dataset, trials),
    ...(armAuditResult ? {
      armAudit: {
        equivalentExceptOcbi: armAuditResult.equivalentExceptOcbi,
        mismatchCategories: armAuditResult.mismatchCategories,
        ...(armAuditResult.structuralDigest ? { structuralDigest: armAuditResult.structuralDigest } : {}),
      },
    } : {}),
    ...(auditEvidenceFiles ? { auditEvidenceFiles } : {}),
  };
  const resultPath = path.join(artifactPath, "result.json");
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(resultPath, 0o600);
  process.stdout.write(`${resultPath}\n`);
}

const moduleUrl = import.meta.url ?? pathToFileURL(__filename).href;
if (process.argv[1] && fs.existsSync(process.argv[1])
  && moduleUrl === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runAgentTaskAbCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
