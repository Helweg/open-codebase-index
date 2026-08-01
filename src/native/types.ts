export interface FileInput {
  path: string;
  content: string;
}

export interface CodeChunk {
  content: string;
  startLine: number;
  startCol?: number;
  endLine: number;
  endCol?: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
}

export type ChunkType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "impl"
  | "trait"
  | "module"
  | "import"
  | "export"
  | "comment"
  | "other";

export interface ParsedFile {
  path: string;
  chunks: CodeChunk[];
  symbols: ParsedSymbol[];
  hash: string;
}

export interface ParsedSymbol {
  name: string;
  kind: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  language: string;
}

export type Confidence = "Direct" | "Inferred";

export type CallType = "Call" | "MethodCall" | "Constructor" | "Import" | "Inherits" | "Implements";

export interface CallSiteData {
  calleeName: string;
  line: number;
  column: number;
  callType: CallType;
  confidence: Confidence;
}

export interface SymbolData {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  language: string;
}

export interface CallEdgeData {
  id: string;
  fromSymbolId: string;
  fromSymbolName?: string;
  fromSymbolFilePath?: string;
  targetName: string;
  toSymbolId?: string;
  callType: string;
  confidence: string;
  line: number;
  col: number;
  isResolved: boolean;
}

export interface PathHopData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  line: number;
  callType: string;
}

export interface ReachabilityData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  depth: number;
}

export interface CommunityData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  communityId: number;
  communityLabel: string;
  crossCommunityConnections: number;
}

export interface CommunityRelationshipData {
  fromSymbolId: string;
  fromSymbolName: string;
  fromFilePath: string;
  toSymbolId: string;
  toSymbolName: string;
  toFilePath: string;
}

export interface CommunityCouplingData {
  communityA: number;
  communityB: number;
  count: number;
  relationships?: CommunityRelationshipData[];
  representativeRelationships?: CommunityRelationshipData[];
}

export interface CentralityData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  callerCount: number;
  calleeCount: number;
  totalConnections: number;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
  hash: string;
  blameSha?: string;
  blameAuthor?: string;
  blameAuthorEmail?: string;
  blameCommittedAt?: number;
  blameSummary?: string;
}

export interface DynamicBatchOptions {
  maxBatchTokens?: number;
  maxBatchItems?: number;
}

export interface KeywordSearchResult {
  chunkId: string;
  score: number;
}

export interface ChunkData {
  chunkId: string;
  contentHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  language: string;
  blameSha?: string;
  blameAuthor?: string;
  blameAuthorEmail?: string;
  blameCommittedAt?: number;
  blameSummary?: string;
}

export interface BranchDelta {
  added: string[];
  removed: string[];
}

export interface DatabaseStats {
  embeddingCount: number;
  chunkCount: number;
  branchChunkCount: number;
  branchCount: number;
  symbolCount: number;
  callEdgeCount: number;
}
