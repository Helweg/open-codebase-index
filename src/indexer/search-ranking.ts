import type { ChunkMetadata } from "../native/index.js";
import { analyzeQueryIntent, rankIntentAwareCandidates } from "./intent-aware-ranking.js";

export type RankedCandidate = { id: string; score: number; metadata: ChunkMetadata };

interface HybridRankOptions {
  fusionStrategy: "weighted" | "rrf";
  rrfK: number;
  rerankTopN: number;
  limit: number;
  hybridWeight: number;
}

interface SemanticRankOptions {
  rerankTopN: number;
  limit: number;
  prioritizeSourcePaths?: boolean;
}

const RANK_HYBRID_CACHE_LIMIT = 256;
const rankHybridResultsCache = new WeakMap<RankedCandidate[], WeakMap<RankedCandidate[], Map<string, RankedCandidate[]>>>();

export function classifyQueryIntentRaw(query: string): "source" | "doc_test" | "neutral" {
  const intent = analyzeQueryIntent(query);
  if (intent.primary === "test" || intent.primary === "docs") return "doc_test";
  if (intent.preferSourcePaths) return "source";
  return "neutral";
}

export function fuseResultsWeighted(
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  keywordWeight: number,
  limit: number
): RankedCandidate[] {
  const semanticWeight = 1 - keywordWeight;
  const fusedScores = new Map<string, { score: number; metadata: ChunkMetadata }>();

  for (const r of semanticResults) {
    fusedScores.set(r.id, {
      score: r.score * semanticWeight,
      metadata: r.metadata,
    });
  }

  for (const r of keywordResults) {
    const existing = fusedScores.get(r.id);
    if (existing) {
      existing.score += r.score * keywordWeight;
    } else {
      fusedScores.set(r.id, {
        score: r.score * keywordWeight,
        metadata: r.metadata,
      });
    }
  }

  const results = Array.from(fusedScores.entries()).map(([id, data]) => ({
    id,
    score: data.score,
    metadata: data.metadata,
  }));

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, limit);
}

export function fuseResultsRrf(
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  rrfK: number,
  limit: number
): RankedCandidate[] {
  const maxPossibleRaw = 2 / (rrfK + 1);
  const rankByIdSemantic = new Map<string, number>();
  const rankByIdKeyword = new Map<string, number>();
  const metadataById = new Map<string, ChunkMetadata>();

  semanticResults.forEach((result, index) => {
    rankByIdSemantic.set(result.id, index + 1);
    metadataById.set(result.id, result.metadata);
  });

  keywordResults.forEach((result, index) => {
    rankByIdKeyword.set(result.id, index + 1);
    if (!metadataById.has(result.id)) {
      metadataById.set(result.id, result.metadata);
    }
  });

  const allIds = new Set<string>([...rankByIdSemantic.keys(), ...rankByIdKeyword.keys()]);
  const fused: RankedCandidate[] = [];

  for (const id of allIds) {
    const semanticRank = rankByIdSemantic.get(id);
    const keywordRank = rankByIdKeyword.get(id);

    const semanticScore = semanticRank ? 1 / (rrfK + semanticRank) : 0;
    const keywordScore = keywordRank ? 1 / (rrfK + keywordRank) : 0;

    const metadata = metadataById.get(id);
    if (!metadata) continue;

    fused.push({
      id,
      score: maxPossibleRaw > 0 ? (semanticScore + keywordScore) / maxPossibleRaw : 0,
      metadata,
    });
  }

  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return fused.slice(0, limit);
}

