import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { replayCodebaseMemoryRun } from "../scripts/competitive-cbm-replay.js";
import type { GoldenQuery } from "../src/eval/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function query(id: string, symbol?: string): GoldenQuery {
  return {
    id,
    query: `find ${id}`,
    queryType: symbol ? "definition" : "conceptual",
    ...(symbol ? { args: { symbol } } : {}),
    expected: { filePath: "src/target.ts" },
  };
}

function rawCommand(symbol: string, raw?: unknown) {
  return {
    command: ["cbm", "cli", "--json", "search_graph", JSON.stringify({
      project: "project-1",
      name_pattern: `^${symbol}$`,
      limit: 50,
      format: "json",
    })],
    stdout: "preserved",
    stderr: "",
    ...(raw === undefined ? { error: "transport failed" } : { raw }),
  };
}

async function fixture(): Promise<{ source: string; corrected: string; originalExplicit: Buffer; marker: Buffer }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "competitive-cbm-replay-"));
  tempDirs.push(root);
  const source = path.join(root, "source-run");
  const corrected = path.join(root, "corrected-run");
  const condition = path.join(source, "repo", "codebase-memory");
  const repeat = path.join(condition, "repeat-1");
  const sourceTree = path.join(condition, "source-and-index", "src");
  await fs.mkdir(repeat, { recursive: true });
  await fs.mkdir(sourceTree, { recursive: true });
  await fs.mkdir(path.join(source, "repo", "grepai"), { recursive: true });
  await fs.writeFile(path.join(sourceTree, "target.ts"), "export function target() {}\n");

  const queries = [query("explicit", "target"), query("natural")];
  await fs.writeFile(path.join(source, "run.json"), JSON.stringify({
    options: { repeats: 1, repositories: ["repo"] },
    sourceLock: { repositories: [{ name: "repo" }] },
  }));
  await fs.writeFile(path.join(source, "repo", "inputs.json"), JSON.stringify({
    queryOrder: queries.map((item) => item.id),
    dataset: { queries },
  }));
  await fs.writeFile(path.join(condition, "first-query.json"), JSON.stringify({ error: "original parser failure" }));

  const originalExplicit = Buffer.from(JSON.stringify({
    queryId: "explicit",
    input: { query: "find explicit", symbol: "target", limit: 50 },
    repeat: 1,
    condition: "codebase-memory",
    durationMs: 4,
    raw: { error: "original parser failure" },
    score: { queryId: "explicit", status: "error", rankedPaths: [], metrics: { hitAt1: 0, hitAt5: 0, mrrAt10: 0, ndcgAt10: 0 } },
  }, null, 2) + "\n");
  await fs.writeFile(path.join(repeat, "explicit.json"), originalExplicit);
  await fs.writeFile(path.join(repeat, "natural.json"), JSON.stringify({
    queryId: "natural",
    input: { query: "find natural", limit: 50 },
    repeat: 1,
    condition: "codebase-memory",
    durationMs: 0,
    score: { queryId: "natural", status: "unsupported", rankedPaths: [] },
  }));

  const response = {
    content: [],
    structuredContent: {
      total: 3,
      count: 3,
      cols: ["name", "label", "lines", "in", "out"],
      groups: [
        { file: "src/target.ts", rows: [["target", "Function", "1-1", 0, 0]] },
        { file: "examples/error", rows: [["examples/error", "Folder", "", 0, 0]] },
        { file: "", rows: [["errors", "Channel", "", 0, 0]] },
      ],
    },
    isError: false,
  };
  await fs.writeFile(path.join(condition, "codebase-memory-query-000001.json"), JSON.stringify(rawCommand("target", response)));
  await fs.writeFile(path.join(condition, "codebase-memory-query-000002.json"), JSON.stringify(rawCommand("target", response)));

  const marker = Buffer.from([0, 1, 2, 3, 255]);
  await fs.writeFile(path.join(source, "repo", "grepai", "marker.bin"), marker);
  return { source, corrected, originalExplicit, marker };
}

