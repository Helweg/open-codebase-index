import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyTaskMutation,
  evaluateCandidate,
  EVALUATOR_NODE_SHA256,
  fileSearchResult,
  FORBIDDEN_SEGMENTS,
  MAX_GENERATED_TOKENS,
  MAX_RUN_MS,
  MAX_TOOL_CALLS,
  OLLAMA_CONTEXT_TOKENS,
  OLLAMA_DIGEST,
  OLLAMA_ENDPOINT,
  OLLAMA_MODEL,
  OLLAMA_SEED,
  OllamaModelDriver,
  PILOT_LABEL,
  PILOT_MANIFEST,
  PILOT_SYSTEM_PROMPT,
  PilotBroker,
  PilotModelError,
  proveSandboxDenials,
  REQUEST_TIMEOUT_MS,
  literalSearchAdapter,
  verifyPilotRuntime,
  type PilotEvaluationOptions,
  type SearchAdapter,
  type SearchResult,
} from "../scripts/competitive-coding-pilot.js";

let tempDir: string;
let evaluatorRoot: string;

function evaluationOptions(): PilotEvaluationOptions {
  const runtimePath = process.env.PILOT_EVALUATOR_NODE_PATH;
  const version = process.env.PILOT_EVALUATOR_NODE_VERSION;
  if (!runtimePath || !version) throw new Error("sandbox tests require explicit PILOT_EVALUATOR_NODE_PATH and PILOT_EVALUATOR_NODE_VERSION");
  return { privateRoot: evaluatorRoot, runtime: { path: runtimePath, expectedVersion: version, expectedSha256: EVALUATOR_NODE_SHA256 } };
}

function write(relativePath: string, content: string): string {
  const target = path.join(tempDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function createAxiosFixture(): void {
  write("package.json", '{"type":"module"}\n');
  write(
    "lib/helpers/isAbsoluteURL.js",
    `'use strict';\nexport default function isAbsoluteURL(url) {\n  return /^([a-z][a-z\\d+\\-.]*:)?\\/\\//i.test(url);\n}\n`,
  );
  write(
    "lib/helpers/combineURLs.js",
    `'use strict';\nexport default function combineURLs(baseURL, relativeURL) {\n  return relativeURL\n    ? baseURL.replace(/\\/?\\/$/, '') + '/' + relativeURL.replace(/^\\/+/, '')\n    : baseURL;\n}\n`,
  );
  write("tests/hidden.js", "throw new Error('must not be visible');\n");
  write(".git/config", "secret\n");
  write("README.md", "fixture\n");
}

const emptySearch: SearchAdapter = async () => [];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "competitive-coding-pilot-test-"));
  evaluatorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "competitive-coding-evaluator-test-"));
  createAxiosFixture();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(evaluatorRoot, { recursive: true, force: true });
});

