import {
  analyzeQueryIntent,
  extractIntentIdentifierHints,
  isConfigPath,
  isDocumentationPath as isIntentDocumentationPath,
  isFixturePath,
  isLikelyImplementationPath as isIntentImplementationPath,
  isTestPath,
  normalizeRankingText,
} from "./intent-aware-ranking.js";
import { classifyQueryIntentRaw, type RankedCandidate } from "./search-ranking.js";
import { CALL_GRAPH_SYMBOL_CHUNK_TYPES } from "./call-graph-constants.js";

export type ExternalRerankBand = "implementation" | "documentation" | "test" | "config" | "other";

const RANKING_TOKEN_CACHE_LIMIT = 4096;

const rankingQueryTokenCache = new Map<string, Set<string>>();
const rankingPathTokenCache = new Map<string, Set<string>>();
const rankingTextTokenCache = new Map<string, Set<string>>();

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "using", "where",
  "what", "when", "why", "how", "are", "was", "were", "be", "been", "being",
  "find", "show", "get", "run", "use", "code", "function", "implementation",
  "retrieve", "results", "result", "search", "pipeline", "top", "in", "on", "of",
  "to", "by", "as", "or", "an", "a",
]);

function setBoundedCache(
  cache: Map<string, Set<string>>,
  key: string,
  value: Set<string>
): void {
  if (cache.size >= RANKING_TOKEN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

export function tokenizeTextForRanking(text: string): Set<string> {
  if (!text) {
    return new Set<string>();
  }

  const lowered = normalizeRankingText(text);
  const cache = rankingQueryTokenCache.get(lowered) ?? rankingTextTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const tokens = new Set(
    lowered
      .replace(/[^\p{L}\p{N}_$\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );

  setBoundedCache(rankingQueryTokenCache, lowered, tokens);
  setBoundedCache(rankingTextTokenCache, lowered, tokens);
  return tokens;
}

export function splitPathTokens(filePath: string): Set<string> {
  const lowered = normalizeRankingText(filePath);
  const cache = rankingPathTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const normalized = lowered
    .replace(/[^\p{L}\p{N}/._-]/gu, " ")
    .split(/[/._-]+/)
    .filter((token) => token.length > 1);
  const tokens = new Set(normalized);
  setBoundedCache(rankingPathTokenCache, lowered, tokens);
  return tokens;
}

export function isTestOrDocPath(filePath: string): boolean {
  return isTestPath(filePath) || isFixturePath(filePath) || isIntentDocumentationPath(filePath);
}

export function isLikelyImplementationPath(filePath: string): boolean {
  return isIntentImplementationPath(filePath);
}

export function isDocumentationPath(filePath: string): boolean {
  return isIntentDocumentationPath(filePath);
}

export function classifyExternalRerankBand(
  candidate: RankedCandidate,
  intent: ReturnType<typeof analyzeQueryIntent>
): ExternalRerankBand {
  const isDocOrTest = isTestOrDocPath(candidate.metadata.filePath);
  const isDocumentation = isDocumentationPath(candidate.metadata.filePath);
  const isTest = isTestPath(candidate.metadata.filePath) || isFixturePath(candidate.metadata.filePath);
  const isConfig = isConfigPath(candidate.metadata.filePath);
  const isImplementation = isLikelyImplementationPath(candidate.metadata.filePath) &&
    isImplementationChunkType(candidate.metadata.chunkType);

  if (intent.preferSourcePaths) {
    if (isImplementation) return "implementation";
    if (isConfig) return "config";
    if (isDocumentation) return "documentation";
    if (isTest || isDocOrTest) return "test";
    return "other";
  }

  if (intent.primary === "docs") {
    if (isDocumentation) return "documentation";
    if (isConfig) return "config";
    if (isImplementation) return "implementation";
    if (isTest || isDocOrTest) return "test";
    return "other";
  }

  if (intent.primary === "test") {
    if (isTest || isDocOrTest) return "test";
    if (isDocumentation) return "documentation";
    if (isConfig) return "config";
    if (isImplementation) return "implementation";
    return "other";
  }

  if (intent.primary === "config") {
    if (isConfig) return "config";
    if (isImplementation) return "implementation";
    if (isDocumentation) return "documentation";
    if (isTest || isDocOrTest) return "test";
    return "other";
  }

  if (isImplementation) return "implementation";
  if (isConfig) return "config";
  if (isDocumentation) return "documentation";
  if (isTest || isDocOrTest) return "test";
  return "other";
}

export function isImplementationChunkType(chunkType: string): boolean {
  return CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunkType) || [
    "export_statement",
    "function",
    "function_declaration",
    "method",
    "method_definition",
    "method_declaration",
    "protocol_function_declaration",
    "init_declaration",
    "deinit_declaration",
    "subscript_declaration",
    "class",
    "class_declaration",
    "actor_declaration",
    "extension_declaration",
    "interface",
    "protocol_declaration",
    "type",
    "enum",
    "enum_declaration",
    "struct_declaration",
    "module",
  ].includes(chunkType);
}

export function extractIdentifierHints(query: string): string[] {
  return extractIntentIdentifierHints(query);
}

export function extractCodeTermHints(query: string): string[] {
  const terms = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
    .filter((term) => !STOPWORDS.has(term));
}

export function normalizeIdentifierVariants(identifier: string): string[] {
  const lower = normalizeRankingText(identifier);
  const compact = lower.replace(/[^\p{L}\p{N}]/gu, "");
  const snake = identifier
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1_$2")
    .toLowerCase();
  const kebab = snake.replace(/_/g, "-");
  const variants = [lower, compact, snake, kebab].filter((value) => value.length > 0);
  return Array.from(new Set(variants));
}

function scoreIdentifierMatch(name: string | undefined, filePath: string, hints: string[]): number {
  const nameLower = (name ?? "").toLowerCase();
  const pathLower = filePath.toLowerCase();

  let best = 0;
  for (const hint of hints) {
    const variants = normalizeIdentifierVariants(hint);
    for (const variant of variants) {
      if (nameLower === variant) {
        best = Math.max(best, 1);
      } else if (nameLower.includes(variant)) {
        best = Math.max(best, 0.8);
      } else if (pathLower.includes(variant)) {
        best = Math.max(best, 0.6);
      }
    }
  }

  return best;
}

export function extractPrimaryIdentifierQueryHint(query: string): string | null {
  const identifiers = extractIdentifierHints(query);
  if (identifiers.length > 0) {
    return identifiers[0] ?? null;
  }

  const codeTerms = extractCodeTermHints(query);
  const best = codeTerms.find((term) => term.length >= 6);
  return best ?? null;
}

function pathSegmentsForAffinityMatch(filePath: string): string[] {
  const normalizedPath = normalizeRankingText(filePath).replace(/\\/g, "/");
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return [];
  }

  const basename = segments[segments.length - 1] ?? "";
  const basenameWithoutExt = basename.replace(/\.[^/.]+$/u, "");
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());

  return Array.from(new Set([
    ...normalizedSegments,
    basenameWithoutExt.toLowerCase(),
  ]));
}

function hasModuleAffinity(filePath: string, exactIdentifierVariants: string[]): boolean {
  const haystack = pathSegmentsForAffinityMatch(filePath);
  return exactIdentifierVariants.some((variant) => {
    if (!variant || variant.length < 2) {
      return false;
    }
    return haystack.includes(variant);
  });
}

const FILE_PATH_HINT_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "rs", "go", "java", "kt", "kts", "swift", "rb", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "scala", "lua",
  "sh", "bash", "zsh", "json", "yaml", "yml", "toml",
];

