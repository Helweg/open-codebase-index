import type { IndexStats, IndexProgress, SearchResult, HealthCheckResult, StatusResult } from "../indexer/index.js";
import type { CallEdgeData, PathHopData } from "../native/index.js";
import type { LogEntry } from "../utils/logger.js";
import { get_encoding } from "tiktoken";

export const MIN_CONTEXT_PACK_TOKEN_BUDGET = 128;
export const MAX_CONTEXT_PACK_TOKEN_BUDGET = 4000;
export const DEFAULT_CONTEXT_PACK_TOKEN_BUDGET = 1200;
const CONTEXT_TOKENIZER = get_encoding("cl100k_base");

interface RankedSearchResult {
  result: SearchResult;
  originalIndex: number;
}

export interface ContextPackOptions {
  tokenBudget?: number;
  heading?: string;
  maxResults?: number;
}

export interface ContextPackResult {
  requestedTokenBudget: number;
  tokenBudget: number;
  text: string;
  tokenEstimate: number;
  results: SearchResult[];
  candidateCount: number;
  deduplicatedCount: number;
  selectedCount: number;
  omittedCount: number;
  duplicateCount: number;
  limitOmittedCount: number;
  budgetOmittedCount: number;
}

export interface BudgetedTextResult {
  text: string;
  tokenBudget: number;
  tokenEstimate: number;
  truncated: boolean;
}

export function clampContextPackTokenBudget(tokenBudget?: number): number {
  if (tokenBudget === undefined || !Number.isFinite(tokenBudget)) {
    return DEFAULT_CONTEXT_PACK_TOKEN_BUDGET;
  }
  return Math.min(
    MAX_CONTEXT_PACK_TOKEN_BUDGET,
    Math.max(MIN_CONTEXT_PACK_TOKEN_BUDGET, Math.floor(tokenBudget)),
  );
}

export function countContextTokens(text: string): number {
  return CONTEXT_TOKENIZER.encode(text).length;
}

export function fitTextToContextBudget(text: string, tokenBudget?: number): BudgetedTextResult {
  const normalizedBudget = clampContextPackTokenBudget(tokenBudget);
  const tokenEstimate = countContextTokens(text);
  if (tokenEstimate <= normalizedBudget) {
    return {
      text,
      tokenBudget: normalizedBudget,
      tokenEstimate,
      truncated: false,
    };
  }

  const suffix = "\n...[truncated to context token budget]";
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join("").trimEnd()}${suffix}`;
    if (countContextTokens(candidate) <= normalizedBudget) low = middle;
    else high = middle - 1;
  }
  const fitted = `${codePoints.slice(0, low).join("").trimEnd()}${suffix}`;
  return {
    text: fitted,
    tokenBudget: normalizedBudget,
    tokenEstimate: countContextTokens(fitted),
    truncated: true,
  };
}

function normalizedLineRange(result: SearchResult): { start: number; end: number } {
  return result.startLine <= result.endLine
    ? { start: result.startLine, end: result.endLine }
    : { start: result.endLine, end: result.startLine };
}

function rankContextCandidates(results: SearchResult[]): RankedSearchResult[] {
  return results
    .map((result, originalIndex) => ({ result, originalIndex }))
    .sort((left, right) => right.result.score - left.result.score || left.originalIndex - right.originalIndex);
}

function deduplicateContextCandidates(candidates: RankedSearchResult[]): SearchResult[] {
  const acceptedByFile = new Map<string, Array<{ start: number; end: number }>>();
  const deduplicated: SearchResult[] = [];

  for (const { result } of candidates) {
    const range = normalizedLineRange(result);
    const accepted = acceptedByFile.get(result.filePath) ?? [];
    if (accepted.some((item) => item.start <= range.end && range.start <= item.end)) {
      continue;
    }
    accepted.push(range);
    acceptedByFile.set(result.filePath, accepted);
    deduplicated.push(result);
  }

  return deduplicated;
}

function diversifyContextCandidates(results: SearchResult[]): SearchResult[] {
  const byFile = new Map<string, SearchResult[]>();
  for (const result of results) {
    const bucket = byFile.get(result.filePath) ?? [];
    bucket.push(result);
    byFile.set(result.filePath, bucket);
  }

  const files = [...byFile.keys()];
  const diversified: SearchResult[] = [];
  for (let depth = 0; diversified.length < results.length; depth += 1) {
    for (const file of files) {
      const result = byFile.get(file)?.[depth];
      if (result) diversified.push(result);
    }
  }
  return diversified;
}

function compactEvidenceValue(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(-(maxChars - 1))}`;
}

