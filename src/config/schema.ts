// Config schema without zod dependency to avoid version conflicts with OpenCode SDK

import { AUTO_DETECT_PROVIDER_ORDER, DEFAULT_INCLUDE, DEFAULT_EXCLUDE, EMBEDDING_MODELS, DEFAULT_PROVIDER_MODELS } from "./constants.js";
import {
  getDefaultDebugConfig,
  getDefaultIndexingConfig,
  getDefaultRerankerBaseUrl,
  getDefaultSearchConfig,
} from "./defaults.js";
import {
  getResolvedString,
  getResolvedStringArray,
  isStringArray,
  isValidFusionStrategy,
  isValidLogLevel,
  isValidModel,
  isValidProvider,
  isValidRerankerProvider,
  isValidScope,
} from "./validators.js";

export { isValidModel } from "./validators.js";

export type IndexScope = "project" | "global";

export interface IndexingConfig {
  autoIndex: boolean;
  /** Maximum time retrieval tools wait for first-use auto-indexing. */
  autoIndexWaitMs: number;
  /** Maximum transient interprocess lock retries for auto-indexing. */
  autoIndexMaxRetries: number;
  /** Initial exponential retry delay after transient lock contention. */
  autoIndexRetryDelayMs: number;
  watchFiles: boolean;
  /**
   * On macOS, defer automatic indexing while the computer is using battery power.
   * Manual index requests are never blocked. Default: false
   */
  pauseBackgroundIndexingOnBattery: boolean;
  maxFileSize: number;
  maxChunksPerFile: number;
  semanticOnly: boolean;
  retries: number;
  retryDelayMs: number;
  autoGc: boolean;
  gcIntervalDays: number;
  gcOrphanThreshold: number;
  /**
   * When true (default), requires a project marker (.git, package.json, Cargo.toml, etc.)
   * to be present before enabling file watching and auto-indexing.
   */
  requireProjectMarker: boolean;
  /**
   * Max directory traversal depth. -1 = unlimited, 0 = only files in the root dir,
   * 1 = one level of subdirectories, etc. Default: 5
   */
  maxDepth: number;
  /**
   * Max number of files to index per directory. Always picks the smallest files first.
   * Default: 100
   */
  maxFilesPerDirectory: number;
  /**
   * When a file hits maxChunksPerFile, fallback to text-based (chunk_by_lines) parsing
   * instead of skipping the rest of the file. Default: true
   */
  fallbackToTextOnMaxChunks: boolean;
  gitBlame: {
    enabled: boolean;
  };
}

export interface SearchConfig {
  maxResults: number;
  minScore: number;
  includeContext: boolean;
  hybridWeight: number;
  fusionStrategy: "weighted" | "rrf";
  rrfK: number;
  rerankTopN: number;
  contextLines: number;
  routingHints: boolean;
  routingGraphHandoffHints: boolean;
  routingHintRole: "system" | "developer";
  /** Multiplicative boost for candidates in an exact query symbol's call-graph community. Default: 0 (disabled). */
  communityBoost: number;
}

export type RerankerProvider = "cohere" | "jina" | "custom";

