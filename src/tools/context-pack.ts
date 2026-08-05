import type { SearchResult } from "../indexer/index.js";

import { get_encoding } from "tiktoken";

import { isLikelyImplementationPath } from "../indexer/intent-aware-ranking.js";

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
  includeExactSearchHandoff?: boolean;
  preferImplementationPaths?: boolean;
  preserveInputOrder?: boolean;
  trace?: (trace: ContextPackTrace) => void;
}

export interface ContextPackTrace {
  inputCandidates: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    score: number;
    chunkType: string;
    name?: string;
  }>;
  rankedCandidates: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    score: number;
    chunkType: string;
    name?: string;
  }>;
  deduplicatedCandidates: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    score: number;
    chunkType: string;
    name?: string;
  }>;
  diversifiedCandidates: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    score: number;
    chunkType: string;
    name?: string;
  }>;
  selectedCandidates: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    score: number;
    chunkType: string;
    name?: string;
  }>;
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

function rankContextCandidates(
  results: SearchResult[],
  preferImplementationPaths: boolean,
): RankedSearchResult[] {
  return results
    .map((result, originalIndex) => ({ result, originalIndex }))
    .sort((left, right) => {
      if (preferImplementationPaths) {
        const leftIsImplementation = isLikelyImplementationPath(left.result.filePath);
        const rightIsImplementation = isLikelyImplementationPath(right.result.filePath);
        if (leftIsImplementation !== rightIsImplementation) {
          return leftIsImplementation ? -1 : 1;
        }
      }
      return right.result.score - left.result.score || left.originalIndex - right.originalIndex;
    });
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
  const characters = [...value];
  if (characters.length <= maxChars) return value;
  return `…${characters.slice(-(maxChars - 1)).join("")}`;
}

const MAX_EXACT_SEARCH_HANDOFF_NAMES = 3;
const MAX_EXACT_SEARCH_HANDOFF_NAME_CHARS = 64;

function toContextPackTraceCandidate(result: SearchResult): ContextPackTrace["inputCandidates"][number] {
  return {
    filePath: result.filePath,
    startLine: result.startLine,
    endLine: result.endLine,
    score: result.score,
    chunkType: result.chunkType,
    name: result.name,
  };
}

export function formatExactSearchHandoff(results: SearchResult[]): string | null {
  const suggestedNames: string[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const rawName = result.name?.trim();
    if (!rawName) {
      continue;
    }

    if (Array.from(rawName).length > MAX_EXACT_SEARCH_HANDOFF_NAME_CHARS) {
      continue;
    }

    if (seen.has(rawName)) {
      continue;
    }

    seen.add(rawName);
    suggestedNames.push(rawName);

    if (suggestedNames.length >= MAX_EXACT_SEARCH_HANDOFF_NAMES) {
      break;
    }
  }

  if (suggestedNames.length === 0) {
    return null;
  }

  const quotedNames = suggestedNames.map((name) => JSON.stringify(name)).join(", ");
  return `Exact-search handoff: use exact grep/search for ${quotedNames} to find usages or exhaustive matches.`;
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
  includeExactSearchHandoff: boolean,
): string {
  const lines = selected.map((result, index) => formatContextEvidence(result, index + 1));
  const notes: string[] = [];
  if (duplicateCount > 0) notes.push(`${duplicateCount} overlapping duplicate${duplicateCount === 1 ? "" : "s"} removed`);
  if (limitOmittedCount > 0) notes.push(`${limitOmittedCount} additional result${limitOmittedCount === 1 ? "" : "s"} excluded by result limit`);
  if (budgetOmittedCount > 0) notes.push(`${budgetOmittedCount} additional result${budgetOmittedCount === 1 ? "" : "s"} omitted by token budget`);
  const footer = notes.length > 0
    ? `Selected ${selected.length} of ${candidateCount} candidates; ${notes.join("; ")}.`
    : `Selected ${selected.length} of ${candidateCount} candidates.`;
  const handoff = includeExactSearchHandoff ? formatExactSearchHandoff(selected) : null;
  return [heading, lines.join("\n"), footer, handoff].filter(Boolean).join("\n\n");
}

export function buildContextPack(results: SearchResult[], options: ContextPackOptions = {}): ContextPackResult {
  const requestedTokenBudget = options.tokenBudget ?? DEFAULT_CONTEXT_PACK_TOKEN_BUDGET;
  const tokenBudget = clampContextPackTokenBudget(options.tokenBudget);
  const heading = compactEvidenceValue(options.heading?.trim() || "Codebase evidence", 160);
  const maxResults = Math.max(0, Math.floor(options.maxResults ?? results.length));
  const includeExactSearchHandoff = options.includeExactSearchHandoff ?? false;
  const candidateCount = results.length;
  const preserveInputOrder = options.preserveInputOrder ?? false;
  const ranked = preserveInputOrder
    ? results.map((result, originalIndex) => ({ result, originalIndex }))
    : rankContextCandidates(results, options.preferImplementationPaths ?? false);
  const rankedCandidates = ranked.map((entry) => toContextPackTraceCandidate(entry.result));
  const deduplicated = deduplicateContextCandidates(ranked);
  const deduplicatedCandidates = deduplicated.map((result) => toContextPackTraceCandidate(result));
  const diversified = preserveInputOrder ? deduplicated : diversifyContextCandidates(deduplicated);
  const diversifiedCandidates = diversified.map((result) => toContextPackTraceCandidate(result));
  const duplicateCount = candidateCount - deduplicated.length;
  const selectable = diversified.slice(0, maxResults);
  const limitOmittedCount = deduplicated.length - selectable.length;
  let selected: SearchResult[] = [];
  let text = formatContextPack(
    heading,
    selected,
    candidateCount,
    duplicateCount,
    limitOmittedCount,
    selectable.length,
    includeExactSearchHandoff,
  );

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
      includeExactSearchHandoff,
    );
    if (countContextTokens(candidateText) > tokenBudget) break;
    selected = candidateSelection;
    text = candidateText;
  }

  const fitted = fitTextToContextBudget(text, tokenBudget);
  const budgetOmittedCount = selectable.length - selected.length;
  const omittedCount = candidateCount - selected.length;
  if (options.trace) {
    options.trace({
      inputCandidates: results.map(toContextPackTraceCandidate),
      rankedCandidates,
      deduplicatedCandidates,
      diversifiedCandidates,
      selectedCandidates: selected.map(toContextPackTraceCandidate),
    });
  }
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
