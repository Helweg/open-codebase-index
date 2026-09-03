import type {
  DebugConfig,
  IndexingConfig,
  McpConfig,
  RerankerProvider,
  SearchConfig,
} from "./schema.js";

export function getDefaultMcpConfig(): McpConfig {
  return {
    stallTimeoutMs: 300_000,
  };
}

export function getDefaultIndexingConfig(): IndexingConfig {
  return {
    autoIndex: false,
    autoIndexWaitMs: 10_000,
    autoIndexMaxRetries: 5,
    autoIndexRetryDelayMs: 100,
    watchFiles: true,
    pauseBackgroundIndexingOnBattery: false,
    maxFileSize: 1048576,
    maxChunksPerFile: 100,
    semanticOnly: false,
    retries: 3,
    retryDelayMs: 1000,
    autoGc: true,
    gcIntervalDays: 7,
    gcOrphanThreshold: 100,
    requireProjectMarker: true,
    maxDepth: 5,
    maxFilesPerDirectory: 100,
    fallbackToTextOnMaxChunks: true,
    // Must stay in sync with DEFAULT_LINES_PER_CHUNK in native/src/lib.rs (the napi
    // fallback used when a native caller omits the argument).
    linesPerChunk: 30,
    gitBlame: { enabled: false },
  };
}

export function getDefaultSearchConfig(): SearchConfig {
  return {
    maxResults: 20,
    minScore: 0.1,
    includeContext: true,
    hybridWeight: 0.5,
    fusionStrategy: "rrf",
    rrfK: 60,
    rerankTopN: 20,
    contextLines: 0,
    routingHints: true,
    routingGraphHandoffHints: false,
    routingHintRole: "system",
    communityBoost: 0,
  };
}

export function getDefaultRerankerBaseUrl(provider: RerankerProvider): string {
  switch (provider) {
    case "cohere":
      return "https://api.cohere.ai/v1";
    case "jina":
      return "https://api.jina.ai/v1";
    case "custom":
      return "";
  }
}

export function getDefaultDebugConfig(): DebugConfig {
  return {
    enabled: false,
    logLevel: "info",
    logSearch: true,
    logEmbedding: true,
    logCache: true,
    logGc: true,
    logBranch: true,
    metrics: true,
  };
}