export interface RerankerConfig {
  /** Whether to enable reranking. Default: false */
  enabled: boolean;
  /** Provider shortcut for hosted rerank APIs. Use 'custom' to provide only baseUrl. */
  provider: RerankerProvider;
  /** Model name for reranking */
  model: string;
  /** Base URL of the rerank API endpoint */
  baseUrl: string;
  /** API key for the rerank service */
  apiKey?: string;
  /** Number of top documents to rerank */
  topN: number;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface DebugConfig {
  enabled: boolean;
  logLevel: LogLevel;
  logSearch: boolean;
  logEmbedding: boolean;
  logCache: boolean;
  logGc: boolean;
  logBranch: boolean;
  metrics: boolean;
  /** @deprecated Ignored. Use top-level effectivenessMetrics.enabled. */
  effectivenessMetrics?: boolean;
}

export interface EffectivenessMetricsConfig {
  /** Opt in to process-lifetime, memory-only repository tool aggregates. */
  enabled: boolean;
}

export interface CustomProviderConfig {
  /** Base URL of the OpenAI-compatible embeddings API. The path /embeddings is appended automatically (e.g. "http://localhost:11434/v1", "https://api.example.com/v1") */
  baseUrl: string;
  /** Model name to send in the API request (e.g. "nomic-embed-text") */
  model: string;
  /** Vector dimensions the model produces (e.g. 768 for nomic-embed-text) */
  dimensions: number;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Max tokens per input text (default: 8192) */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Max concurrent embedding requests (default: 3). Increase for local servers like llama.cpp or vLLM. */
  concurrency?: number;
  /** Minimum delay between requests in milliseconds (default: 1000). Set to 0 for local servers. */
  requestIntervalMs?: number;
  maxBatchSize?: number;
  max_batch_size?: number;
}

export interface CodebaseIndexConfig {
  embeddingProvider: EmbeddingProvider | 'custom' | 'auto';
  embeddingModel?: EmbeddingModelName;
  /** Configuration for custom OpenAI-compatible embedding providers (required when embeddingProvider is 'custom') */
  customProvider?: CustomProviderConfig;
  scope: IndexScope;
  indexing?: Partial<IndexingConfig>;
  search?: Partial<SearchConfig>;
  debug?: Partial<DebugConfig>;
  /** Privacy-safe effectiveness aggregation, independent from debug logging. */
  effectivenessMetrics?: Partial<EffectivenessMetricsConfig>;
  /** Reranking configuration for improving search result quality */
  reranker?: Partial<RerankerConfig>;
  /** External directories to index as knowledge bases (absolute or relative paths) */
  knowledgeBases?: string[];
  /** Override the default include patterns (replaces defaults) */
  include: string[];
  /** Override the default exclude patterns (replaces defaults) */
  exclude: string[];
  /** Additional file patterns to include (extends defaults) */
  additionalInclude?: string[];
}

export type ParsedCodebaseIndexConfig = CodebaseIndexConfig & {
  indexing: IndexingConfig;
  search: SearchConfig;
  debug: DebugConfig;
  effectivenessMetrics: EffectivenessMetricsConfig;
  reranker?: RerankerConfig;
  knowledgeBases: string[];
  additionalInclude: string[];
};

export function parseConfig(raw: unknown): ParsedCodebaseIndexConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const embeddingProviderValue = getResolvedString(input.embeddingProvider, "$root.embeddingProvider");
  const scopeValue = getResolvedString(input.scope, "$root.scope");
  const includeValue = getResolvedStringArray(input.include, "$root.include");
  const excludeValue = getResolvedStringArray(input.exclude, "$root.exclude");

  const defaultIndexing = getDefaultIndexingConfig();
  const defaultSearch = getDefaultSearchConfig();
  const defaultDebug = getDefaultDebugConfig();

