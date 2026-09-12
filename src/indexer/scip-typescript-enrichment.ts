import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { CallEdgeData, SymbolData } from "../native/types.js";

export const SCIP_TYPESCRIPT_ADAPTER_VERSION = "1";
const DEFINITION_ROLE = 1;
const JAVASCRIPT_FAMILY = new Set(["typescript", "tsx", "javascript", "jsx"]);
const MAX_STDERR_BYTES = 16 * 1024;

interface ScipOccurrence {
  range?: unknown;
  TypedRange?: unknown;
  symbol?: unknown;
  symbol_roles?: unknown;
}

interface ScipDocument {
  relative_path?: unknown;
  position_encoding?: unknown;
  occurrences?: unknown;
}

interface ScipPrintIndex {
  metadata?: {
    tool_info?: { name?: unknown; version?: unknown };
    project_root?: unknown;
    text_document_encoding?: unknown;
  };
  documents?: unknown;
}

interface NormalizedOccurrence {
  line: number;
  startCol: number;
  endLine: number;
  endCol: number;
  symbol: string;
  roles: number;
}

interface PreparedDocument {
  filePath: string;
  lines: string[];
  occurrences: NormalizedOccurrence[];
}

export interface ScipApplyResult {
  edges: CallEdgeData[];
  matchedEdges: number;
  unmatchedOccurrences: number;
  ambiguousDefinitions: number;
  disagreements: number;
}

export interface PreparedScipEnrichment {
  adapterVersion: string;
  fingerprint: string;
  outcome: "ready" | "disabled" | "missing" | "stale" | "failed" | "rejected";
  message?: string;
  indexPath?: string;
  indexSha256?: string;
  indexSize?: number;
  indexMtimeMs?: number;
  freshness: "not-required" | "fresh" | "stale" | "unavailable";
  generatorName?: string;
  generatorVersion?: string;
  matchedEdges: number;
  unmatchedOccurrences: number;
  ambiguousDefinitions: number;
  disagreements: number;
  apply(edges: readonly CallEdgeData[], symbols: readonly SymbolData[]): ScipApplyResult;
}

export interface PrepareScipEnrichmentInput {
  enabled: boolean;
  materializedProjectRoot: string;
  indexFile: string;
  decoderCommand: string;
  timeoutMs: number;
  maxOutputBytes: number;
  requireFreshIndex: boolean;
  relevantFiles: readonly { path: string }[];
  signal?: AbortSignal;
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inert(
  configFingerprint: string,
  outcome: PreparedScipEnrichment["outcome"],
  freshness: PreparedScipEnrichment["freshness"],
  details: Partial<PreparedScipEnrichment> = {},
): PreparedScipEnrichment {
  const state = {
    adapterVersion: SCIP_TYPESCRIPT_ADAPTER_VERSION,
    configFingerprint,
    outcome,
    freshness,
    indexPath: details.indexPath ?? null,
    indexSha256: details.indexSha256 ?? null,
    indexSize: details.indexSize ?? null,
    indexMtimeMs: details.indexMtimeMs ?? null,
  };
  return {
    adapterVersion: SCIP_TYPESCRIPT_ADAPTER_VERSION,
    fingerprint: stableFingerprint(state),
    outcome,
    freshness,
    matchedEdges: 0,
    unmatchedOccurrences: 0,
    ambiguousDefinitions: 0,
    disagreements: 0,
    ...details,
    apply: (edges) => ({
      edges: [...edges],
      matchedEdges: 0,
      unmatchedOccurrences: 0,
      ambiguousDefinitions: 0,
      disagreements: 0,
    }),
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeDocumentPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || path.posix.isAbsolute(value) || value.includes("\\")) return undefined;
  if (value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
  return normalized;
}

function utf16ColumnToUtf8(line: string, column: number): number | undefined {
  if (!Number.isInteger(column) || column < 0 || column > line.length) return undefined;
  if (column > 0 && column < line.length) {
    const previous = line.charCodeAt(column - 1);
    const current = line.charCodeAt(column);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return undefined;
  }
  return Buffer.byteLength(line.slice(0, column), "utf8");
}

function utf8Column(line: string, column: number): number | undefined {
  if (!Number.isInteger(column) || column < 0) return undefined;
  const bytes = Buffer.from(line, "utf8");
  if (column > bytes.length) return undefined;
  try {
    const prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, column));
    return Buffer.byteLength(prefix, "utf8") === column ? column : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRange(
  value: unknown,
  typedRange: unknown,
  lines: readonly string[],
  encoding: 1 | 2,
): Omit<NormalizedOccurrence, "symbol" | "roles"> | undefined {
  if (typedRange !== undefined && typedRange !== null) return undefined;
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4) || !value.every(Number.isInteger)) return undefined;
  const [startLineZero, startCharacter] = value as number[];
  const endLineZero = value.length === 3 ? startLineZero : value[2] as number;
  const endCharacter = value.length === 3 ? value[2] as number : value[3] as number;
  if (startLineZero < 0 || endLineZero < startLineZero || startLineZero >= lines.length || endLineZero >= lines.length) return undefined;
  const convert = encoding === 1 ? utf8Column : utf16ColumnToUtf8;
  const startByte = convert(lines[startLineZero] ?? "", startCharacter);
  const endByte = convert(lines[endLineZero] ?? "", endCharacter);
  if (startByte === undefined || endByte === undefined || (startLineZero === endLineZero && endByte < startByte)) return undefined;
  return {
    line: startLineZero + 1,
    startCol: startByte,
    endLine: endLineZero + 1,
    endCol: endByte,
  };
}

