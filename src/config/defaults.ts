import type {
  DebugConfig,
  IndexingConfig,
  RerankerProvider,
  SearchConfig,
} from "./schema.js";

export function getDefaultIndexingConfig(): IndexingConfig {
  return {
    autoIndex: false,
    watchFiles: true,
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
