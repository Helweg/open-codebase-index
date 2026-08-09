import type { ChunkMetadata } from "../native/index.js";

export type RankedCandidate = { id: string; score: number; metadata: ChunkMetadata };

export type PrimaryQueryIntent =
  | "definition"
  | "implementation"
  | "test"
  | "docs"
  | "config"
  | "call-flow"
  | "conceptual"
  | "neutral";

export interface QueryIntentProfile {
  primary: PrimaryQueryIntent;
  identifierHints: string[];
  primaryIdentifier?: string;
  preferSourcePaths: boolean;
  explicitArtifactIntent: boolean;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "code",
  "find", "for", "from", "get", "how", "in", "into", "is", "of", "on", "or",
  "result", "results", "retrieve", "run", "search", "show", "that", "the", "this",
  "to", "top", "use", "using", "was", "were", "what", "when", "where", "which",
  "who", "why", "with",
]);

const INTENT_WORDS = new Set([
  "benchmark", "benchmarks", "body", "call", "called", "callee", "callees", "caller",
  "callers", "calls", "class", "config", "configuration", "declaration", "defined",
  "definition", "dependency", "docs", "documentation", "example", "examples", "fixture",
  "fixtures", "function", "guide", "implement", "implementation", "implemented", "implements",
  "invoked", "logic", "manifest", "method", "readme", "reference", "references", "settings",
  "source", "spec", "specs", "symbol", "test", "tests", "usage",
]);

const AUTHORITATIVE_CHUNK_TYPES = new Set([
  "actor_declaration",
  "arrow_function",
  "class",
  "class_declaration",
  "class_definition",
  "class_name_statement",
  "class_specifier",
  "constructor_definition",
  "deinit_declaration",
  "enum",
  "enum_declaration",
  "enum_definition",
  "enum_item",
  "extension_declaration",
  "function",
  "function_declaration",
  "function_definition",
  "function_item",
  "impl",
  "impl_item",
  "init_declaration",
  "interface",
  "interface_declaration",
  "method",
  "method_declaration",
  "method_definition",
  "mod_item",
  "module",
  "namespace_definition",
  "protocol_declaration",
  "protocol_function_declaration",
  "signal_statement",
  "struct",
  "struct_declaration",
  "struct_item",
  "struct_specifier",
  "subscript_declaration",
  "trait",
  "trait_declaration",
  "trait_item",
  "trigger_declaration",
  "type",
  "type_alias_declaration",
  "type_declaration",
  "type_spec",
  "union_declaration",
]);

const IMPORT_CHUNK_TYPES = new Set([
  "import",
  "import_declaration",
  "import_statement",
  "include_directive",
  "use_declaration",
  "use_statement",
]);

const WEAK_CONTAINER_CHUNK_TYPES = new Set([
  "block",
  "export_statement",
  "lexical_declaration",
  "other",
  "program",
  "source_file",
  "statement_block",
]);

const TEST_CHUNK_TYPES = new Set(["test", "test_declaration"]);

const IMPLEMENTATION_FILE_EXTENSIONS = new Set([
  "apex", "bash", "c", "cc", "cls", "cpp", "cs", "cts", "cxx", "gd", "go", "h",
  "hpp", "hxx", "inc", "java", "js", "jsx", "kt", "kts", "lua", "m", "metal",
  "mjs", "mts", "php", "py", "rb", "rs", "scala", "sh", "swift", "trigger", "ts",
  "tsx", "zig", "zsh",
]);

function normalizePath(filePath: string): string {
  return normalizeRankingText(filePath).replace(/\\/g, "/");
}

export function normalizeRankingText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compactIdentifier(value: string): string {
  return normalizeRankingText(value).replace(/[^\p{L}\p{N}$]+/gu, "");
}

function identifierTokens(value: string): string[] {
  const normalized = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}$]+/gu, " ")
    .toLowerCase();
  return normalized.split(/\s+/).filter((token) => token.length > 1);
}

function queryWords(query: string): string[] {
  return query.normalize("NFKC").match(/[\p{L}_$][\p{L}\p{N}_$-]*/gu) ?? [];
}

function hasCodeShape(value: string): boolean {
  return /[_$]/u.test(value) || /[\p{Ll}\p{N}][\p{Lu}]/u.test(value);
}

