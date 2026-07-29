export const CHUNK_TYPES = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "struct",
  "impl",
  "trait",
  "module",
  "other",
] as const;
export type ChunkType = (typeof CHUNK_TYPES)[number];

export const CALL_GRAPH_DIRECTIONS = ["callers", "callees"] as const;
export type CallGraphDirection = (typeof CALL_GRAPH_DIRECTIONS)[number];

export const RELATIONSHIP_TYPES = [
  "Call",
  "MethodCall",
  "Constructor",
  "Import",
  "Inherits",
  "Implements",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const INDEX_LOG_CATEGORIES = ["search", "embedding", "cache", "gc", "branch", "general"] as const;
export type IndexLogCategory = (typeof INDEX_LOG_CATEGORIES)[number];

export const INDEX_LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type IndexLogLevel = (typeof INDEX_LOG_LEVELS)[number];

export interface SharedCodebaseContextArgs {
  query: string;
  from?: string | null;
  to?: string | null;
  fromFilePath?: string | null;
  toFilePath?: string | null;
  symbol?: string | null;
  limit?: number | null;
  maxDepth?: number | null;
  fileType?: string | null;
  directory?: string | null;
  tokenBudget?: number | null;
}

export interface SharedIndexCodebaseArgs {
  force?: boolean;
  estimateOnly?: boolean;
  verbose?: boolean;
}

export interface SharedIndexMetricsArgs {
  reset?: boolean;
}

export interface SharedIndexLogsArgs {
  limit?: number;
  category?: IndexLogCategory | null;
  level?: IndexLogLevel | null;
}

export interface SharedImplementationLookupArgs {
  query: string;
  limit?: number;
  fileType?: string;
  directory?: string;
}

export interface SharedCallGraphArgs {
  name: string;
  direction?: CallGraphDirection;
  filePath?: string;
  symbolId?: string;
  relationshipType?: RelationshipType;
}

export interface SharedCallGraphPathArgs {
  from: string;
  to: string;
  fromFilePath?: string;
  toFilePath?: string;
  maxDepth?: number;
}
