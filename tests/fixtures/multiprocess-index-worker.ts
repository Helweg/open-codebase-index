import { parseConfig } from "../../src/config/schema.js";
import { Indexer } from "../../src/indexer/index.js";
import { isIndexLockContentionError } from "../../src/indexer/index-lock.js";
import { createWatcherWithIndexer, type CombinedWatcher } from "../../src/watcher/index.js";

type WorkerOperation = "index" | "force" | "watch";

interface RunMessage {
  type: "run";
  operation: WorkerOperation;
  pauseBeforeWatchIndex?: boolean;
}

interface StopMessage {
  type: "stop";
}

interface ResumeWatchIndexMessage {
  type: "resume-watch-index";
}

const projectRootValue = process.env.TEST_PROJECT_ROOT;
const baseUrlValue = process.env.TEST_EMBEDDING_BASE_URL;
if (!projectRootValue || !baseUrlValue) {
  throw new Error("TEST_PROJECT_ROOT and TEST_EMBEDDING_BASE_URL are required");
}
const projectRoot = projectRootValue;
const baseUrl = baseUrlValue;

const config = parseConfig({
  embeddingProvider: "custom",
  scope: "project",
  customProvider: {
    baseUrl,
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
});

const indexer = new Indexer(projectRoot, config, "opencode");
let watcher: CombinedWatcher | null = null;
let running = false;
let resumeWatchIndex: (() => void) | null = null;

function send(message: Record<string, unknown>): void {
  if (process.send) process.send(message);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (isIndexLockContentionError(error)) {
    return {
      ok: false,
      name: "IndexLockContentionError",
      code: "INDEX_BUSY",
      owner: error.owner,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: false,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

async function finish(): Promise<void> {
  await watcher?.stop();
  watcher = null;
  await indexer.close();
  process.disconnect?.();
}

async function runOnce(operation: Exclude<WorkerOperation, "watch">): Promise<void> {
  try {
    const stats = operation === "force" ? await indexer.forceIndex() : await indexer.index();
    send({ type: "result", operation, ok: true, stats });
  } catch (error) {
    send({ type: "result", operation, ...serializeError(error) });
  } finally {
    await finish();
  }
}

async function startWatcher(pauseBeforeIndex = false): Promise<void> {
  let admission = pauseBeforeIndex ? Promise.withResolvers<void>() : null;
  resumeWatchIndex = admission?.resolve ?? null;
  const originalIndex = indexer.index.bind(indexer);
  indexer.index = async (...args) => {
    send({ type: "watch-attempt" });
    // Gate only the first real watcher request; contention retries must proceed normally.
    const pendingAdmission = admission;
    admission = null;
    if (pendingAdmission) await pendingAdmission.promise;
    try {
      const stats = await originalIndex(...args);
      send({ type: "watch-result", ok: true, stats });
      return stats;
    } catch (error) {
      send({ type: "watch-result", ...serializeError(error) });
      throw error;
    }
  };

  watcher = createWatcherWithIndexer(() => indexer, projectRoot, config, "opencode");
  await watcher.whenReady();
  send({ type: "watcher-ready" });
}

process.on("message", (message: RunMessage | StopMessage | ResumeWatchIndexMessage) => {
  if (message.type === "resume-watch-index") {
    const resume = resumeWatchIndex;
    if (!resume) throw new Error("No paused watcher index request to resume");
    resumeWatchIndex = null;
    resume();
    return;
  }
  if (message.type === "stop") {
    void finish();
    return;
  }
  if (message.type !== "run" || running) return;
  running = true;
  if (message.operation === "watch") {
    void startWatcher(message.pauseBeforeWatchIndex).catch(async (error) => {
      send({ type: "result", operation: "watch", ...serializeError(error) });
      await finish();
    });
    return;
  }
  void runOnce(message.operation);
});

send({ type: "ready", pid: process.pid });