describe("frozen pilot manifest", () => {
  it("pins the local model, digest, common limits, and two synthetic tasks", () => {
    expect(PILOT_MANIFEST.label).toBe(PILOT_LABEL);
    expect(PILOT_MANIFEST.frozenBeforeCalls).toBe(true);
    expect(PILOT_MANIFEST.model).toEqual({
      name: OLLAMA_MODEL,
      digest: OLLAMA_DIGEST,
      endpoint: OLLAMA_ENDPOINT,
      seed: OLLAMA_SEED,
      numCtx: OLLAMA_CONTEXT_TOKENS,
      temperature: 0,
      think: "high",
      systemPrompt: PILOT_SYSTEM_PROMPT,
    });
    expect(PILOT_MANIFEST.limits).toEqual({
      maxToolCalls: MAX_TOOL_CALLS,
      maxGeneratedTokens: MAX_GENERATED_TOKENS,
      maxRunMs: MAX_RUN_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(PILOT_MANIFEST.tasks).toHaveLength(2);
    expect(PILOT_MANIFEST.conditions.map(({ id }) => id)).toEqual(["literal-unindexed", "ocbi-hybrid", "codegraph"]);
    expect(PILOT_MANIFEST.tasks.every((task) => task.label === "synthetic-regression-pilot")).toBe(true);
    expect(PILOT_MANIFEST.tasks.every((task) => !task.prompt.includes("lib/") && !task.prompt.includes("isAbsoluteURL"))).toBe(true);
  });

  it("applies each seeded mutation only when the frozen reference text is unique", () => {
    for (const task of PILOT_MANIFEST.tasks) {
      applyTaskMutation(tempDir, task);
      expect(fs.readFileSync(path.join(tempDir, task.mutation.file), "utf8")).toContain(task.mutation.newText);
      expect(() => applyTaskMutation(tempDir, task)).toThrow("mutation precondition failed");
      createAxiosFixture();
    }
  });
});

describe("PilotBroker confinement", () => {
  it("treats exact dot root-list aliases like omitted path with the same filtered files", async () => {
    for (const segment of FORBIDDEN_SEGMENTS) write(`${segment}/metadata`, "hidden");
    const broker = new PilotBroker(tempDir, emptySearch);
    const omitted = await broker.execute({ name: "list", arguments: {} });
    const dot = await broker.execute({ name: "list", arguments: { path: "." } });
    const dotSlash = await broker.execute({ name: "list", arguments: { path: "./" } });
    expect(omitted.ok).toBe(true);
    expect(dot).toEqual(omitted);
    expect(dotSlash).toEqual(omitted);
    expect(dot.output).toEqual([...broker.allowedFiles]);
    expect(dot.output).not.toBe(dotSlash.output);
    expect(JSON.stringify(dot.output)).not.toContain("metadata");
    expect(broker.callCount).toBe(3);
  });

  it.each([".", "./"])("does not allow root alias %s for reads, writes, or search results", async alias => {
    const broker = new PilotBroker(tempDir, async () => [{ filePath: alias, startLine: 1, endLine: 1 }]);
    expect((await broker.execute({ name: "read", arguments: { path: alias } })).ok).toBe(false);
    expect((await broker.execute({ name: "replace_unique", arguments: { path: alias, oldText: "old", newText: "new" } })).ok).toBe(false);
    expect((await broker.execute({ name: "search", arguments: { query: "anything" } })).ok).toBe(false);
  });

  it.each(["", "/", "..", "../outside", "././", "tests", ".git", ".codegraph"])("still rejects unsafe list path %s", async requested => {
    const broker = new PilotBroker(tempDir, emptySearch);
    expect((await broker.execute({ name: "list", arguments: { path: requested } })).ok).toBe(false);
  });

  it("lists only allowed files and never exposes tests or index metadata", async () => {
    for (const segment of FORBIDDEN_SEGMENTS) write(`${segment}/index/secret`, "index\n");
    write("lib/helper.test.js", "test sentinel");
    const broker = new PilotBroker(tempDir, emptySearch);
    const result = await broker.execute({ name: "list", arguments: {} });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("lib/helpers/isAbsoluteURL.js");
    expect(result.output).not.toContain("tests/hidden.js");
    expect(result.output).not.toContain(".git/config");
    expect(result.output).not.toContain(".codebase-index/index/secret");
    expect(result.output).not.toContain("lib/helper.test.js");
    expect(() => fileSearchResult(tempDir, "lib/helper.test.js")).toThrow("forbidden");
    for (const segment of FORBIDDEN_SEGMENTS) {
      expect(result.output).not.toContain(`${segment}/index/secret`);
      expect(() => fileSearchResult(tempDir, `${segment}/index/secret`)).toThrow("forbidden");
    }
  });

  it.each(["../outside", "/etc/passwd", "tests/hidden.js", ".git/config", ".codebase-index/index/secret", ".codegraph/db", ".grepai/index", ".opencode/index"])(
    "rejects forbidden or escaping read path %s",
    async (requestedPath) => {
      const broker = new PilotBroker(tempDir, emptySearch);
      const result = await broker.execute({ name: "read", arguments: { path: requestedPath } });
      expect(result.ok).toBe(false);
    },
  );

  it("rejects symlink escapes for reads and writes", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "competitive-pilot-outside-"));
    const outsideFile = path.join(outside, "outside.js");
    fs.writeFileSync(outsideFile, "outside\n");
    fs.symlinkSync(outsideFile, path.join(tempDir, "lib", "escape.js"));
    try {
      const broker = new PilotBroker(tempDir, emptySearch);
      const read = await broker.execute({ name: "read", arguments: { path: "lib/escape.js" } });
      const replace = await broker.execute({
        name: "replace_unique",
        arguments: { path: "lib/escape.js", oldText: "outside", newText: "changed" },
      });
      expect(read.ok).toBe(false);
      expect(replace.ok).toBe(false);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside\n");
      expect(() => fileSearchResult(tempDir, "lib/escape.js")).toThrow("symlink");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects internal symlink aliases to forbidden test content", async () => {
    const alias = path.join(tempDir, "lib", "hidden-alias.js");
    fs.symlinkSync(path.join("..", "tests", "hidden.js"), alias);
    const broker = new PilotBroker(tempDir, emptySearch);
    const read = await broker.execute({ name: "read", arguments: { path: "lib/hidden-alias.js" } });
    const list = await broker.execute({ name: "list", arguments: { path: "lib/hidden-alias.js" } });
    const replace = await broker.execute({
      name: "replace_unique",
      arguments: { path: "lib/hidden-alias.js", oldText: "must not", newText: "changed" },
    });
    expect(read.ok).toBe(false);
    expect(list.ok).toBe(false);
    expect(replace.ok).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, "tests", "hidden.js"), "utf8")).toContain("must not be visible");
  });

  it("rejects hardlinked files and leaves the outside inode unchanged", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "competitive-pilot-hardlink-"));
    const outsideFile = path.join(outside, "outside.js");
    fs.writeFileSync(outsideFile, "outside hardlink sentinel\n");
    fs.linkSync(outsideFile, path.join(tempDir, "lib", "hardlink.js"));
    try {
      const broker = new PilotBroker(tempDir, emptySearch);
      expect((await broker.execute({ name: "read", arguments: { path: "lib/hardlink.js" } })).ok).toBe(false);
      expect((await broker.execute({ name: "list", arguments: { path: "lib/hardlink.js" } })).ok).toBe(false);
      expect((await broker.execute({
        name: "replace_unique",
        arguments: { path: "lib/hardlink.js", oldText: "sentinel", newText: "changed" },
      })).ok).toBe(false);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside hardlink sentinel\n");
      expect(() => fileSearchResult(tempDir, "lib/hardlink.js")).toThrow("hardlinked");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes only an existing lib JavaScript file with one unique match", async () => {
    const broker = new PilotBroker(tempDir, emptySearch);
    const success = await broker.execute({
      name: "replace_unique",
      arguments: { path: "lib/helpers/isAbsoluteURL.js", oldText: "return /^", newText: "return /* fixed */ /^" },
    });
    expect(success).toEqual({ ok: true, output: { filePath: "lib/helpers/isAbsoluteURL.js", replacements: 1 } });

    const readme = await broker.execute({
      name: "replace_unique",
      arguments: { path: "README.md", oldText: "fixture", newText: "changed" },
    });
    const missing = await broker.execute({
      name: "replace_unique",
      arguments: { path: "lib/new.js", oldText: "x", newText: "y" },
    });
    expect(readme.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "lib/new.js"))).toBe(false);
  });

  it("rejects a non-unique replacement", async () => {
    write("lib/duplicate.js", "same same");
    const broker = new PilotBroker(tempDir, emptySearch);
    const result = await broker.execute({
      name: "replace_unique",
      arguments: { path: "lib/duplicate.js", oldText: "same", newText: "other" },
    });
    expect(result).toEqual({ ok: false, error: "oldText is not unique" });
  });

  it("validates injected search output and prevents hidden or escaping results", async () => {
    const hiddenSearch: SearchAdapter = async () => [{ filePath: "tests/hidden.js", startLine: 1, endLine: 1 }];
    const escapingSearch: SearchAdapter = async () => [{ filePath: "../outside.js", startLine: 1, endLine: 1 }];
    const hidden = await new PilotBroker(tempDir, hiddenSearch).execute({ name: "search", arguments: { query: "secret" } });
    const escaping = await new PilotBroker(tempDir, escapingSearch).execute({ name: "search", arguments: { query: "secret" } });
    expect(hidden.ok).toBe(false);
    expect(escaping.ok).toBe(false);
  });

  it("ignores adapter-provided content and derives snippets from the verified file range", async () => {
    const untrusted = {
      filePath: "lib/helpers/isAbsoluteURL.js",
      startLine: 2,
      endLine: 2,
      content: "forged hidden content",
      unexpectedMetadata: "must not be forwarded",
      score: 1,
    } as unknown as SearchResult;
    const broker = new PilotBroker(tempDir, async () => [untrusted]);
    const result = await broker.execute({ name: "search", arguments: { query: "anything", limit: 1 } });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual([
      expect.objectContaining({
        filePath: "lib/helpers/isAbsoluteURL.js",
        startLine: 2,
        endLine: 2,
        content: "export default function isAbsoluteURL(url) {",
      }),
    ]);
    expect(JSON.stringify(result.output)).not.toContain("unexpectedMetadata");
  });

  it("serializes concurrent search tool calls", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let invocation = 0;
    const search: SearchAdapter = async () => {
      invocation += 1;
      const current = invocation;
      events.push(`start-${current}`);
      if (current === 1) await firstBlocked;
      events.push(`end-${current}`);
      return [];
    };
    const broker = new PilotBroker(tempDir, search);
    const first = broker.execute({ name: "search", arguments: { query: "first" } });
    const second = broker.execute({ name: "search", arguments: { query: "second" } });
    await vi.waitFor(() => expect(events).toEqual(["start-1"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("fails closed after the twelfth tool call", async () => {
    const broker = new PilotBroker(tempDir, emptySearch);
    for (let index = 0; index < MAX_TOOL_CALLS; index += 1) {
      expect((await broker.execute({ name: "list", arguments: {} })).ok).toBe(true);
    }
    expect(await broker.execute({ name: "list", arguments: {} })).toEqual({ ok: false, error: "tool call limit exceeded" });
    expect(broker.callCount).toBe(MAX_TOOL_CALLS + 1);
  });

  it("provides a bounded literal unindexed search condition", async () => {
    const broker = new PilotBroker(tempDir, literalSearchAdapter);
    const result = await broker.execute({ name: "search", arguments: { query: "RFC", limit: 5 } });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual([]);
    const matched = await broker.execute({ name: "search", arguments: { query: "isAbsoluteURL", limit: 5 } });
    expect(matched.ok).toBe(true);
    expect(matched.output).toEqual([expect.objectContaining({ filePath: "lib/helpers/isAbsoluteURL.js" })]);
  });
});

describe("OllamaModelDriver", () => {
  it("pins every request to loopback, verifies the digest, and uses the frozen options", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: OLLAMA_MODEL, digest: OLLAMA_DIGEST }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: { role: "assistant", content: "done", tool_calls: [] }, prompt_eval_count: 11, eval_count: 7 }), { status: 200 });
    });
    const driver = new OllamaModelDriver(fetchMock);
    const result = await driver.run({
      prompt: "same prompt",
      broker: new PilotBroker(tempDir, emptySearch),
      deadlineMs: Date.now() + 10_000,
      maxGeneratedTokens: MAX_GENERATED_TOKENS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result.promptTokens).toBe(11);
    expect(result.generatedTokens).toBe(7);
    expect(requests.every(({ url }) => url.startsWith(`${OLLAMA_ENDPOINT}/`))).toBe(true);
    const body = JSON.parse(requests[1].init.body as string);
    expect(body).toMatchObject({ model: OLLAMA_MODEL, stream: false, think: "high" });
    expect(body.options).toEqual({
      num_predict: MAX_GENERATED_TOKENS,
      temperature: 0,
      seed: OLLAMA_SEED,
      num_ctx: OLLAMA_CONTEXT_TOKENS,
    });
    expect(body.messages[0].role).toBe("system");
  });

  it("refuses a same-name model with a different digest before chat", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: OLLAMA_MODEL, digest: "wrong" }] }), { status: 200 }));
    const driver = new OllamaModelDriver(fetchMock);
    await expect(driver.run({
      prompt: "prompt",
      broker: new PilotBroker(tempDir, emptySearch),
      deadlineMs: Date.now() + 10_000,
      maxGeneratedTokens: MAX_GENERATED_TOKENS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })).rejects.toThrow("pinned Ollama model digest is unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, -1, 1.5, Number.NaN])("rejects invalid eval_count %s and preserves failure artifacts", async (evalCount) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: OLLAMA_MODEL, digest: OLLAMA_DIGEST }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: { role: "assistant", content: "done" }, prompt_eval_count: 3, eval_count: evalCount }), { status: 200 });
    });
    const driver = new OllamaModelDriver(fetchMock);
    const error = await driver.run({
      prompt: "prompt",
      broker: new PilotBroker(tempDir, emptySearch),
      deadlineMs: Date.now() + 10_000,
      maxGeneratedTokens: MAX_GENERATED_TOKENS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(PilotModelError);
    expect((error as PilotModelError).message).toBe("Ollama response has invalid eval_count");
    expect((error as PilotModelError).promptTokens).toBe(3);
    expect((error as PilotModelError).generatedTokens).toBe(0);
  });
});