  const rawIndexing = (input.indexing && typeof input.indexing === "object" ? input.indexing : {}) as Record<string, unknown>;
  const indexing: IndexingConfig = {
    autoIndex: typeof rawIndexing.autoIndex === "boolean" ? rawIndexing.autoIndex : defaultIndexing.autoIndex,
    autoIndexWaitMs: typeof rawIndexing.autoIndexWaitMs === "number"
      ? Math.min(60_000, Math.max(0, Math.floor(rawIndexing.autoIndexWaitMs)))
      : defaultIndexing.autoIndexWaitMs,
    autoIndexMaxRetries: typeof rawIndexing.autoIndexMaxRetries === "number"
      ? Math.min(10, Math.max(0, Math.floor(rawIndexing.autoIndexMaxRetries)))
      : defaultIndexing.autoIndexMaxRetries,
    autoIndexRetryDelayMs: typeof rawIndexing.autoIndexRetryDelayMs === "number"
      ? Math.min(10_000, Math.max(10, Math.floor(rawIndexing.autoIndexRetryDelayMs)))
      : defaultIndexing.autoIndexRetryDelayMs,
    watchFiles: typeof rawIndexing.watchFiles === "boolean" ? rawIndexing.watchFiles : defaultIndexing.watchFiles,
    pauseBackgroundIndexingOnBattery: typeof rawIndexing.pauseBackgroundIndexingOnBattery === "boolean"
      ? rawIndexing.pauseBackgroundIndexingOnBattery
      : defaultIndexing.pauseBackgroundIndexingOnBattery,
    maxFileSize: typeof rawIndexing.maxFileSize === "number" ? rawIndexing.maxFileSize : defaultIndexing.maxFileSize,
    maxChunksPerFile: typeof rawIndexing.maxChunksPerFile === "number" ? Math.max(1, rawIndexing.maxChunksPerFile) : defaultIndexing.maxChunksPerFile,
    semanticOnly: typeof rawIndexing.semanticOnly === "boolean" ? rawIndexing.semanticOnly : defaultIndexing.semanticOnly,
    retries: typeof rawIndexing.retries === "number" ? rawIndexing.retries : defaultIndexing.retries,
    retryDelayMs: typeof rawIndexing.retryDelayMs === "number" ? rawIndexing.retryDelayMs : defaultIndexing.retryDelayMs,
    autoGc: typeof rawIndexing.autoGc === "boolean" ? rawIndexing.autoGc : defaultIndexing.autoGc,
    gcIntervalDays: typeof rawIndexing.gcIntervalDays === "number" ? Math.max(1, rawIndexing.gcIntervalDays) : defaultIndexing.gcIntervalDays,
    gcOrphanThreshold: typeof rawIndexing.gcOrphanThreshold === "number" ? Math.max(0, rawIndexing.gcOrphanThreshold) : defaultIndexing.gcOrphanThreshold,
    requireProjectMarker: typeof rawIndexing.requireProjectMarker === "boolean" ? rawIndexing.requireProjectMarker : defaultIndexing.requireProjectMarker,
    maxDepth: typeof rawIndexing.maxDepth === "number" ? (rawIndexing.maxDepth < -1 ? -1 : rawIndexing.maxDepth) : defaultIndexing.maxDepth,
    maxFilesPerDirectory: typeof rawIndexing.maxFilesPerDirectory === "number" ? Math.max(1, rawIndexing.maxFilesPerDirectory) : defaultIndexing.maxFilesPerDirectory,
    fallbackToTextOnMaxChunks: typeof rawIndexing.fallbackToTextOnMaxChunks === "boolean" ? rawIndexing.fallbackToTextOnMaxChunks : defaultIndexing.fallbackToTextOnMaxChunks,
    gitBlame: {
      enabled: rawIndexing.gitBlame && typeof rawIndexing.gitBlame === "object" && typeof (rawIndexing.gitBlame as Record<string, unknown>).enabled === "boolean"
        ? (rawIndexing.gitBlame as { enabled: boolean }).enabled
        : defaultIndexing.gitBlame.enabled,
    },
  };