function formatContextEvidence(result: SearchResult, index: number): string {
  const symbol = result.name ? ` ${JSON.stringify(compactEvidenceValue(result.name, 80))}` : "";
  const path = compactEvidenceValue(result.filePath, 120);
  return `[${index}] ${result.chunkType}${symbol} in ${path}:${result.startLine}-${result.endLine} (score ${result.score.toFixed(2)})`;
}

function formatContextPack(
  heading: string,
  selected: SearchResult[],
  candidateCount: number,
  duplicateCount: number,
  limitOmittedCount: number,
  budgetOmittedCount: number,
): string {
  const lines = selected.map((result, index) => formatContextEvidence(result, index + 1));
  const notes: string[] = [];
  if (duplicateCount > 0) notes.push(`${duplicateCount} overlapping duplicate${duplicateCount === 1 ? "" : "s"} removed`);
  if (limitOmittedCount > 0) notes.push(`${limitOmittedCount} additional result${limitOmittedCount === 1 ? "" : "s"} excluded by result limit`);
  if (budgetOmittedCount > 0) notes.push(`${budgetOmittedCount} additional result${budgetOmittedCount === 1 ? "" : "s"} omitted by token budget`);
  const footer = notes.length > 0
    ? `Selected ${selected.length} of ${candidateCount} candidates; ${notes.join("; ")}.`
    : `Selected ${selected.length} of ${candidateCount} candidates.`;
  return `${heading}\n\n${lines.join("\n")}\n\n${footer}`;
}

export function buildContextPack(results: SearchResult[], options: ContextPackOptions = {}): ContextPackResult {
  const requestedTokenBudget = options.tokenBudget ?? DEFAULT_CONTEXT_PACK_TOKEN_BUDGET;
  const tokenBudget = clampContextPackTokenBudget(options.tokenBudget);
  const heading = compactEvidenceValue(options.heading?.trim() || "Codebase evidence", 160);
  const maxResults = Math.max(0, Math.floor(options.maxResults ?? results.length));
  const candidateCount = results.length;
  const deduplicated = deduplicateContextCandidates(rankContextCandidates(results));
  const diversified = diversifyContextCandidates(deduplicated);
  const duplicateCount = candidateCount - deduplicated.length;
  const selectable = diversified.slice(0, maxResults);
  const limitOmittedCount = deduplicated.length - selectable.length;
  let selected: SearchResult[] = [];
  let text = formatContextPack(heading, selected, candidateCount, duplicateCount, limitOmittedCount, selectable.length);

  for (let count = 1; count <= selectable.length; count += 1) {
    const candidateSelection = selectable.slice(0, count);
    const budgetOmittedCount = selectable.length - candidateSelection.length;
    const candidateText = formatContextPack(
      heading,
      candidateSelection,
      candidateCount,
      duplicateCount,
      limitOmittedCount,
      budgetOmittedCount,
    );
    if (countContextTokens(candidateText) > tokenBudget) break;
    selected = candidateSelection;
    text = candidateText;
  }

  if (selected.length === 0 && selectable.length > 0) {
    selected = [selectable[0]];
    text = formatContextPack(
      compactEvidenceValue(heading, 60),
      selected,
      candidateCount,
      duplicateCount,
      limitOmittedCount,
      selectable.length - 1,
    );
  }

  const fitted = fitTextToContextBudget(text, tokenBudget);
  const budgetOmittedCount = selectable.length - selected.length;
  const omittedCount = candidateCount - selected.length;
  return {
    requestedTokenBudget,
    tokenBudget,
    text: fitted.text,
    tokenEstimate: fitted.tokenEstimate,
    results: selected,
    candidateCount,
    deduplicatedCount: deduplicated.length,
    selectedCount: selected.length,
    omittedCount,
    duplicateCount,
    limitOmittedCount,
    budgetOmittedCount,
  };
}