describe("competitive CBM replay", () => {
  it("replays every repeat from monotonic anchored raw artifacts into a separate corrected tree", async () => {
    const { source, corrected, originalExplicit, marker } = await fixture();
    const originalHash = hash(await fs.readFile(path.join(source, "repo", "codebase-memory", "repeat-1", "explicit.json")));

    await replayCodebaseMemoryRun(source, corrected, "correction-test-v1");

    expect(hash(await fs.readFile(path.join(source, "repo", "codebase-memory", "repeat-1", "explicit.json"))))
      .toBe(originalHash);
    expect(await fs.readFile(path.join(corrected, "repo", "grepai", "marker.bin"))).toEqual(marker);
    const derived = JSON.parse(await fs.readFile(path.join(corrected, "repo", "codebase-memory", "repeat-1", "explicit.json"), "utf8")) as {
      score: { status: string; rankedPaths: string[] };
      correction: Record<string, string>;
    };
    expect(derived.score).toMatchObject({ status: "success", rankedPaths: ["src/target.ts"] });
    expect(derived.correction).toMatchObject({
      version: "correction-test-v1",
      sourceArtifactSha256: hash(originalExplicit),
      originalStatus: "error",
      correctedStatus: "success",
      rawArtifact: "codebase-memory-query-000002.json",
    });
    expect(derived.correction.rawSha256).toMatch(/^[a-f0-9]{64}$/);

    const naturalSource = await fs.readFile(path.join(source, "repo", "codebase-memory", "repeat-1", "natural.json"));
    const naturalCorrected = JSON.parse(await fs.readFile(path.join(corrected, "repo", "codebase-memory", "repeat-1", "natural.json"), "utf8")) as {
      score: { status: string };
      correction: { rawArtifact?: string };
    };
    expect(naturalCorrected.score.status).toBe("unsupported");
    expect(naturalCorrected.correction.rawArtifact).toBeUndefined();
    expect(await fs.readFile(path.join(source, "repo", "codebase-memory", "repeat-1", "natural.json"))).toEqual(naturalSource);
  });

  it("rejects raw command order or symbol mismatches instead of searching ahead", async () => {
    const { source, corrected } = await fixture();
    const rawFile = path.join(source, "repo", "codebase-memory", "codebase-memory-query-000002.json");
    await fs.writeFile(rawFile, JSON.stringify(rawCommand("different", {})));

    await expect(replayCodebaseMemoryRun(source, corrected)).rejects.toThrow(/raw command order mismatch/);
  });

  it("records corrected parse errors instead of silently converting them to zero", async () => {
    const { source, corrected } = await fixture();
    const rawFile = path.join(source, "repo", "codebase-memory", "codebase-memory-query-000002.json");
    const invalid = {
      content: [],
      structuredContent: {
        total: 1,
        count: 1,
        cols: ["name", "label"],
        groups: [{ file: "../outside.ts", rows: [["outside", "Function"]] }],
      },
      isError: false,
    };
    await fs.writeFile(rawFile, JSON.stringify(rawCommand("target", invalid)));

    await replayCodebaseMemoryRun(source, corrected);
    const derived = JSON.parse(await fs.readFile(path.join(corrected, "repo", "codebase-memory", "repeat-1", "explicit.json"), "utf8")) as {
      score: { status: string };
      correction: { correctedParsingError?: string; statusChanged: boolean };
    };
    expect(derived.score.status).toBe("error");
    expect(derived.correction.correctedParsingError).toMatch(/outside project root/);
    expect(derived.correction.statusChanged).toBe(false);
  });

  it("collapses only a proven adjacent malformed/failure pair for one invocation", async () => {
    const { source, corrected } = await fixture();
    const condition = path.join(source, "repo", "codebase-memory");
    const standard = path.join(condition, "codebase-memory-query-000002.json");
    await fs.rm(standard);
    const malformed = rawCommand("target");
    await fs.writeFile(path.join(condition, "codebase-memory-query-malformed-000002.json"), JSON.stringify(malformed));
    await fs.writeFile(path.join(condition, "codebase-memory-query-failure-000003.json"), JSON.stringify(malformed));

    await replayCodebaseMemoryRun(source, corrected);
    const derived = JSON.parse(await fs.readFile(path.join(corrected, "repo", "codebase-memory", "repeat-1", "explicit.json"), "utf8")) as {
      score: { status: string };
      correction: { rawArtifact: string; relatedRawArtifact: string };
    };
    expect(derived.score.status).toBe("error");
    expect(derived.correction).toMatchObject({
      rawArtifact: "codebase-memory-query-malformed-000002.json",
      relatedRawArtifact: "codebase-memory-query-failure-000003.json",
    });
  });
});