export function extractIntentIdentifierHints(query: string): string[] {
  const quoted = Array.from(query.matchAll(/[`'"]([\p{L}_$][\p{L}\p{N}_$-]*)[`'"]/gu))
    .map((match) => match[1]);
  const words = queryWords(query);
  const normalizedWords = words.map((word) => normalizeRankingText(word));
  const contentWords = words.filter((_word, index) => {
    const normalized = normalizedWords[index] ?? "";
    return normalized.length >= 2 && !STOPWORDS.has(normalized) && !INTENT_WORDS.has(normalized);
  });

  const explicitlyCodeShaped = contentWords.filter(hasCodeShape);
  const hasDefinitionWording = /\b(?:defined|definition|declaration|implemented|implementation|symbol)\b/iu.test(query) ||
    /\bwhere\s+is\b/iu.test(query);
  const singleContentHint = contentWords.length === 1 ? contentWords : [];
  const intentAnchoredHints = hasDefinitionWording ? contentWords.slice(0, 3) : [];
  const candidates = [...quoted, ...explicitlyCodeShaped, ...singleContentHint, ...intentAnchoredHints];

  const seen = new Set<string>();
  const hints: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeRankingText(candidate);
    if (normalized.length < 2 || seen.has(normalized)) continue;
    seen.add(normalized);
    hints.push(normalized);
  }
  return hints.slice(0, 8);
}

export function analyzeQueryIntent(query: string): QueryIntentProfile {
  const normalized = normalizeRankingText(query);
  const identifierHints = extractIntentIdentifierHints(query);
  const primaryIdentifier = identifierHints[0];
  const testIntent = /\b(?:tests?|specs?|fixtures?|benchmarks?|coverage)\b/u.test(normalized);
  const docsIntent = /\b(?:docs?|documentation|readme|guides?|usage|examples?)\b/u.test(normalized);
  const configIntent = /\b(?:config|configuration|settings|manifest|tsconfig|package\.json|ya?ml|toml)\b/u.test(normalized);
  const callFlowIntent = /\b(?:callers?|callees?|call\s+(?:flow|graph|path|chain)|called\s+by|invoked\s+by|references?\s+to|dependency\s+path)\b/u.test(normalized) ||
    /\bwho\s+calls\b/u.test(normalized);
  const definitionIntent = /\b(?:defined|definition|declaration|symbol)\b/u.test(normalized) ||
    /\bwhere\s+is\b/u.test(normalized);
  const implementationIntent = /\b(?:implement|implementation|implemented|implements|source|logic|body)\b/u.test(normalized);
  const conceptual = identifierHints.length === 0 && queryWords(query).filter((word) => {
    const wordNormalized = normalizeRankingText(word);
    return !STOPWORDS.has(wordNormalized) && !INTENT_WORDS.has(wordNormalized);
  }).length >= 3;

  let primary: PrimaryQueryIntent;
  if (testIntent) primary = "test";
  else if (docsIntent) primary = "docs";
  else if (configIntent) primary = "config";
  else if (callFlowIntent) primary = "call-flow";
  else if (definitionIntent) primary = "definition";
  else if (implementationIntent) primary = "implementation";
  else if (conceptual) primary = "conceptual";
  else primary = "neutral";

  const explicitArtifactIntent = primary === "test" || primary === "docs" || primary === "config" || primary === "call-flow";
  const preferSourcePaths = primary === "definition" || primary === "implementation" || primary === "call-flow" ||
    (primary === "neutral" && identifierHints.length > 0);

  return {
    primary,
    identifierHints,
    primaryIdentifier,
    preferSourcePaths,
    explicitArtifactIntent,
  };
}

export function isTestPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/u.test(normalized) ||
    /(?:\.(?:test|spec)|_(?:test|spec))\.[^/]+$/u.test(normalized) ||
    /(?:^|\/)(?:test|spec)_[^/]+\.[^/]+$/u.test(normalized);
}

export function isFixturePath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(?:^|\/)(?:fixture|fixtures|testdata|snapshots?)(?:\/|$)/u.test(normalized) || normalized.endsWith(".snap");
}