const FILE_PATH_HINT_SUFFIX_REGEX = new RegExp(
  "\\s+\\bin\\s+[\"'`]?((?:\\.\\/)?(?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.(?:" +
  FILE_PATH_HINT_EXTENSIONS.join("|") +
  "))[\"'`]?[\\])}>.,;!?]*\\s*$",
  "i"
);

function normalizeFilePathForHintMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase().replace(/^\.\//, "");
}

export function pathMatchesHint(filePath: string, hint: string): boolean {
  const normalizedPath = normalizeFilePathForHintMatch(filePath);
  const normalizedHint = normalizeFilePathForHintMatch(hint);

  return normalizedPath.endsWith(normalizedHint) ||
    normalizedPath.includes(`/${normalizedHint}`) ||
    normalizedPath.includes(normalizedHint);
}

export function extractFilePathHint(query: string): string | null {
  const match = query.match(FILE_PATH_HINT_SUFFIX_REGEX);
  const rawPath = match?.[1];
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^\.\//, "");
}

export function stripFilePathHint(query: string): string {
  const stripped = query.replace(FILE_PATH_HINT_SUFFIX_REGEX, "").trim();
  return stripped.length > 0 ? stripped : query;
}

export function buildDeterministicIdentifierPass(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primary = extractPrimaryIdentifierQueryHint(query);
  if (!primary) {
    return [];
  }
  const filePathHint = extractFilePathHint(query);
  const primaryVariants = normalizeIdentifierVariants(primary);

  const hints = [primary, ...extractIdentifierHints(query), ...extractCodeTermHints(query)]
    .map((value) => value.toLowerCase())
    .filter((value, idx, arr) => value.length >= 3 && arr.indexOf(value) === idx)
    .slice(0, 8);

  const deterministic = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();

      const exactIdentifierVariants = primaryVariants.filter((value) => value.length >= 2);
      const exactMatch = exactIdentifierVariants.some((variant) =>
        nameLower === variant ||
        nameLower.replace(/[^a-z0-9]/g, "") === variant.replace(/[^a-z0-9]/g, "")
      );
      let maxMatch = 0;
      const nameMatchesPrimary = exactMatch;
      const pathAffinity = exactMatch ? hasModuleAffinity(candidate.metadata.filePath, exactIdentifierVariants) : false;
      const pathMatchesFileHint = filePathHint ? pathMatchesHint(candidate.metadata.filePath, filePathHint) : false;

      for (const hint of hints) {
        const variants = normalizeIdentifierVariants(hint);
        for (const variant of variants) {
          if (nameLower === variant) {
            maxMatch = Math.max(maxMatch, 1);
          } else if (nameLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.85);
          } else if (pathLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.7);
          }
        }
      }

      if (pathMatchesFileHint && nameMatchesPrimary) {
        maxMatch = Math.max(maxMatch, 1);
      }

      return {
        candidate,
        maxMatch,
        pathMatchesFileHint,
        nameMatchesPrimary,
        pathAffinity,
      };
    })
    .filter((entry) => entry.maxMatch >= 0.7)
    .sort((a, b) => {
      const aAnchored = a.pathMatchesFileHint && a.nameMatchesPrimary ? 1 : 0;
      const bAnchored = b.pathMatchesFileHint && b.nameMatchesPrimary ? 1 : 0;
      if (aAnchored !== bAnchored) return bAnchored - aAnchored;

      if (a.nameMatchesPrimary !== b.nameMatchesPrimary) {
        return b.nameMatchesPrimary ? 1 : -1;
      }
      if (a.pathAffinity !== b.pathAffinity) return b.pathAffinity ? 1 : -1;
      if (b.maxMatch !== a.maxMatch) return b.maxMatch - a.maxMatch;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 12));

  return deterministic.map((entry) => ({
    id: entry.candidate.id,
    score: entry.pathMatchesFileHint && entry.nameMatchesPrimary
      ? 0.995
      : Math.min(1, 0.9 + entry.maxMatch * 0.09),
    metadata: entry.candidate.metadata,
  }));
}


export function buildIdentifierDefinitionLane(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primaryHint = extractPrimaryIdentifierQueryHint(query);
  if (!primaryHint) {
    return [];
  }

  const hints = [primaryHint, ...extractIdentifierHints(query), ...extractCodeTermHints(query)].slice(0, 8);
  const scored = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const matchScore = scoreIdentifierMatch(candidate.metadata.name, candidate.metadata.filePath, hints);
      return {
        candidate,
        matchScore,
      };
    })
    .filter((entry) => entry.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 10));

  return scored.map((entry) => ({
    id: entry.candidate.id,
    score: Math.min(1, 0.9 + entry.matchScore * 0.09),
    metadata: entry.candidate.metadata,
  }));
}
