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

  it("rejects every comma-separated local declarator before resolving an imported target", async () => {
    await writeSource("tests/comma-shadow/shadow.test.ts", `import { signalGate } from '../../src/gate.js';
it('uses a local substitute instead of the imported target', () => {
  const sentinel = 0, signalGate = foreignGate;
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/comma-shadow" });
    expect(response.details?.results?.map((result) => path.relative(root, result.filePath))).toEqual([
      "tests/comma-shadow/shadow.test.ts",
    ]);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("does not attribute same-line or merged adjacent outside calls to a test callback", async () => {
    await writeSource("tests/outside/same-line.test.ts", `import { signalGate } from '../../src/gate.js';
it('unrelated registration has a long title to remain an independent indexed source unit', () => { expect(true).toBe(true); }); signalGate([false, false, false, false, false, false]);
`);
    await writeSource("tests/outside/adjacent.test.ts", `import { signalGate } from '../../src/gate.js';
it('independent arithmetic', () => { expect(true).toBe(true); });
signalGate([false, false, false, false, false, false]);
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/outside" });
    expect(new Set(response.details?.results?.map((result) => path.relative(root, result.filePath)))).toEqual(
      new Set(["tests/outside/same-line.test.ts", "tests/outside/adjacent.test.ts"]),
    );
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("keeps the strongest verified related reference after the twenty-reference boundary", async () => {
    await writeSource("tests/ranking/related.test.ts", `import { createTransport } from '../../src/transport.js';
${Array.from({ length: 20 }, (_, index) => `it('independent arithmetic preserves an ordinary transport result ${index}', () => {
  expect(createTransport([true])).toBeTruthy();
});
`).join("")}it('signal gate behavior honors false inputs', () => {
  expect(createTransport([true, false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/ranking", limit: 1 });
    expect(response.details?.results?.map((result) => ({
      start: result.startLine, end: result.endLine, score: result.score,
      kind: result.evidenceKind, referenced: result.referencedSymbol,
    }))).toEqual([{
      start: 62, end: 64, score: 0.75, kind: "related_caller_test_reference", referenced: "createTransport",
    }]);
    expect(response.details?.testDiscovery?.capped).toBe(true);
    const bounded = await retrieve({ directory: "tests/ranking", limit: 100, tokenBudget: 4000 });
    expect(bounded.details?.results).toHaveLength(20);
    expect(bounded.details?.results?.[0]?.startLine).toBe(62);
  });

  it("prioritizes selected test configuration over unrelated directories without asserting a foreign alias link", async () => {
    await writeSource("tsconfig.json", JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@logic/gate": ["src/gate.ts"] } },
    }));
    await writeSource("src/foreign.ts", "export function foreignGate(inputs: boolean[]) { return false; }\n");
    for (let index = 0; index < 60; index += 1) {
      await writeSource(`tests/config/a${String(index).padStart(2, "0")}/decoy.test.ts`,
        "it('independent arithmetic', () => { expect(1 + 1).toBe(2); });\n");
    }
    await writeSource("tests/config/zz/deep/tsconfig.json", JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@logic/gate": ["foreign.ts"] } },
    }));
    await writeSource("tests/config/zz/deep/foreign.ts",
      "export { foreignGate as signalGate } from '../../../../src/foreign.js';\n");
    await writeSource("tests/config/zz/deep/alias.test.ts", `import { signalGate } from '@logic/gate';
it('uses the foreign gate through the nearest configured alias', () => {
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/config" });
    expect(response.details?.results?.some((result) => result.filePath.endsWith("alias.test.ts"))).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("fails linkage closed when a selected deep configuration chain exceeds the read budget", async () => {
    await writeSource("tsconfig.json", JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@logic/gate": ["src/gate.ts"] } },
    }));
    const directory = `tests/config-budget/${Array.from({ length: 25 }, (_, index) => `d${index}`).join("/")}`;
    await writeSource(`${directory}/tsconfig.json`, JSON.stringify({ extends: "./base.json" }));
    await writeSource(`${directory}/base.json`, JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@logic/gate": ["foreign.ts"] } },
    }));
    await writeSource(`${directory}/foreign.ts`, "export function foreignGate(inputs: boolean[]) { return false; }\nexport { foreignGate as signalGate };\n");
    await writeSource(`${directory}/alias.test.ts`, `import { signalGate } from '@logic/gate';
it('uses signalGate through an incompletely probed local alias chain', () => {
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/config-budget" });
    expect(response.details?.testDiscovery?.capped).toBe(true);
    expect(response.details?.results?.some((result) => result.filePath.endsWith("alias.test.ts"))).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("rejects destructured declarations in for-of loop headers as imported target evidence", async () => {
    await writeSource("tests/loop-shadow/loop.test.ts", `import { signalGate } from '../../src/gate.js';
it('uses a destructured local substitute', () => {
  for (const { signalGate } of substitutes) {
    expect(signalGate([false])).toBe(false);
  }
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/loop-shadow" });
    expect(response.details?.results?.some((result) => result.filePath.endsWith("loop.test.ts"))).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("requires a bare JavaScript callee rather than an object or this receiver", async () => {
    for (const receiver of ["unrelated", "this"]) {
      await writeSource(`tests/js-methods/${receiver}.test.js`, `import { signalGate } from '../../src/gate.js';
it('uses a receiver method rather than the imported signalGate', function () {
  expect(${receiver}.signalGate([false])).toBe(false);
});
`);
    }
    await indexer.index();
    const response = await retrieve({ directory: "tests/js-methods" });
    expect(new Set(response.details?.results?.map((result) => path.relative(root, result.filePath)))).toEqual(
      new Set(["tests/js-methods/unrelated.test.js", "tests/js-methods/this.test.js"]),
    );
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("incorporates selected package manifests before resolving a conflicting self-reference", async () => {
    await writeSource("package.json", JSON.stringify({ name: "gate-package", type: "module", exports: "./src/gate.js" }));
    await writeSource("tests/self/package.json", JSON.stringify({ name: "gate-package", type: "module", exports: "./foreign.js" }));
    await writeSource("src/foreign.ts", "export function foreignGate(inputs: boolean[]) { return false; }\n");
    await writeSource("tests/self/foreign.js", "export { foreignGate as signalGate } from '../../src/foreign.js';\n");
    await writeSource("tests/self/alias.test.js", `import { signalGate } from 'gate-package';
it('uses the selected package self-reference, not the root package', () => {
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/self" });
    expect(response.details?.results?.some((result) => result.filePath.endsWith("alias.test.js"))).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("allows resolved no-alias configuration but rejects workspace fallback through unresolved extends", async () => {
    await writeSource("package.json", JSON.stringify({ name: "@logic/gate", type: "module", exports: "./src/gate.js" }));
    await writeSource("src/foreign.ts", "export function foreignGate(inputs: boolean[]) { return false; }\n");
    await writeSource("tests/resolved/tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
    await writeSource("tests/resolved/alias.test.ts", `import { signalGate } from '@logic/gate';
it('uses a resolved configuration without aliases', () => {
  expect(signalGate([false])).toBe(false);
});
`);
    await writeSource("tests/unresolved/tsconfig.json", JSON.stringify({
      extends: "shared-tsconfig", compilerOptions: { baseUrl: ".", paths: { "@logic/gate": ["foreign.ts"] } },
    }));
    await writeSource("tests/unresolved/foreign.ts", "export { foreignGate as signalGate } from '../../src/foreign.js';\n");
    await writeSource("tests/unresolved/alias.test.ts", `import { signalGate } from '@logic/gate';
it('uses a foreign path mapping whose package extends cannot be resolved here', () => {
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const resolved = await retrieve({ directory: "tests/resolved" });
    expect(resolved.details?.results?.map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind,
    }))).toEqual([{ file: "tests/resolved/alias.test.ts", kind: "direct_target_test_reference" }]);
    const unresolved = await retrieve({ directory: "tests/unresolved" });
    expect(unresolved.details?.results?.some((result) => result.filePath.endsWith("alias.test.ts"))).toBe(true);
    expect(unresolved.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("fails escaped declaration, function and parameter binding spellings closed", async () => {
    const forms = [
      `it('uses an escaped declaration', () => {
  const signal\\u0047ate = foreignGate;
  expect(signalGate([false])).toBe(false);
});`,
      `it('uses an escaped local function', () => {
  function signal\\u0047ate(inputs) { return foreignGate(inputs); }
  expect(signalGate([false])).toBe(false);
});`,
      `it('uses an escaped parameter', (signal\\u0047ate) => {
  expect(signalGate([false])).toBe(false);
});`,
    ];
    for (const [index, form] of forms.entries()) {
      await writeSource(`tests/escaped/form-${index}.test.js`,
        `import { signalGate } from '../../src/gate.js';\n${form}\n`);
    }
    await indexer.index();
    const response = await retrieve({ directory: "tests/escaped" });
    expect(new Set(response.details?.results?.map((result) => path.relative(root, result.filePath)))).toEqual(
      new Set(["tests/escaped/form-0.test.js", "tests/escaped/form-1.test.js", "tests/escaped/form-2.test.js"]),
    );
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it.each([
    ["abstract", "EnvelopeFactory", "abstract class Envelope\\u0046actory {}", "new EnvelopeFactory()"],
    ["enum", "signalGate", "enum signal\\u0047ate { Foreign = 0 }", "signalGate([false])"],
  ])("rejects escaped TypeScript %s value declarations as imported target evidence", async (kind, target, declaration, call) => {
    await writeSource("src/factory.ts", "export class EnvelopeFactory { value = 1; }\n");
    const module = target === "EnvelopeFactory" ? "factory" : "gate";
    await writeSource(`tests/escaped-types/${kind}.test.ts`, `import { ${target} } from '../../src/${module}.js';
it('uses a local escaped value declaration rather than the imported target', () => {
  ${declaration}
  ${call};
});
`);
    await indexer.index();
    const response = await retrieve({ query: `tests for ${target}`, directory: "tests/escaped-types" });
    expect(response.details?.results?.some((result) => result.filePath.endsWith(`${kind}.test.ts`))).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("does not reuse a star-export result after a demanded package invalidates that traversal", async () => {
    await writeSource("package.json", JSON.stringify({ name: "gate-package", type: "module", exports: "./src/gate.js" }));
    await writeSource("tests/late/barrel.js", `export * from './a-primary.js';
export * from './z-sub/marker.js';
export const barrelMarker = 'registered barrel source for bounded import verification';
`);
    await writeSource("tests/late/a-primary.js", `export { signalGate } from 'gate-package';
export const primaryMarker = 'registered primary source for bounded import verification';
`);
    await writeSource("tests/late/z-sub/package.json", JSON.stringify({
      name: "gate-package", type: "module", exports: "./marker.js",
    }));
    await writeSource("tests/late/z-sub/marker.js",
      "export const markerValue = 'registered marker metadata for the demanded nested package';\n");
    await writeSource("tests/late/repeated.test.js", `import { signalGate } from './barrel.js';
it('repeats a barrel import while nested package ambiguity is discovered', () => {
  expect(signalGate([false])).toBe(false);
  expect(signalGate([false])).toBe(false);
});
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/late" });
    expect(response.details?.results?.some((result) => result.filePath.endsWith("repeated.test.js"))).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("preserves direct imported construction references with exact callback citations", async () => {
    await writeSource("src/factory.ts", "export class EnvelopeFactory { value = 1; }\n");
    await writeSource("tests/constructors/factory.test.ts", `import { EnvelopeFactory } from '../../src/factory.js';
it('constructs the imported EnvelopeFactory directly', () => {
  const value = new EnvelopeFactory();
  expect(value.value).toBe(1);
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for EnvelopeFactory", directory: "tests/constructors" });
    expect(response.details?.results?.map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([{
      file: "tests/constructors/factory.test.ts", kind: "direct_target_test_reference", referenced: "EnvelopeFactory",
      line: 3, start: 2, end: 5,
    }]);
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

  it("keeps require and import conditional exports bound to their actual executable targets", async () => {
    await writeSource("package.json", JSON.stringify({
      name: "dual",
      type: "commonjs",
      exports: { import: "./src/conditional-target.cjs", require: "./src/conditional-foreign.cjs" },
    }));
    await writeSource("src/conditional-target.cjs", "function ConditionalTarget() {}\nmodule.exports = ConditionalTarget;\n");
    await writeSource("src/conditional-foreign.cjs", "function ConditionalForeign() {}\nmodule.exports = ConditionalForeign;\n");
    await writeSource("tests/conditions/import.test.mjs", `import ConditionalTarget from 'dual';
it('calls the import target', () => { ConditionalTarget(); });
`);
    await writeSource("tests/conditions/relative.test.cjs", `const ConditionalTarget = require('../../src/conditional-target.cjs');
it('calls the direct target', () => { ConditionalTarget(); });
`);
    await writeSource("tests/conditions/foreign.test.cjs", `const ConditionalForeign = require('dual');
it('calls the require target', () => { ConditionalForeign(); });
`);
    await writeSource("tests/conditions/decoy.test.cjs", `const ConditionalTarget = require('dual');
it('calls a different function through the same spelling', () => { ConditionalTarget(); });
`);
    await indexer.index();
    for (const [name, expected] of [
      ["ConditionalTarget", ["tests/conditions/import.test.mjs", "tests/conditions/relative.test.cjs"]],
      ["ConditionalForeign", ["tests/conditions/foreign.test.cjs"]],
    ] as const) {
      const response = await retrieve({ query: `tests for ${name}` });
      expect(new Set(response.details?.results?.filter((result) => result.evidenceKind).map((result) =>
        path.relative(root, result.filePath)))).toEqual(new Set(expected));
    }
  });

  it("ignores erased ambient wrapper ownership while retaining real require shadows", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/ambient-root.ts", `declare const module: { exports: unknown };
declare const exports: unknown;
declare class __dirname {}
declare const { pathName: __filename }: { pathName: string };
function AmbientRoot() { return 1; }
module.exports = AmbientRoot;
`);
    await writeSource("src/ambient-import.cjs", `function AmbientImportRoot() { return 1; }
module.exports = AmbientImportRoot;
`);
    await writeSource("tests/ambient/root.test.ts", `import AmbientRoot from '../../src/ambient-root.js';
it('calls the runtime root beside erased declarations', () => {
  AmbientRoot();
});
`);
    await writeSource("tests/ambient/require.test.ts", `declare const require: (name: string) => unknown;
const AmbientImportRoot = require('../../src/ambient-import.cjs');
it('uses the unshadowed runtime require', () => {
  AmbientImportRoot();
});
`);
    await writeSource("tests/ambient/shadow.test.js", `var require = () => () => 1;
const AmbientImportRoot = require('../../src/ambient-import.cjs');
it('calls a foreign runtime require result', () => {
  AmbientImportRoot();
});
`);
    await indexer.index();
    const ambient = await retrieve({ query: "tests for AmbientRoot", directory: "tests/ambient" });
    expect(ambient.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([{ file: "tests/ambient/root.test.ts", line: 3, start: 2, end: 4 }]);
    const importer = await retrieve({ query: "tests for AmbientImportRoot", directory: "tests/ambient" });
    expect(importer.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([{ file: "tests/ambient/require.test.ts", line: 4, start: 3, end: 5 }]);
  });

  it("requires CommonJS importer origin for static require ancestry", async () => {
    await writeSource("src/import-origin.cjs", `function ImportOriginRoot() { return 1; }
module.exports = ImportOriginRoot;
`);
    await writeSource("tests/import-origin/mod/package.json", JSON.stringify({ type: "module" }));
    for (const file of ["safe.test.cjs", "unknown.test.js", "explicit.test.mjs", "mod/typed.test.js"]) {
      const specifier = file.startsWith("mod/") ? "../../../src/import-origin.cjs" : "../../src/import-origin.cjs";
      await writeSource(`tests/import-origin/${file}`, `const ImportOriginRoot = require('${specifier}');
it('calls the imported root', () => {
  ImportOriginRoot();
});
`);
    }
    await writeSource("tests/import-origin/syntax.test.cjs", `export {};
const ImportOriginRoot = require('../../src/import-origin.cjs');
it('does not acquire a builtin require from ESM syntax', () => {
  ImportOriginRoot();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for ImportOriginRoot", directory: "tests/import-origin" });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([{ file: "tests/import-origin/safe.test.cjs", line: 3, start: 2, end: 4 }]);
  });

  it("abstains from unaccounted package format after the shared configuration budget is exhausted", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/budget-root.cjs", `function ConfigurationBudgetRoot() { return 1; }
module.exports = ConfigurationBudgetRoot;
`);
    const directory = `tests/config-budget/${Array.from({ length: 50 }, (_, index) => `d${index}`).join("/")}`;
    const relative = path.posix.relative(directory, "src/budget-root.cjs");
    for (const extension of ["js", "cjs"]) {
      await writeSource(`${directory}/root.test.${extension}`, `const ConfigurationBudgetRoot = require('${relative}');
it('calls the root within a deep configuration hierarchy', () => {
  ConfigurationBudgetRoot();
});
`);
    }
    await indexer.index();
    const response = await retrieve({ query: "tests for ConfigurationBudgetRoot", directory: "tests/config-budget" });
    expect(response.details?.testDiscovery?.capped).toBe(true);
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([{ file: `${directory}/root.test.cjs`, line: 3, start: 2, end: 4 }]);
  });

  it("flags top-level for-await and program-scope lexical wrapper conflicts as ESM origin", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/for-await.js", `for await (const value of []) {
  void value;
}
function ForAwaitRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = ForAwaitRoot; }
`);
    await writeSource("src/async-for-await.js", `async function drain() {
  for await (const value of []) {
    void value;
  }
}
function AsyncRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = AsyncRoot; }
`);
    await writeSource("src/lexical-wrapper.js", `const require = () => undefined;
function LexicalRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = LexicalRoot; }
`);
    await writeSource("src/lexical-class.js", `class __dirname {}
function ClassRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = ClassRoot; }
`);
    await writeSource("src/local-shadow.js", `function run() {
  const require = () => undefined;
  return require;
}
function LocalRoot() { run(); return 1; }
if (typeof module !== 'undefined') { module.exports = LocalRoot; }
`);
    await writeSource("src/block-await.js", `{
  const settled = await Promise.resolve(1);
  void settled;
}
function BlockAwaitRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = BlockAwaitRoot; }
`);
    await writeSource("src/async-arrow.js", `const drain = async () => {
  for await (const value of []) {
    void value;
  }
};
function AsyncArrowRoot() { drain(); return 1; }
if (typeof module !== 'undefined') { module.exports = AsyncArrowRoot; }
`);
    await writeSource("src/destructured-object.js", `const { x: __filename } = {};
function ObjectWrapperRoot() { return 1; }
module.exports = ObjectWrapperRoot;
`);
    await writeSource("src/destructured-array.js", `const [__dirname] = [];
function ArrayWrapperRoot() { return 1; }
module.exports = ArrayWrapperRoot;
`);
    await writeSource("src/property-key.js", `const { __filename: localName } = {};
function PropertyKeyRoot() { return localName; }
module.exports = PropertyKeyRoot;
`);
    await writeSource("src/var-destructured.js", `var { x: __filename } = {};
function VarWrapperRoot() { return 1; }
module.exports = VarWrapperRoot;
`);
    await writeSource("src/local-destructured.js", `function runLocal() {
  const [__dirname] = [];
  return __dirname;
}
function LocalDestructuredRoot() { return runLocal(); }
module.exports = LocalDestructuredRoot;
`);
    const cases = [
      ["ForAwaitRoot", "../../src/for-await.js", false],
      ["AsyncRoot", "../../src/async-for-await.js", true],
      ["BlockAwaitRoot", "../../src/block-await.js", false],
      ["AsyncArrowRoot", "../../src/async-arrow.js", true],
      ["LexicalRoot", "../../src/lexical-wrapper.js", false],
      ["ClassRoot", "../../src/lexical-class.js", false],
      ["LocalRoot", "../../src/local-shadow.js", true],
      ["ObjectWrapperRoot", "../../src/destructured-object.js", false],
      ["ArrayWrapperRoot", "../../src/destructured-array.js", false],
      ["PropertyKeyRoot", "../../src/property-key.js", true],
      ["VarWrapperRoot", "../../src/var-destructured.js", true],
      ["LocalDestructuredRoot", "../../src/local-destructured.js", true],
    ] as const;
    for (const [name, specifier] of cases) {
      await writeSource(`tests/origin2/${name}.test.js`, `import ${name} from '${specifier}';
it('uses the module root export', () => {
  ${name}();
});
`);
    }
    await indexer.index();
    for (const [name, , expected] of cases) {
      const linked = await retrieve({ query: `tests for ${name}`, directory: "tests/origin2" });
      const files = linked.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath));
      expect(files).toEqual(expected ? [`tests/origin2/${name}.test.js`] : []);
    }
  });

  it("requires provable CommonJS format before accepting a root export", async () => {
    const rootBody = "function __NAME__() { return 1; }\n";
    await writeSource("src/direct-esm.mjs", `${rootBody.replace("__NAME__", "MjsRoot")}if (typeof module !== 'undefined') { module.exports = MjsRoot; }\n`);
    await writeSource("src/mod/package.json", JSON.stringify({ type: "module" }));
    await writeSource("src/mod/root.js", `${rootBody.replace("__NAME__", "ModuleRoot")}if (typeof module !== 'undefined') { module.exports = ModuleRoot; }\n`);
    await writeSource("src/meta.js", `const located = import.meta.url;\n${rootBody.replace("__NAME__", "MetaRoot")}if (typeof module !== 'undefined') { module.exports = MetaRoot; }\n`);
    await writeSource("src/awaited.js", `const settled = await Promise.resolve(1);\nfunction AwaitRoot() { return settled; }\nif (typeof module !== 'undefined') { module.exports = AwaitRoot; }\n`);
    await writeSource("src/direct-cjs.cjs", `function CjsRoot() { return 1; }\nmodule.exports = CjsRoot;\n`);
    const cases = [
      ["MjsRoot", "../../src/direct-esm.mjs"],
      ["ModuleRoot", "../../src/mod/root.js"],
      ["MetaRoot", "../../src/meta.js"],
      ["AwaitRoot", "../../src/awaited.js"],
      ["CjsRoot", "../../src/direct-cjs.cjs"],
    ] as const;
    for (const [name, specifier] of cases) {
      await writeSource(`tests/format/${name}.test.js`, `import ${name} from '${specifier}';
it('uses the module root export', () => {
  ${name}();
});
`);
    }
    await indexer.index();
    for (const [name] of cases) {
      const linked = await retrieve({ query: `tests for ${name}`, directory: "tests/format" });
      const files = linked.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath));
      expect(files).toEqual(name === "CjsRoot" ? [`tests/format/CjsRoot.test.js`] : []);
    }
  });

  it("keeps genuine exports beside type-only forms and binds a CommonJS root only as ESM default", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/typed.ts", `export type Alias = string;
export interface Contract { value: string }
export type { Contract as ReexportedContract } from './contract.js';
export { type Contract as ContractValue } from './contract.js';
export function RealTarget(value: string) {
  return value;
}
export { RealTarget as RealAlias };
`);
    await writeSource("src/contract.ts", "export interface Contract { value: string }\n");
    await writeSource("src/cjs-only.js", `function RootOnly(value) {
  return value;
}
if (typeof module !== 'undefined') {
  module.exports = RootOnly;
}
`);
    await writeSource("tests/origins/typed.test.ts", `import { RealTarget } from '../../src/typed.js';
it('uses the genuine runtime export beside type-only forms', () => {
  RealTarget('value');
});
`);
    await writeSource("tests/origins/cjs.test.ts", `import RootOnly from '../../src/cjs-only.js';
it('reads a CommonJS root as an ESM default', () => {
  RootOnly('value');
});
`);
    await writeSource("tests/origins/cjs-named.test.ts", `import { RootOnly } from '../../src/cjs-only.js';
it('cannot name-import a CommonJS root', () => {
  RootOnly('value');
});
`);
    await writeSource("src/cjs-typed.ts", `import type { Contract } from './contract.js';
export type Alias = string;
export interface Shape { value: string }
function TypedRoot(value: string) {
  return value;
}
if (typeof module !== 'undefined') {
  module.exports = TypedRoot;
}
`);
    await writeSource("tests/origins/cjs-typed.test.ts", `import TypedRoot from '../../src/cjs-typed.js';
it('keeps a CommonJS root despite type-only syntax', () => {
  TypedRoot('value');
});
`);
    await indexer.index();
    const typedRoot = await retrieve({ query: "tests for TypedRoot", directory: "tests/origins" });
    expect(typedRoot.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath)))
      .toEqual(["tests/origins/cjs-typed.test.ts"]);
    const typed = await retrieve({ query: "tests for RealTarget", directory: "tests/origins" });
    expect(typed.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath)))
      .toEqual(["tests/origins/typed.test.ts"]);
    const cjs = await retrieve({ query: "tests for RootOnly", directory: "tests/origins" });
    expect(cjs.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "tests/origins/cjs.test.ts", kind: "direct_target_test_reference", referenced: "RootOnly", line: 3, start: 2, end: 4 },
    ]);
  });

  it("refuses star fallback when an explicit export form is unsupported", async () => {
    await writeSource("src/star-source.js", "export function NamespaceMember() {}\n");
    await writeSource("src/star-plain.js", "export function StarTarget() {}\n");
    await writeSource("src/star-barrel.js", `export * as StarTarget from './star-source.js';
export * from './star-plain.js';
`);
    await writeSource("src/star-control.js", "export * from './star-plain.js';\n");
    await writeSource("src/legit.js", "export function LegitTarget() {}\n");
    await writeSource("tests/opaque/star.test.js", `import { StarTarget } from '../../src/star-barrel.js';
it('imports through an unsupported explicit export', () => {
  StarTarget();
});
`);
    await writeSource("tests/opaque/star-control.test.js", `import { StarTarget } from '../../src/star-control.js';
it('imports the unique target through a plain star export', () => {
  StarTarget();
});
`);
    await writeSource("tests/opaque/legit.test.js", `import { LegitTarget } from '../../src/legit.js';
it('imports a plain named export', () => {
  LegitTarget();
});
`);
    await indexer.index();
    // Only the plain star barrel may link: the opaque namespace re-export shadows the star fallback.
    const opaque = await retrieve({ query: "tests for StarTarget", directory: "tests/opaque" });
    expect(opaque.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath)))
      .toEqual(["tests/opaque/star-control.test.js"]);
    const legit = await retrieve({ query: "tests for LegitTarget", directory: "tests/opaque" });
    expect(legit.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath)))
      .toEqual(["tests/opaque/legit.test.js"]);
  });

  it("does not let export-like text inside a regex literal create a linkable export", async () => {
    await writeSource("src/regexp.ts", `export const pattern = /export default Target/;
export function Target(value: string) {
  return value;
}
`);
    await writeSource("src/regex-only.js", `const pattern = /export default Target/;
module.exports = pattern;
`);
    await writeSource("tests/regexp/default.test.ts", `import Target from '../../src/regexp.js';
it('would need a real default export', () => {
  Target('value');
});
`);
    await writeSource("tests/regexp/require.test.js", `const Target = require('../../src/regex-only.js');
test('requires a non-callable module value', () => {
  Target('value');
});
`);
    await writeSource("tests/regexp/named.test.ts", `import { Target } from '../../src/regexp.js';
it('uses the genuine named export', () => {
  Target('value');
});
`);
    await indexer.index();
    const linked = await retrieve({ query: "tests for Target", directory: "tests/regexp" });
    expect(linked.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, line: result.referenceLine,
    }))).toEqual([{ file: "tests/regexp/named.test.ts", kind: "direct_target_test_reference", line: 3 }]);
  });

  it("fails closed when the nearest package manifest is unprovable inside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "caller-format-outside-"));
    try {
      await fs.writeFile(path.join(outside, "package.json"), JSON.stringify({ type: "commonjs" }));
      await writeSource("src/linked/root.js", `function LinkedRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = LinkedRoot; }
`);
      await fs.symlink(path.join(outside, "package.json"), path.join(root, "src/linked/package.json"));
      await writeSource("src/known/package.json", JSON.stringify({ type: "commonjs" }));
      await writeSource("src/known/root.js", `function KnownRoot() { return 1; }
if (typeof module !== 'undefined') { module.exports = KnownRoot; }
`);
      await writeSource("tests/boundary/linked.test.js", `import LinkedRoot from '../../src/linked/root.js';
it('uses the linked root export', () => {
  LinkedRoot();
});
`);
      await writeSource("tests/boundary/known.test.js", `import KnownRoot from '../../src/known/root.js';
it('uses the known root export', () => {
  KnownRoot();
});
`);
      await indexer.index();
      const linked = await retrieve({ query: "tests for LinkedRoot", directory: "tests/boundary" });
      expect(linked.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
      const known = await retrieve({ query: "tests for KnownRoot", directory: "tests/boundary" });
      expect(known.details?.results?.filter((result) => result.evidenceKind).map((result) => path.relative(root, result.filePath)))
        .toEqual(["tests/boundary/known.test.js"]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("resolves a guarded CommonJS root export to its current declaration", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/guarded.js", `function LocateTarget(value) {
  return value;
}
if (typeof module !== 'undefined') {
  module.exports = LocateTarget;
}
`);
    await writeSource("tests/guarded/locate.test.js", `const LocateTarget = require('../../src/guarded.js');
test('calls the guarded root export', () => {
  LocateTarget('value');
});
`);
    await indexer.index();
    const guarded = await retrieve({ query: "tests for LocateTarget", directory: "tests/guarded" });
    expect(guarded.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "tests/guarded/locate.test.js", kind: "direct_target_test_reference", referenced: "LocateTarget", line: 3, start: 2, end: 4 },
    ]);
  });

  it("keeps consecutive named imports owned by their module and verifies a same-file callable target", async () => {
    await writeSource("tsconfig.json", JSON.stringify({ extends: "unsupported-package-config" }));
    await writeSource("src/parser.ts", `function tokensToFunction(tokens: string) {
  return tokens;
}
export function compile(value: string) {
  return tokensToFunction(value);
}
export function parse(value: string) {
  return value;
}
`);
    await writeSource("src/parser.spec.ts", `import { describe, it, expect } from 'vitest';
import { parse, compile } from './parser.js';
it('parse accepts input', () => {
  expect(parse('input')).toBe('input');
});
it('compile preserves tokens', () => {
  expect(compile('tokens')).toBe('tokens');
});
it('parse nested callback', () => {
  expect(() => parse('nested')).not.toThrow();
});
`);
    await indexer.index();
    const direct = await retrieve({ query: "tests for parse", limit: 5 });
    expect(direct.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "src/parser.spec.ts", kind: "direct_target_test_reference", referenced: "parse", line: 4, start: 3, end: 5 },
      { file: "src/parser.spec.ts", kind: "direct_target_test_reference", referenced: "parse", line: 10, start: 9, end: 11 },
    ]);
    const related = await retrieve({ query: "tests for tokensToFunction", limit: 5 });
    expect(related.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "src/parser.spec.ts", kind: "related_caller_test_reference", referenced: "compile", line: 7, start: 6, end: 8 },
    ]);
  });

  it("links guarded CommonJS functions despite type-only declarations and classifies root test.js", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("index.js", `function Emitter(object) {
  if (object) return mixin(object);
}
function mixin(object) {
  return object;
}
Emitter.prototype.on = function on() {};
if (typeof module !== 'undefined') {
  module.exports = Emitter;
}
`);
    await writeSource("index.d.ts", "export type Emitter = { on(): void };\n");
    await writeSource("test.js", `const Emitter = require('./index.js');
test('construct an emitter', () => {
  new Emitter();
});
test('mixin an object', () => {
  Emitter({});
});
`);
    await indexer.index();
    const direct = await retrieve({ query: "tests for Emitter", limit: 5 });
    expect(direct.details?.testDiscovery?.resolution).toBe("resolved");
    expect(direct.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "test.js", kind: "direct_target_test_reference", referenced: "Emitter", line: 3, start: 2, end: 4 },
      { file: "test.js", kind: "direct_target_test_reference", referenced: "Emitter", line: 6, start: 5, end: 7 },
    ]);
    const related = await retrieve({ query: "tests for mixin", limit: 5 });
    expect(related.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol, line: result.referenceLine,
    }))).toContainEqual({
      file: "test.js", kind: "related_caller_test_reference", referenced: "Emitter", line: 6,
    });
    await writeSource("src/other-emitter.js", "export function Emitter() {}\n");
    await indexer.index();
    const ambiguous = await retrieve({ query: "tests for Emitter" });
    expect(ambiguous.details?.testDiscovery?.resolution).toBe("ambiguous");
    expect(ambiguous.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("links a CommonJS constructable class export as a one-hop caller", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/limiter.js", `function limiter(value) { return value; }
module.exports = limiter;
`);
    await writeSource("src/permessage-deflate.js", `const limiter = require('./limiter.js');
class PerMessageDeflate {
  constructor(value) { this.value = limiter(value); }
}
module.exports = PerMessageDeflate;
`);
    await writeSource("tests/limiter.test.js", `const limiter = require('../src/limiter.js');
it('limits a direct value', () => {
  expect(limiter('direct')).toBe('direct');
});
`);
    await writeSource("test/permessage-deflate.test.js", `const PerMessageDeflate = require('../src/permessage-deflate.js');
it('preserves the constructed value', () => {
  const extension = new PerMessageDeflate('related');
  expect(extension.value).toBe('related');
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for limiter" });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "tests/limiter.test.js", kind: "direct_target_test_reference", referenced: "limiter", line: 3, start: 2, end: 4 },
      { file: "test/permessage-deflate.test.js", kind: "related_caller_test_reference", referenced: "PerMessageDeflate", line: 3, start: 2, end: 5 },
    ]);
  });

  it("does not use a mutated CommonJS class export as a related caller", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/limiter.js", `function limiter(value) { return value; }
module.exports = limiter;
`);
    await writeSource("src/permessage-deflate.js", `const limiter = require('./limiter.js');
class PerMessageDeflate {
  constructor(value) { this.value = limiter(value); }
}
class Replacement {}
module.exports = PerMessageDeflate;
module.exports = Replacement;
`);
    await writeSource("tests/limiter.test.js", `const limiter = require('../src/limiter.js');
it('limits a direct value', () => {
  expect(limiter('direct')).toBe('direct');
});
`);
    await writeSource("test/permessage-deflate.test.js", `const PerMessageDeflate = require('../src/permessage-deflate.js');
it('uses the replacement class', () => {
  new PerMessageDeflate('foreign');
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for limiter" });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => result.evidenceKind))
      .toEqual(["direct_target_test_reference"]);
  });

  it("does not promote an exported class for a method-owned caller edge", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/limiter.js", `function limiter(value) { return value; }
module.exports = limiter;
`);
    await writeSource("src/permessage-deflate.js", `const limiter = require('./limiter.js');
class PerMessageDeflate {
  run(value) { return limiter(value); }
}
module.exports = PerMessageDeflate;
`);
    await writeSource("tests/limiter.test.js", `const limiter = require('../src/limiter.js');
it('limits a direct value', () => {
  expect(limiter('direct')).toBe('direct');
});
`);
    await writeSource("test/permessage-deflate.test.js", `const PerMessageDeflate = require('../src/permessage-deflate.js');
it('constructs the class without invoking its method', () => {
  new PerMessageDeflate();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for limiter" });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => result.evidenceKind))
      .toEqual(["direct_target_test_reference"]);
  });

  it("does not promote an exported class for a nested-class constructor edge", async () => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/limiter.js", `function limiter(value) { return value; }
module.exports = limiter;
`);
    await writeSource("src/permessage-deflate.js", `const limiter = require('./limiter.js');
class PerMessageDeflate {
  constructor(value) {
    class Inner {
      constructor() { this.value = limiter(value); }
    }
    return new Inner();
  }
}
module.exports = PerMessageDeflate;
`);
    await writeSource("tests/limiter.test.js", `const limiter = require('../src/limiter.js');
it('limits a direct value', () => {
  expect(limiter('direct')).toBe('direct');
});
`);
    await writeSource("test/permessage-deflate.test.js", `const PerMessageDeflate = require('../src/permessage-deflate.js');
it('constructs the outer class', () => {
  new PerMessageDeflate('related');
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for limiter" });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => result.evidenceKind))
      .toEqual(["direct_target_test_reference"]);
  });

  it.each([
    ["stored arrow", "constructor(value) { this.later = () => limiter(value); }"],
    ["stored function expression", "constructor(value) { this.later = function () { return limiter(value); }; }"],
    ["static constructor method", "static constructor(value) { return limiter(value); }"],
    ["stored default arrow", "constructor(value = () => limiter('stored')) { this.later = value; }"],
  ])("does not promote an exported class for a %s helper edge", async (_form, member) => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/limiter.js", `function limiter(value) { return value; }
module.exports = limiter;
`);
    await writeSource("src/permessage-deflate.js", `const limiter = require('./limiter.js');
class PerMessageDeflate {
  ${member}
}
module.exports = PerMessageDeflate;
`);
    await writeSource("tests/limiter.test.js", `const limiter = require('../src/limiter.js');
it('limits a direct value', () => {
  expect(limiter('direct')).toBe('direct');
});
`);
    await writeSource("test/permessage-deflate.test.js", `const PerMessageDeflate = require('../src/permessage-deflate.js');
it('constructs the class without invoking stored or static callbacks', () => {
  new PerMessageDeflate();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for limiter" });
    expect(response.details?.testDiscovery?.verifiedCallerCount).toBe(0);
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => result.evidenceKind))
      .toEqual(["direct_target_test_reference"]);
  });

  it.each([
    ["default parameter", "constructor(value = limiter('related')) { this.value = value; }",
      "expect(new PerMessageDeflate().value).toBe('related');"],
    ["computed method name", "constructor() { this.value = { [limiter('related')]() {} }; }",
      "expect(Object.keys(new PerMessageDeflate().value)).toEqual(['related']);"],
  ])("links a constructor-owned %s helper call", async (_form, member, assertion) => {
    await writeSource("package.json", JSON.stringify({ type: "commonjs" }));
    await writeSource("src/limiter.js", `function limiter(value) { return value; }
module.exports = limiter;
`);
    await writeSource("src/permessage-deflate.js", `const limiter = require('./limiter.js');
class PerMessageDeflate {
  ${member}
}
module.exports = PerMessageDeflate;
`);
    await writeSource("test/permessage-deflate.test.js", `const PerMessageDeflate = require('../src/permessage-deflate.js');
it('uses the constructor-evaluated helper', () => {
  ${assertion}
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for limiter" });
    expect(response.details?.testDiscovery?.verifiedCallerCount).toBe(1);
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, referenced: result.referencedSymbol,
      line: result.referenceLine, start: result.startLine, end: result.endLine,
    }))).toEqual([
      { file: "test/permessage-deflate.test.js", kind: "related_caller_test_reference", referenced: "PerMessageDeflate", line: 3, start: 2, end: 4 },
    ]);
  });

  it.each([
    ["declaration", "export function Constructable() {}"],
    ["anonymous expression", "export const Constructable = function () {};"],
    ["named expression", "export const Constructable = function InternalConstructor() {};"],
  ])("uses actual runtime identity for ordinary %s construction", async (_form, declaration) => {
    await writeSource("src/constructable.js", `${declaration}\n`);
    await writeSource("spec.js", `import { Constructable } from './src/constructable.js';
test('constructs an ordinary function', () => {
  new Constructable();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for Constructable", directory: "", limit: 5 });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, line: result.referenceLine,
      start: result.startLine, end: result.endLine,
    }))).toEqual([{ file: "spec.js", kind: "direct_target_test_reference", line: 3, start: 2, end: 4 }]);
  });

  it.each([
    ["arrow", "export const NonConstructor = () => {};"],
    ["async", "export async function NonConstructor() {}"],
    ["generator", "export function* NonConstructor() {}"],
  ])("does not label a %s function as constructable", async (_form, declaration) => {
    await writeSource("src/non-constructor.js", `${declaration}\n`);
    await writeSource("test.js", `import { NonConstructor } from './src/non-constructor.js';
test('contains an invalid construction', () => {
  new NonConstructor();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for NonConstructor" });
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("admits unrelated lexical shadows but rejects parameters, destructuring and hoisted locals at the call", async () => {
    await writeSource("tests/scopes/proof.test.ts", `import { signalGate } from '../../src/gate.js';
function unrelated(signalGate: unknown) {}
it('calls the imported target despite an unrelated parameter', () => {
  signalGate([false]);
});
it('shadows in a callback parameter', (signalGate) => {
  signalGate([false]);
});
it('shadows through destructuring', () => {
  const { signalGate } = foreign;
  signalGate([false]);
});
it('shadows through a hoisted var', () => {
  signalGate([false]);
  var signalGate = foreignGate;
});
it('shadows through catch binding', () => {
  try { throw foreignGate; } catch (signalGate) { signalGate([false]); }
});
signalGate([false]);
`);
    await indexer.index();
    const response = await retrieve({ directory: "tests/scopes", limit: 5 });
    expect(response.details?.results?.filter((result) => result.evidenceKind).map((result) => ({
      file: path.relative(root, result.filePath), kind: result.evidenceKind, line: result.referenceLine,
      start: result.startLine, end: result.endLine,
    }))).toEqual([{ file: "tests/scopes/proof.test.ts", kind: "direct_target_test_reference", line: 4, start: 3, end: 5 }]);
  });

  it("rejects stale same-line target columns rather than accepting a declaration somewhere in the range", async () => {
    await writeSource("src/local.ts", `export function actualTarget() { return 1; }
export function localCaller() { return actualTarget(); }
`);
    await writeSource("tests/local.test.ts", `import { localCaller } from '../src/local.js';
it('calls the local caller', () => {
  localCaller();
});
`);
    await indexer.index();
    const before = await retrieve({ query: "tests for actualTarget" });
    expect(before.details?.results?.filter((result) => result.evidenceKind).map((result) => result.referencedSymbol)).toEqual(["localCaller"]);
    await writeSource("src/local.ts", `       export function actualTarget() { return 1; }
export function localCaller() { return actualTarget(); }
`);
    const stale = await retrieve({ query: "tests for actualTarget" });
    expect(stale.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it.each([
    ["dynamic", "const DynamicTarget = require(modulePath);"],
    ["conditional", "const DynamicTarget = condition ? require('../../src/dynamic.js') : foreign;"],
    ["reassigned", "const DynamicTarget = require('../../src/dynamic.js'); DynamicTarget = foreign;"],
    ["shadowed require", "function require() { return foreign; } const DynamicTarget = require('../../src/dynamic.js');"],
  ])("rejects %s CommonJS importer ancestry", async (_form, importer) => {
    await writeSource("src/dynamic.js", "function DynamicTarget() {}\nmodule.exports = DynamicTarget;\n");
    await writeSource("tests/cjs/proof.test.js", `${importer}
test('invokes a binding without static target ownership', () => {
  DynamicTarget();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for DynamicTarget", directory: "tests/cjs" });
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it.each([
    ["conditional", "if (condition) module.exports = ExportTarget;"],
    ["guard alternate", "if (typeof module !== 'undefined') module.exports = ExportTarget; else module.exports = foreign;"],
    ["dynamic", "module.exports = choose(ExportTarget);"],
    ["reassigned", "module.exports = ExportTarget; module.exports = foreign;"],
    ["shadowed module", "const module = {}; module.exports = ExportTarget;"],
  ])("rejects %s CommonJS exporter ancestry", async (_form, exporter) => {
    await writeSource("src/exporter.js", `function ExportTarget() {}\n${exporter}\n`);
    await writeSource("tests/cjs/exporter.test.js", `const ExportTarget = require('../../src/exporter.js');
test('invokes a binding without a unique static root export', () => {
  ExportTarget();
});
`);
    await indexer.index();
    const response = await retrieve({ query: "tests for ExportTarget", directory: "tests/cjs" });
    expect(response.details?.results?.filter((result) => result.evidenceKind)).toEqual([]);
  });

  it("stops a cancelled traversal rather than returning a partial linked pack", async () => {
    await indexer.index();
    const abort = new AbortController();
    abort.abort();
    await expect(resolveCodebaseContext(root, "opencode", { query: "tests for signalGate" }, { signal: abort.signal }))
      .rejects.toThrow("cancelled");
  });
});