export function isDocumentationPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(?:^|\/)docs?(?:\/|$)/u.test(normalized) || /(?:^|\/)readme(?:\.|$)/u.test(normalized) ||
    /\.(?:md|mdx|rst|adoc|txt)$/u.test(normalized);
}

export function isGeneratedOrVendorPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(?:^|\/)(?:node_modules|vendor|vendors|generated|dist|build|coverage|\.next|target)(?:\/|$)/u.test(normalized) ||
    /(?:\.min\.[^/]+|\.generated\.[^/]+|(?:^|\/)package-lock\.json|(?:^|\/)yarn\.lock|(?:^|\/)pnpm-lock\.yaml)$/u.test(normalized);
}

export function isConfigPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const baseName = normalized.split("/").pop() ?? normalized;
  return /(?:^|\/)(?:config|configs|\.github)(?:\/|$)/u.test(normalized) ||
    /^(?:package\.json|tsconfig(?:\.[^.]+)?\.json|pyproject\.toml|cargo\.toml|go\.mod)$/u.test(baseName) ||
    /(?:^|\.)(?:config|settings|rc)\.[^/]+$/u.test(baseName) ||
    /\.(?:yaml|yml|toml|ini)$/u.test(baseName);
}

export function isAuthoritativeChunkType(chunkType: string): boolean {
  return AUTHORITATIVE_CHUNK_TYPES.has(normalizeRankingText(chunkType));
}

export function isImportChunkType(chunkType: string): boolean {
  return IMPORT_CHUNK_TYPES.has(normalizeRankingText(chunkType));
}

function isWeakContainer(metadata: ChunkMetadata): boolean {
  const chunkType = normalizeRankingText(metadata.chunkType);
  const lineSpan = Math.max(1, metadata.endLine - metadata.startLine + 1);
  if (chunkType === "export_statement") return true;
  return WEAK_CONTAINER_CHUNK_TYPES.has(chunkType) && (lineSpan <= 2 || !metadata.name);
}

export function isLikelyImplementationPath(filePath: string): boolean {
  if (isTestPath(filePath) || isFixturePath(filePath) || isDocumentationPath(filePath) || isGeneratedOrVendorPath(filePath)) {
    return false;
  }
  if (!isConfigPath(filePath)) return true;
  const extension = normalizePath(filePath).split(".").pop() ?? "";
  return IMPLEMENTATION_FILE_EXTENSIONS.has(extension);
}

function nameMatchStrength(name: string | undefined, hints: string[]): number {
  if (!name || hints.length === 0) return 0;
  const normalizedName = normalizeRankingText(name);
  const compactName = compactIdentifier(name);
  const nameTokens = new Set(identifierTokens(name));
  let best = 0;

  for (const hint of hints) {
    const normalizedHint = normalizeRankingText(hint);
    const compactHint = compactIdentifier(hint);
    if (normalizedName === normalizedHint) {
      best = Math.max(best, 4);
    } else if (compactName.length > 0 && compactName === compactHint) {
      best = Math.max(best, 3.6);
    } else if (normalizedName.startsWith(normalizedHint) || normalizedHint.startsWith(normalizedName)) {
      best = Math.max(best, 1.6);
    } else if (normalizedName.includes(normalizedHint)) {
      best = Math.max(best, 1.2);
    } else {
      const hintTokens = identifierTokens(hint);
      if (hintTokens.length > 0 && hintTokens.every((token) => nameTokens.has(token))) {
        best = Math.max(best, 1);
      }
    }
  }

  return best;
}