export function rerankResults(
  query: string,
  candidates: RankedCandidate[],
  rerankTopN: number,
  options?: { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  return rankIntentAwareCandidates(query, candidates, rerankTopN, options);
}

function diversifyEntriesByFileAndSymbol<T>(
  entries: T[],
  getCandidate: (entry: T) => RankedCandidate,
  enabled: boolean
): T[] {
  if (!enabled || entries.length <= 2) {
    return entries;
  }

  const groups = new Map<string, T[]>();
  const groupOrder: string[] = [];

  for (const entry of entries) {
    const candidate = getCandidate(entry);
    const filePath = candidate.metadata.filePath;
    if (!groups.has(filePath)) {
      groups.set(filePath, []);
      groupOrder.push(filePath);
    }
    groups.get(filePath)?.push(entry);
  }

  const diversifiedGroups = groupOrder.map((filePath) => {
    const group = groups.get(filePath) ?? [];
    return diversifyGroupBySymbol(group, getCandidate);
  });

  const result: T[] = [];
  let added = true;
  let round = 0;
  while (added) {
    added = false;
    for (const group of diversifiedGroups) {
      const entry = group[round];
      if (entry !== undefined) {
        result.push(entry);
        added = true;
      }
    }
    round += 1;
  }

  return result;
}

export function diversifyCandidatesByFile(candidates: RankedCandidate[], enabled: boolean): RankedCandidate[] {
  return diversifyEntriesByFileAndSymbol(candidates, (candidate) => candidate, enabled);
}

function diversifyGroupBySymbol<T>(
  entries: T[],
  getCandidate: (entry: T) => RankedCandidate
): T[] {
  if (entries.length <= 2) {
    return entries;
  }

  const seenKeys = new Set<string>();
  const primary: T[] = [];
  const remainder: T[] = [];

  for (const entry of entries) {
    const key = buildDiversityKey(getCandidate(entry).metadata);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      primary.push(entry);
    } else {
      remainder.push(entry);
    }
  }

  return [...primary, ...remainder];
}

function buildDiversityKey(metadata: ChunkMetadata): string {
  const normalizedPath = metadata.filePath.toLowerCase();
  const normalizedName = (metadata.name ?? "").trim().toLowerCase();
  if (normalizedName.length > 0) {
    return `${normalizedPath}#${normalizedName}`;
  }
  return normalizedPath;
}

export function rankHybridResults(
  query: string,
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  options: HybridRankOptions & { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  const prioritizeSourcePaths = options.prioritizeSourcePaths ?? classifyQueryIntentRaw(query) === "source";
  const cacheKey = `${query}\u0001${options.fusionStrategy}|${options.rrfK}|${options.hybridWeight}|${options.rerankTopN}|${options.limit}|${prioritizeSourcePaths ? 1 : 0}`;

  let byKeyword = rankHybridResultsCache.get(semanticResults);
  if (!byKeyword) {
    byKeyword = new WeakMap<RankedCandidate[], Map<string, RankedCandidate[]>>();
    rankHybridResultsCache.set(semanticResults, byKeyword);
  }

  let bucket = byKeyword.get(keywordResults);
  if (!bucket) {
    bucket = new Map<string, RankedCandidate[]>();
    byKeyword.set(keywordResults, bucket);
  } else {
    const cached = bucket.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const fused = options.fusionStrategy === "rrf"
    ? fuseResultsRrf(semanticResults, keywordResults, options.rrfK, overfetchLimit)
    : fuseResultsWeighted(semanticResults, keywordResults, options.hybridWeight, overfetchLimit);

  const rerankPoolLimit = Math.max(overfetchLimit, options.rerankTopN * 3, options.limit * 6);
  const rerankPool = fused.slice(0, rerankPoolLimit);
  const ranked = rerankResults(query, rerankPool, options.rerankTopN, {
    prioritizeSourcePaths,
  });

  if (bucket.size >= RANK_HYBRID_CACHE_LIMIT) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) {
      bucket.delete(oldest);
    }
  }
  bucket.set(cacheKey, ranked);

  return ranked;
}

export function rankSemanticOnlyResults(
  query: string,
  semanticResults: RankedCandidate[],
  options: SemanticRankOptions
): RankedCandidate[] {
  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const bounded = semanticResults.slice(0, overfetchLimit);
  return rerankResults(query, bounded, options.rerankTopN, {
    prioritizeSourcePaths: options.prioritizeSourcePaths ?? false,
  });
}