  const rawSearch = (input.search && typeof input.search === "object" ? input.search : {}) as Record<string, unknown>;
  const search: SearchConfig = {
    maxResults: typeof rawSearch.maxResults === "number" ? rawSearch.maxResults : defaultSearch.maxResults,
    minScore: typeof rawSearch.minScore === "number" ? rawSearch.minScore : defaultSearch.minScore,
    includeContext: typeof rawSearch.includeContext === "boolean" ? rawSearch.includeContext : defaultSearch.includeContext,
    hybridWeight: typeof rawSearch.hybridWeight === "number" ? Math.min(1, Math.max(0, rawSearch.hybridWeight)) : defaultSearch.hybridWeight,
    fusionStrategy: isValidFusionStrategy(rawSearch.fusionStrategy) ? rawSearch.fusionStrategy : defaultSearch.fusionStrategy,
    rrfK: typeof rawSearch.rrfK === "number" ? Math.max(1, Math.floor(rawSearch.rrfK)) : defaultSearch.rrfK,
    rerankTopN: typeof rawSearch.rerankTopN === "number" ? Math.min(200, Math.max(0, Math.floor(rawSearch.rerankTopN))) : defaultSearch.rerankTopN,
    contextLines: typeof rawSearch.contextLines === "number" ? Math.min(50, Math.max(0, rawSearch.contextLines)) : defaultSearch.contextLines,
    routingHints: typeof rawSearch.routingHints === "boolean" ? rawSearch.routingHints : defaultSearch.routingHints,
    routingGraphHandoffHints: typeof rawSearch.routingGraphHandoffHints === "boolean" ? rawSearch.routingGraphHandoffHints : defaultSearch.routingGraphHandoffHints,
    routingHintRole: rawSearch.routingHintRole === "developer" || rawSearch.routingHintRole === "system"
      ? rawSearch.routingHintRole
      : defaultSearch.routingHintRole,
    communityBoost: typeof rawSearch.communityBoost === "number" && Number.isFinite(rawSearch.communityBoost)
      ? Math.min(1, Math.max(0, rawSearch.communityBoost))
      : defaultSearch.communityBoost,
  };

  const rawDebug = (input.debug && typeof input.debug === "object" ? input.debug : {}) as Record<string, unknown>;
  const debug: DebugConfig = {
    enabled: typeof rawDebug.enabled === "boolean" ? rawDebug.enabled : defaultDebug.enabled,
    logLevel: isValidLogLevel(rawDebug.logLevel) ? rawDebug.logLevel : defaultDebug.logLevel,
    logSearch: typeof rawDebug.logSearch === "boolean" ? rawDebug.logSearch : defaultDebug.logSearch,
    logEmbedding: typeof rawDebug.logEmbedding === "boolean" ? rawDebug.logEmbedding : defaultDebug.logEmbedding,
    logCache: typeof rawDebug.logCache === "boolean" ? rawDebug.logCache : defaultDebug.logCache,
    logGc: typeof rawDebug.logGc === "boolean" ? rawDebug.logGc : defaultDebug.logGc,
    logBranch: typeof rawDebug.logBranch === "boolean" ? rawDebug.logBranch : defaultDebug.logBranch,
    metrics: typeof rawDebug.metrics === "boolean" ? rawDebug.metrics : defaultDebug.metrics,
  };

  const rawEffectivenessMetrics = (
    input.effectivenessMetrics && typeof input.effectivenessMetrics === "object"
      ? input.effectivenessMetrics
      : {}
  ) as Record<string, unknown>;
  const effectivenessMetrics: EffectivenessMetricsConfig = {
    enabled: rawEffectivenessMetrics.enabled === true,
  };

  const rawKnowledgeBases = input.knowledgeBases;
  const knowledgeBases: string[] = isStringArray(rawKnowledgeBases)
    ? rawKnowledgeBases.filter(p => typeof p === "string" && p.trim().length > 0).map(p => p.trim())
    : [];

  const rawAdditionalInclude = input.additionalInclude;
  const additionalInclude: string[] = isStringArray(rawAdditionalInclude)
    ? rawAdditionalInclude
      .filter(p => typeof p === "string" && p.trim().length > 0)
      .map(p => p.trim())
    : [];

  let embeddingProvider: EmbeddingProvider | 'custom' | 'auto';
  let embeddingModel: EmbeddingModelName | undefined;
  let customProvider: CustomProviderConfig | undefined;
  let reranker: RerankerConfig | undefined;

  const githubCopilotDeprecationMessage =
    "`embeddingProvider: \"github-copilot\"` is deprecated and no longer available. " +
    "Migrate existing configs to `embeddingProvider: \"google\"` and select an explicit Google model. " +
    "For existing indexes, run `index_codebase` with `force: true` after changing to `gemini-embedding-001` " +
    "or `gemini-embedding-2` to rebuild embeddings. See docs/configuration.md for details.";

