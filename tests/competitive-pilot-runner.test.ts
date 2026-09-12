import type { CompetitiveAdapterOptions, CompetitiveCondition, CompetitiveQuery } from "../scripts/competitive-adapters.js";
import type {
  BrokerToolCall,
  ModelDriver,
  ModelDriverContext,
  PilotTask,
  EvaluatorRuntime,
  EvaluatorResult,
  PilotRuntimeVerification,
  SandboxProbeResult,
} from "../scripts/competitive-coding-pilot.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPilotOrder,
  PILOT_CONDITIONS,
  PILOT_ORDER_SEED,
  runCompetitivePilot,
  type PilotRunnerDependencies,
} from "../scripts/competitive-pilot-runner.js";
import {
  AXIOS_REVISION,
  PILOT_MANIFEST,
  PilotModelError,
  EVALUATOR_NODE_SHA256,
  FORBIDDEN_SEGMENTS,
  MAX_TOOL_CALLS,
} from "../scripts/competitive-coding-pilot.js";

let tempDir: string;

const denied: SandboxProbeResult = { outsideReadDenied: true, outsideWriteDenied: true, networkDenied: true, childProcessDenied: true };

async function verifiedRuntime(runtime: EvaluatorRuntime): Promise<PilotRuntimeVerification> {
  return {
    evaluator: { path: runtime.path, version: runtime.expectedVersion, sha256: runtime.expectedSha256 },
    model: { name: PILOT_MANIFEST.model.name, digest: PILOT_MANIFEST.model.digest, endpoint: PILOT_MANIFEST.model.endpoint },
  };
}

function evaluatedTask(workspace: string, task: PilotTask, passed = !workspace.includes("preflight-mutants")): EvaluatorResult {
  return { passed, stdout: JSON.stringify(passed ? task.hiddenExpectedOutputs : task.hiddenExpectedOutputs.map(() => null)), stderr: "", exitCode: 0 };
}

async function repairTask(context: ModelDriverContext): Promise<void> {
  const task = PILOT_MANIFEST.tasks.find(candidate => candidate.prompt === context.prompt);
  if (!task) throw new Error("unknown fixture task prompt");
  const result = await context.broker.execute({
    name: "replace_unique",
    arguments: { path: task.mutation.file, oldText: task.mutation.newText, newText: task.mutation.oldText },
  });
  expect(result.ok).toBe(true);
}

function fakeDependencies(source: string): PilotRunnerDependencies {
  return {
    createPublicAdapter: () => ({
      async index() {},
      async query() { return { status: "success" as const, paths: [], raw: {}, durationMs: 0 }; },
      async close() {},
    }),
    evaluate: async (workspace, task) => evaluatedTask(workspace, task),
    extractArchive: extractFrom(source),
    proveSafety: async () => denied,
    validateFrozenInputs: async () => {},
    verifyRuntime: verifiedRuntime,
  };
}

