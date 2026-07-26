import type { ChildProcess } from "child_process";
import type { AddressInfo } from "net";
import { fork } from "child_process";
import * as fs from "fs";
import { createServer, type Server, type ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { acquireIndexLock, releaseIndexLock } from "../src/indexer/index-lock.js";
import { Database, InvertedIndex, VectorStore } from "../src/native/index.js";

interface WorkerMessage {
  type: string;
  ok?: boolean;
  code?: string;
  pid?: number;
  stats?: { indexedChunks?: number };
  owner?: { pid?: number; token?: string };
  message?: string;
}

interface Bm25PublicationBarrier {
  targetPath: string;
  readyPath: string;
  releasePath: string;
}

class WorkerController {
  readonly child: ChildProcess;
  readonly messages: WorkerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
  }> = [];
  private readonly output: string[] = [];

  constructor(projectRoot: string, baseUrl: string, bm25Barrier?: Bm25PublicationBarrier) {
    const workerPath = fileURLToPath(new URL("./fixtures/multiprocess-index-worker.ts", import.meta.url));
    const execArgv = ["--import", "tsx"];
    if (bm25Barrier) {
      execArgv.push("--import", new URL("./fixtures/bm25-publication-barrier.mjs", import.meta.url).href);
    }
    this.child = fork(workerPath, [], {
      execArgv,
      env: {
        ...process.env,
        TEST_PROJECT_ROOT: projectRoot,
        TEST_EMBEDDING_BASE_URL: baseUrl,
        ...(bm25Barrier ? {
          TEST_BM25_TARGET_PATH: bm25Barrier.targetPath,
          TEST_BM25_READY_PATH: bm25Barrier.readyPath,
          TEST_BM25_RELEASE_PATH: bm25Barrier.releasePath,
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.stdout?.on("data", (chunk) => this.output.push(String(chunk)));
    this.child.stderr?.on("data", (chunk) => this.output.push(String(chunk)));
    this.child.on("message", (message: WorkerMessage) => {
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  send(message: Record<string, unknown>): void {
    if (!this.child.connected) return;
    this.child.send(message, (error) => {
      if (error && !["EPIPE", "ERR_IPC_CHANNEL_CLOSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        this.output.push(String(error));
      }
    });
  }

  async waitFor(predicate: (message: WorkerMessage) => boolean, timeoutMs = 5000): Promise<WorkerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Worker timeout. Messages: ${JSON.stringify(this.messages)}\n${this.output.join("")}`));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = (message) => {
        clearTimeout(timeout);
        originalResolve(message);
      };
    });
  }

  async waitForReady(): Promise<void> {
    await this.waitFor((message) => message.type === "ready");
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.send({ type: "stop" });
    await this.waitForExit(1500).catch(() => {
      this.child.kill("SIGKILL");
    });
    await this.waitForExit();
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.waitForExit();
  }

  async waitForExit(timeoutMs = 5000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker did not exit")), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

class FakeEmbeddingServer {
  private server: Server | null = null;
  private blocked = false;
  private pendingResponses: Array<() => void> = [];
  private countWaiters: Array<{ count: number; resolve: () => void }> = [];
  requestCount = 0;
  active = 0;
  maxActive = 0;
  inputs: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/embeddings") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => { void this.respond(body, response); });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  get baseUrl(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error("Server is not listening");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  block(): void {
    this.blocked = true;
  }

  release(): void {
    this.blocked = false;
    for (const resolve of this.pendingResponses.splice(0)) resolve();
  }

  reset(): void {
    if (this.active !== 0) throw new Error("Cannot reset with active requests");
    this.requestCount = 0;
    this.maxActive = 0;
    this.inputs = [];
  }

  async waitForRequestCount(count: number, timeoutMs = 5000): Promise<void> {
    if (this.requestCount >= count) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = { count, resolve };
      this.countWaiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.countWaiters.indexOf(waiter);
        if (index >= 0) this.countWaiters.splice(index, 1);
        reject(new Error(`Expected ${count} requests, received ${this.requestCount}`));
      }, timeoutMs);
      waiter.resolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (this.active > 0) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`Server still has ${this.active} active requests`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async close(): Promise<void> {
    this.release();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async respond(body: string, response: ServerResponse): Promise<void> {
    const parsed = JSON.parse(body) as { input?: unknown };
    const requestInputs = Array.isArray(parsed.input) ? parsed.input.map(String) : [String(parsed.input ?? "")];
    this.inputs.push(...requestInputs);
    this.requestCount += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    for (const waiter of [...this.countWaiters]) {
      if (this.requestCount < waiter.count) continue;
      this.countWaiters.splice(this.countWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.active -= 1;
    };
    response.once("close", finish);

    if (this.blocked) await new Promise<void>((resolve) => this.pendingResponses.push(resolve));
    if (response.destroyed) {
      finish();
      return;
    }

    const data = requestInputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: 8 }, (_, dimension) => ((input.length + dimension * 17) % 97) / 97),
    }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data, usage: { total_tokens: requestInputs.length } }), finish);
  }
}

describe("multiprocess indexing", () => {
  let tempDir: string;
  let projectRoot: string;
  let sourcePath: string;
  let embeddingServer: FakeEmbeddingServer;
  let workers: WorkerController[];
  let mcpClients: Client[];
  let localIndexers: Indexer[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiprocess-index-"));
    projectRoot = path.join(tempDir, "project");
    sourcePath = path.join(projectRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "fixture" }));
    fs.writeFileSync(sourcePath, "export function alpha() { return 'alpha'; }\nexport function beta() { return alpha(); }\n");
    embeddingServer = new FakeEmbeddingServer();
    await embeddingServer.start();
    workers = [];
    mcpClients = [];
    localIndexers = [];
  });

  afterEach(async () => {
    embeddingServer?.release();
    await Promise.all((mcpClients ?? []).map((client) => client.close().catch(() => {})));
    await Promise.all((workers ?? []).map((worker) => worker.stop()));
    await Promise.all((localIndexers ?? []).map((indexer) => indexer.close().catch(() => {})));
    await embeddingServer?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createWorker(bm25Barrier?: Bm25PublicationBarrier): Promise<WorkerController> {
    const worker = new WorkerController(projectRoot, embeddingServer.baseUrl, bm25Barrier);
    workers.push(worker);
    await worker.waitForReady();
    return worker;
  }

  async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (!fs.existsSync(filePath)) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function createMcpClient(configPath: string): Promise<{
    client: Client;
    transport: StdioClientTransport;
    stderr: string[];
  }> {
    const stderr: string[] = [];
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cliPath, "--project", projectRoot, "--config", configPath, "--host", "opencode"],
      cwd: path.dirname(cliPath),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const client = new Client({ name: "multiprocess-test-client", version: "1.0.0" });
    mcpClients.push(client);
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`MCP client failed to connect: ${stderr.join("")}`, { cause: error });
    }
    return { client, transport, stderr };
  }

  async function seedIndex(): Promise<void> {
    const worker = await createWorker();
    worker.send({ type: "run", operation: "index" });
    const result = await worker.waitFor((message) => message.type === "result");
    expect(result.ok).toBe(true);
    await worker.waitForExit();
    await embeddingServer.waitForIdle();
  }

  function createLocalIndexer(
    autoGc = false,
    search?: {
      fusionStrategy?: "weighted" | "rrf";
      hybridWeight?: number;
      minScore?: number;
    },
  ): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      scope: "project",
      customProvider: {
        baseUrl: embeddingServer.baseUrl,
        model: "multiprocess-test",
        dimensions: 8,
        timeoutMs: 5000,
        maxBatchSize: 64,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      include: ["**/*.ts"],
      exclude: ["**/.opencode/**", "**/.git/**", "**/node_modules/**"],
      indexing: {
        autoIndex: false,
        watchFiles: false,
        autoGc,
        retries: 0,
        retryDelayMs: 1,
        gitBlame: { enabled: false },
      },
      search,
      debug: { enabled: false },
    });
    const indexer = new Indexer(projectRoot, config);
    localIndexers.push(indexer);
    return indexer;
  }

  function readOwner(): string {
    return fs.readFileSync(path.join(projectRoot, ".opencode", "index", "indexing.lock", "owner.json"), "utf-8");
  }

  function assertIndexIntegrity(): void {
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const database = new Database(path.join(indexPath, "codebase.db"));
    const stats = database.getStats();
    const branchChunkIds = database.getBranchChunkIds("default");
    expect(stats?.chunkCount).toBeGreaterThan(0);
    expect(stats?.embeddingCount).toBeGreaterThan(0);
    expect(stats?.branchChunkCount).toBe(branchChunkIds.length);
    expect(branchChunkIds.length).toBe(stats?.chunkCount);
    for (const chunkId of branchChunkIds) {
      const chunk = database.getChunk(chunkId);
      expect(chunk).not.toBeNull();
      expect(database.getEmbedding(chunk!.contentHash)).not.toBeNull();
    }
    database.close();

    const vectors = new VectorStore(path.join(indexPath, "vectors"), 8);
    vectors.load();
    expect(vectors.count()).toBe(stats?.chunkCount);
    expect(vectors.getAllMetadata().map(({ key }) => key).sort()).toEqual([...branchChunkIds].sort());

    const inverted = new InvertedIndex(path.join(indexPath, "inverted-index.json"));
    inverted.load();
    expect(inverted.getDocumentCount()).toBe(stats?.chunkCount);
    expect(Array.from(inverted.search("function", 20).keys()).some((chunkId) => branchChunkIds.includes(chunkId))).toBe(true);
    const hashes = JSON.parse(fs.readFileSync(path.join(indexPath, "file-hashes.json"), "utf-8")) as Record<string, string>;
    expect(Object.keys(hashes).length).toBeGreaterThan(0);
    expect(hashes[sourcePath]).toBeTypeOf("string");
    expect(fs.existsSync(path.join(indexPath, "failed-batches.json"))).toBe(false);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
    expect(fs.readdirSync(indexPath).some((name) => name.includes(".tmp.") || name.includes(".bak.") || name.startsWith("indexing.lock."))).toBe(false);
  }

  it("allows only one normal indexer to embed", async () => {
    embeddingServer.block();
    const first = await createWorker();
    const second = await createWorker();
    first.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();
    second.send({ type: "run", operation: "index" });
    const busy = await second.waitFor((message) => message.type === "result");

    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);
    expect(readOwner()).toBe(ownerBefore);

    embeddingServer.release();
    const success = await first.waitFor((message) => message.type === "result");
    expect(success.ok).toBe(true);
    await first.waitForExit();
    await second.waitForExit();
    expect(embeddingServer.requestCount).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    expect(embeddingServer.maxActive).toBe(1);
    assertIndexIntegrity();
  });

  it("keeps the active lease when the same Indexer receives an overlapping mutation", async () => {
    const indexer = createLocalIndexer();
    embeddingServer.block();
    const firstIndex = indexer.index();
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();

    await expect(indexer.index()).rejects.toMatchObject({ code: "INDEX_BUSY" });
    expect(readOwner()).toBe(ownerBefore);
    expect(embeddingServer.requestCount).toBe(1);

    embeddingServer.release();
    await expect(firstIndex).resolves.toMatchObject({ indexedChunks: expect.any(Number) });
    await embeddingServer.waitForIdle();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    assertIndexIntegrity();
  });

  it("does not create index artifacts for a cold status read", async () => {
    const indexPath = path.join(projectRoot, ".opencode", "index");
    expect(fs.existsSync(indexPath)).toBe(false);

    const status = await createLocalIndexer().getStatus();

    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBe(0);
    expect(fs.existsSync(indexPath)).toBe(false);
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("refreshes the same cold reader after the first writer publishes the index", async () => {
    embeddingServer.block();
    const worker = await createWorker();
    worker.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const indexer = createLocalIndexer();

    const statusDuringWrite = await indexer.getStatus();
    expect(statusDuringWrite.indexed).toBe(false);
    expect(statusDuringWrite.vectorCount).toBe(0);

    embeddingServer.release();
    const result = await worker.waitFor((message) => message.type === "result");
    expect(result.ok).toBe(true);
    await worker.waitForExit();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const statusAfterWrite = await indexer.getStatus();
    expect(statusAfterWrite.indexed).toBe(true);
    expect(statusAfterWrite.warning).toBeUndefined();
    expect(embeddingServer.requestCount).toBe(0);

    const results = await indexer.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(embeddingServer.inputs).toEqual(["alpha"]);
    assertIndexIntegrity();
  });

  it("keeps an unreadable BM25 artifact untouched under a live writer lease", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const invertedIndexPath = path.join(indexPath, "inverted-index.json");
    const readableBm25 = fs.readFileSync(invertedIndexPath, "utf-8");
    const unreadableBm25 = "{partial";
    fs.writeFileSync(invertedIndexPath, unreadableBm25);
    const lease = acquireIndexLock(indexPath, "index");
    const ownerBefore = readOwner();

    try {
      const indexer = createLocalIndexer();
      const status = await indexer.getStatus();
      const results = await indexer.search("alpha");

      expect(status.indexed).toBe(true);
      expect(status.vectorCount).toBeGreaterThan(0);
      expect(status.warning).toMatch(/keyword.*index_codebase with force=true/i);
      expect(results.length).toBeGreaterThan(0);
      expect(fs.readFileSync(invertedIndexPath, "utf-8")).toBe(unreadableBm25);
      expect(readOwner()).toBe(ownerBefore);
      expect(embeddingServer.requestCount).toBe(1);
      expect(embeddingServer.inputs).toEqual(["alpha"]);
      expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);

      fs.writeFileSync(invertedIndexPath, readableBm25);
      const recoveredStatus = await indexer.getStatus();
      expect(recoveredStatus.indexed).toBe(true);
      expect(recoveredStatus.warning).toBeUndefined();
      expect(embeddingServer.requestCount).toBe(1);
    } finally {
      releaseIndexLock(lease);
    }
  });

  it("falls back to semantic-only ranking when weighted BM25 is unavailable", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const invertedIndexPath = path.join(indexPath, "inverted-index.json");
    const unreadableBm25 = "{partial";
    fs.writeFileSync(invertedIndexPath, unreadableBm25);
    const indexer = createLocalIndexer(false, {
      fusionStrategy: "weighted",
      hybridWeight: 1,
      minScore: 0.1,
    });

    const results = await indexer.search("conceptual behavior flow");

    expect(results.length).toBeGreaterThan(0);
    expect(fs.readFileSync(invertedIndexPath, "utf-8")).toBe(unreadableBm25);
    expect(embeddingServer.inputs).toEqual(["conceptual behavior flow"]);
  });

  it("reports an unreadable vector store without replacing it", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const vectorPath = path.join(indexPath, "vectors");
    const metadataPath = path.join(indexPath, "vectors.meta.json");
    const vectorBefore = fs.readFileSync(vectorPath);
    const metadataBefore = fs.readFileSync(metadataPath, "utf-8");
    const unreadableMetadata = "{partial";
    fs.writeFileSync(metadataPath, unreadableMetadata);
    const indexer = createLocalIndexer();

    const status = await indexer.getStatus();

    expect(status.indexed).toBe(false);
    expect(status.warning).toMatch(/vector.*remove this checkout's local index directory.*index_codebase/i);
    expect(fs.readFileSync(vectorPath)).toEqual(vectorBefore);
    expect(fs.readFileSync(metadataPath, "utf-8")).toBe(unreadableMetadata);
    await expect(indexer.search("alpha")).rejects.toThrow(/vector.*index_codebase/i);
    expect(embeddingServer.requestCount).toBe(0);

    fs.writeFileSync(metadataPath, metadataBefore);
    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(recoveredStatus.warning).toBeUndefined();
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("rejects a valid vector metadata file from a different publication", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const vectorPath = path.join(indexPath, "vectors");
    const metadataPath = `${vectorPath}.meta.json`;
    const originalMetadata = fs.readFileSync(metadataPath);
    const published = new VectorStore(vectorPath, 8);
    published.loadStrict();
    const foreignPath = path.join(tempDir, "foreign-vectors");
    const foreign = new VectorStore(foreignPath, 8);
    published.getAllMetadata().forEach(({ metadata }, index) => {
      foreign.add(
        `foreign-${index}`,
        Array.from({ length: 8 }, (_, dimension) => index + dimension / 10),
        { ...metadata, hash: `foreign-hash-${index}` },
      );
    });
    foreign.save();
    fs.copyFileSync(`${foreignPath}.meta.json`, metadataPath);
    const reader = createLocalIndexer();

    const mismatchedStatus = await reader.getStatus();
    expect(mismatchedStatus.indexed).toBe(false);
    expect(mismatchedStatus.warning).toMatch(/vector.*fingerprint.*index_codebase/i);
    await expect(reader.search("alpha")).rejects.toThrow(/vector.*fingerprint.*index_codebase/i);
    expect(embeddingServer.requestCount).toBe(0);

    fs.writeFileSync(metadataPath, originalMetadata);
    const recoveredStatus = await reader.getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(recoveredStatus.warning).toBeUndefined();
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("requires a writer to fingerprint a structurally valid legacy vector pair", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const metadataPath = path.join(indexPath, "vectors.meta.json");
    const legacyMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
    delete legacyMetadata.vector_fingerprint;
    fs.writeFileSync(metadataPath, JSON.stringify(legacyMetadata));
    const reader = createLocalIndexer();

    const legacyStatus = await reader.getStatus();

    expect(legacyStatus.indexed).toBe(false);
    expect(legacyStatus.warning).toMatch(/vector.*fingerprint.*index_codebase/i);
    expect(embeddingServer.requestCount).toBe(0);
    expect((JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>).vector_fingerprint).toBeUndefined();

    const writer = await createWorker();
    writer.send({ type: "run", operation: "index" });
    expect((await writer.waitFor((message) => message.type === "result")).ok).toBe(true);
    await writer.waitForExit();
    expect(embeddingServer.requestCount).toBe(0);
    expect((JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>).vector_fingerprint).toBeTypeOf("string");

    const recoveredStatus = await reader.getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(recoveredStatus.warning).toBeUndefined();
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("fingerprints an empty legacy vector pair after a successful writer publication", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.rmSync(sourcePath);
    await createLocalIndexer().index();
    expect(embeddingServer.requestCount).toBe(0);

    const indexPath = path.join(projectRoot, ".opencode", "index");
    const metadataPath = path.join(indexPath, "vectors.meta.json");
    const legacyMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
    delete legacyMetadata.vector_fingerprint;
    fs.writeFileSync(metadataPath, JSON.stringify(legacyMetadata));
    const reader = createLocalIndexer();
    expect((await reader.getStatus()).warning).toMatch(/vector.*fingerprint.*index_codebase/i);

    const writer = await createWorker();
    writer.send({ type: "run", operation: "index" });
    expect((await writer.waitFor((message) => message.type === "result")).ok).toBe(true);
    await writer.waitForExit();

    expect((JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>).vector_fingerprint).toBeTypeOf("string");
    expect(embeddingServer.requestCount).toBe(0);
  });

  it.each(["vectors", "vectors.meta.json"])(
    "reports an incomplete vector publication when %s is missing",
    async (missingName) => {
      await seedIndex();
      embeddingServer.reset();
      const indexPath = path.join(projectRoot, ".opencode", "index");
      const missingPath = path.join(indexPath, missingName);
      const retainedPath = path.join(
        indexPath,
        missingName === "vectors" ? "vectors.meta.json" : "vectors",
      );
      const retainedBefore = fs.readFileSync(retainedPath);
      fs.rmSync(missingPath, { force: true });
      const indexer = createLocalIndexer();

      const status = await indexer.getStatus();

      expect(status.indexed).toBe(false);
      expect(status.vectorCount).toBe(0);
      expect(status.warning).toMatch(/vector.*remove this checkout's local index directory.*index_codebase/i);
      expect(fs.existsSync(missingPath)).toBe(false);
      expect(fs.readFileSync(retainedPath)).toEqual(retainedBefore);
      await expect(indexer.search("alpha")).rejects.toThrow(/vector.*index_codebase/i);
      expect(embeddingServer.requestCount).toBe(0);
    },
  );

  it.each(["vectors", "vectors.meta.json"])(
    "rejects an incomplete vector publication during fresh writer initialization when %s is missing",
    async (missingName) => {
      await seedIndex();
      embeddingServer.reset();
      const indexPath = path.join(projectRoot, ".opencode", "index");
      const missingPath = path.join(indexPath, missingName);
      const retainedPath = path.join(
        indexPath,
        missingName === "vectors" ? "vectors.meta.json" : "vectors",
      );
      const retainedBefore = fs.readFileSync(retainedPath);
      const databasePath = path.join(indexPath, "codebase.db");
      const database = new Database(databasePath);
      const statsBefore = database.getStats();
      const branchChunkIdsBefore = database.getBranchChunkIds("default");
      database.close();
      fs.rmSync(missingPath, { force: true });

      const writer = await createWorker();
      writer.send({ type: "run", operation: "index" });
      const result = await writer.waitFor((message) => message.type === "result");
      await writer.waitForExit();

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/incomplete vector publication/i);
      expect(embeddingServer.requestCount).toBe(0);
      expect(fs.existsSync(missingPath)).toBe(false);
      expect(fs.readFileSync(retainedPath)).toEqual(retainedBefore);
      const reloadedDatabase = new Database(databasePath);
      expect(reloadedDatabase.getStats()).toEqual(statsBefore);
      expect(reloadedDatabase.getBranchChunkIds("default")).toEqual(branchChunkIdsBefore);
      reloadedDatabase.close();
    },
  );

  it("reports an unreadable database without resetting published artifacts", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const dbPath = path.join(indexPath, "codebase.db");
    const vectorPath = path.join(indexPath, "vectors");
    const metadataPath = path.join(indexPath, "vectors.meta.json");
    const invertedIndexPath = path.join(indexPath, "inverted-index.json");
    const hashesPath = path.join(indexPath, "file-hashes.json");
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    const unreadableDatabase = Buffer.from("not a sqlite database");
    fs.writeFileSync(dbPath, unreadableDatabase);
    const artifactsBefore = new Map([
      [vectorPath, fs.readFileSync(vectorPath)],
      [metadataPath, fs.readFileSync(metadataPath)],
      [invertedIndexPath, fs.readFileSync(invertedIndexPath)],
      [hashesPath, fs.readFileSync(hashesPath)],
    ]);
    const indexer = createLocalIndexer();

    const status = await indexer.getStatus();

    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBeGreaterThan(0);
    expect(status.warning).toMatch(/database.*index_codebase/i);
    expect(fs.readFileSync(dbPath)).toEqual(unreadableDatabase);
    for (const [artifactPath, content] of artifactsBefore) {
      expect(fs.readFileSync(artifactPath)).toEqual(content);
    }
    await expect(indexer.search("alpha")).rejects.toThrow(/database.*index_codebase/i);
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("degrades the same healthy reader when its database becomes unreadable", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const dbPath = path.join(indexPath, "codebase.db");
    const unreadableDatabase = Buffer.from("not a sqlite database");
    const indexer = createLocalIndexer();

    const healthyStatus = await indexer.getStatus();
    expect(healthyStatus.indexed).toBe(true);

    fs.writeFileSync(dbPath, unreadableDatabase);
    const degradedStatus = await indexer.getStatus();

    expect(degradedStatus.indexed).toBe(false);
    expect(degradedStatus.warning).toMatch(/database.*index_codebase/i);
    expect(fs.readFileSync(dbPath)).toEqual(unreadableDatabase);
    await expect(indexer.search("alpha")).rejects.toThrow(/database.*index_codebase/i);
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("keeps a degraded reader snapshot blocked while the same Indexer upgrades to writer", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const dbPath = path.join(indexPath, "codebase.db");
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.writeFileSync(dbPath, "not a sqlite database");
    const indexer = createLocalIndexer();

    const status = await indexer.getStatus();
    expect(status.warning).toMatch(/database.*index_codebase/i);

    const searching = indexer.search("alpha");
    const indexing = indexer.index();

    await expect(searching).rejects.toThrow(/database.*index_codebase/i);
    await expect(indexing).resolves.toMatchObject({ indexedChunks: expect.any(Number) });
    expect(embeddingServer.inputs).not.toContain("alpha");
    assertIndexIntegrity();
  });

  it("defers legacy database creation to the next writer without re-embedding", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const dbPath = path.join(indexPath, "codebase.db");
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    const indexer = createLocalIndexer();

    const readerStatus = await indexer.getStatus();

    expect(readerStatus.indexed).toBe(false);
    expect(readerStatus.vectorCount).toBeGreaterThan(0);
    expect(readerStatus.warning).toMatch(/database.*index_codebase/i);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(embeddingServer.requestCount).toBe(0);

    const stats = await indexer.index();
    const writerStatus = await indexer.getStatus();
    const database = new Database(dbPath);
    try {
      expect(stats.indexedChunks).toBe(0);
      expect(writerStatus.indexed).toBe(true);
      expect(writerStatus.warning).toBeUndefined();
      expect(database.getStats().chunkCount).toBeGreaterThan(0);
      expect(database.getBranchChunkIds("default").length).toBeGreaterThan(0);
      expect(embeddingServer.requestCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it("publishes BM25 atomically while a cold reader overlaps the writer save", async () => {
    await seedIndex();
    embeddingServer.reset();
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const invertedIndexPath = path.join(indexPath, "inverted-index.json");
    const readyPath = path.join(tempDir, "bm25-publication-ready.json");
    const releasePath = path.join(tempDir, "bm25-publication-release");
    const publishedBefore = fs.readFileSync(invertedIndexPath, "utf-8");
    fs.writeFileSync(
      sourcePath,
      "export function alpha() { return 'alpha'; }\nexport function publicationmarker() { return 'publicationmarker'; }\n",
    );
    const worker = await createWorker({
      targetPath: fs.realpathSync(invertedIndexPath),
      readyPath,
      releasePath,
    });
    worker.send({ type: "run", operation: "index" });

    try {
      await waitForFile(readyPath);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; worker messages: ${JSON.stringify(worker.messages)}`);
    }
    const barrier = JSON.parse(fs.readFileSync(readyPath, "utf-8")) as { source: string; destination: string };
    const ownerBeforeRead = readOwner();
    const requestsBeforeRead = embeddingServer.requestCount;
    const inputsBeforeRead = [...embeddingServer.inputs];
    const reader = createLocalIndexer();

    try {
      const staged = new InvertedIndex(barrier.source);
      staged.load();
      expect(staged.search("publicationmarker").size).toBeGreaterThan(0);

      const published = new InvertedIndex(invertedIndexPath);
      published.load();
      expect(published.search("publicationmarker").size).toBe(0);
      expect(fs.readFileSync(invertedIndexPath, "utf-8")).toBe(publishedBefore);

      const status = await reader.getStatus();
      expect(status.indexed).toBe(true);
      expect(fs.readFileSync(invertedIndexPath, "utf-8")).toBe(publishedBefore);
      expect(fs.existsSync(barrier.source)).toBe(true);
      expect(readOwner()).toBe(ownerBeforeRead);
      expect(embeddingServer.requestCount).toBe(requestsBeforeRead);
      expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);
    } finally {
      fs.writeFileSync(releasePath, "release");
    }

    const result = await worker.waitFor((message) => message.type === "result");
    expect(result.ok).toBe(true);
    await worker.waitForExit();

    const publishedAfter = new InvertedIndex(invertedIndexPath);
    publishedAfter.load();
    expect(fs.readFileSync(invertedIndexPath, "utf-8")).not.toBe(publishedBefore);
    expect(publishedAfter.search("publicationmarker").size).toBeGreaterThan(0);
    expect(fs.existsSync(barrier.source)).toBe(false);
    const finalStatus = await reader.getStatus();
    expect(finalStatus.indexed).toBe(true);
    expect(embeddingServer.requestCount).toBe(requestsBeforeRead);
    const searchResults = await reader.search("publicationmarker");
    expect(searchResults.some((searchResult) => searchResult.content.includes("publicationmarker"))).toBe(true);
    expect(embeddingServer.inputs).toEqual([...inputsBeforeRead, "publicationmarker"]);
    assertIndexIntegrity();
  });

  it("refreshes a first-publication BM25 reader after the atomic rename", async () => {
    const indexPath = path.join(projectRoot, ".opencode", "index");
    const invertedIndexPath = path.join(indexPath, "inverted-index.json");
    const readyPath = path.join(tempDir, "first-bm25-publication-ready.json");
    const releasePath = path.join(tempDir, "first-bm25-publication-release");
    const canonicalTargetPath = path.join(
      fs.realpathSync(projectRoot),
      ".opencode",
      "index",
      "inverted-index.json",
    );
    const worker = await createWorker({
      targetPath: canonicalTargetPath,
      readyPath,
      releasePath,
    });
    worker.send({ type: "run", operation: "index" });

    await waitForFile(readyPath);
    const reader = createLocalIndexer();
    const requestsBeforeRead = embeddingServer.requestCount;
    try {
      const statusBeforePublish = await reader.getStatus();

      expect(statusBeforePublish.indexed).toBe(true);
      expect(statusBeforePublish.warning).toMatch(/keyword.*semantic search/i);
      expect(fs.existsSync(invertedIndexPath)).toBe(false);
      expect(embeddingServer.requestCount).toBe(requestsBeforeRead);
    } finally {
      fs.writeFileSync(releasePath, "release");
    }

    const result = await worker.waitFor((message) => message.type === "result");
    expect(result.ok).toBe(true);
    await worker.waitForExit();

    const statusAfterPublish = await reader.getStatus();
    expect(statusAfterPublish.indexed).toBe(true);
    expect(statusAfterPublish.warning).toBeUndefined();
    expect(embeddingServer.requestCount).toBe(requestsBeforeRead);
    assertIndexIntegrity();
  });

  it("coordinates a cold reader and writer on the same Indexer", async () => {
    const indexer = createLocalIndexer();
    const [status, stats] = await Promise.all([
      indexer.getStatus(),
      indexer.index(),
    ]);

    expect(status.provider).toBe("custom");
    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    assertIndexIntegrity();
  });

  it("waits for writer-first initialization on the same Indexer", async () => {
    const indexer = createLocalIndexer();
    const indexing = indexer.index();
    const status = indexer.getStatus();
    const [stats, statusResult] = await Promise.all([indexing, status]);

    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(statusResult.compatibility).not.toBeNull();
    expect(embeddingServer.requestCount).toBe(1);
    assertIndexIntegrity();
  });

  it("refreshes a stale writer instance after another writer publishes", async () => {
    const indexer = createLocalIndexer();
    await indexer.index();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    fs.writeFileSync(
      sourcePath,
      "export function alpha() { return 'alpha'; }\nexport function publicationmarker() { return 'publicationmarker'; }\n",
    );
    const externalWriter = await createWorker();
    externalWriter.send({ type: "run", operation: "index" });
    expect((await externalWriter.waitFor((message) => message.type === "result")).ok).toBe(true);
    await externalWriter.waitForExit();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const results = await indexer.search("publicationmarker");
    expect(results.some((result) => result.name === "publicationmarker")).toBe(true);
    const removedResults = await indexer.search("beta");
    expect(removedResults.every((result) => result.name !== "beta")).toBe(true);
    expect(embeddingServer.inputs).toEqual(["publicationmarker", "beta"]);

    embeddingServer.reset();
    fs.appendFileSync(sourcePath, "export function writeragain() { return 'writeragain'; }\n");
    await expect(indexer.index()).resolves.toMatchObject({ indexedChunks: expect.any(Number) });
    expect(embeddingServer.inputs.some((input) => input.includes("writeragain"))).toBe(true);
    assertIndexIntegrity();
  });

  it("clears a lost local lease before refreshing a later external publication", async () => {
    const indexer = createLocalIndexer();
    embeddingServer.block();
    const indexing = indexer.index();
    await embeddingServer.waitForRequestCount(1);
    fs.rmSync(path.join(projectRoot, ".opencode", "index", "indexing.lock"), {
      recursive: true,
      force: true,
    });
    embeddingServer.release();
    await expect(indexing).rejects.toThrow(/lost ownership/i);
    expect(Reflect.get(indexer, "writerArtifactFingerprint")).toBeNull();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    fs.writeFileSync(sourcePath, "export function afterlostlease() { return 'afterlostlease'; }\n");
    const externalWriter = await createWorker();
    externalWriter.send({ type: "run", operation: "index" });
    expect((await externalWriter.waitFor((message) => message.type === "result")).ok).toBe(true);
    await externalWriter.waitForExit();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const results = await indexer.search("afterlostlease");
    expect(results.some((result) => result.name === "afterlostlease")).toBe(true);
    expect(embeddingServer.inputs).toEqual(["afterlostlease"]);
  });

  it("clears transient reader issues after a successful writer reload", async () => {
    const indexer = createLocalIndexer();
    await indexer.index();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();
    const invertedIndexPath = path.join(projectRoot, ".opencode", "index", "inverted-index.json");
    const readableBm25 = fs.readFileSync(invertedIndexPath);
    fs.writeFileSync(invertedIndexPath, "{partial");

    const degradedStatus = await indexer.getStatus();
    expect(degradedStatus.warning).toMatch(/keyword.*semantic search/i);

    fs.writeFileSync(invertedIndexPath, readableBm25);
    await indexer.index();
    const healthyStatus = await indexer.getStatus();
    expect(healthyStatus.warning).toBeUndefined();
    expect(embeddingServer.requestCount).toBe(0);
  });

  it("defers auto-GC from a cold reader to the next writer", async () => {
    const indexer = createLocalIndexer(true);
    const indexPath = path.join(projectRoot, ".opencode", "index");

    await indexer.getStatus();
    const databaseBeforeWriter = new Database(path.join(indexPath, "codebase.db"));
    expect(databaseBeforeWriter.getMetadata("lastGcTimestamp")).toBeNull();
    databaseBeforeWriter.close();
    expect(embeddingServer.requestCount).toBe(0);

    await indexer.index();
    const databaseAfterWriter = new Database(path.join(indexPath, "codebase.db"));
    expect(databaseAfterWriter.getMetadata("lastGcTimestamp")).not.toBeNull();
    databaseAfterWriter.close();
    assertIndexIntegrity();
  });

  it("leaves crashed-writer recovery to the next writer", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function recovered() { return 'after-crash'; }\n");
    embeddingServer.block();
    const crashed = await createWorker();
    crashed.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    await crashed.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const indexPath = path.join(projectRoot, ".opencode", "index");
    const ownerBeforeRead = readOwner();
    await createLocalIndexer().getStatus();

    expect(readOwner()).toBe(ownerBeforeRead);
    expect(embeddingServer.requestCount).toBe(0);
    expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);

    await createLocalIndexer().index();
    await embeddingServer.waitForIdle();
    embeddingServer.reset();

    const recoveredStatus = await createLocalIndexer().getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(embeddingServer.requestCount).toBe(0);
    assertIndexIntegrity();
  });

  it("allows only one of two real MCP stdio servers to index", async () => {
    const configPath = path.join(tempDir, "mcp-config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      embeddingProvider: "custom",
      scope: "project",
      customProvider: {
        baseUrl: embeddingServer.baseUrl,
        model: "multiprocess-test",
        dimensions: 8,
        timeoutMs: 5000,
        maxBatchSize: 64,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      include: ["**/*.ts"],
      exclude: ["**/.opencode/**", "**/.git/**", "**/node_modules/**"],
      indexing: {
        autoIndex: false,
        watchFiles: false,
        autoGc: false,
        retries: 0,
        retryDelayMs: 1,
        gitBlame: { enabled: false },
      },
      debug: { enabled: false },
    }));

    const first = await createMcpClient(configPath);
    const second = await createMcpClient(configPath);
    expect(first.transport.pid).not.toBeNull();
    expect(second.transport.pid).not.toBeNull();
    expect(first.transport.pid).not.toBe(second.transport.pid);

    embeddingServer.block();
    const firstResultPromise = first.client.callTool({ name: "index_codebase", arguments: {} });
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();
    const busyResult = await second.client.callTool({ name: "index_codebase", arguments: {} });

    expect(busyResult.isError).toBe(true);
    expect((busyResult.content as Array<{ text?: string }>).map(({ text }) => text ?? "").join("\n")).toContain("INDEX_BUSY");
    expect(readOwner()).toBe(ownerBefore);
    expect(embeddingServer.requestCount).toBe(1);

    embeddingServer.release();
    const firstResult = await firstResultPromise;
    expect(firstResult.isError).not.toBe(true);
    await embeddingServer.waitForIdle();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);

    await Promise.all([first.client.close(), second.client.close()]);
    mcpClients = [];
    assertIndexIntegrity();
  });

  it.each([
    ["force", "index"],
    ["index", "force"],
  ] as const)("keeps %s against %s under one lease", async (winningOperation, losingOperation) => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function alpha() { return 'updated'; }\nexport function gamma() { return alpha(); }\n");
    embeddingServer.block();

    const winner = await createWorker();
    const loser = await createWorker();
    winner.send({ type: "run", operation: winningOperation });
    const firstEvent = await Promise.race([
      embeddingServer.waitForRequestCount(1).then(() => ({ type: "embedding" as const })),
      winner.waitFor((message) => message.type === "result").then((message) => ({ type: "result" as const, message })),
    ]);
    if (firstEvent.type === "result") {
      throw new Error(`Winner exited before embedding: ${JSON.stringify(firstEvent.message)}`);
    }
    const ownerBefore = readOwner();
    loser.send({ type: "run", operation: losingOperation });
    const busy = await loser.waitFor((message) => message.type === "result");

    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);
    expect(readOwner()).toBe(ownerBefore);

    embeddingServer.release();
    expect((await winner.waitFor((message) => message.type === "result")).ok).toBe(true);
    await winner.waitForExit();
    await loser.waitForExit();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    assertIndexIntegrity();
  });

  it("recovers a crashed owner safely with two concurrent reclaimers", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function recovered() { return 'after-crash'; }\n");
    embeddingServer.block();
    const crashed = await createWorker();
    crashed.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const crashedOwner = JSON.parse(readOwner()) as { pid: number; token: string };
    await crashed.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();

    const indexPath = path.join(projectRoot, ".opencode", "index");
    for (const fileName of ["vectors", "vectors.meta.json"]) {
      const targetPath = path.join(indexPath, fileName);
      fs.renameSync(targetPath, `${targetPath}.bak.${crashedOwner.pid}.${crashedOwner.token}`);
    }
    fs.writeFileSync(
      path.join(indexPath, `file-hashes.json.tmp.${crashedOwner.pid}.${crashedOwner.token}.1`),
      "interrupted",
    );

    embeddingServer.reset();
    embeddingServer.block();

    const first = await createWorker();
    const second = await createWorker();
    first.send({ type: "run", operation: "index" });
    second.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const newOwner = JSON.parse(readOwner()) as { token: string };
    expect(newOwner.token).not.toBe(crashedOwner.token);

    const firstResultPromise = first.waitFor((message) => message.type === "result");
    const secondResultPromise = second.waitFor((message) => message.type === "result");
    const busy = await Promise.race([firstResultPromise, secondResultPromise]);
    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);

    embeddingServer.release();
    const results = await Promise.all([firstResultPromise, secondResultPromise]);
    expect(results.filter((result) => result.ok).length).toBe(1);
    expect(results.filter((result) => result.code === "INDEX_BUSY").length).toBe(1);
    await first.waitForExit();
    await second.waitForExit();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    assertIndexIntegrity();
  });

  it("recovers every pending owner after the recovery process also crashes", async () => {
    await seedIndex();
    embeddingServer.reset();
    fs.writeFileSync(sourcePath, "export function recoveredTwice() { return 'after-two-crashes'; }\n");
    embeddingServer.block();

    const firstCrashed = await createWorker();
    firstCrashed.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const firstOwner = JSON.parse(readOwner()) as { token: string };
    await firstCrashed.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();

    embeddingServer.reset();
    embeddingServer.block();
    const crashedRecovery = await createWorker();
    crashedRecovery.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);
    const secondOwner = JSON.parse(readOwner()) as { token: string };
    expect(secondOwner.token).not.toBe(firstOwner.token);
    await crashedRecovery.kill();
    embeddingServer.release();
    await embeddingServer.waitForIdle();

    embeddingServer.reset();
    embeddingServer.block();
    const finalRecovery = await createWorker();
    finalRecovery.send({ type: "run", operation: "index" });
    await embeddingServer.waitForRequestCount(1);

    const indexPath = path.join(projectRoot, ".opencode", "index");
    const pendingMarkers = fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."));
    expect(pendingMarkers).toHaveLength(2);

    embeddingServer.release();
    expect((await finalRecovery.waitFor((message) => message.type === "result")).ok).toBe(true);
    await finalRecovery.waitForExit();
    await embeddingServer.waitForIdle();
    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);
    assertIndexIntegrity();
  });

  it("coalesces two watcher processes without duplicate embeddings", async () => {
    const first = await createWorker();
    const second = await createWorker();
    first.send({ type: "run", operation: "watch" });
    second.send({ type: "run", operation: "watch" });
    await Promise.all([
      first.waitFor((message) => message.type === "watcher-ready"),
      second.waitFor((message) => message.type === "watcher-ready"),
    ]);

    embeddingServer.block();
    fs.writeFileSync(sourcePath, "export function watched() { return 'changed'; }\n");
    await embeddingServer.waitForRequestCount(1);
    const ownerBefore = readOwner();
    const busy = await Promise.race([
      first.waitFor((message) => message.type === "watch-result" && message.code === "INDEX_BUSY"),
      second.waitFor((message) => message.type === "watch-result" && message.code === "INDEX_BUSY"),
    ]);
    expect(busy.code).toBe("INDEX_BUSY");
    expect(embeddingServer.requestCount).toBe(1);
    expect(readOwner()).toBe(ownerBefore);

    embeddingServer.release();
    await Promise.race([
      first.waitFor((message) => message.type === "watch-result" && message.ok === true),
      second.waitFor((message) => message.type === "watch-result" && message.ok === true),
    ]);
    await Promise.all([
      first.waitFor((message) => message.type === "watch-result" && message.ok === true),
      second.waitFor((message) => message.type === "watch-result" && message.ok === true),
    ]);

    expect(embeddingServer.requestCount).toBe(1);
    expect(embeddingServer.maxActive).toBe(1);
    expect(new Set(embeddingServer.inputs).size).toBe(embeddingServer.inputs.length);
    await Promise.all([first.stop(), second.stop()]);
    assertIndexIntegrity();
  });
});
