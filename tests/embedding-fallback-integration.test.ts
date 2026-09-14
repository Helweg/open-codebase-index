import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config/schema.js";
import { createMcpServer } from "../src/mcp-server.js";
import { Indexer } from "../src/indexer/index.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

async function replicaServer() {
  const state = { status: 200, requests: 0, invalid: false };
  const server = createServer(async (request, response) => {
    state.requests++;
    const buffers: Buffer[] = [];
    for await (const buffer of request) buffers.push(buffer);
    if (state.status !== 200) { response.writeHead(state.status).end(); return; }
    const body = JSON.parse(Buffer.concat(buffers).toString()) as { input: string[] };
    // Keep retrieval assertions deterministic without external models or a network dependency.
    const data = body.input.map((text) => ({ embedding: state.invalid ? [1] : [
      text.toLowerCase().includes("retry") ? 1 : 0,
      text.toLowerCase().includes("config") ? 1 : 0,
      0.1, 0.2,
    ] }));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data, usage: { total_tokens: body.input.length } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { state, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-embedding-replica-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "retry.ts"), "export function retryRequest() { return 'retry failed request'; }\n");
  fs.writeFileSync(path.join(root, "config.ts"), "export function loadConfig() { return 'config from file'; }\n");
  const primary = await replicaServer();
  const fallback = await replicaServer();
  const config = parseConfig({
    embeddingProvider: "custom",
    customProvider: { baseUrl: primary.baseUrl, model: "replica-model", dimensions: 4, maxTokens: 8192, concurrency: 1, requestIntervalMs: 0, timeoutMs: 1000 },
    embeddingFallback: { provider: "custom", baseUrl: fallback.baseUrl, model: "replica-model", dimensions: 4 },
    include: ["**/*.ts"],
    indexing: { autoIndex: false, watchFiles: false, requireProjectMarker: false, retries: 0, gitBlame: { enabled: false } },
    search: { minScore: 0 },
  });
  fs.mkdirSync(path.join(root, ".codebase-index"));
  fs.writeFileSync(path.join(root, ".codebase-index", "config.json"), JSON.stringify(config));
  return { root, primary, fallback, config };
}

it("indexes through MCP on the fallback, searches the same index on either replica and returns to the primary", async () => {
  const { root, config, primary, fallback } = await fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  primary.state.status = 503;
  const server = createMcpServer(root, config, "codex");
  const client = new Client({ name: "embedding-fallback-test", version: "1.0.0" });
  cleanups.push(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const indexed = await client.callTool({ name: "index_codebase", arguments: {} });
  expect(indexed.isError, JSON.stringify(indexed)).not.toBe(true);
  expect(fallback.state.requests).toBeGreaterThan(0);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Using fallback"), { statusCode: 503, timedOut: false });
  const search = async (query: string) => {
    const result = await client.callTool({ name: "codebase_search", arguments: { query, limit: 2 } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.stringify(result.content);
  };
  expect(await search("retry failed request")).toContain("retry.ts");
  const fallbackCount = fallback.state.requests;
  primary.state.status = 200;
  expect(await search("config file")).toContain("config.ts");
  expect(fallback.state.requests).toBe(fallbackCount);
  const status = await client.callTool({ name: "index_status", arguments: {} });
  expect(status.isError, JSON.stringify(status)).not.toBe(true);
  expect(JSON.stringify(status.content)).toContain("compatible");
});

it("preserves primary metadata through failure, recovery and indexer restart", async () => {
  const { root, config, primary, fallback } = await fixture();
  let indexer = new Indexer(root, config, "codex");
  cleanups.push(async () => { await indexer.close(); });
  await indexer.index();
  const before = await indexer.getStatus();
  primary.state.status = 503;
  expect((await indexer.search("retry request", 2))[0].filePath).toContain("retry.ts");
  fallback.state.invalid = true;
  const requestsBeforeInvalid = fallback.state.requests;
  // Exercise a writer: a new chunk must be reported failed without persisting its invalid vector.
  fs.writeFileSync(path.join(root, "new.ts"), "export function newConfiguration() { return 'config'; }\n");
  await indexer.index();
  expect(fallback.state.requests).toBeGreaterThan(requestsBeforeInvalid);
  const failedStatus = await indexer.getStatus();
  expect(failedStatus.vectorCount).toBe(before.vectorCount);
  expect(failedStatus.failedBatchesCount).toBeGreaterThan(0);
  fallback.state.invalid = false;
  const recovery = await indexer.retryFailedBatches();
  expect(recovery.remaining).toBe(0);
  expect(recovery.succeeded).toBeGreaterThan(0);
  await indexer.close();
  indexer = new Indexer(root, config, "codex");
  expect((await indexer.search("config loader", 2))[0].filePath).toContain("config.ts");
  const after = await indexer.getStatus();
  expect(after.compatibility.compatible).toBe(before.compatibility.compatible);
  expect(after.compatibility.storedMetadata).toMatchObject({ embeddingProvider: "custom", embeddingModel: "replica-model", embeddingDimensions: 4 });
  expect(after.model).toEqual(before.model);
  expect(after.provider).toEqual(before.provider);
  expect(after.failedBatchesCount).toBe(0);
});

it.each([[429, 429], [503, 429], [429, 503]])("applies shared rate-limit backoff after primary HTTP %i and fallback HTTP %i", async (primaryStatus, fallbackStatus) => {
  const { root, config, primary, fallback } = await fixture();
  config.debug.enabled = true;
  config.debug.logEmbedding = true;
  primary.state.status = primaryStatus;
  fallback.state.status = fallbackStatus;
  const indexer = new Indexer(root, config, "codex");
  cleanups.push(async () => { await indexer.close(); });
  await indexer.index();
  const rateLimitLog = indexer.getLogger().getLogs().find((entry) => entry.message === "Rate limited, backing off");
  expect(rateLimitLog?.data?.backoffMs).toBeGreaterThan(0);
  expect((await indexer.getStatus()).failedBatchesCount).toBeGreaterThan(0);
});
