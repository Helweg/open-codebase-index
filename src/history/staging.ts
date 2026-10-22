import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { createLeaseTemporaryPath } from "../indexer/index-lock.js";
import type { IndexLockLease } from "../indexer/index-lock.js";
import { HistoryError } from "./config.js";
import type { HistoryApi, HistoryDiscoveryPage } from "./github.js";
import type { HistoryCachedResponse, HistoryEntity, HistorySnapshot, HistorySyncProgress } from "./types.js";
import { assertHistoryProjectPath } from "./paths.js";
import { hydrateHistoryCache, packHistoryCache, projectHistoryResponse } from "./responses.js";
import { withHistoryLock } from "./storage.js";

const STAGE_VERSION = 2;
interface StageMetadata {
  version: typeof STAGE_VERSION;
  startedAt: string;
  generation: string;
  repositoryId: string;
  principalId: string;
  initialSince?: string;
  configuredInitialSince: string | null;
}
const stageMetadataSchema: z.ZodType<StageMetadata> = z.object({
  version: z.literal(STAGE_VERSION), startedAt: z.string().datetime(), generation: z.string().uuid(),
  repositoryId: z.string().min(1), principalId: z.string().min(1), initialSince: z.string().optional(),
  configuredInitialSince: z.string().nullable(),
});
export interface HistoryStage {
  api: HistoryApi;
  startedAt: string;
  generation: string;
  cache(entities: HistoryEntity[]): Record<string, HistoryCachedResponse>;
  clear(): void;
}
function metadata(directory: string): StageMetadata | undefined {
  const file = path.join(directory, "fetch-staging", "metadata.json");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), file);
  if (!existsSync(file)) return undefined;
  try { return stageMetadataSchema.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; }
}

/** Caller holds the lease; scope metadata can recover an initial cancelled sync without body replay. */
export function readHistoryStageWindow(directory: string): { initialSince?: string; configuredInitialSince: string | null } | undefined {
  const state = metadata(directory);
  return state ? { initialSince: state.initialSince, configuredInitialSince: state.configuredInitialSince } : undefined;
}

/** Caller holds the history lease. Old raw payloads are deleted without reading their bodies. */
export function retireHistoryStage(directory: string, published?: HistorySnapshot): void {
  const staging = path.join(directory, "fetch-staging");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), staging);
  if (!existsSync(staging)) return;
  const state = metadata(directory);
  const committed = published?.syncGeneration ? state?.generation === published.syncGeneration : Boolean(published?.cursor && state?.startedAt === published.cursor);
  if (!state || committed) rmSync(staging, { recursive: true, force: true });
}

export async function cleanLegacyHistoryStaging(directory: string): Promise<void> {
  const staging = path.join(directory, "fetch-staging");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), staging);
  if (existsSync(staging) && metadata(directory)?.version !== STAGE_VERSION) {
    await withHistoryLock(directory, "index", async () => retireHistoryStage(directory));
  }
}

export function openHistoryStage(directory: string, api: HistoryApi, lease: IndexLockLease, repositoryId: string, principalId: string, initialSince: string | undefined, configuredInitialSince: string | null, published?: HistorySnapshot): HistoryStage {
  retireHistoryStage(directory, published);
  const staging = path.join(directory, "fetch-staging");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o700);
  const file = path.join(staging, "metadata.json");
  const atomicWrite = (target: string, value: unknown) => {
    assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), target);
    const temporary = createLeaseTemporaryPath(target, lease.owner);
    try {
      writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  };
  const state: StageMetadata = metadata(directory) ?? { version: STAGE_VERSION, startedAt: new Date().toISOString(), generation: lease.owner.token, repositoryId, principalId, initialSince, configuredInitialSince };
  if (state.repositoryId !== repositoryId || state.principalId !== principalId) throw new HistoryError("HISTORY_INACCESSIBLE", "unfinished sync belongs to a different repository or public auth principal");
  if (state.initialSince !== initialSince || state.configuredInitialSince !== configuredInitialSince) throw new HistoryError("HISTORY_CONFIG", "initial window differs from unfinished sync; clear history before changing it");
  if (!existsSync(file)) atomicWrite(file, state);
  const oldResponses = hydrateHistoryCache(published);
  const used = new Map<string, HistoryCachedResponse>();
  const checkpoint = async <T>(key: string, fetch: () => Promise<T>): Promise<{ fetchedAt: string; value: T }> => {
    const target = path.join(staging, `${createHash("sha256").update(key).digest("hex")}.json`);
    assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), target);
    if (existsSync(target)) return JSON.parse(readFileSync(target, "utf8")) as { fetchedAt: string; value: T };
    const value = await fetch();
    const result = { fetchedAt: new Date().toISOString(), value };
    atomicWrite(target, result);
    return result;
  };
  return {
    startedAt: state.startedAt,
    generation: state.generation,
    api: {
      access: () => api.access(),
      async get(endpoint) {
        const fetched = await checkpoint(`GET ${endpoint}`, async () => {
          const previous = oldResponses.get(endpoint);
          const response = await api.get(endpoint, previous?.etag);
          if (response.status === 304) {
            if (!previous?.etag) throw new HistoryError("HISTORY_INCOMPLETE", "conditional response has no exact cached representation");
            return { etag: response.etag ?? previous.etag, value: projectHistoryResponse(endpoint, previous.value) };
          }
          return { etag: response.etag, value: projectHistoryResponse(endpoint, response.value) };
        });
        used.set(endpoint, { fetchedAt: fetched.fetchedAt, ...fetched.value });
        return { status: 200, ...fetched.value };
      },
      discover: async (kind, after) => (await checkpoint<HistoryDiscoveryPage>(`QUERY ${kind} ${after ?? ""}`, () => api.discover(kind, after))).value,
    },
    cache: (entities) => packHistoryCache(used, entities),
    clear: () => rmSync(staging, { recursive: true, force: true }),
  };
}

export function readHistorySyncProgress(directory: string, published?: HistorySnapshot): HistorySyncProgress | undefined {
  const staging = path.join(directory, "fetch-staging");
  const state = metadata(directory);
  if (state?.version !== STAGE_VERSION) return undefined;
  if (published?.syncGeneration ? state.generation === published.syncGeneration : published?.cursor === state.startedAt) return undefined;
  return { resumable: true, startedAt: state.startedAt, cachedRequests: readdirSync(staging).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length };
}