function tokenOverlap(query: string, metadata: ChunkMetadata): number {
  const queryTokens = new Set(queryWords(query).flatMap(identifierTokens).filter((token) => !STOPWORDS.has(token)));
  if (queryTokens.size === 0) return 0;
  const candidateTokens = new Set([
    ...identifierTokens(metadata.name ?? ""),
    ...identifierTokens(metadata.chunkType),
    ...identifierTokens(normalizePath(metadata.filePath).split("/").slice(-3).join(" ")),
  ]);
  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function callFlowAffinity(metadata: ChunkMetadata): number {
  const tokens = new Set([
    ...identifierTokens(metadata.name ?? ""),
    ...identifierTokens(normalizePath(metadata.filePath)),
  ]);
  return ["call", "caller", "callee", "graph", "reference", "dependency", "edge", "path"]
    .filter((token) => tokens.has(token)).length;
}

interface ScoredCandidate {
  candidate: RankedCandidate;
  adjustedScore: number;
  originalIndex: number;
  nameMatch: number;
}

function scoreCandidate(query: string, intent: QueryIntentProfile, candidate: RankedCandidate, originalIndex: number): ScoredCandidate {
  const metadata = candidate.metadata;
  const nameMatch = nameMatchStrength(metadata.name, intent.identifierHints);
  const authoritative = isAuthoritativeChunkType(metadata.chunkType);
  const importChunk = isImportChunkType(metadata.chunkType);
  const weakContainer = isWeakContainer(metadata);
  const testPath = isTestPath(metadata.filePath) || TEST_CHUNK_TYPES.has(normalizeRankingText(metadata.chunkType));
  const fixturePath = isFixturePath(metadata.filePath);
  const docsPath = isDocumentationPath(metadata.filePath);
  const generatedOrVendor = isGeneratedOrVendorPath(metadata.filePath);
  const configPath = isConfigPath(metadata.filePath);
  const implementationPath = isLikelyImplementationPath(metadata.filePath);
  const overlap = tokenOverlap(query, metadata);
  let boost = 0;

  if (intent.primary === "conceptual") {
    boost += Math.min(0.14, overlap * 0.14);
    if (generatedOrVendor) boost -= 0.18;
    if (importChunk || weakContainer) boost -= 0.04;
  } else if (intent.primary === "test") {
    boost += testPath ? 1.25 : 0;
    boost += fixturePath ? 0.7 : 0;
    boost += /\b(?:test|spec|fixture)\b/u.test(normalizeRankingText(metadata.name ?? "")) ? 0.35 : 0;
    boost += nameMatch * 0.28;
    if (docsPath) boost -= 0.2;
    if (generatedOrVendor) boost -= 0.7;
  } else if (intent.primary === "docs") {
    boost += docsPath ? 1.25 : 0;
    boost += normalizePath(metadata.filePath).includes("readme") ? 0.25 : 0;
    boost += nameMatch * 0.25;
    if (testPath || fixturePath) boost -= 0.25;
    if (generatedOrVendor) boost -= 0.7;
  } else if (intent.primary === "config") {
    boost += configPath ? 1.3 : 0;
    boost += nameMatch * 0.35;
    boost += Math.min(0.3, overlap * 0.3);
    if (testPath || fixturePath || docsPath) boost -= 0.35;
    if (generatedOrVendor) boost -= 0.7;
  } else if (intent.primary === "call-flow") {
    boost += Math.min(1.2, callFlowAffinity(metadata) * 0.35);
    boost += authoritative && implementationPath ? 0.3 : 0;
    boost += nameMatch * 0.12;
    if (testPath || fixturePath || docsPath) boost -= 0.55;
    if (importChunk || weakContainer) boost -= 0.25;
    if (generatedOrVendor) boost -= 0.8;
  } else {
    const identifierDriven = intent.identifierHints.length > 0;
    boost += nameMatch;
    boost += authoritative ? (identifierDriven ? 0.65 : 0.18) : 0;
    boost += implementationPath && intent.preferSourcePaths ? 0.22 : 0;
    boost += Math.min(identifierDriven ? 0.25 : 0.12, overlap * (identifierDriven ? 0.25 : 0.12));
    if (importChunk) boost -= identifierDriven ? 1.05 : 0.08;
    if (weakContainer) boost -= identifierDriven ? 0.9 : 0.06;
    if (testPath) boost -= intent.preferSourcePaths ? 0.85 : 0;
    if (fixturePath) boost -= intent.preferSourcePaths ? 1 : 0;
    if (docsPath) boost -= intent.preferSourcePaths ? 0.8 : 0;
    if (generatedOrVendor) boost -= intent.preferSourcePaths ? 1.1 : 0.2;
  }

  return {
    candidate,
    adjustedScore: candidate.score + boost,
    originalIndex,
    nameMatch,
  };
}

function rangesOverlap(a: ChunkMetadata, b: ChunkMetadata): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function containsRange(outer: ChunkMetadata, inner: ChunkMetadata): boolean {
  return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

function areDuplicateEvidence(a: RankedCandidate, b: RankedCandidate): boolean {
  if (normalizePath(a.metadata.filePath) !== normalizePath(b.metadata.filePath)) return false;
  const aName = normalizeRankingText(a.metadata.name ?? "");
  const bName = normalizeRankingText(b.metadata.name ?? "");
  const sameNamedSymbol = aName.length > 0 && aName === bName;
  const eitherUnnamed = aName.length === 0 || bName.length === 0;
  const eitherWeakContainer = isWeakContainer(a.metadata) || isWeakContainer(b.metadata);
  const sameRange = a.metadata.startLine === b.metadata.startLine && a.metadata.endLine === b.metadata.endLine;
  if (sameRange) return sameNamedSymbol || eitherUnnamed || eitherWeakContainer;
  if (a.metadata.hash && b.metadata.hash && a.metadata.hash === b.metadata.hash) {
    return sameNamedSymbol || eitherUnnamed || eitherWeakContainer;
  }
  if (!rangesOverlap(a.metadata, b.metadata)) return false;

  const nested = containsRange(a.metadata, b.metadata) || containsRange(b.metadata, a.metadata);
  return nested && (sameNamedSymbol || eitherWeakContainer);
}

function deduplicateEvidence(entries: ScoredCandidate[]): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  for (const entry of entries) {
    if (selected.some((existing) => areDuplicateEvidence(existing.candidate, entry.candidate))) continue;
    selected.push(entry);
  }
  return selected;
}

function diversify(entries: ScoredCandidate[], preserveExactMatches: boolean): ScoredCandidate[] {
  if (entries.length <= 2) return entries;
  const exact = preserveExactMatches ? entries.filter((entry) => entry.nameMatch >= 3.6) : [];
  const exactIds = new Set(exact.map((entry) => entry.candidate.id));
  const remainder = entries.filter((entry) => !exactIds.has(entry.candidate.id));
  const groups = new Map<string, ScoredCandidate[]>();
  const order: string[] = [];

  for (const entry of remainder) {
    const filePath = normalizePath(entry.candidate.metadata.filePath);
    if (!groups.has(filePath)) {
      groups.set(filePath, []);
      order.push(filePath);
    }
    groups.get(filePath)?.push(entry);
  }

  const diversified: ScoredCandidate[] = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    for (const filePath of order) {
      const entry = groups.get(filePath)?.[round];
      if (!entry) continue;
      diversified.push(entry);
      added = true;
    }
    round += 1;
  }

  return [...exact, ...diversified];
}

