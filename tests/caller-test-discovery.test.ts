import type { CodebaseContextInput } from "../src/tools/context.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { resolveCodebaseContext } from "../src/tools/context.js";
import { configCache, getIndexerCacheKey, indexerCache } from "../src/tools/operation-runtime.js";
import { TEST_DISCOVERY_MAX_FILE_BYTES } from "../src/tools/test-discovery.js";

let root: string;
let indexer: Indexer;

async function writeSource(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
  await fs.writeFile(path.join(root, filePath), content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "caller-test-discovery-"));
  const config = parseConfig({
    indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
    search: { minScore: 0 },
  });
  indexer = new Indexer(root, config, "opencode");
  const key = getIndexerCacheKey(root, "opencode");
  configCache.set(key, config);
  indexerCache.set(key, indexer);
  await writeSource("src/gate.ts", `export function signalGate(inputs: boolean[]) {
  return inputs.every(Boolean);
}
`);
  await writeSource("src/transport.ts", `import { signalGate } from './gate.js';
export function createTransport(inputs: boolean[]) {
  const fetch = () => signalGate(inputs);
  return fetch();
}
`);
  await writeSource("tests/a-related.test.ts", `import { createTransport } from '../src/transport.js';
it('createTransport - returns the caller result', () => {
  expect(createTransport([true, false])).toBe(false);
});
`);
  await writeSource("tests/z-direct.test.ts", `import { signalGate } from '../src/gate.js';
it('signalGate - rejects a false input directly', () => {
  expect(signalGate([true, false])).toBe(false);
});
`);
  await writeSource("tests/decoy.test.ts", `import { signalGate } from '../src/gate.js';
it('contains spelling but no target execution', () => {
  // signalGate([false]);
  expect('signalGate([false])').toContain('signalGate');
  expect(signalGateExtra([false])).toBe(false);
  expect(unrelated.signalGate([false])).toBe(false);
});
`);
});

afterEach(async () => {
  await indexer.close();
  const key = getIndexerCacheKey(root, "opencode");
  indexerCache.delete(key);
  configCache.delete(key);
  await fs.rm(root, { recursive: true, force: true });
});

function retrieve(options: Partial<CodebaseContextInput> = {}) {
  return resolveCodebaseContext(root, "opencode", { query: "tests for signalGate", tokenBudget: 1200, ...options });
}

