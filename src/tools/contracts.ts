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
  diagnostic?: boolean;
}

export interface SharedCodebaseEditContextArgs {
  query: string;
  symbol?: string | null;
  filePath?: string | null;
  callerLimit?: number | null;
  calleeLimit?: number | null;
  tokenBudget?: number | null;
}

export const MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT = 1 as const;
export const MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT = 20 as const;
export const DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT = 5 as const;

export interface SharedIndexCodebaseArgs {
  force?: boolean;
  estimateOnly?: boolean;
  dryRun?: boolean;
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

export interface SharedCodeCommunitiesArgs {
  branch?: string;
  minSize?: number;
  limit?: number;
  hubThreshold?: number;
  minCoupling?: number;
  couplingLimit?: number;
}

export const CODE_COMMUNITIES_MIN_SIZE = 1;
export const CODE_COMMUNITIES_DEFAULT_LIMIT = 20;
export const CODE_COMMUNITIES_MAX_LIMIT = 100;
export const CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD = 5;
export const CODE_COMMUNITIES_MIN_COUPLING = 1;
export const CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT = 20;
export const CODE_COMMUNITIES_MAX_COUPLING_LIMIT = 100;