  if (embeddingProviderValue === 'custom') {
    embeddingProvider = 'custom';
    const rawCustom = (input.customProvider && typeof input.customProvider === 'object' ? input.customProvider : null) as Record<string, unknown> | null;
    const baseUrlValue = getResolvedString(rawCustom?.baseUrl, "$root.customProvider.baseUrl");
    const modelValue = getResolvedString(rawCustom?.model, "$root.customProvider.model");
    const apiKeyValue = getResolvedString(rawCustom?.apiKey, "$root.customProvider.apiKey");
    if (rawCustom && typeof baseUrlValue === 'string' && baseUrlValue.trim().length > 0 && typeof modelValue === 'string' && modelValue.trim().length > 0 && typeof rawCustom.dimensions === 'number' && Number.isInteger(rawCustom.dimensions) && rawCustom.dimensions > 0) {
      customProvider = {
        baseUrl: baseUrlValue.trim().replace(/\/+$/, ''),
        model: modelValue,
        dimensions: rawCustom.dimensions,
        apiKey: apiKeyValue,
        maxTokens: typeof rawCustom.maxTokens === 'number' ? rawCustom.maxTokens : undefined,
        timeoutMs: typeof rawCustom.timeoutMs === 'number' ? Math.max(1000, rawCustom.timeoutMs) : undefined,
        concurrency: typeof rawCustom.concurrency === 'number' ? Math.max(1, Math.floor(rawCustom.concurrency)) : undefined,
        requestIntervalMs: typeof rawCustom.requestIntervalMs === 'number' ? Math.max(0, Math.floor(rawCustom.requestIntervalMs)) : undefined,
        maxBatchSize: typeof rawCustom.maxBatchSize === 'number'
          ? Math.max(1, Math.floor(rawCustom.maxBatchSize))
          : typeof rawCustom.max_batch_size === 'number'
            ? Math.max(1, Math.floor(rawCustom.max_batch_size))
            : undefined,
      };
      // Warn if baseUrl doesn't end with an API version path like /v1.
      // Note: using console.warn here because Logger isn't initialized yet at config parse time.
      if (!/\/v\d+\/?$/.test(customProvider.baseUrl)) {
        console.warn(
          `[codebase-index] Warning: customProvider.baseUrl ("${customProvider.baseUrl}") does not end with an API version path like /v1. ` +
          `The plugin appends /embeddings automatically, so the full URL will be "${customProvider.baseUrl}/embeddings". ` +
          `If your provider expects /v1/embeddings, set baseUrl to "${customProvider.baseUrl}/v1".`
        );
      }
    } else {
      throw new Error(
        "embeddingProvider is 'custom' but customProvider config is missing or invalid. " +
        "Required fields: baseUrl (string), model (string), dimensions (positive integer)."
      );
    }
  } else if (isValidProvider(embeddingProviderValue)) {
    embeddingProvider = embeddingProviderValue;
    const rawEmbeddingModel = input.embeddingModel;
    if (typeof rawEmbeddingModel === "string") {
      const embeddingModelValue = getResolvedString(rawEmbeddingModel, "$root.embeddingModel");
      if (embeddingModelValue) {
        embeddingModel = isValidModel(embeddingModelValue, embeddingProvider) ? embeddingModelValue : DEFAULT_PROVIDER_MODELS[embeddingProvider];
      }
    } else if (rawEmbeddingModel) {
      embeddingModel = DEFAULT_PROVIDER_MODELS[embeddingProvider];
    }
  } else if (embeddingProviderValue === 'github-copilot') {
    throw new Error(githubCopilotDeprecationMessage);
  } else {
    embeddingProvider = 'auto';
  }

