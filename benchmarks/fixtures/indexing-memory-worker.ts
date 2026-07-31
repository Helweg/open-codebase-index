import type { CallEdgeData } from "../../src/native/index.js";

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../../src/config/schema.js";
import { Indexer } from "../../src/indexer/index.js";
import { Database, VectorStore } from "../../src/native/index.js";

type BenchmarkMode = "unbounded" | "bounded";

interface MemoryFixture {
  version: number;
  fileCount: number;
  functionsPerFile: number;
  payloadCharacters: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function source(fileIndex: number, fixture: MemoryFixture): string {
  return Array.from({ length: fixture.functionsPerFile }, (_, functionIndex) => {
    const name = `fixture_${fileIndex}_${functionIndex}`;
    const previous = functionIndex === 0 ? "" : `fixture_${fileIndex}_${functionIndex - 1}() + `;
    const payload = `${fileIndex}:${functionIndex}:` + "x".repeat(fixture.payloadCharacters);
    return `export function ${name}() { return ${previous}${JSON.stringify(payload)}; }`;
  }).join("\n\n");
}

async function main(): Promise<void> {
  const mode = process.argv[2] as BenchmarkMode;
  const fixturePath = process.argv[3];
  if ((mode !== "unbounded" && mode !== "bounded") || !fixturePath) {
    throw new Error("Usage: indexing-memory-worker <unbounded|bounded> <fixture.json>");
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as MemoryFixture;
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `indexing-memory-${mode}-`));
  const indexPath = fs.mkdtempSync(path.join(os.tmpdir(), `indexing-memory-index-${mode}-`));
  const sourceDir = path.join(projectDir, "src");
  fs.mkdirSync(sourceDir, { recursive: true });

  let sourceBytes = 0;
  for (let fileIndex = 0; fileIndex < fixture.fileCount; fileIndex++) {
    const content = source(fileIndex, fixture);
    sourceBytes += Buffer.byteLength(content, "utf8");
    fs.writeFileSync(path.join(sourceDir, `${fileIndex.toString().padStart(4, "0")}.ts`), content, "utf8");
  }

  const requestDigest = createHash("sha256");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const texts = body.input ?? [];
    for (const text of texts) {
      requestDigest.update(text);
      requestDigest.update("\0");
    }
    return new Response(JSON.stringify({
      data: texts.map((text) => {
        const seed = Array.from(text).reduce((total, char) => (total * 31 + char.charCodeAt(0)) % 997, 0);
        return { embedding: Array.from({ length: 8 }, (_, index) => (seed + index * 17) / 997) };
      }),
      usage: { total_tokens: Math.max(1, texts.length * 8) },
    }), { status: 200 });
  };

  let indexer: Indexer | undefined;
  try {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "indexing-memory-fixture",
        dimensions: 8,
        maxBatchSize: 128,
        concurrency: 2,
        requestIntervalMs: 0,
      },
      indexing: { watchFiles: false, retries: 0, autoGc: false, maxFilesPerDirectory: 2000 },
    });
    indexer = new Indexer(projectDir, config, "opencode", {
      indexPath,
      fileBatchLimits: mode === "unbounded"
        ? { maxFiles: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }
        : undefined,
    });

    global.gc?.();
    const startedAt = performance.now();
    const stats = await indexer.index();
    const ranked = await indexer.search("fixture_12_3", 5, { definitionIntent: true });
    const rankedTarget = ranked.find((result) => result.name === "fixture_12_3");
    if (!rankedTarget) {
      throw new Error("Expected fixture_12_3 in ranked search results");
    }
    const durationMs = performance.now() - startedAt;
    await indexer.close();
    indexer = undefined;

    const fileHashes = JSON.parse(fs.readFileSync(path.join(indexPath, "file-hashes.json"), "utf8")) as Record<string, string>;
    const filePaths = Object.keys(fileHashes).sort();
    const database = new Database(path.join(indexPath, "codebase.db"));
    const chunks = filePaths.flatMap((filePath) => database.getChunksByFile(filePath))
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
    const symbols = filePaths.flatMap((filePath) => database.getSymbolsByFile(filePath))
      .sort((left, right) => left.id.localeCompare(right.id));
    const edgesById = new Map<string, CallEdgeData>();
    const branches = database.getAllBranches().sort().map((branch) => {
      for (const symbol of database.getSymbolsForBranch(branch)) {
        for (const edge of database.getCallees(symbol.id, branch)) edgesById.set(edge.id, edge);
      }
      return {
        branch,
        chunks: database.getBranchChunkIds(branch).sort(),
        symbols: database.getBranchSymbolIds(branch).sort(),
      };
    });
    const embeddingDigests = chunks.map((chunk) => ({
      contentHash: chunk.contentHash,
      embedding: sha256(database.getEmbedding(chunk.contentHash) ?? Buffer.alloc(0)),
    }));
    const databaseStats = database.getStats();
    database.close();

    const vectors = new VectorStore(path.join(indexPath, "vectors"), 8);
    vectors.loadStrict();
    const vectorMetadata = vectors.getAllMetadata().sort((left, right) => left.key.localeCompare(right.key));
    const invertedIndex = JSON.parse(fs.readFileSync(path.join(indexPath, "inverted-index.json"), "utf8")) as unknown;
    const requestDigestValue = requestDigest.digest("hex");
    const components = Object.fromEntries(Object.entries({
      fileHashes,
      chunks,
      symbols,
      edges: Array.from(edgesById.values()),
      branches,
      embeddingDigests,
      databaseStats,
      vectorMetadata,
      invertedIndex,
      rankedTarget: {
        filePath: path.relative(projectDir, rankedTarget.filePath),
        startLine: rankedTarget.startLine,
        endLine: rankedTarget.endLine,
        name: rankedTarget.name,
      },
    }).map(([key, value]) => [key, sha256(JSON.stringify(canonicalize(value)))]));
    const digest = sha256(JSON.stringify(canonicalize({ fixtureVersion: fixture.version, components })));

    console.log(JSON.stringify({
      mode,
      digest,
      requestDigest: requestDigestValue,
      components,
      files: stats.totalFiles,
      chunks: stats.totalChunks,
      sourceBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      durationMs,
    }));
  } finally {
    await indexer?.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(indexPath, { recursive: true, force: true });
  }
}

await main();
