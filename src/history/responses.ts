import type { HistoryCachedResponse, HistoryEntity, HistorySnapshot } from "./types.js";
import { HistoryError } from "./config.js";
export const HISTORY_HTTP_CACHE_VERSION = 1;

export interface HistoryRestResponse {
  status: 200 | 304;
  etag?: string;
  value?: unknown;
}

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryError("HISTORY_API", "invalid GitHub object response");
  return value as JsonRecord;
}
function pick(value: JsonRecord, keys: string[]): JsonRecord {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
function discussion(value: JsonRecord): JsonRecord {
  const identity = pick(value, ["id", "node_id", "state"]);
  // Keep pending page membership, but no unpublished private review body or body reference.
  if (value.state === "PENDING") return identity;
  const result = { ...identity, ...pick(value, ["body", "created_at", "updated_at", "submitted_at"]) };
  if (value.user && typeof value.user === "object") result.user = pick(object(value.user), ["login"]);
  return result;
}

/** The durable representation is a strict endpoint DTO, never a raw API response. */
export function projectHistoryResponse(endpoint: string, response: unknown): unknown {
  const route = endpoint.split("?")[0];
  if (/^repos\/[^/]+\/[^/]+$/.test(route)) return pick(object(response), ["id", "node_id", "full_name"]);
  if (/\/pulls\/[0-9]+$/.test(route)) {
    const value = object(response);
    const result = pick(value, ["changed_files", "merged_at", "merge_commit_sha", "draft"]);
    for (const name of ["head", "base"]) if (value[name] && typeof value[name] === "object") result[name] = pick(object(value[name]), ["sha"]);
    return result;
  }
  if (/\/issues\/[0-9]+$/.test(route)) {
    const value = object(response);
    return { ...discussion(value), ...pick(value, ["number", "title", "state"]), ...(value.pull_request ? { pull_request: true } : {}) };
  }
  if (!Array.isArray(response)) throw new HistoryError("HISTORY_API", "invalid GitHub collection response");
  if (/\/(?:comments|reviews)$/.test(route)) return response.map((value) => discussion(object(value)));
  if (/\/files$/.test(route)) return response.map((value) => pick(object(value), ["filename"]));
  if (/\/timeline$/.test(route)) return response.map((item) => {
    const value = object(item);
    const result = pick(value, ["id", "node_id", "event", "created_at", "sha", "commit_id"]);
    if (value.source && typeof value.source === "object") {
      const source = object(value.source);
      if (source.issue && typeof source.issue === "object") result.source = { issue: pick(object(source.issue), ["html_url"]) };
    }
    return result;
  });
  throw new HistoryError("HISTORY_API", "unsupported history response projection");
}

function endpointDocumentKind(endpoint: string): { number: number; kind: string } | undefined {
  const route = endpoint.split("?")[0];
  const match = /\/(issues|pulls)\/([0-9]+)(?:\/(comments|reviews))?$/.exec(route);
  if (!match || match[1] === "pulls" && !match[3]) return undefined;
  return { number: Number(match[2]), kind: !match[3] ? "body" : match[3] === "reviews" ? "review" : match[1] === "pulls" ? "review_comment" : "comment" };
}

/** Resolve only against the old, immutable published snapshot, before fetching replacements. */
export function hydrateHistoryCache(snapshot: HistorySnapshot | undefined): Map<string, HistoryCachedResponse> {
  const result = new Map<string, HistoryCachedResponse>();
  if (!snapshot?.repositoryId || !snapshot.principalId || snapshot.httpCacheVersion !== HISTORY_HTTP_CACHE_VERSION || !snapshot.httpCache) return result;
  const bodies = new Map<string, string>(snapshot.entities.flatMap((entity) => entity.documents.map((doc) => [`${entity.number}:${doc.id}`, doc.body] as const)));
  for (const [endpoint, cached] of Object.entries(snapshot.httpCache)) {
    const source = endpointDocumentKind(endpoint);
    let valid = true;
    const hydrate = (item: unknown): unknown => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const value = item as JsonRecord;
      if (!source) return value;
      if (value.state === "PENDING" && !("body" in value)) return value;
      if (!value.body || typeof value.body !== "object" || !("historyDocument" in value.body)) { valid = false; return value; }
      const reference = value.body.historyDocument;
      const expected = `${source.number}:${source.kind}:${value.id ?? value.node_id}`;
      if (reference !== expected || !bodies.has(expected)) { valid = false; return value; }
      return { ...value, body: bodies.get(expected) };
    };
    const value = Array.isArray(cached.value) ? cached.value.map(hydrate) : hydrate(cached.value);
    if (valid) result.set(endpoint, { ...cached, value });
  }
  return result;
}

/** Bodies already live in normalized documents; avoid duplicating them in published cache JSON. */
export function packHistoryCache(responses: Map<string, HistoryCachedResponse>, entities: HistoryEntity[]): Record<string, HistoryCachedResponse> {
  const included = new Set(entities.map((entity) => entity.number));
  const bodies = new Map<string, string>(entities.flatMap((entity) => entity.documents.map((doc) => [`${entity.number}:${doc.id}`, doc.body] as const)));
  const result: Record<string, HistoryCachedResponse> = {};
  for (const [endpoint, cached] of responses) {
    const entity = /\/(?:issues|pulls)\/([0-9]+)/.exec(endpoint);
    if (entity && !included.has(Number(entity[1]))) continue;
    const source = endpointDocumentKind(endpoint);
    let valid = true;
    const encode = (item: unknown): unknown => {
      if (!source || !item || typeof item !== "object" || Array.isArray(item)) return item;
      const value = item as JsonRecord;
      if (!("body" in value)) return value;
      const reference = `${source.number}:${source.kind}:${value.id ?? value.node_id}`;
      if (!bodies.has(reference) || bodies.get(reference) !== String(value.body ?? "")) { valid = false; return value; }
      return { ...value, body: { historyDocument: reference } };
    };
    const value = Array.isArray(cached.value) ? cached.value.map(encode) : encode(cached.value);
    if (valid) result[endpoint] = { ...cached, value };
  }
  return result;
}