  const rawReranker = (input.reranker && typeof input.reranker === "object"
    ? input.reranker
    : {}) as Record<string, unknown>;
  const rerankerEnabled = typeof rawReranker.enabled === "boolean" ? rawReranker.enabled : false;
  if (rerankerEnabled) {
    const provider = isValidRerankerProvider(rawReranker.provider) ? rawReranker.provider : "custom";
    const model = getResolvedString(rawReranker.model, "$root.reranker.model");
    if (!model || model.trim().length === 0) {
      throw new Error("reranker is enabled but reranker.model is missing or invalid.");
    }

    const configuredBaseUrl = getResolvedString(rawReranker.baseUrl, "$root.reranker.baseUrl");
    const baseUrl = configuredBaseUrl?.trim() || getDefaultRerankerBaseUrl(provider);
    if (baseUrl.length === 0) {
      throw new Error("reranker is enabled but reranker.baseUrl is missing or invalid for provider 'custom'.");
    }

    const apiKey = getResolvedString(rawReranker.apiKey, "$root.reranker.apiKey");
    if ((provider === "cohere" || provider === "jina") && (!apiKey || apiKey.trim().length === 0)) {
      throw new Error(`reranker provider '${provider}' requires reranker.apiKey when enabled.`);
    }

    reranker = {
      enabled: true,
      provider,
      model: model.trim(),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: apiKey?.trim() || undefined,
      topN: typeof rawReranker.topN === "number" ? Math.min(50, Math.max(1, Math.floor(rawReranker.topN))) : 15,
      timeoutMs: typeof rawReranker.timeoutMs === "number" ? Math.max(1000, Math.floor(rawReranker.timeoutMs)) : 10000,
    };
  }

  return {
    embeddingProvider,
    embeddingModel,
    customProvider,
    scope: isValidScope(scopeValue) ? scopeValue : "project",
    include: includeValue ?? DEFAULT_INCLUDE,
    exclude: excludeValue ?? DEFAULT_EXCLUDE,
    additionalInclude,
    indexing,
    search,
    debug,
    effectivenessMetrics,
    reranker,
    knowledgeBases,
  };
}

export function getDefaultModelForProvider(provider: EmbeddingProvider): EmbeddingModelInfo {
  const models = EMBEDDING_MODELS[provider];
  const providerDefault = DEFAULT_PROVIDER_MODELS[provider];
  return models[providerDefault as keyof typeof models];
}

/**
 * Built-in embedding providers derived from the static EMBEDDING_MODELS catalog.
 * 'custom' is intentionally excluded from this union because it has no static model
 * catalog — its model/dimensions/config are entirely user-defined at runtime via
 * CustomProviderConfig. Code that handles all providers uses `EmbeddingProvider | 'custom'`.
 */
export type EmbeddingProvider = keyof typeof EMBEDDING_MODELS;

export const availableProviders: EmbeddingProvider[] = Object.keys(EMBEDDING_MODELS) as EmbeddingProvider[];

export const autoDetectProviders: EmbeddingProvider[] = AUTO_DETECT_PROVIDER_ORDER.filter(
  (provider): provider is EmbeddingProvider => provider in EMBEDDING_MODELS,
);

export type ProviderModels = {
  [P in keyof typeof EMBEDDING_MODELS]: P extends "ollama"
    ? string
    : keyof (typeof EMBEDDING_MODELS)[P]
}

export type EmbeddingModelName = ProviderModels[keyof ProviderModels];

/** Shared fields across all embedding model types (built-in and custom) */
export interface BaseModelInfo {
  model: string;
  dimensions: number;
  maxTokens: number;
  costPer1MTokens: number;
}

export interface GoogleEmbeddingModelInfo extends BaseModelInfo {
  provider: "google";
  taskAble: boolean;
  promptStyle?: "embedding-2";
}

export type EmbeddingProviderModelInfo = {
  [P in EmbeddingProvider]: P extends "ollama"
    ? BaseModelInfo & { provider: "ollama" }
    : P extends "google"
      ? GoogleEmbeddingModelInfo
    : (typeof EMBEDDING_MODELS)[P][keyof (typeof EMBEDDING_MODELS)[P]]
}

export type EmbeddingModelInfo = EmbeddingProviderModelInfo[EmbeddingProvider];
