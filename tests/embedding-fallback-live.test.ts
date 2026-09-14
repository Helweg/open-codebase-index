import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

// Opt-in: only synthetic source text is sent to the explicitly supplied model replicas.
const primaryUrl = process.env.CBI_LIVE_PRIMARY_URL;
const fallbackUrl = process.env.CBI_LIVE_FALLBACK_URL;
const model = process.env.CBI_LIVE_MODEL;
const dimensions = Number(process.env.CBI_LIVE_DIMENSIONS);

it.skipIf(!primaryUrl || !fallbackUrl || !model || !dimensions)("retrieves across two real replicas, outage, protocol change and primary recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-replica-live-"));
  let primaryUnavailable = false;
  let forwarded = 0;
  const relay = createServer(async (request, response) => {
    if (primaryUnavailable) { response.writeHead(503).end(); return; }
    try {
      const buffers: Buffer[] = [];
      for await (const buffer of request) buffers.push(buffer);
      forwarded++;
      const upstream = await fetch(`${primaryUrl}/embeddings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: Buffer.concat(buffers), signal: AbortSignal.timeout(120000),
      });
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(await upstream.text());
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
  let indexer: Indexer | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    const cases = [
      { file: "retry.ts", source: "export async function retryNetworkRequest(send: () => Promise<string>) { for (let attempt = 0; attempt < 3; attempt++) { try { return await send(); } catch (error) { if (attempt === 2) throw error; } } }", query: "retry failed network requests" },
      { file: "config.ts", source: "export function loadConfigurationFromEnvironment() { return { serverUrl: process.env.SERVER_URL, apiKey: process.env.API_KEY }; }", query: "load configuration from environment variables" },
      { file: "sorting.ts", source: "export function sortProductsByPrice(products: Array<{price: number}>) { return [...products].sort((a,b) => a.price-b.price); }", query: "order products by ascending price" },
      { file: "password.ts", source: "import { randomBytes, scryptSync } from 'node:crypto'; export function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return { salt, hash: scryptSync(password, salt, 64).toString('hex') }; }", query: "secure password hashing with random salt" },
    ];
    for (const entry of cases) fs.writeFileSync(path.join(root, entry.file), entry.source);
    const config = parseConfig({
      embeddingProvider: "custom", customProvider: {
        baseUrl: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/v1`, model, dimensions,
        maxTokens: 8192, timeoutMs: 120000, maxBatchSize: 16, concurrency: 1, requestIntervalMs: 0,
      },
      embeddingFallback: { provider: "custom", baseUrl: fallbackUrl, model, dimensions },
      include: ["**/*.ts"], search: { minScore: 0, fusionStrategy: "weighted", hybridWeight: 0 },
      indexing: { autoIndex: false, watchFiles: false, requireProjectMarker: false, retries: 0, gitBlame: { enabled: false } },
    });
    let activeConfig = config;
    const baselineRanks = new Map<string, number>();
    const checkQueries = async (phase: string) => {
      // Reopen to bypass the query embedding cache and exercise routing on identical queries.
      await indexer?.close();
      indexer = new Indexer(root, activeConfig, "codex");
      const matches: Array<{ file: string; top1: string; rank: number }> = [];
      for (const entry of cases) {
        let semanticCount = 0;
        const results = await indexer!.search(entry.query, 3, { hybridWeight: 0, trace: (trace) => { semanticCount = trace.semanticCandidates.length; } });
        expect(semanticCount, `${phase}: semantic retrieval must run`).toBeGreaterThan(0);
        const index = results.findIndex((result) => result.filePath.endsWith(entry.file));
        const rank = index < 0 ? 4 : index + 1;
        if (phase === "primary-index-primary-queries") baselineRanks.set(entry.file, rank);
        else expect(rank, `${phase}: retrieval rank must not regress for ${entry.query}`).toBeLessThanOrEqual(baselineRanks.get(entry.file)!);
        matches.push({ file: entry.file, top1: path.basename(results[0].filePath), rank });
      }
      const status = await indexer!.getStatus();
      expect(status.compatibility.compatible).toBe(true);
      expect(status.failedBatchesCount).toBe(0);
      process.stdout.write(JSON.stringify({ phase, rankings: matches, vectors: status.vectorCount, failedBatches: status.failedBatchesCount }) + "\n");
    };
    indexer = new Indexer(root, config, "codex");
    await indexer.index();
    await checkQueries("primary-index-primary-queries");
    primaryUnavailable = true;
    await checkQueries("primary-index-fallback-queries");
    await indexer.close();
    const nativeConfig = parseConfig({ ...config, embeddingFallback: { ...config.embeddingFallback, provider: "ollama", baseUrl: fallbackUrl!.replace(/\/v1\/?$/, "") } });
    activeConfig = nativeConfig;
    indexer = new Indexer(root, nativeConfig, "codex");
    await checkQueries("primary-index-native-fallback-queries");
    const beforeRecovery = forwarded;
    primaryUnavailable = false;
    await checkQueries("recovered-primary");
    expect(forwarded).toBeGreaterThan(beforeRecovery);
    primaryUnavailable = true;
    await indexer.forceIndex();
    primaryUnavailable = false;
    await checkQueries("fallback-index-primary-queries");
  } finally {
    await indexer?.close();
    relay.closeAllConnections();
    await new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 240000);