const MAX_CONTENT_LINES = 30;

function truncateContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTENT_LINES) return content;
  return (
    lines.slice(0, MAX_CONTENT_LINES).join("\n") +
    `\n// ... (${lines.length - MAX_CONTENT_LINES} more lines)`
  );
}

export function formatIndexStats(stats: IndexStats, verbose: boolean = false): string {
  if (stats.resetCorruptedIndex) {
    return stats.warning ?? "Detected a corrupted local index and reset it during indexing. Run index_codebase again to rebuild search data.";
  }

  const lines: string[] = [];

  if (stats.failedChunks > 0) {
    lines.push(`INDEXING WARNING: ${stats.failedChunks} chunks failed to embed.`);
    if (stats.failedBatchesPath) {
      lines.push(`Inspect failed batches at: ${stats.failedBatchesPath}`);
    }
    lines.push("");
  }
  
  if (stats.indexedChunks === 0 && stats.removedChunks === 0) {
    lines.push(`${stats.totalFiles} files processed, ${stats.existingChunks} code chunks already up to date.`);
  } else if (stats.indexedChunks === 0) {
    lines.push(`${stats.totalFiles} files, removed ${stats.removedChunks} stale chunks, ${stats.existingChunks} chunks remain.`);
  } else {
    let main = `${stats.totalFiles} files processed, ${stats.indexedChunks} new chunks embedded.`;
    if (stats.existingChunks > 0) {
      main += ` ${stats.existingChunks} unchanged chunks skipped.`;
    }
    lines.push(main);

    if (stats.removedChunks > 0) {
      lines.push(`Removed ${stats.removedChunks} stale chunks.`);
    }

    if (stats.failedChunks > 0) {
      lines.push(`Failed: ${stats.failedChunks} chunks.`);
    }

    lines.push(`Tokens: ${stats.tokensUsed.toLocaleString()}, Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
  }

  if (verbose) {
    if (stats.skippedFiles.length > 0) {
      const tooLarge = stats.skippedFiles.filter(f => f.reason === "too_large");
      const excluded = stats.skippedFiles.filter(f => f.reason === "excluded");
      const gitignored = stats.skippedFiles.filter(f => f.reason === "gitignore");
      
      lines.push("");
      lines.push(`Skipped files: ${stats.skippedFiles.length}`);
      if (tooLarge.length > 0) {
        lines.push(`  Too large (${tooLarge.length}): ${tooLarge.slice(0, 5).map(f => f.path).join(", ")}${tooLarge.length > 5 ? "..." : ""}`);
      }
      if (excluded.length > 0) {
        lines.push(`  Excluded (${excluded.length}): ${excluded.slice(0, 5).map(f => f.path).join(", ")}${excluded.length > 5 ? "..." : ""}`);
      }
      if (gitignored.length > 0) {
        lines.push(`  Gitignored (${gitignored.length}): ${gitignored.slice(0, 5).map(f => f.path).join(", ")}${gitignored.length > 5 ? "..." : ""}`);
      }
    }

    if (stats.parseFailures.length > 0) {
      lines.push("");
      lines.push(`Files with no extractable chunks (${stats.parseFailures.length}): ${stats.parseFailures.slice(0, 10).join(", ")}${stats.parseFailures.length > 10 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

export function formatStatus(status: StatusResult): string {
  if (!status.indexed) {
    if (status.warning) {
      return status.warning;
    }

    if (status.failedBatchesCount > 0) {
      const lines = [
        "Codebase is not indexed. The last indexing run left failed embedding batches.",
        "Fix the provider/model configuration, then rerun index_codebase normally to retry the saved failed batches. Use force=true only for a full rebuild or compatibility reset.",
      ];

      if (status.failedBatchesPath) {
        lines.push(`Failed batches: ${status.failedBatchesPath}`);
      }

      return lines.join("\n");
    }

    return "Codebase is not indexed. Run index_codebase to create an index.";
  }

  const lines = [
    `Indexed chunks: ${status.vectorCount.toLocaleString()}`,
    `Provider: ${status.provider}`,
    `Model: ${status.model}`,
    `Location: ${status.indexPath}`,
  ];

  if (status.currentBranch !== "default") {
    lines.push(`Current branch: ${status.currentBranch}`);
    lines.push(`Base branch: ${status.baseBranch}`);
  }

  if (status.failedBatchesCount > 0) {
    lines.push("");
    lines.push(`INDEXING WARNING: ${status.failedBatchesCount} failed embedding batch${status.failedBatchesCount === 1 ? " remains" : "es remain"}.`);
    if (status.failedBatchesPath) {
      lines.push(`Failed batches: ${status.failedBatchesPath}`);
    }
  }

  if (status.warning) {
    lines.push("");
    lines.push(`INDEX WARNING: ${status.warning}`);
  }

  if (status.compatibility && !status.compatibility.compatible) {
    lines.push("");
    lines.push(`COMPATIBILITY WARNING: ${status.compatibility.reason}`);
    if (status.compatibility.storedMetadata) {
      const stored = status.compatibility.storedMetadata;
      lines.push(`Index was built with: ${stored.embeddingProvider}/${stored.embeddingModel} (${stored.embeddingDimensions}D)`);
      lines.push(`Current config:       ${status.provider}/${status.model}`);
    }
  } else if (!status.compatibility) {
    lines.push(`Compatibility: No compatibility information found. Maybe the index is not initialized yet, try running index_codebase.`);
  } else {
    lines.push(`Compatibility: Index is compatible with the current provider and model.`);
  }

  return lines.join("\n");
}

export function formatProgressTitle(progress: IndexProgress): string {
  switch (progress.phase) {
    case "scanning":
      return "Scanning files...";
    case "parsing":
      return `Parsing: ${progress.filesProcessed}/${progress.totalFiles} files`;
    case "embedding":
      return `Embedding: ${progress.chunksProcessed}/${progress.totalChunks} chunks`;
    case "storing":
      return "Storing index...";
    case "complete":
      return "Indexing complete";
    default:
      return "Indexing...";
  }
}

export function calculatePercentage(progress: IndexProgress): number {
  if (progress.phase === "scanning") return 0;
  if (progress.phase === "complete") return 100;
  
  if (progress.phase === "parsing") {
    if (progress.totalFiles === 0) return 5;
    return Math.round(5 + (progress.filesProcessed / progress.totalFiles) * 15);
  }
  
  if (progress.phase === "embedding") {
    if (progress.totalChunks === 0) return 20;
    return Math.round(20 + (progress.chunksProcessed / progress.totalChunks) * 70);
  }
  
  if (progress.phase === "storing") return 95;
  
  return 0;
}

export function formatCodebasePeek(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No matching code found. Try a different query or run index_codebase first.";
  }

  const formatted = results.map((r, idx) => {
    const location = `${r.filePath}:${r.startLine}-${r.endLine}`;
    const name = r.name ? `"${r.name}"` : "(anonymous)";
    return `[${idx + 1}] ${r.chunkType} ${name} at ${location} (score: ${r.score.toFixed(2)})${formatBlame(r)}`;
  });

  return formatted.join("\n");
}

export function formatHealthCheck(result: HealthCheckResult): string {
  if (result.resetCorruptedIndex) {
    return result.warning ?? "Detected a corrupted local index and reset it. Run index_codebase to rebuild search data.";
  }

  if (result.removed === 0 && result.gcOrphanEmbeddings === 0 && result.gcOrphanChunks === 0 && result.gcOrphanSymbols === 0 && result.gcOrphanCallEdges === 0) {
    return "Index is healthy. No stale entries found.";
  }

  const lines: string[] = [];
  
  if (result.removed > 0) {
    lines.push(`Removed stale entries: ${result.removed}`);
  }
  
  if (result.gcOrphanEmbeddings > 0) {
    lines.push(`Garbage collected orphan embeddings: ${result.gcOrphanEmbeddings}`);
  }
  
  if (result.gcOrphanChunks > 0) {
    lines.push(`Garbage collected orphan chunks: ${result.gcOrphanChunks}`);
  }

  if (result.gcOrphanSymbols > 0) {
    lines.push(`Garbage collected orphan symbols: ${result.gcOrphanSymbols}`);
  }

  if (result.gcOrphanCallEdges > 0) {
    lines.push(`Garbage collected orphan call edges: ${result.gcOrphanCallEdges}`);
  }

  if (result.filePaths.length > 0) {
    lines.push(`Cleaned paths: ${result.filePaths.join(", ")}`);
  }

  return lines.join("\n");
}

export function formatLogs(logs: LogEntry[]): string {
  if (logs.length === 0) {
    return "No logs recorded yet. Logs are captured during indexing and search operations.";
  }

  return logs.map(l => {
    const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : "";
    return `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${dataStr}`;
  }).join("\n");
}

export function formatCallGraphCallers(name: string, callers: CallEdgeData[], relationshipType?: string): string {
  if (callers.length === 0) {
    return `No callers found for "${name}"${relationshipType ? ` with type ${relationshipType}` : ""}. It may not be called by any tracked function, or the index needs updating.`;
  }

  const formatted = callers.map((edge, index) => {
    const confidence = edge.confidence !== "Direct" ? ` [${edge.confidence.toLowerCase()}]` : "";
    return `[${index + 1}] \u2190 from ${edge.fromSymbolName ?? "<unknown>"} in ${edge.fromSymbolFilePath ?? "<unknown file>"} [${edge.fromSymbolId}] (${edge.callType})${confidence} at line ${edge.line}${edge.isResolved ? " [resolved]" : " [unresolved]"}`;
  });

  return `"${name}" is called by ${callers.length} function(s):\n\n${formatted.join("\n")}`;
}

export function formatCallGraphCallees(symbolId: string, callees: CallEdgeData[], relationshipType?: string): string {
  if (callees.length === 0) {
    return `No callees found for symbol ${symbolId}${relationshipType ? ` with type ${relationshipType}` : ""}. The function may not call any other tracked functions.`;
  }

  return callees.map((edge, index) => {
    const confidence = edge.confidence !== "Direct" ? ` [${edge.confidence.toLowerCase()}]` : "";
    return `[${index + 1}] \u2192 ${edge.targetName} (${edge.callType})${confidence} at line ${edge.line}${edge.isResolved ? ` [resolved: ${edge.toSymbolId}]` : " [unresolved]"}`;
  }).join("\n");
}

export function formatCallGraphPath(from: string, to: string, path: PathHopData[]): string {
  if (path.length === 0) {
    return `No path found between "${from}" and "${to}". They may be in disconnected components, or the call graph index needs updating.`;
  }

  const formatted = path.map((hop, index) => {
    const prefix = index === 0 ? "[start]" : `--${hop.callType}-->`;
    const location = hop.filePath ? ` (${hop.filePath}:${hop.line})` : "";
    return `${prefix} ${hop.symbolName}${location}`;
  });

  return `Path (${path.length} hops):\n${formatted.join("\n")}`;
}

function formatResultHeader(result: SearchResult, index: number): string {
  return result.name
    ? `[${index + 1}] ${result.chunkType} "${result.name}" in ${result.filePath}:${result.startLine}-${result.endLine}`
    : `[${index + 1}] ${result.chunkType} in ${result.filePath}:${result.startLine}-${result.endLine}`;
}

function formatBlame(result: SearchResult): string {
  if (!result.blame) {
    return "";
  }

  const date = new Date(result.blame.committedAt * 1000).toISOString().slice(0, 10);
  return `\n    ${result.blame.sha.slice(0, 7)} | ${result.blame.author} | ${date} | ${result.blame.summary}`;
}

export function formatDefinitionLookup(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No definition found for "${query}". Try codebase_search for broader discovery, or verify the symbol name.`;
  }

  const formatted = results.map((r, idx) => {
    const header = formatResultHeader(r, idx);
    return `${header} (score: ${r.score.toFixed(2)})${formatBlame(r)}\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
  });

  return formatted.join("\n\n");
}

export type ScoreFormat = "score" | "similarity";

export function formatSearchResults(results: SearchResult[], scoreFormat: ScoreFormat = "similarity"): string {
  const formatted = results.map((r, idx) => {
    const header = formatResultHeader(r, idx);

    const scoreLabel = scoreFormat === "similarity"
      ? `(similarity: ${(r.score * 100).toFixed(1)}%)`
      : `(score: ${r.score.toFixed(2)})`;

    return `${header} ${scoreLabel}${formatBlame(r)}\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
  });

  return formatted.join("\n\n");
}