export function rankIntentAwareCandidates(
  query: string,
  candidates: RankedCandidate[],
  rerankTopN: number,
  options?: { prioritizeSourcePaths?: boolean },
): RankedCandidate[] {
  if (rerankTopN <= 0 || candidates.length <= 1) return candidates;
  const intent = analyzeQueryIntent(query);
  if (options?.prioritizeSourcePaths !== undefined && options.prioritizeSourcePaths !== intent.preferSourcePaths) {
    intent.preferSourcePaths = options.prioritizeSourcePaths;
  }

  const topN = Math.min(rerankTopN, candidates.length);
  const scoredHead = candidates.slice(0, topN).map((candidate, index) => scoreCandidate(query, intent, candidate, index));
  scoredHead.sort((a, b) => {
    if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
    if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  const scoredTail = candidates.slice(topN).map((candidate, index) => ({
    candidate,
    adjustedScore: candidate.score,
    originalIndex: topN + index,
    nameMatch: nameMatchStrength(candidate.metadata.name, intent.identifierHints),
  }));
  const deduplicated = deduplicateEvidence([...scoredHead, ...scoredTail]);
  const shouldDiversify = intent.primary !== "definition" && intent.primary !== "implementation" || intent.identifierHints.length === 0;
  const preserveExactMatches = intent.identifierHints.length > 0 &&
    (intent.primary === "definition" || intent.primary === "implementation" || intent.primary === "neutral");
  const ordered = shouldDiversify
    ? diversify(deduplicated, preserveExactMatches)
    : deduplicated;
  return ordered.map((entry) => entry.candidate);
}
