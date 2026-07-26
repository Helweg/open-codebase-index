import type { DebugConfig, LogLevel } from "../config/schema.js";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface Metrics {
  indexingStartTime?: number;
  indexingEndTime?: number;
  filesScanned: number;
  filesParsed: number;
  parseMs: number;
  chunksProcessed: number;
  chunksEmbedded: number;
  chunksFromCache: number;
  chunksRemoved: number;
  embeddingApiCalls: number;
  embeddingTokensUsed: number;
  embeddingErrors: number;
  
  searchCount: number;
  searchTotalMs: number;
  searchAvgMs: number;
  searchLastMs: number;
  embeddingCallMs: number;
  vectorSearchMs: number;
  keywordSearchMs: number;
  fusionMs: number;
  
  cacheHits: number;
  cacheMisses: number;
  
  queryCacheHits: number;
  queryCacheSimilarHits: number;
  queryCacheMisses: number;
  
  gcRuns: number;
  gcOrphansRemoved: number;
  gcChunksRemoved: number;
  gcEmbeddingsRemoved: number;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

function createEmptyMetrics(): Metrics {
  return {
    filesScanned: 0,
    filesParsed: 0,
    parseMs: 0,
    chunksProcessed: 0,
    chunksEmbedded: 0,
    chunksFromCache: 0,
    chunksRemoved: 0,
    embeddingApiCalls: 0,
    embeddingTokensUsed: 0,
    embeddingErrors: 0,
    searchCount: 0,
    searchTotalMs: 0,
    searchAvgMs: 0,
    searchLastMs: 0,
    embeddingCallMs: 0,
    vectorSearchMs: 0,
    keywordSearchMs: 0,
    fusionMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    queryCacheHits: 0,
    queryCacheSimilarHits: 0,
    queryCacheMisses: 0,
    gcRuns: 0,
    gcOrphansRemoved: 0,
    gcChunksRemoved: 0,
    gcEmbeddingsRemoved: 0,
  };
}

export class Logger {
  private config: DebugConfig;
  private metrics: Metrics;
  private logs: LogEntry[] = [];
  private maxLogs = 1000;

  constructor(config: DebugConfig) {
    this.config = config;
    this.metrics = createEmptyMetrics();
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false;
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.config.logLevel];
  }

  private log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  private withMetrics(fn: () => void): void {
    if (!this.config.metrics) return;
    fn();
  }

  search(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.config.logSearch) {
      this.log(level, "search", message, data);
    }
  }

  embedding(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.config.logEmbedding) {
      this.log(level, "embedding", message, data);
    }
  }

  cache(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.config.logCache) {
      this.log(level, "cache", message, data);
    }
  }

  gc(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.config.logGc) {
      this.log(level, "gc", message, data);
    }
  }

  branch(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.config.logBranch) {
      this.log(level, "branch", message, data);
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", "general", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", "general", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", "general", message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", "general", message, data);
  }

  recordIndexingStart(): void {
    this.withMetrics(() => {
      this.metrics.indexingStartTime = Date.now();
    });
  }

  recordIndexingEnd(): void {
    this.withMetrics(() => {
      this.metrics.indexingEndTime = Date.now();
    });
  }

  recordFilesScanned(count: number): void {
    this.withMetrics(() => {
      this.metrics.filesScanned = count;
    });
  }

  recordFilesParsed(count: number): void {
    this.withMetrics(() => {
      this.metrics.filesParsed = count;
    });
  }

  recordParseDuration(durationMs: number): void {
    this.withMetrics(() => {
      this.metrics.parseMs = durationMs;
    });
  }

  recordChunksProcessed(count: number): void {
    this.withMetrics(() => {
      this.metrics.chunksProcessed += count;
    });
  }

  recordChunksEmbedded(count: number): void {
    this.withMetrics(() => {
      this.metrics.chunksEmbedded += count;
    });
  }

  recordChunksFromCache(count: number): void {
    this.withMetrics(() => {
      this.metrics.chunksFromCache += count;
    });
  }

  recordChunksRemoved(count: number): void {
    this.withMetrics(() => {
      this.metrics.chunksRemoved += count;
    });
  }

  recordEmbeddingApiCall(tokens: number): void {
    this.withMetrics(() => {
      this.metrics.embeddingApiCalls++;
      this.metrics.embeddingTokensUsed += tokens;
    });
  }

  recordEmbeddingError(): void {
    this.withMetrics(() => {
      this.metrics.embeddingErrors++;
    });
  }

  recordSearch(durationMs: number, breakdown?: { embeddingMs: number; vectorMs: number; keywordMs: number; fusionMs: number }): void {
    this.withMetrics(() => {
      this.metrics.searchCount++;
      this.metrics.searchTotalMs += durationMs;
      this.metrics.searchLastMs = durationMs;
      this.metrics.searchAvgMs = this.metrics.searchTotalMs / this.metrics.searchCount;

      if (breakdown) {
        this.metrics.embeddingCallMs = breakdown.embeddingMs;
        this.metrics.vectorSearchMs = breakdown.vectorMs;
        this.metrics.keywordSearchMs = breakdown.keywordMs;
        this.metrics.fusionMs = breakdown.fusionMs;
      }
    });
  }

  recordCacheHit(): void {
    this.withMetrics(() => {
      this.metrics.cacheHits++;
    });
  }

  recordCacheMiss(): void {
    this.withMetrics(() => {
      this.metrics.cacheMisses++;
    });
  }

  recordQueryCacheHit(): void {
    this.withMetrics(() => {
      this.metrics.queryCacheHits++;
    });
  }

  recordQueryCacheSimilarHit(): void {
    this.withMetrics(() => {
      this.metrics.queryCacheSimilarHits++;
    });
  }

  recordQueryCacheMiss(): void {
    this.withMetrics(() => {
      this.metrics.queryCacheMisses++;
    });
  }

  recordGc(orphans: number, chunks: number, embeddings: number): void {
    this.withMetrics(() => {
      this.metrics.gcRuns++;
      this.metrics.gcOrphansRemoved += orphans;
      this.metrics.gcChunksRemoved += chunks;
      this.metrics.gcEmbeddingsRemoved += embeddings;
    });
  }

  getMetrics(): Metrics {
    return { ...this.metrics };
  }

  getLogs(limit?: number): LogEntry[] {
    const logs = [...this.logs];
    if (limit) {
      return logs.slice(-limit);
    }
    return logs;
  }

  getLogsByCategory(category: string, limit?: number): LogEntry[] {
    const filtered = this.logs.filter(l => l.category === category);
    if (limit) {
      return filtered.slice(-limit);
    }
    return filtered;
  }

  getLogsByLevel(level: LogLevel, limit?: number): LogEntry[] {
    const filtered = this.logs.filter(l => l.level === level);
    if (limit) {
      return filtered.slice(-limit);
    }
    return filtered;
  }

  resetMetrics(): void {
    this.metrics = createEmptyMetrics();
  }

  clearLogs(): void {
    this.logs = [];
  }

  formatMetrics(): string {
    const m = this.metrics;
    const lines: string[] = [];
    
    if (m.indexingStartTime && m.indexingEndTime) {
      const duration = m.indexingEndTime - m.indexingStartTime;
      lines.push(`Indexing duration: ${(duration / 1000).toFixed(2)}s`);
    }
    
    lines.push("");
    lines.push("Indexing:");
    lines.push(`  Files scanned: ${m.filesScanned}`);
    lines.push(`  Files parsed: ${m.filesParsed}`);
    lines.push(`  Chunks processed: ${m.chunksProcessed}`);
    lines.push(`  Chunks embedded: ${m.chunksEmbedded}`);
    lines.push(`  Chunks from cache: ${m.chunksFromCache}`);
    lines.push(`  Chunks removed: ${m.chunksRemoved}`);
    
    lines.push("");
    lines.push("Embedding API:");
    lines.push(`  API calls: ${m.embeddingApiCalls}`);
    lines.push(`  Tokens used: ${m.embeddingTokensUsed.toLocaleString()}`);
    lines.push(`  Errors: ${m.embeddingErrors}`);
    
    if (m.searchCount > 0) {
      lines.push("");
      lines.push("Search:");
      lines.push(`  Total searches: ${m.searchCount}`);
      lines.push(`  Average time: ${m.searchAvgMs.toFixed(2)}ms`);
      lines.push(`  Last search: ${m.searchLastMs.toFixed(2)}ms`);
      if (m.embeddingCallMs > 0) {
        lines.push(`    - Embedding: ${m.embeddingCallMs.toFixed(2)}ms`);
        lines.push(`    - Vector search: ${m.vectorSearchMs.toFixed(2)}ms`);
        lines.push(`    - Keyword search: ${m.keywordSearchMs.toFixed(2)}ms`);
        lines.push(`    - Fusion: ${m.fusionMs.toFixed(2)}ms`);
      }
    }
    
    const totalCacheOps = m.cacheHits + m.cacheMisses;
    if (totalCacheOps > 0) {
      lines.push("");
      lines.push("Cache:");
      lines.push(`  Hits: ${m.cacheHits}`);
      lines.push(`  Misses: ${m.cacheMisses}`);
      lines.push(`  Hit rate: ${((m.cacheHits / totalCacheOps) * 100).toFixed(1)}%`);
    }
    
    if (m.gcRuns > 0) {
      lines.push("");
      lines.push("Garbage Collection:");
      lines.push(`  GC runs: ${m.gcRuns}`);
      lines.push(`  Orphans removed: ${m.gcOrphansRemoved}`);
      lines.push(`  Chunks removed: ${m.gcChunksRemoved}`);
      lines.push(`  Embeddings removed: ${m.gcEmbeddingsRemoved}`);
    }
    
    return lines.join("\n");
  }

  formatRecentLogs(limit = 20): string {
    const logs = this.getLogs(limit);
    if (logs.length === 0) {
      return "No logs recorded.";
    }
    
    return logs.map(l => {
      const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : "";
      return `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${dataStr}`;
    }).join("\n");
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isMetricsEnabled(): boolean {
    return this.config.enabled && this.config.metrics;
  }
}

let globalLogger: Logger | null = null;

export function initializeLogger(config: DebugConfig): Logger {
  globalLogger = new Logger(config);
  return globalLogger;
}

export function getLogger(): Logger | null {
  return globalLogger;
}
