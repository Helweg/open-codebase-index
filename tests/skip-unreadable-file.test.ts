import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

// A file that is unreadable at the OS level (chmod 000 -> open() returns EACCES;
// an LSM denial returns EPERM) must be skipped, not abort the whole index. The
// hash step (native/src/hasher.rs fs::File::open) throws on such a file; the
// indexer wraps hashFile in try/catch and records the file with reason
// "unreadable" so the remaining files index. chmod 000 exercises the same catch
// path as an EPERM-by-LSM file (e.g. Matlab2's lib/@medusa7/calc_spreads.m).
describe("indexer skips unreadable files instead of aborting", () => {
  let tempDir: string;
  let tempHome: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const embeddingDimensions = 8;
  let _indexers: Indexer[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return {
          embedding: Array.from(
            { length: embeddingDimensions },
            (_, idx) => ((seed + idx * 17) % 997) / 997,
          ),
        };
      });
      return new Response(
        JSON.stringify({ data, usage: { total_tokens: Math.max(1, texts.length * embeddingDimensions) } }),
        { status: 200 },
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skip-unreadable-"));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "skip-unreadable-home-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    // A readable source file that should index normally.
    fs.writeFileSync(
      path.join(tempDir, "src", "readable.ts"),
      ["export function alpha() {", "  return 'alpha';", "}", ""].join("\n"),
      "utf-8",
    );
    // An unreadable source file (chmod 000): passes the walk (stat is allowed for
    // the owner) but open() in hashFile fails. The indexer must skip it.
    fs.writeFileSync(
      path.join(tempDir, "src", "unreadable.ts"),
      ["export function beta() {", "  return 'beta';", "}", ""].join("\n"),
      "utf-8",
    );
    fs.chmodSync(path.join(tempDir, "src", "unreadable.ts"), 0o000);
  });

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
    fetchSpy.mockRestore();
    // Restore perms so cleanup is robust, then remove.
    try {
      fs.chmodSync(path.join(tempDir, "src", "unreadable.ts"), 0o644);
    } catch {
      // file may be gone
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createIndexer(projectRoot: string): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: `mock-${embeddingDimensions}d`,
        dimensions: embeddingDimensions,
      },
      debug: { enabled: true, logLevel: "warn", logSearch: false, logEmbedding: false, logCache: false, logGc: false, logBranch: false, metrics: false },
      indexing: { watchFiles: false, retries: 0, retryDelayMs: 1 },
    });
    const indexer = new Indexer(projectRoot, config, "opencode");
    _indexers.push(indexer);
    return indexer;
  }

  it("indexes the readable file and records the unreadable file as skipped", async () => {
    const indexer = createIndexer(tempDir);
    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBeGreaterThan(0);
    const unreadableSkip = stats.skippedFiles.find(
      (entry) => entry.reason === "unreadable" && entry.path.endsWith("unreadable.ts"),
    );
    expect(unreadableSkip).toBeDefined();
  });
});