describe("caller-aware test evidence", () => {
  it("selects direct target references before related caller tests without claiming invariant coverage", async () => {
    await indexer.index();
    const response = await retrieve();
    expect(response.details?.results?.map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind,
      start: result.startLine, end: result.endLine, referenced: result.referencedSymbol,
    }))).toEqual([
      { file: "tests/z-direct.test.ts", kind: "direct_target_test_reference", start: 2, end: 4, referenced: "signalGate" },
      { file: "tests/a-related.test.ts", kind: "related_caller_test_reference", start: 2, end: 4, referenced: "createTransport" },
    ]);
    const citations = [...response.text.matchAll(/^\[(\d+)\] \S+(?: "(?:\\.|[^"\\])*")? in (.+?):(\d+)-(\d+) \(score[^\n]*\)/gmu)];
    expect(citations.map((citation) => ({
      file: citation[2], start: Number(citation[3]), end: Number(citation[4]),
    }))).toEqual(response.details?.results?.map((result) => ({
      file: result.filePath, start: result.startLine, end: result.endLine,
    })));
    const limited = await retrieve({ limit: 1, tokenBudget: 128 });
    expect(limited.details?.results?.map((result) => result.evidenceKind)).toEqual(["direct_target_test_reference"]);
    expect(limited.details?.tokenEstimate).toBeLessThanOrEqual(128);
  });

  it("selects a related test for the target behavior before an alphabetically earlier unrelated caller use at limit one", async () => {
    await writeSource("src/gate.ts", `export function serializeEnvelope(value: Record<string, string>) {
  return JSON.stringify(value);
}
`);
    await writeSource("src/transport.ts", `import { serializeEnvelope } from './gate.js';
export function sendBatch(value: Record<string, string>) {
  return serializeEnvelope(value);
}
`);
    await writeSource("tests/a-related.test.ts", `import { sendBatch } from '../src/transport.js';
it('accepts an empty batch', () => {
  expect(sendBatch({})).toBe('{}');
});
`);
    await writeSource("tests/z-related-behavior.test.ts", `import { sendBatch } from '../src/transport.js';
it('serialized envelopes preserve metadata', () => {
  const envelopes = { author: 'Ada' };
  expect(sendBatch(envelopes)).toContain('author');
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for serializeEnvelope", limit: 1 });
    expect(response.details?.results?.map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
    }))).toEqual([
      { file: "tests/z-related-behavior.test.ts", kind: "related_caller_test_reference", referenced: "sendBatch" },
    ]);
  });

  it("finds relevant tests after more than 200 alphabetic decoys without provider requests", async () => {
    for (let index = 0; index < 210; index += 1) {
      await writeSource(`tests/000-decoys/group-${Math.floor(index / 70)}/decoy-${String(index).padStart(3, "0")}.test.ts`, `it('independent arithmetic', () => {
  expect(1 + 1).toBe(2);
});
`);
    }
    const providerRequests = vi.spyOn(globalThis, "fetch");
    try {
      await indexer.index();
      const inventory = (await indexer.getIndexedFilePathsForActiveBranch()).map((filePath) => path.relative(root, filePath)).sort();
      expect(inventory.indexOf("tests/z-direct.test.ts")).toBeGreaterThanOrEqual(200);
      expect(inventory.indexOf("tests/a-related.test.ts")).toBeGreaterThanOrEqual(200);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        const response = await retrieve();
        expect(response.details?.results?.map((result) => ({
          file: path.relative(root, result.filePath), kind: result.evidenceKind,
        }))).toEqual([
          { file: "tests/z-direct.test.ts", kind: "direct_target_test_reference" },
          { file: "tests/a-related.test.ts", kind: "related_caller_test_reference" },
        ]);
        expect(response.details?.testDiscovery?.scannedFileCount).toBeLessThanOrEqual(200);
      }
      expect(providerRequests).not.toHaveBeenCalled();
    } finally {
      providerRequests.mockRestore();
    }
  });

  it("keeps returned test scopes hard, while allowing internal navigation outside the test directory", async () => {
    await indexer.index();
    const scoped = await retrieve({ directory: " ./tests/ ", fileType: " .TS " });
    expect(scoped.details?.results?.map((result) => result.evidenceKind)).toEqual([
      "direct_target_test_reference", "related_caller_test_reference",
    ]);
    for (const allowUnscopedRecovery of [undefined, false]) {
      const missed = await retrieve({ directory: " ./missing\\scope/ ", fileType: " .PY ", allowUnscopedRecovery });
      expect(missed.details?.results ?? []).toEqual([]);
      expect(missed.details?.recovery?.attempts.flatMap((attempt) => attempt.relaxedFields)).toEqual([]);
    }
    const recovered = await retrieve({ directory: "missing/scope", fileType: "py", allowUnscopedRecovery: true });
    expect(recovered.details?.results?.map((result) => result.evidenceKind)).toEqual([
      "direct_target_test_reference", "related_caller_test_reference",
    ]);
    expect(recovered.details?.recovery?.attempts.map((attempt) => ({
      scope: attempt.scope, relaxedFields: attempt.relaxedFields,
    }))).toEqual([
      { scope: "scoped", relaxedFields: [] },
      { scope: "scoped", relaxedFields: [] },
      { scope: "unscoped", relaxedFields: ["directory", "fileType"] },
    ]);
    expect(recovered.text).toContain("filter removed");
  });

  it("keeps scoped alias evidence identical before any opted-in unscoped recovery", async () => {
    await writeSource("tests/aliases/alias.test.ts", `import { signalGate as localGate } from '../../src/gate.js';
it('signalGate rejects false input through an alias', () => {
  expect(localGate([true, false])).toBe(false);
});
`);
    await indexer.index();
    const scope = { directory: " ./tests\\aliases/ ", fileType: " .TS " };
    const omitted = await retrieve(scope);
    expect(omitted.details?.results?.map((result) => ({
      file: path.relative(root, result.filePath),
      start: result.startLine, end: result.endLine, evidenceKind: result.evidenceKind,
    }))).toEqual([{
      file: "tests/aliases/alias.test.ts", start: 2, end: 4, evidenceKind: undefined,
    }]);
    expect(omitted.details?.recovery?.attempts).toEqual([
      { kind: "conceptual", scope: "scoped", resultCount: 0, relaxedFields: [] },
      { kind: "conceptual", scope: "scoped", resultCount: 1, relaxedFields: [] },
    ]);
    for (const allowUnscopedRecovery of [false, true]) {
      expect(await retrieve({ ...scope, allowUnscopedRecovery })).toStrictEqual(omitted);
    }
  });

  it("does not manufacture relationships for missing targets, ambiguous definitions, or stale caller edges", async () => {
    await indexer.index();
    const missing = await retrieve({ query: "tests for missingGate" });
    expect(missing.details?.testDiscovery?.resolution).toBe("not_found");
    expect(missing.details?.results?.filter((result) => result.evidenceKind) ?? []).toEqual([]);
    await writeSource("src/transport.ts", `export function createTransport(inputs: boolean[]) {
  return inputs.some(Boolean);
}
`);
    const stale = await retrieve();
    expect(stale.details?.results?.map((result) => result.evidenceKind)).toEqual(["direct_target_test_reference"]);
    await writeSource("src/duplicate.ts", "export function signalGate(inputs: boolean[]) { return false; }\n");
    await indexer.index();
    const ambiguous = await retrieve();
    expect(ambiguous.details?.testDiscovery?.resolution).toBe("ambiguous");
    expect(ambiguous.details?.results?.filter((result) => result.evidenceKind) ?? []).toEqual([]);
  });

  it("keeps explicit symbols definition-only and multi-identifier or qualified test questions on the ordinary route", async () => {
    await indexer.index();
    const explicit = await retrieve({ symbol: "signalGate" });
    expect(explicit.details?.route).toBe("definition");
    expect(explicit.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual(["src/gate.ts"]);
    expect(explicit.details?.testDiscovery).toBeUndefined();
    const multiple = await retrieve({ query: "tests for signalGate and createTransport" });
    expect(multiple.details?.testDiscovery).toBeUndefined();
    const qualified = await retrieve({ query: "tests for signalGate rejects false input" });
    expect(qualified.details?.testDiscovery).toBeUndefined();
    expect(qualified.details?.results?.map((result) => path.relative(root, result.filePath))).toContain("tests/z-direct.test.ts");
  });

  it("rejects same-name foreign imports and preserves useful unlabelled scoped fallback", async () => {
    await writeSource("tests/foreign/import.test.ts", `import { signalGate, createTransport } from 'unrelated-external-package';
it('signalGate and createTransport use a different package', () => {
  expect(signalGate([false])).toBe(false);
  expect(createTransport([false])).toBe(false);
});
`);
    await indexer.index();
    const linked = await retrieve();
    expect(linked.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual([
      "tests/z-direct.test.ts", "tests/a-related.test.ts",
    ]);
    const foreignOnly = await retrieve({ directory: "tests/foreign" });
    expect(foreignOnly.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual([
      "tests/foreign/import.test.ts",
    ]);
    expect(foreignOnly.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
    expect(foreignOnly.text).not.toContain("Direct target test reference");
    expect(foreignOnly.text).not.toContain("Related caller test");
  });

  it("does not label destructured shadow calls as direct target references", async () => {
    await writeSource("tests/shadows/destructured.test.ts", `import { signalGate } from '../../src/gate.js';
it('signalGate is shadowed by a local destructured binding', () => {
  const { signalGate } = unrelatedRegistry;
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/shadows" });
    expect(response.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual([
      "tests/shadows/destructured.test.ts",
    ]);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("rejects parameter shadowing, escaped symlinks, oversized files, and unindexed tests", async () => {
    await writeSource("tests/shadow.test.ts", `it('uses a local parameter', (signalGate) => {
  expect(signalGate([true, false])).toBe(false);
});
`);
    await indexer.index();
    await writeSource("tests/unindexed.test.ts", `it('not in active inventory', () => {
  expect(signalGate([true, false])).toBe(false);
});
`);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "caller-test-outside-"));
    try {
      await fs.writeFile(path.join(outside, "external.ts"), `it('outside tree', () => {
  expect(signalGate([true, false])).toBe(false);
});
`);
      await fs.rm(path.join(root, "tests/z-direct.test.ts"));
      await fs.symlink(path.join(outside, "external.ts"), path.join(root, "tests/z-direct.test.ts"));
      const escaped = await retrieve();
      expect(escaped.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual(["tests/a-related.test.ts"]);
      await fs.rm(path.join(root, "tests/z-direct.test.ts"));
      await writeSource("tests/z-direct.test.ts", "x".repeat(TEST_DISCOVERY_MAX_FILE_BYTES + 1));
      const oversized = await retrieve();
      expect(oversized.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual(["tests/a-related.test.ts"]);
      expect(oversized.details?.testDiscovery?.capped).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("stops a cancelled traversal rather than returning a partial linked pack", async () => {
    await indexer.index();
    const abort = new AbortController();
    abort.abort();
    await expect(resolveCodebaseContext(root, "opencode", { query: "tests for signalGate" }, { signal: abort.signal }))
      .rejects.toThrow("cancelled");
  });
});
