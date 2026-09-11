import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoldenQuery } from "../src/eval/types.js";
import {
  adapterInput,
  firstSupportedQuery,
  parseBenchmarkArgs,
  preserveWorkspace,
  shuffled,
  summarizeTracks,
  timedQuery,
  validateEmbeddingLock,
  validateInterfaceLock,
} from "../scripts/competitive-benchmark.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function query(id: string, symbol?: string): GoldenQuery {
  return { id, query: `query ${id}`, queryType: symbol ? "definition" : "conceptual", ...(symbol ? { args: { symbol } } : {}), expected: { filePath: `${id}.ts` } };
}

describe("competitive benchmark protocol", () => {
  it("never exposes expected symbols, paths or graded answers to adapters", () => {
    const query: GoldenQuery = {
      id: "no-oracle", query: "find the parser", queryType: "conceptual",
      expected: { symbol: "SECRET_ANSWER", filePath: "secret/answer.ts", gradedEvidence: [{ path: "other/answer.ts", relevance: 3 }] },
    };
    expect(adapterInput(query)).toEqual({ query: "find the parser", limit: 50 });
    expect(JSON.stringify(adapterInput(query))).not.toContain("SECRET");
  });
  it("passes only the explicitly supplied user symbol", () => {
    const query: GoldenQuery = { id: "explicit", query: "where is parse", queryType: "definition", args: { symbol: "parse" }, expected: { symbol: "different-oracle", filePath: "answer.ts" } };
    expect(adapterInput(query)).toEqual({ query: "where is parse", symbol: "parse", limit: 50 });
  });
  it("randomizes reproducibly without mutating frozen inputs", () => {
    const original = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(shuffled(original, 20260910)).toEqual(shuffled(original, 20260910));
    expect(shuffled(original, 20260910)).not.toEqual(shuffled(original, 20260911));
    expect([...shuffled(original, 20260910)].sort()).toEqual([...original]);
    expect(original).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(shuffled([], 1)).toEqual([]);
  });

  it("strictly validates CLI selections and values", () => {
    const base = ["--scratch-root", "scratch", "--output", "output"];
    expect(parseBenchmarkArgs([...base, "--conditions", "grepai,ocbi-hybrid", "--repos", "axios,express", "--repeats", "2"])).toMatchObject({
      conditions: ["grepai", "ocbi-hybrid"], repositories: ["axios", "express"], repeats: 2,
    });
    expect(() => parseBenchmarkArgs([...base, "--conditions", "grepai,grepai"])).toThrow(/unique/);
    expect(() => parseBenchmarkArgs([...base, "--conditions", "grepai, unknown"])).toThrow(/whitespace/);
    expect(() => parseBenchmarkArgs([...base, "--conditions", "unknown"])).toThrow(/Unknown condition/);
    expect(() => parseBenchmarkArgs([...base, "--repos", "axios,"])).toThrow(/non-empty/);
    expect(() => parseBenchmarkArgs([...base, "--repeats", "2.0"])).toThrow(/Repeats/);
    expect(() => parseBenchmarkArgs([...base, "--bogus", "x"])).toThrow(/Unknown argument/);
    expect(() => parseBenchmarkArgs([...base, "--output", "other"])).toThrow(/Duplicate argument/);
    expect(() => parseBenchmarkArgs([...base, "--repos"])).toThrow(/Missing value/);
  });

  it("selects a supported first query without leaking an oracle symbol", () => {
    const natural = query("natural");
    natural.expected.symbol = "SECRET_ORACLE";
    const explicit = query("explicit", "publicSymbol");
    expect(firstSupportedQuery("codebase-memory", [natural, explicit])).toBe(explicit);
    expect(firstSupportedQuery("grepai", [natural, explicit])).toBe(natural);
    expect(JSON.stringify(adapterInput(firstSupportedQuery("codebase-memory", [natural, explicit])!))).not.toContain("SECRET");
  });

  it("preserves elapsed time when a query fails", async () => {
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(37);
    const failure = new Error("query failed");
    await expect(timedQuery(async () => { throw failure; }, now)).resolves.toEqual({ error: failure, durationMs: 27 });
  });

  it("reports explicit-symbol and natural-language tracks separately", () => {
    const queries = [query("natural-1"), query("explicit-1", "one"), query("natural-2"), query("explicit-2", "two")];
    const rows = [10, 20, 30, 40];
    expect(summarizeTracks(queries, rows, selected => ({ values: selected }))).toEqual({
      "explicit-symbol": { queryCount: 2, metrics: { values: [20, 40] } },
      "natural-language": { queryCount: 2, metrics: { values: [10, 30] } },
    });
    expect(() => summarizeTracks(queries, rows.slice(1), selected => selected)).toThrow(/equal lengths/);
  });

  it("preserves the workspace even when adapter close fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "competitive-benchmark-"));
    tempDirs.push(root);
    const workspace = path.join(root, "active-source");
    const destination = path.join(root, "source-and-index");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "evidence.txt"), "preserve me");
    await expect(preserveWorkspace(workspace, destination, async () => { throw new Error("close failed"); })).rejects.toThrow("close failed");
    await expect(fs.readFile(path.join(destination, "evidence.txt"), "utf8")).resolves.toBe("preserve me");
  });

  it("aborts when workspace preservation fails after still attempting close", async () => {
    const close = vi.fn(async () => undefined);
    const rename = vi.fn(async () => { throw new Error("rename failed"); });
    await expect(preserveWorkspace("source", "destination", close, rename)).rejects.toThrow(/Failed to preserve/);
    expect(close).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledWith("source", "destination");
  });

  it("validates confined frozen artifact hashes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "competitive-lock-"));
    tempDirs.push(root);
    const projectRoot = path.join(root, "project");
    const toolsRoot = path.join(root, "tools");
    await fs.mkdir(projectRoot);
    await fs.mkdir(toolsRoot);
    await fs.writeFile(path.join(toolsRoot, "runner"), "pinned binary");
    const digest = createHash("sha256").update("pinned binary").digest("hex");
    const nodeSha256 = createHash("sha256").update(await fs.readFile(process.execPath)).digest("hex");
    const runtime = { nodeVersion: process.version, nodeSha256, platform: process.platform, arch: process.arch };
    const options = { projectRoot, toolsRoot, scratchRoot: root, outputRoot: path.join(root, "output"), conditions: ["grepai" as const], repeats: 1 };
    await expect(validateInterfaceLock({ status: "frozen", artifacts: [{ root: "tools", path: "runner", sha256: digest }], runtime, models: {}, interfaces: {} }, options)).resolves.toBeUndefined();
    await expect(validateInterfaceLock({ status: "frozen", artifacts: [{ root: "tools", path: "../escape", sha256: digest }], runtime }, options)).rejects.toThrow(/Unsafe/);
    await fs.writeFile(path.join(root, "outside"), "pinned binary");
    await fs.symlink(path.join(root, "outside"), path.join(toolsRoot, "escape-link"));
    await expect(validateInterfaceLock({ status: "frozen", artifacts: [{ root: "tools", path: "escape-link", sha256: digest }], runtime }, options)).rejects.toThrow(/escapes its root/);
    await expect(validateInterfaceLock({ status: "frozen", artifacts: [{ root: "tools", path: "runner", sha256: "0".repeat(64) }], runtime }, options)).rejects.toThrow(/hash mismatch/);
    await expect(validateInterfaceLock({ status: "frozen", artifacts: [{ root: "tools", path: "runner", sha256: digest }], runtime: { ...runtime, nodeVersion: "v0.0.0" } }, options)).rejects.toThrow(/runtime identity/);
    await expect(validateInterfaceLock({ status: "draft", artifacts: [{ root: "tools", path: "runner", sha256: digest }], runtime }, options)).rejects.toThrow(/frozen/);
  });

  it("checks the frozen Ollama digest only for embedding-dependent conditions", async () => {
    const digest = "a".repeat(64);
    const lock = { models: { embedding: { name: "nomic-embed-text:latest", digest } } };
    const fetchTags = vi.fn(async () => ({ models: [{ name: "nomic-embed-text:latest", digest }] }));
    await expect(validateEmbeddingLock(lock, ["ocbi-hybrid"], fetchTags)).resolves.toBeUndefined();
    expect(fetchTags).toHaveBeenCalledOnce();
    fetchTags.mockClear();
    await expect(validateEmbeddingLock(lock, ["ocbi-structural", "codegraph"], fetchTags)).resolves.toBeUndefined();
    expect(fetchTags).not.toHaveBeenCalled();
    await expect(validateEmbeddingLock(lock, ["grepai"], async () => ({ models: [{ name: "nomic-embed-text:latest", digest: "b".repeat(64) }] }))).rejects.toThrow(/model mismatch/);
  });
});