function runDecoder(
  command: string,
  indexPath: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      ["print", "--json", indexPath],
      {
        encoding: "utf8",
        maxBuffer: maxOutputBytes,
        timeout: timeoutMs,
        signal,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const diagnostic = typeof stderr === "string" ? stderr.slice(0, MAX_STDERR_BYTES).trim() : "";
          reject(new Error(diagnostic.length > 0 ? `${error.message}: ${diagnostic}` : error.message));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.destroy();
  });
}

function compatibleTarget(callType: string, kind: string): boolean {
  const lower = kind.toLowerCase();
  if (callType === "Constructor") return lower.includes("class") || lower.includes("constructor");
  if (callType === "Inherits" || callType === "Implements") return lower.includes("class") || lower.includes("interface") || lower.includes("type");
  if (callType === "MethodCall") return lower.includes("method") || lower.includes("function");
  if (callType === "Call") return lower.includes("function") || lower.includes("method") || lower.includes("arrow");
  if (callType === "Import") return !lower.includes("parameter") && !lower.includes("variable");
  return false;
}

function scipDescriptorName(symbol: string): string | undefined {
  const descriptor = symbol.match(/(?:[#/.])([A-Za-z_$][\w$]*)(?:\(\))?[.#]?(?:\([^)]*\))?$/);
  if (descriptor?.[1]) return descriptor[1];
  const backtickMatches = [...symbol.matchAll(/`([^`]+)`/g)];
  if (backtickMatches.length > 0) return backtickMatches.at(-1)?.[1];
  return undefined;
}

function isRelevantFreshnessPath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/").toLowerCase();
  if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(normalized)) return true;
  const base = path.posix.basename(normalized);
  return /^(?:tsconfig|jsconfig).*\.json$/.test(base)
    || base === "package.json"
    || [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "bun.lock",
      "bun.lockb",
      "lerna.json",
      "rush.json",
    ].includes(base);
}

function rangesOverlap(symbol: SymbolData, occurrence: NormalizedOccurrence): boolean {
  if (occurrence.endLine < symbol.startLine || occurrence.line > symbol.endLine) return false;
  if (occurrence.line === symbol.endLine && symbol.endCol > 0 && occurrence.startCol > symbol.endCol) return false;
  if (occurrence.endLine === symbol.startLine && occurrence.endCol < symbol.startCol) return false;
  return true;
}

function definitionMatchesSymbol(symbol: SymbolData, occurrence: NormalizedOccurrence, lines: readonly string[]): boolean {
  if (symbol.startLine !== occurrence.line || occurrence.line !== occurrence.endLine) return false;
  const line = lines[occurrence.line - 1];
  if (line === undefined) return false;
  const spans: Array<{ startCol: number; endCol: number }> = [];
  let offset = 0;
  while (offset <= line.length) {
    const index = line.indexOf(symbol.name, offset);
    if (index < 0) break;
    const before = line[index - 1] ?? "";
    const after = line[index + symbol.name.length] ?? "";
    if (!/[\p{L}\p{N}_$]/u.test(before) && !/[\p{L}\p{N}_$]/u.test(after)) {
      spans.push({
        startCol: Buffer.byteLength(line.slice(0, index), "utf8"),
        endCol: Buffer.byteLength(line.slice(0, index + symbol.name.length), "utf8"),
      });
    }
    offset = index + Math.max(1, symbol.name.length);
  }
  return spans.length === 1
    && spans[0].startCol === occurrence.startCol
    && spans[0].endCol === occurrence.endCol
    && rangesOverlap(symbol, occurrence);
}

function occurrenceContainsEdge(occurrence: NormalizedOccurrence, edge: CallEdgeData): boolean {
  return occurrence.line === edge.line
    && occurrence.endLine === edge.line
    && edge.col >= occurrence.startCol
    && edge.col < occurrence.endCol;
}

function buildPrepared(
  configFingerprint: string,
  stateDetails: Pick<PreparedScipEnrichment, "indexPath" | "indexSha256" | "indexSize" | "indexMtimeMs" | "freshness">,
  root: string,
  parsed: ScipPrintIndex,
  allowedDocumentPaths: ReadonlySet<string>,
  maxSourceBytes: number,
): PreparedScipEnrichment {
  const tool = parsed.metadata?.tool_info;
  const generatorName = typeof tool?.name === "string" ? tool.name : undefined;
  const generatorVersion = typeof tool?.version === "string" ? tool.version : undefined;
  const metadataEncoding = parsed.metadata?.text_document_encoding;
  const rawDocuments = Array.isArray(parsed.documents) ? parsed.documents as ScipDocument[] : [];
  const documents = new Map<string, PreparedDocument>();
  let acceptedSourceBytes = 0;

  for (const raw of [...rawDocuments].sort((a, b) => String(a.relative_path).localeCompare(String(b.relative_path)))) {
    const relativePath = normalizeDocumentPath(raw.relative_path);
    if (!relativePath || documents.has(relativePath) || !allowedDocumentPaths.has(relativePath)) continue;
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    if (!isWithinRoot(absolutePath, root)) continue;
    let source: string;
    try {
      const realPath = fs.realpathSync(absolutePath);
      const sourceStat = fs.statSync(realPath);
      if (!isWithinRoot(realPath, root) || !sourceStat.isFile() || sourceStat.size > maxSourceBytes) continue;
      if (acceptedSourceBytes + sourceStat.size > maxSourceBytes) continue;
      acceptedSourceBytes += sourceStat.size;
      source = fs.readFileSync(realPath, "utf8");
    } catch {
      continue;
    }
    const lines = source.split(/\r?\n/);
    // scip-typescript@0.4.0's real output reports metadata encoding 1 while its
    // occurrence columns are UTF-16 code units. Keep this pinned compatibility
    // exception narrow instead of guessing for other generators.
    const encoding: 1 | 2 | undefined = generatorName === "scip-typescript" && generatorVersion === "0.4.0"
      ? 2
      : raw.position_encoding === 1 || raw.position_encoding === 2
        ? raw.position_encoding
        : metadataEncoding === 1 || metadataEncoding === 2
          ? metadataEncoding
          : undefined;
    if (encoding === undefined) continue;
    const occurrences: NormalizedOccurrence[] = [];
    for (const rawOccurrence of Array.isArray(raw.occurrences) ? raw.occurrences as ScipOccurrence[] : []) {
      if (typeof rawOccurrence.symbol !== "string" || rawOccurrence.symbol.length === 0) continue;
      const normalized = normalizeRange(rawOccurrence.range, rawOccurrence.TypedRange, lines, encoding);
      if (!normalized) continue;
      occurrences.push({
        ...normalized,
        symbol: rawOccurrence.symbol,
        roles: typeof rawOccurrence.symbol_roles === "number" && Number.isInteger(rawOccurrence.symbol_roles)
          ? rawOccurrence.symbol_roles
          : 0,
      });
    }
    occurrences.sort((a, b) => a.line - b.line || a.startCol - b.startCol || a.endCol - b.endCol || a.symbol.localeCompare(b.symbol));
    documents.set(relativePath, { filePath: relativePath, lines, occurrences });
  }

  const fingerprint = stableFingerprint({
    adapterVersion: SCIP_TYPESCRIPT_ADAPTER_VERSION,
    configFingerprint,
    outcome: "ready",
    ...stateDetails,
    generatorName: generatorName ?? null,
    generatorVersion: generatorVersion ?? null,
  });
  const prepared: PreparedScipEnrichment = {
    adapterVersion: SCIP_TYPESCRIPT_ADAPTER_VERSION,
    fingerprint,
    outcome: "ready",
    ...stateDetails,
    generatorName,
    generatorVersion,
    matchedEdges: 0,
    unmatchedOccurrences: 0,
    ambiguousDefinitions: 0,
    disagreements: 0,
    apply(edges, symbols) {
      const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
      const symbolsByFile = new Map<string, SymbolData[]>();
      for (const symbol of [...symbols].sort((a, b) => a.id.localeCompare(b.id))) {
        const normalizedPath = symbol.filePath.split(path.sep).join("/");
        const list = symbolsByFile.get(normalizedPath) ?? [];
        list.push(symbol);
        symbolsByFile.set(normalizedPath, list);
      }
      const definitions = new Map<string, SymbolData[]>();
      const ambiguousDefinitionSymbols = new Set<string>();
      for (const document of documents.values()) {
        const fileSymbols = symbolsByFile.get(document.filePath) ?? [];
        for (const occurrence of document.occurrences) {
          if ((occurrence.roles & DEFINITION_ROLE) === 0 || occurrence.symbol.startsWith("local ")) continue;
          const descriptorName = scipDescriptorName(occurrence.symbol);
          if (!descriptorName) continue;
          const candidates = fileSymbols.filter((symbol) =>
            symbol.name === descriptorName
            && definitionMatchesSymbol(symbol, occurrence, document.lines)
          );
          if (candidates.length !== 1) {
            if (candidates.length > 1) ambiguousDefinitionSymbols.add(occurrence.symbol);
            continue;
          }
          const list = definitions.get(occurrence.symbol) ?? [];
          if (!list.some((symbol) => symbol.id === candidates[0].id)) list.push(candidates[0]);
          definitions.set(occurrence.symbol, list);
        }
      }

      let matchedEdges = 0;
      let unmatchedOccurrences = 0;
      let ambiguousDefinitions = 0;
      let disagreements = 0;
      const enriched = edges.map((edge) => {
        const source = symbolById.get(edge.fromSymbolId);
        if (!source || !JAVASCRIPT_FAMILY.has(source.language)) return edge;
        const document = documents.get(source.filePath.split(path.sep).join("/"));
        if (!document) return edge;
        const references = document.occurrences.filter((occurrence) =>
          (occurrence.roles & DEFINITION_ROLE) === 0
          && occurrenceContainsEdge(occurrence, edge)
          && !occurrence.symbol.startsWith("local ")
        );
        if (references.length !== 1) {
          if (!edge.isResolved) unmatchedOccurrences += 1;
          return edge;
        }
        const targets = definitions.get(references[0].symbol) ?? [];
        if (ambiguousDefinitionSymbols.has(references[0].symbol) || targets.length > 1) {
          ambiguousDefinitions += 1;
          return edge;
        }
        if (targets.length !== 1 || !compatibleTarget(edge.callType, targets[0].kind)) {
          if (!edge.isResolved) unmatchedOccurrences += 1;
          return edge;
        }
        const target = targets[0];
        if (edge.isResolved) {
          if (edge.toSymbolId !== target.id) disagreements += 1;
          return edge;
        }
        matchedEdges += 1;
        return { ...edge, toSymbolId: target.id, isResolved: true };
      });
      prepared.matchedEdges += matchedEdges;
      prepared.unmatchedOccurrences += unmatchedOccurrences;
      prepared.ambiguousDefinitions += ambiguousDefinitions;
      prepared.disagreements += disagreements;
      return { edges: enriched, matchedEdges, unmatchedOccurrences, ambiguousDefinitions, disagreements };
    },
  };
  return prepared;
}

export async function prepareScipTypeScriptEnrichment(input: PrepareScipEnrichmentInput): Promise<PreparedScipEnrichment> {
  const normalizedIndexFile = input.indexFile.trim();
  const normalizedDecoderCommand = input.decoderCommand.trim();
  const configFingerprint = stableFingerprint({
    adapterVersion: SCIP_TYPESCRIPT_ADAPTER_VERSION,
    enabled: input.enabled,
    indexFile: normalizedIndexFile,
    decoderCommand: normalizedDecoderCommand,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    requireFreshIndex: input.requireFreshIndex,
  });
  if (!input.enabled) return inert(configFingerprint, "disabled", "unavailable");
  if (!normalizedIndexFile || !normalizedDecoderCommand) {
    return inert(configFingerprint, "rejected", "unavailable", { message: "SCIP paths must not be empty" });
  }

  let root: string;
  try {
    root = fs.realpathSync(input.materializedProjectRoot);
  } catch {
    return inert(configFingerprint, "rejected", "unavailable", { message: "Materialized project root is unreadable" });
  }
  const configuredPath = path.resolve(root, normalizedIndexFile);
  if (!isWithinRoot(configuredPath, root)) {
    return inert(configFingerprint, "rejected", "unavailable", { message: "SCIP index escapes project root" });
  }

  let indexPath: string;
  let stat: fs.Stats;
  let indexSha256: string;
  let indexBytes: Buffer;
  try {
    indexPath = fs.realpathSync(configuredPath);
    stat = fs.statSync(indexPath);
    if (!isWithinRoot(indexPath, root) || !stat.isFile()) {
      return inert(configFingerprint, "rejected", "unavailable", { indexPath, message: "SCIP index is not a project-local file" });
    }
    if (stat.size > input.maxOutputBytes) {
      return inert(configFingerprint, "rejected", "unavailable", { indexPath, message: "SCIP index exceeds the configured input cap" });
    }
    indexBytes = fs.readFileSync(indexPath);
    const afterRead = fs.statSync(indexPath);
    if (afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || afterRead.ino !== stat.ino) {
      return inert(configFingerprint, "rejected", "unavailable", { indexPath, message: "SCIP index changed while being fingerprinted" });
    }
    indexSha256 = createHash("sha256").update(indexBytes).digest("hex");
  } catch {
    return inert(configFingerprint, "missing", "unavailable", { message: "SCIP index is missing or unreadable" });
  }
  const stateDetails = {
    indexPath,
    indexSha256,
    indexSize: stat.size,
    indexMtimeMs: stat.mtimeMs,
  };

  let freshness: PreparedScipEnrichment["freshness"] = "not-required";
  const allowedDocumentPaths = new Set<string>();
  for (const file of input.relevantFiles) {
    try {
      const realFile = fs.realpathSync(file.path);
      if (!isWithinRoot(realFile, root) || !fs.statSync(realFile).isFile()) continue;
      const relativePath = path.relative(root, realFile).split(path.sep).join("/");
      if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i.test(relativePath)) allowedDocumentPaths.add(relativePath);
    } catch {
      // Discovery handles unreadable files independently.
    }
  }
  if (input.requireFreshIndex) {
    let newestInput = 0;
    for (const file of input.relevantFiles) {
      if (!isRelevantFreshnessPath(file.path)) continue;
      try {
        newestInput = Math.max(newestInput, fs.statSync(file.path).mtimeMs);
      } catch {
        return inert(configFingerprint, "stale", "stale", { ...stateDetails, message: "A relevant SCIP input became unreadable" });
      }
    }
    const pendingDirectories = [root];
    let visitedEntries = 0;
    let freshnessScanExhausted = false;
    while (pendingDirectories.length > 0 && visitedEntries < 20_000) {
      const directory = pendingDirectories.pop();
      if (!directory) break;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return inert(configFingerprint, "stale", "stale", { ...stateDetails, message: "SCIP freshness inputs are unreadable" });
      }
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries >= 20_000) {
          freshnessScanExhausted = true;
          break;
        }
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".codebase-index") continue;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pendingDirectories.push(entryPath);
        else if (entry.isFile() && isRelevantFreshnessPath(entryPath)) {
          try {
            newestInput = Math.max(newestInput, fs.statSync(entryPath).mtimeMs);
          } catch {
            return inert(configFingerprint, "stale", "stale", { ...stateDetails, message: "A relevant SCIP input became unreadable" });
          }
        }
      }
    }
    if (freshnessScanExhausted || pendingDirectories.length > 0) {
      return inert(configFingerprint, "stale", "stale", { ...stateDetails, message: "SCIP freshness scan exceeded its bounded entry limit" });
    }
    if (newestInput > stat.mtimeMs) {
      return inert(configFingerprint, "stale", "stale", { ...stateDetails, message: "SCIP index is older than project inputs" });
    }
    freshness = "fresh";
  }

  try {
    const stdout = await runDecoder(normalizedDecoderCommand, indexPath, input.timeoutMs, input.maxOutputBytes, input.signal);
    const afterDecodeStat = fs.statSync(indexPath);
    if (afterDecodeStat.size > input.maxOutputBytes) {
      return inert(configFingerprint, "rejected", freshness, { ...stateDetails, message: "SCIP index grew beyond the configured input cap during decoding" });
    }
    const afterDecode = fs.readFileSync(indexPath);
    if (
      afterDecodeStat.size !== stat.size
      || afterDecodeStat.mtimeMs !== stat.mtimeMs
      || afterDecodeStat.ino !== stat.ino
      || !afterDecode.equals(indexBytes)
    ) {
      return inert(configFingerprint, "rejected", freshness, { ...stateDetails, message: "SCIP index changed during decoding" });
    }
    const parsed = JSON.parse(stdout) as ScipPrintIndex;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.documents)) {
      return inert(configFingerprint, "rejected", freshness, { ...stateDetails, message: "SCIP decoder returned an invalid index" });
    }
    if (typeof parsed.metadata?.project_root !== "string") {
      return inert(configFingerprint, "rejected", freshness, { ...stateDetails, message: "SCIP project root is missing" });
    }
    if (typeof parsed.metadata.project_root === "string") {
      try {
        const rootUrl = new URL(parsed.metadata.project_root);
        if (rootUrl.protocol !== "file:") throw new Error("not a file URL");
        const projectRoot = fs.realpathSync(fileURLToPath(rootUrl));
        if (projectRoot !== root) {
          return inert(configFingerprint, "rejected", freshness, { ...stateDetails, message: "SCIP project root does not match materialized root" });
        }
      } catch {
        return inert(configFingerprint, "rejected", freshness, { ...stateDetails, message: "SCIP project root is invalid" });
      }
    }
    return buildPrepared(configFingerprint, { ...stateDetails, freshness }, root, parsed, allowedDocumentPaths, input.maxOutputBytes);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return inert(configFingerprint, "failed", freshness, {
      ...stateDetails,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