function directory(name: string): string {
  const result = path.join(tempDir, name);
  fs.mkdirSync(result, { recursive: true });
  return result;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createAxiosSource(root: string): void {
  write(root, "package.json", '{"type":"module"}\n');
  write(root, "README.md", "public axios source\n");
  write(
    root,
    "lib/helpers/isAbsoluteURL.js",
    "export default function isAbsoluteURL(url) {\n  return /^([a-z][a-z\\d+\\-.]*:)?\\/\\//i.test(url);\n}\n",
  );
  write(
    root,
    "lib/helpers/combineURLs.js",
    "export default function combineURLs(baseURL, relativeURL) {\n  return relativeURL\n    ? baseURL.replace(/\\/?\\/$/, '') + '/' + relativeURL.replace(/^\\/+/, '')\n    : baseURL;\n}\n",
  );
  write(root, "tests/oracle-sentinel.js", "HIDDEN_TEST_SENTINEL\n");
  write(root, ".git/config", "HIDDEN_GIT_SENTINEL\n");
}

function createLockedInputs(): {
  projectRoot: string;
  scratchRoot: string;
  toolsRoot: string;
  archive: string;
  source: string;
  evaluatorRuntime: EvaluatorRuntime;
} {
  const projectRoot = directory("project");
  const scratchRoot = directory("scratch");
  const toolsRoot = directory("tools");
  const source = directory("source-fixture");
  createAxiosSource(source);
  const archive = path.join(scratchRoot, "archives", `axios-${AXIOS_REVISION}.tar`);
  write(scratchRoot, `archives/axios-${AXIOS_REVISION}.tar`, "frozen archive bytes");
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  write(projectRoot, "benchmarks/competitive/2026-09-10/source-lock.json", JSON.stringify({
    repositories: [{ name: "axios", revision: AXIOS_REVISION, archiveSha256: digest }],
  }));
  write(projectRoot, "dist/cli.js", "// fixture\n");
  return { projectRoot, scratchRoot, toolsRoot, archive, source,
    evaluatorRuntime: { path: path.join(toolsRoot, "node"), expectedVersion: "v24.0.0", expectedSha256: EVALUATOR_NODE_SHA256 } };
}

function extractFrom(source: string): (archive: string, destination: string) => Promise<void> {
  return async (_archive, destination) => {
    fs.mkdirSync(destination, { recursive: false });
    fs.cpSync(source, destination, { recursive: true });
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "competitive-pilot-runner-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("pilot ordering", () => {
  it("creates one deterministic serial order containing every task-condition pair", () => {
    const first = buildPilotOrder();
    const second = buildPilotOrder();
    expect(PILOT_ORDER_SEED).toBe(20_260_910);
    expect(first.map(({ task, condition, orderIndex }) => ({ taskId: task.id, condition, orderIndex })))
      .toEqual(second.map(({ task, condition, orderIndex }) => ({ taskId: task.id, condition, orderIndex })));
    expect(first).toHaveLength(6);
    for (const task of PILOT_MANIFEST.tasks) {
      expect(first.filter(spec => spec.task.id === task.id).map(spec => spec.condition).sort())
        .toEqual([...PILOT_CONDITIONS].sort());
    }
    expect(first.map(spec => spec.orderIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("competitive pilot runner", () => {
  it("runs six cells serially, records order before model access, and structurally isolates oracle data", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "results", "pilot");
    const events: string[] = [];
    const modelVisible: Array<{ prompt: string; keys: string[]; search: BrokerToolCall }> = [];
    const publicQueries: CompetitiveQuery[] = [];
    const indexedRoots: string[] = [];
    const evaluated: Array<{ taskId: string; hidden: unknown[] }> = [];

    const modelDriver: ModelDriver = {
      async run(context: ModelDriverContext) {
        expect(fs.existsSync(path.join(outputRoot, "run-plan.json"))).toBe(true);
        const preflight = JSON.parse(fs.readFileSync(path.join(outputRoot, "preflight.json"), "utf8"));
        expect(preflight.status).toBe("passed");
        expect(preflight.tasks).toHaveLength(2);
        expect(preflight.safety).toEqual(denied);
        events.push(`model:${context.prompt}`);
        const call: BrokerToolCall = { name: "search", arguments: { query: "public model query", limit: 7 } };
        const result = await context.broker.execute(call);
        expect(result.ok).toBe(true);
        modelVisible.push({ prompt: context.prompt, keys: Object.keys(context).sort(), search: call });
        await repairTask(context);
        return { text: "done", promptTokens: 11, generatedTokens: 3, transcript: [{ type: "model" }] };
      },
    };

    const createPublicAdapter = vi.fn((_condition: CompetitiveCondition, options: CompetitiveAdapterOptions) => {
      indexedRoots.push(options.projectRoot);
      return {
        async index() {
          events.push(`index:${path.basename(path.dirname(options.projectRoot))}`);
          expect(fs.existsSync(path.join(options.projectRoot, "tests"))).toBe(false);
          expect(fs.existsSync(path.join(options.projectRoot, ".git"))).toBe(false);
        },
        async query(input: CompetitiveQuery) {
          publicQueries.push(input);
          return { status: "success" as const, paths: ["lib/helpers/isAbsoluteURL.js"], raw: { public: true }, durationMs: 1 };
        },
        async close() {
          events.push("close");
        },
      };
    });

    const evaluate = vi.fn(async (workspace: string, task: PilotTask) => {
      if (workspace.includes(`${path.sep}runs${path.sep}`)) events.push(`evaluate:${task.id}`);
      evaluated.push({ taskId: task.id, hidden: task.hiddenExpectedOutputs });
      return evaluatedTask(workspace, task);
    });

    const results = await runCompetitivePilot(
      { ...inputs, outputRoot, modelDriver },
      {
        createPublicAdapter,
        evaluate,
        extractArchive: extractFrom(inputs.source),
        proveSafety: async () => denied,
        verifyRuntime: verifiedRuntime,
        validateFrozenInputs: async () => {},
        now: (() => { let value = 100; return () => value += 5; })(),
      },
    );

    expect(results).toHaveLength(6);
    expect(results.every(result => result.status === "passed")).toBe(true);
    expect(results.every(result => result.toolCalls === 2)).toBe(true);
    expect(modelVisible).toHaveLength(6);
    expect(modelVisible.every(entry => entry.keys.sort().join(",") === "broker,deadlineMs,maxGeneratedTokens,prompt,requestTimeoutMs")).toBe(true);
    expect(modelVisible.every(entry => Object.keys(entry.search.arguments).sort().join(",") === "limit,query")).toBe(true);
    expect(publicQueries).toHaveLength(4);
    expect(publicQueries).toEqual(Array(4).fill({ query: "public model query", limit: 7 }));
    expect(indexedRoots).toHaveLength(4);
    expect(evaluated).toHaveLength(10);

    const modelFacing = JSON.stringify({ modelVisible, publicQueries });
    for (const task of PILOT_MANIFEST.tasks) {
      expect(modelFacing).not.toContain(JSON.stringify(task.hiddenExpectedOutputs));
      expect(modelFacing).not.toContain("hiddenExpectedOutputs");
    }
    expect(modelFacing).not.toContain("HIDDEN_TEST_SENTINEL");
    expect(modelFacing).not.toContain("HIDDEN_GIT_SENTINEL");

    const plan = JSON.parse(fs.readFileSync(path.join(outputRoot, "run-plan.json"), "utf8"));
    expect(plan.seed).toBe(PILOT_ORDER_SEED);
    expect(plan.model).toEqual(PILOT_MANIFEST.model);
    expect(plan.limits).toEqual(PILOT_MANIFEST.limits);
    expect(plan.conditions.map(({ id }: { id: string }) => id)).toEqual([...PILOT_CONDITIONS]);
    expect(plan.runtime.evaluator.sha256).toBe(EVALUATOR_NODE_SHA256);
    expect(plan.order).toEqual(results.map(({ taskId, condition, orderIndex }) => ({ taskId, condition, orderIndex })));
    expect(JSON.stringify(plan)).not.toContain("hiddenExpectedOutputs");
    expect(JSON.stringify(plan)).not.toContain("evaluatorInputs");

    for (const result of results) {
      const runDirectory = fs.readdirSync(path.join(outputRoot, "runs")).find(name => name.startsWith(String(result.orderIndex).padStart(2, "0")));
      expect(runDirectory).toBeDefined();
      const workspace = path.join(outputRoot, "runs", runDirectory!, "workspace");
      expect(fs.existsSync(path.join(workspace, "tests"))).toBe(false);
      expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
      expect(fs.existsSync(path.join(outputRoot, "runs", runDirectory!, "result.json"))).toBe(true);
    }

    const lifecycle = events.filter(event => event.startsWith("model:") || event.startsWith("evaluate:"));
    expect(lifecycle).toHaveLength(12);
    for (let index = 0; index < lifecycle.length; index += 2) {
      expect(lifecycle[index]).toMatch(/^model:/);
      expect(lifecycle[index + 1]).toMatch(/^evaluate:/);
    }
  });

  it("fails closed before extraction or model access when the source archive hash is wrong", async () => {
    const inputs = createLockedInputs();
    fs.appendFileSync(inputs.archive, "tampered");
    const extractArchive = vi.fn(extractFrom(inputs.source));
    const modelDriver: ModelDriver = { run: vi.fn() };

    await expect(runCompetitivePilot(
      { ...inputs, outputRoot: path.join(inputs.scratchRoot, "results", "bad-output"), modelDriver },
      { extractArchive },
    )).rejects.toThrow("Axios source archive hash mismatch");
    expect(extractArchive).not.toHaveBeenCalled();
    expect(modelDriver.run).not.toHaveBeenCalled();
  });

  it("retains model failure transcript, token usage, diff, and continues later cells", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "results", "failure-output");
    let calls = 0;
    const modelDriver: ModelDriver = {
      async run(context) {
        calls += 1;
        await context.broker.execute({
          name: "replace_unique",
          arguments: {
            path: "lib/helpers/isAbsoluteURL.js",
            oldText: "export default",
            newText: "// candidate edit\nexport default",
          },
        });
        if (calls === 1) throw new PilotModelError("sentinel model failure", [{ raw: "transcript" }], 13, 5);
        return { text: "done", promptTokens: 2, generatedTokens: 1, transcript: [] };
      },
    };

    const results = await runCompetitivePilot(
      { ...inputs, outputRoot, modelDriver },
      {
        createPublicAdapter: () => ({
          async index() {},
          async query() { return { status: "success" as const, paths: [], raw: {}, durationMs: 0 }; },
          async close() {},
        }),
        evaluate: async (workspace, task) => evaluatedTask(workspace, task, workspace.endsWith("public-source")),
        extractArchive: extractFrom(inputs.source),
        proveSafety: async () => denied,
        verifyRuntime: verifiedRuntime,
        validateFrozenInputs: async () => {},
      },
    );

    expect(results).toHaveLength(6);
    expect(results[0].status).toBe("failed");
    expect(results.every(result => result.toolCalls === 1)).toBe(true);
    expect(results[0].error).toMatchObject({
      name: "PilotModelError",
      message: "sentinel model failure",
      transcript: [{ raw: "transcript" }],
      promptTokens: 13,
      generatedTokens: 5,
    });
    expect(results[0].diff.changedFiles).toEqual([
      expect.objectContaining({ path: "lib/helpers/isAbsoluteURL.js" }),
    ]);
    expect(fs.existsSync(path.join(outputRoot, "summary.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(outputRoot, "progress.json"), "utf8")).completed).toHaveLength(6);
  });

  it.each(["reference-fails", "mutant-passes", "mutant-crashes", "mutant-malformed"])(
    "blocks every model and index call when preflight %s",
    async failure => {
      const inputs = createLockedInputs();
      const outputRoot = path.join(inputs.scratchRoot, failure);
      const modelDriver: ModelDriver = { run: vi.fn() };
      const dependencies = fakeDependencies(inputs.source);
      const createPublicAdapter = vi.fn(dependencies.createPublicAdapter!);
      dependencies.createPublicAdapter = createPublicAdapter;
      dependencies.evaluate = async (workspace, task) => {
        const result = evaluatedTask(workspace, task);
        if (workspace.endsWith("public-source") && failure === "reference-fails") return { ...result, passed: false };
        if (workspace.includes("preflight-mutants")) {
          if (failure === "mutant-passes") return { ...result, passed: true };
          if (failure === "mutant-crashes") return { ...result, exitCode: 1, stderr: "runtime failure" };
          if (failure === "mutant-malformed") return { ...result, stdout: "not JSON" };
        }
        return result;
      };
      await expect(runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, dependencies)).rejects.toThrow();
      expect(modelDriver.run).not.toHaveBeenCalled();
      expect(createPublicAdapter).not.toHaveBeenCalled();
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, "preflight.json"), "utf8"));
      expect(artifact.status).toBe("failed");
      expect(artifact.tasks[0].reference).toBeDefined();
      expect(artifact.tasks[0].mutant).toBeDefined();
      expect(artifact.error).toBeDefined();
    },
  );

  it.each(["generic", "pilot", "limit"])("retains attempted counts when model execution fails with %s error", async kind => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, `counts-${kind}`);
    const attempted = kind === "limit" ? MAX_TOOL_CALLS + 1 : 2;
    const modelDriver: ModelDriver = {
      async run({ broker }) {
        const transcript: unknown[] = [];
        for (let index = 0; index < attempted; index += 1) {
          const result = await broker.execute(index === 1
            ? { name: "read", arguments: { path: "tests/hidden.js" } }
            : { name: "list", arguments: { path: "." } });
          transcript.push(result);
          if (index === 1) expect(result.ok).toBe(false);
          if (kind === "limit" && index === MAX_TOOL_CALLS) expect(result.error).toBe("tool call limit exceeded");
        }
        if (kind === "generic") throw new Error("generic failure after tools");
        throw new PilotModelError(kind === "limit" ? "tool call limit exceeded" : "model failure after tools", transcript, 11, 7);
      },
    };
    const results = await runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, fakeDependencies(inputs.source));
    for (const result of results) {
      expect(result.status).toBe("failed");
      expect(result.toolCalls).toBe(attempted);
      expect(result.error?.message).toContain(kind === "limit" ? "tool call limit exceeded" : "failure after tools");
      if (kind !== "generic") {
        expect(result.error?.transcript).toHaveLength(attempted);
        expect(result.error).toMatchObject({ promptTokens: 11, generatedTokens: 7 });
      }
    }
  });

  it.each(Object.keys(denied) as Array<keyof SandboxProbeResult>)("blocks inference when %s is not proven", async missing => {
    const inputs = createLockedInputs();
    const modelDriver: ModelDriver = { run: vi.fn() };
    const dependencies = fakeDependencies(inputs.source);
    dependencies.proveSafety = async () => ({ ...denied, [missing]: false });
    await expect(runCompetitivePilot({ ...inputs, outputRoot: path.join(inputs.scratchRoot, missing), modelDriver }, dependencies))
      .rejects.toThrow("all four sandbox denials");
    expect(modelDriver.run).not.toHaveBeenCalled();
  });

  it.each(["frozen-tools", "model-digest"])("rejects %s verification failures before calibration or inference", async gate => {
    const inputs = createLockedInputs();
    const modelDriver: ModelDriver = { run: vi.fn() };
    const dependencies = fakeDependencies(inputs.source);
    const extractArchive = vi.fn(extractFrom(inputs.source));
    dependencies.extractArchive = extractArchive;
    if (gate === "frozen-tools") dependencies.validateFrozenInputs = async () => { throw new Error("frozen tool hash mismatch"); };
    else dependencies.verifyRuntime = async () => { throw new Error("pinned Ollama model digest is unavailable"); };
    await expect(runCompetitivePilot({ ...inputs, outputRoot: path.join(inputs.scratchRoot, gate), modelDriver }, dependencies)).rejects.toThrow();
    expect(modelDriver.run).not.toHaveBeenCalled();
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it("rejects a symlink output parent before creating anything through it", async () => {
    const inputs = createLockedInputs();
    const outside = directory("outside-output");
    fs.symlinkSync(outside, path.join(inputs.scratchRoot, "alias"));
    await expect(runCompetitivePilot({ ...inputs, outputRoot: path.join(inputs.scratchRoot, "alias", "nested", "pilot") }, fakeDependencies(inputs.source)))
      .rejects.toThrow("symlinks");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects reused output without modifying earlier evidence", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "existing");
    write(outputRoot, "sentinel", "prior evidence");
    await expect(runCompetitivePilot({ ...inputs, outputRoot }, fakeDependencies(inputs.source))).rejects.toThrow();
    expect(fs.readFileSync(path.join(outputRoot, "sentinel"), "utf8")).toBe("prior evidence");
  });

  it("keeps adapter .gitignore setup changes out of the model patch", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "setup-boundary");
    const dependencies = fakeDependencies(inputs.source);
    dependencies.createPublicAdapter = (_condition, options) => ({
      async index() { write(options.projectRoot, ".gitignore", ".codegraph/\n"); },
      async query() { return { status: "success" as const, paths: [], raw: {}, durationMs: 0 }; },
      async close() {},
    });
    const modelDriver: ModelDriver = {
      async run(context) {
        const runDirectory = path.dirname(context.broker.root);
        const baseline = JSON.parse(fs.readFileSync(path.join(runDirectory, "before-source.json"), "utf8"));
        if (fs.existsSync(path.join(context.broker.root, ".gitignore"))) expect(baseline[".gitignore"]).toBe(".codegraph/\n");
        await repairTask(context);
        return { text: "done", promptTokens: 1, generatedTokens: 1, transcript: [] };
      },
    };
    const results = await runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, dependencies);
    for (const result of results) {
      expect(result.status).toBe("passed");
      expect(result.patchValidity.valid).toBe(true);
      expect(result.diff.changedFiles.map(change => change.path)).toEqual([result.patchValidity.expectedFile]);
      expect(result.setupDiff.changedFiles.map(change => change.path)).toEqual(result.condition === "literal-unindexed" ? [] : [".gitignore"]);
    }
  });

  it.each(["no-patch", "extra-source"])("does not accept hidden-test success with %s", async invalid => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, invalid);
    const modelDriver: ModelDriver = {
      async run(context) {
        if (invalid === "extra-source") {
          await repairTask(context);
          const task = PILOT_MANIFEST.tasks.find(candidate => candidate.prompt === context.prompt)!;
          const extra = PILOT_MANIFEST.tasks.find(candidate => candidate.id !== task.id)!;
          expect((await context.broker.execute({ name: "replace_unique", arguments: {
            path: extra.mutation.file, oldText: "export default", newText: "// unexpected edit\nexport default",
          } })).ok).toBe(true);
        }
        return { text: "done", promptTokens: 1, generatedTokens: 1, transcript: [] };
      },
    };
    const results = await runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, fakeDependencies(inputs.source));
    for (const result of results) {
      expect(result.evaluator?.passed).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.patchValidity.valid).toBe(false);
      expect(result.patchValidity.unexpectedFiles).toHaveLength(invalid === "extra-source" ? 1 : 0);
      expect(result.patchValidity.reason).toContain("exactly");
    }
  });

  it("records unexpected setup source changes for review before model access", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "setup-source-review");
    const dependencies = fakeDependencies(inputs.source);
    dependencies.createPublicAdapter = (_condition, options) => ({
      async index() { fs.appendFileSync(path.join(options.projectRoot, "lib/helpers/isAbsoluteURL.js"), "// indexer change\n"); },
      async query() { return { status: "success" as const, paths: [], raw: {}, durationMs: 0 }; },
      async close() {},
    });
    const modelDriver: ModelDriver = { run: vi.fn(async (context: ModelDriverContext) => {
      await repairTask(context);
      return { text: "done", promptTokens: 1, generatedTokens: 1, transcript: [] };
    }) };
    const results = await runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, dependencies);
    expect(modelDriver.run).toHaveBeenCalledTimes(2);
    for (const result of results.filter(candidate => candidate.condition !== "literal-unindexed")) {
      expect(result.status).toBe("failed");
      expect(result.patchValidity.unexpectedSetupFiles).toEqual(["lib/helpers/isAbsoluteURL.js"]);
      expect(result.setupDiff.changedFiles).toHaveLength(1);
      expect(result.diff.changedFiles).toHaveLength(0);
      expect(result.error?.message).toContain("requiring review");
    }
  });

  it("uses the same excluded index scope for source copy, broker and final diffs", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "index-scope");
    for (const segment of FORBIDDEN_SEGMENTS) write(inputs.source, `${segment}/metadata`, "excluded");
    const dependencies = fakeDependencies(inputs.source);
    dependencies.createPublicAdapter = (_condition, options) => ({
      async index() {
        for (const segment of FORBIDDEN_SEGMENTS) {
          expect(fs.existsSync(path.join(options.projectRoot, segment))).toBe(false);
          write(options.projectRoot, `${segment}/metadata`, "tool-generated index");
        }
      },
      async query() { return { status: "success" as const, paths: [], raw: {}, durationMs: 0 }; },
      async close() {},
    });
    const modelDriver: ModelDriver = {
      async run({ broker }) {
        const files = await broker.execute({ name: "list", arguments: {} });
        expect(JSON.stringify(files)).not.toContain("metadata");
        return { text: "done", promptTokens: 1, generatedTokens: 1, transcript: [] };
      },
    };
    const results = await runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, dependencies);
    expect(results.every(result => result.diff.changedFiles.length === 0 && !result.diff.error)).toBe(true);
  });

  it("retains model usage and baseline when adapter cleanup and the final snapshot fail", async () => {
    const inputs = createLockedInputs();
    const outputRoot = path.join(inputs.scratchRoot, "teardown-errors");
    const dependencies = fakeDependencies(inputs.source);
    dependencies.createPublicAdapter = (_condition, options) => ({
      async index() {},
      async query() { return { status: "success" as const, paths: [], raw: {}, durationMs: 0 }; },
      async close() {
        fs.symlinkSync(path.join(options.projectRoot, "README.md"), path.join(options.projectRoot, "lib", "snapshot-link.js"));
        throw new Error("owned cleanup sentinel");
      },
    });
    const modelDriver: ModelDriver = {
      async run({ broker }) {
        await broker.execute({ name: "replace_unique", arguments: { path: "lib/helpers/isAbsoluteURL.js", oldText: "export default", newText: "// edit\nexport default" } });
        return { text: "done", promptTokens: 17, generatedTokens: 4, transcript: [{ preserved: true }] };
      },
    };
    const results = await runCompetitivePilot({ ...inputs, outputRoot, modelDriver }, dependencies);
    const indexed = results.filter(result => result.condition !== "literal-unindexed");
    expect(indexed).toHaveLength(4);
    for (const result of indexed) {
      expect(result.status).toBe("failed");
      expect(result.model).toMatchObject({ promptTokens: 17, generatedTokens: 4, transcript: [{ preserved: true }] });
      expect(result.toolCalls).toBe(1);
      expect(result.error?.message).toContain("owned cleanup sentinel");
      expect(result.diff.error?.message).toContain("symlink");
      const runDirectory = fs.readdirSync(path.join(outputRoot, "runs")).find(name => name.startsWith(String(result.orderIndex).padStart(2, "0")))!;
      const artifactDir = path.join(outputRoot, "runs", runDirectory);
      expect(fs.existsSync(path.join(artifactDir, "before-source.json"))).toBe(true);
      expect(fs.existsSync(path.join(artifactDir, "model.json"))).toBe(true);
      expect(fs.readFileSync(path.join(artifactDir, "workspace", "lib/helpers/isAbsoluteURL.js"), "utf8")).toContain("// edit");
    }
  });
});