describe("explicit evaluator gate", () => {
  it("fails closed without runtime options and never falls back to the host runtime", async () => {
    await expect(proveSandboxDenials(tempDir)).rejects.toThrow("explicit evaluator runtime");
    await expect(evaluateCandidate(tempDir, PILOT_MANIFEST.tasks[0])).rejects.toThrow("explicit evaluator runtime");
  });

  it("rejects a non-frozen runtime identity before launching any subprocess", async () => {
    await expect(verifyPilotRuntime({ path: process.execPath, expectedVersion: process.version, expectedSha256: "0".repeat(64) }))
      .rejects.toThrow("frozen standalone Node 24");
  });

  it("rejects evaluator storage within candidate source", async () => {
    await expect(evaluateCandidate(tempDir, PILOT_MANIFEST.tasks[0], {
      privateRoot: tempDir,
      runtime: { path: process.execPath, expectedVersion: "v24.0.0", expectedSha256: EVALUATOR_NODE_SHA256 },
    })).rejects.toThrow("disjoint");
  });
});

// Explicit opt-in separates ordinary mocked/unit validation from the coordinator's
// authorized subprocess calibration window. Missing runtime configuration fails.
describe.runIf(process.env.COMPETITIVE_PILOT_SANDBOX_TESTS === "1")("sandbox evaluator", () => {
  it("proves outside reads, writes, network, and child processes are denied", async () => {
    await expect(proveSandboxDenials(tempDir, evaluationOptions())).resolves.toEqual({
      outsideReadDenied: true,
      outsideWriteDenied: true,
      networkDenied: true,
      childProcessDenied: true,
    });
  });

  it("fails each seeded regression and passes only after the reference repair", async () => {
    for (const task of PILOT_MANIFEST.tasks) {
      createAxiosFixture();
      applyTaskMutation(tempDir, task);
      const broken = await evaluateCandidate(tempDir, task, evaluationOptions());
      expect(broken.passed, `${task.id} should fail in seeded state: ${broken.stderr}`).toBe(false);
      expect(broken.exitCode).toBe(0);
      expect(broken.error).toBeUndefined();

      const target = path.join(tempDir, task.mutation.file);
      const content = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, content.replace(task.mutation.newText, task.mutation.oldText));
      const repaired = await evaluateCandidate(tempDir, task, evaluationOptions());
      expect(repaired.passed, `${task.id} should pass after reference repair: ${repaired.stdout}\n${repaired.stderr}`).toBe(true);
    }
  });

  it("compares expected outputs only in the parent, not in the child source", async () => {
    const task = PILOT_MANIFEST.tasks[0];
    const original = await evaluateCandidate(tempDir, task, evaluationOptions());
    const changedOracle = await evaluateCandidate(tempDir, { ...task, hiddenExpectedOutputs: [] }, evaluationOptions());
    expect(original.passed).toBe(true);
    expect(changedOracle.passed).toBe(false);
    expect(changedOracle.stdout).toBe(original.stdout);
  });

  it("does not accept candidate stdout spoofing or process termination", async () => {
    const task = PILOT_MANIFEST.tasks[0];
    const target = path.join(tempDir, task.mutation.file);
    fs.writeFileSync(target, `console.log('{"passed":true}');\nprocess.exit(0);\nexport default () => true;\n`);
    const result = await evaluateCandidate(tempDir, task, evaluationOptions());
    expect(result.passed).toBe(false);
    expect(result.stdout).not.toContain('"passed":true');
  });

  it("reaps a timed-out evaluator before removing its isolated workspace", async () => {
    const task = PILOT_MANIFEST.tasks[0];
    fs.writeFileSync(path.join(tempDir, task.mutation.file), "export default function stalled() { while (true) {} }\n");
    const result = await evaluateCandidate(tempDir, task, evaluationOptions());
    expect(result.passed).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.signal).toBe("SIGKILL");
    expect(fs.readdirSync(evaluatorRoot)).toEqual([]);
  });
});
