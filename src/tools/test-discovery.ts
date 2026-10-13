import type { SearchResult, KeywordFileCandidateResult } from "../indexer/index.js";
import type { CallGraphDataResult } from "./operations.js";
import type { CallSiteData, CodeChunk, ParsedFile, SymbolData } from "../native/index.js";
import type { OperationControl } from "../utils/operation-control.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { extractCalls, parseFiles } from "../native/index.js";
import { isTestPath } from "../indexer/intent-aware-ranking.js";
import { tokenizeTextForRanking } from "../indexer/definition-ranking.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { createTestBindingResolver, testModuleData } from "./test-binding-resolution.js";

export const TEST_DISCOVERY_MAX_CALLERS = 8;
export const TEST_DISCOVERY_MAX_FILES = 200;
export const TEST_DISCOVERY_MAX_FILE_BYTES = 256 * 1024;
export const TEST_DISCOVERY_MAX_REFERENCES = 20;
const LANGUAGES: Record<string, string> = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
};
const TEST_CALLBACK_TYPES: Record<string, true> = {
  arrow_function: true, function: true, function_expression: true, expression_statement: true,
};
const SOURCE_LITERAL_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gu;

export type TestEvidenceKind = "direct_target_test_reference" | "related_caller_test_reference";

export interface TestReferenceResult extends SearchResult {
  evidenceKind: TestEvidenceKind;
  referencedSymbol: string;
  referenceLine: number;
}

export interface TestDiscoveryResult {
  results: TestReferenceResult[];
  resolution: "resolved" | "ambiguous" | "not_found";
  scannedFileCount: number;
  candidateFileCount: number;
  verifiedCallerCount: number;
  capped: boolean;
}

export interface TestDiscoveryOperations {
  lookup(symbol: string): Promise<SearchResult[]>;
  graph(symbol: string, filePath: string): Promise<CallGraphDataResult>;
  indexedFiles(): Promise<string[]>;
  lexicalFiles(identifiers: string[], allowedFilePaths: string[]): Promise<KeywordFileCandidateResult>;
}

export interface TestDiscoveryScope {
  fileType?: string;
  directory?: string;
}

function relativePath(root: string, filePath: string): string | undefined {
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function inScope(filePath: string, scope: TestDiscoveryScope): boolean {
  return (!scope.fileType || path.extname(filePath).slice(1).toLowerCase() === scope.fileType)
    && (!scope.directory || filePath === scope.directory || filePath.startsWith(`${scope.directory}/`));
}

async function readSource(root: string, filePath: string, markCapped: () => void, control?: OperationControl): Promise<string | undefined> {
  throwIfOperationAborted(control?.signal);
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root).catch(() => undefined),
    fs.realpath(path.resolve(root, filePath)).catch(() => undefined),
  ]);
  throwIfOperationAborted(control?.signal);
  if (!realRoot || !realFile || !relativePath(realRoot, realFile)) return undefined;
  const handle = await fs.open(realFile, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    throwIfOperationAborted(control?.signal);
    if (!stat.isFile()) return undefined;
    if (stat.size > TEST_DISCOVERY_MAX_FILE_BYTES) { markCapped(); return undefined; }
    const buffer = Buffer.alloc(TEST_DISCOVERY_MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    throwIfOperationAborted(control?.signal);
    if (bytesRead > TEST_DISCOVERY_MAX_FILE_BYTES) { markCapped(); return undefined; }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

interface SourceEvidence {
  parsed: ParsedFile;
  calls: CallSiteData[];
  lines: string[];
  bindingContent: string;
  content: string;
}

function parseSource(filePath: string, content: string): SourceEvidence | undefined {
  const language = LANGUAGES[path.extname(filePath).toLowerCase()];
  if (!language) return undefined;
  const [parsed] = parseFiles([{ path: filePath, content }]);
  if (!parsed || parsed.parseFailed) return undefined;
  return { parsed, content, calls: extractCalls(content, language), lines: content.split("\n"), bindingContent: content.replace(SOURCE_LITERAL_RE, " ") };
}

function resolvedReferenceMatchesDefinition(reference: SymbolData | undefined, definition: SearchResult, root: string): boolean {
  return reference !== undefined && reference.name === definition.name && reference.filePath === relativePath(root, definition.filePath)
    && reference.startLine >= definition.startLine && reference.startLine <= definition.endLine;
}

function executableReference(call: CallSiteData, name: string): boolean {
  // Import, inheritance and arbitrary obj.name() do not prove an executable reference to name.
  return call.calleeName === name && (call.callType === "Call" || call.callType === "Constructor");
}

function declaresName(source: SourceEvidence, name: string): boolean {
  // Conservative: a same-file declaration makes an imported/global test reference uncertain.
  if (source.parsed.symbols.some((symbol) => symbol.name === name)) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifier = `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`;
  const binding = new RegExp(`\\b(?:const|let|var|function|class)\\s+${identifier}|\\b(?:const|let|var)\\s*(?:\\{[^}]*|\\[[^\\]]*)${identifier}|${identifier}\\s*=>|\\([^)]*${identifier}[^)]*\\)\\s*(?::[^=;{]*)?(?:=>|\\{)`, "u");
  return binding.test(source.bindingContent);
}

function testContainer(source: SourceEvidence, call: CallSiteData): { chunk: CodeChunk; startLine: number } | undefined {
  const containers = source.parsed.chunks
    .filter((chunk) => TEST_CALLBACK_TYPES[chunk.chunkType]
      && chunk.startLine <= call.line && chunk.endLine >= call.line)
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine));
  for (const chunk of containers) {
    if ((chunk.chunkType as string) === "expression_statement"
      && source.calls.some((candidate) => (candidate.calleeName === "test" || candidate.calleeName === "it")
        && candidate.callType === "Call" && candidate.line === chunk.startLine)
      && /^\s*(?:test|it)\s*\(/u.test(chunk.content)) {
      return { chunk, startLine: chunk.startLine };
    }
    const testCall = source.calls.find((candidate) => (candidate.calleeName === "test" || candidate.calleeName === "it")
      && candidate.callType === "Call" && candidate.line <= chunk.startLine && chunk.startLine - candidate.line <= 3);
    if (!testCall) continue;
    const prefix = source.lines.slice(testCall.line - 1, chunk.startLine - 1).join("\n")
      + (testCall.line < chunk.startLine ? "\n" : "")
      + (source.lines[chunk.startLine - 1] ?? "").slice(0, chunk.startCol ?? 0);
    if (/\b(?:test|it)\s*\(/u.test(prefix) && !/\)\s*;/u.test(prefix)) {
      return { chunk, startLine: testCall.line };
    }
  }
  return undefined;
}

function referenceTerms(text: string): Set<string> {
  return tokenizeTextForRanking(text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/_/gu, " "));
}

function relatedReferenceScore(content: string, targetTerms: Set<string>): number {
  if (targetTerms.size === 0) return 0.5;
  const terms = referenceTerms(content);
  let matches = 0;
  for (const target of targetTerms) {
    for (const term of terms) {
      if (term.length >= 3 && (term.startsWith(target) || target.startsWith(term))) {
        matches += 1;
        break;
      }
    }
  }
  // Lexical relevance only: even a full overlap stays below a direct reference.
  return 0.5 + 0.25 * matches / targetTerms.size;
}

/** Current-source syntactic references only, not runtime coverage or invariant proof. */
export async function discoverSymbolTests(
  root: string,
  symbol: string,
  scope: TestDiscoveryScope,
  operations: TestDiscoveryOperations,
  control?: OperationControl,
): Promise<TestDiscoveryResult> {
  const result: TestDiscoveryResult = {
    results: [], resolution: "not_found", scannedFileCount: 0, candidateFileCount: 0,
    verifiedCallerCount: 0, capped: false,
  };
  const markCapped = (): void => { result.capped = true; };
  throwIfOperationAborted(control?.signal);
  const definitions = (await operations.lookup(symbol)).filter((definition) => definition.name === symbol);
  throwIfOperationAborted(control?.signal);
  const unique = [...new Map(definitions.map((definition) => [
    `${definition.filePath}:${definition.startLine}`, definition,
  ])).values()];
  if (unique.length !== 1) {
    result.resolution = unique.length > 1 ? "ambiguous" : "not_found";
    return result;
  }
  const target = unique[0];
  const targetPath = relativePath(root, target.filePath);
  if (!targetPath) return result;
  const content = await readSource(root, targetPath, markCapped, control);
  const targetSource = content === undefined ? undefined : parseSource(targetPath, content);
  const targetDeclaration = targetSource?.parsed.symbols.find((candidate) => candidate.name === symbol
    && candidate.startLine >= target.startLine && candidate.startLine <= target.endLine);
  if (!targetSource || !targetDeclaration) return result;
  result.resolution = "resolved";

  const graph = await operations.graph(symbol, target.filePath);
  throwIfOperationAborted(control?.signal);
  const callers = graph.resolution.status === "resolved" && graph.resolution.name === symbol
    && relativePath(root, graph.resolution.filePath) === targetPath
    ? graph.callers.filter((edge) => edge.fromSymbolName && edge.fromSymbolFilePath
      && edge.targetName === symbol && (edge.callType === "Call" || edge.callType === "Constructor"))
      .sort((left, right) => (left.fromSymbolFilePath ?? "").localeCompare(right.fromSymbolFilePath ?? "")
        || left.line - right.line || left.fromSymbolId.localeCompare(right.fromSymbolId))
    : [];
  const inventory = [...new Set((await operations.indexedFiles()).map((filePath) => relativePath(root, filePath))
    .filter((filePath): filePath is string => Boolean(filePath)))].sort();
  throwIfOperationAborted(control?.signal);
  const candidates = inventory.filter((filePath) => isTestPath(filePath)
    && Boolean(LANGUAGES[path.extname(filePath).toLowerCase()]) && inScope(filePath, scope));
  if (candidates.length === 0) return result;
  const navigationFiles = callers.slice(0, TEST_DISCOVERY_MAX_CALLERS)
    .map((edge) => relativePath(root, edge.fromSymbolFilePath!))
    .filter((filePath): filePath is string => Boolean(filePath));
  const resolver = await createTestBindingResolver(inventory, [targetPath, ...navigationFiles, ...candidates],
    (filePath) => readSource(root, filePath, markCapped, control), markCapped, control);
  resolver.seedModule(targetPath, testModuleData(targetPath, targetSource.content, targetSource.parsed));
  const callerDefinitionsByName = new Map<string, SearchResult>();
  const seenCallers = new Set<string>();
  let navigatedCallers = 0;
  for (const edge of callers) {
    throwIfOperationAborted(control?.signal);
    if (seenCallers.has(edge.fromSymbolId)) continue;
    seenCallers.add(edge.fromSymbolId);
    if (navigatedCallers >= TEST_DISCOVERY_MAX_CALLERS) { result.capped = true; break; }
    navigatedCallers += 1;
    const callerPath = relativePath(root, edge.fromSymbolFilePath!);
    if (!callerPath || isTestPath(callerPath)) continue;
    const callerContent = await readSource(root, callerPath, markCapped, control);
    const source = callerContent === undefined ? undefined : parseSource(callerPath, callerContent);
    if (!source || declaresName(source, symbol)) continue;
    const sourceCall = source.calls.find((call) => executableReference(call, symbol) && call.line === edge.line);
    if (!sourceCall) continue;
    resolver.seedModule(callerPath, testModuleData(callerPath, source.content, source.parsed));
    const targetReference = await resolver.resolveCallTarget(callerPath, source.content, sourceCall);
    throwIfOperationAborted(control?.signal);
    if (!resolvedReferenceMatchesDefinition(targetReference, target, root)) continue;
    const exportedCandidates = new Set<SourceEvidence["parsed"]["symbols"][number]>();
    const enclosing = source.parsed.symbols.filter((candidate) => {
      if (candidate.name === symbol || candidate.startLine > edge.line || candidate.endLine < edge.line) return false;
      const prefix = (source.lines[candidate.startLine - 1] ?? "").slice(0, candidate.startCol);
      const exported = /^\s*export\s+(?:default\s+)?(?:async\s+)?$/u.test(prefix);
      if (exported) exportedCandidates.add(candidate);
      return exported || candidate.name === edge.fromSymbolName;
    }).sort((left, right) => Number(exportedCandidates.has(right)) - Number(exportedCandidates.has(left))
      || left.endLine - left.startLine - (right.endLine - right.startLine));
    // Anonymous callback owners may use their source-verified enclosing export, never a filename guess.
    if (enclosing.length > 2) result.capped = true;
    for (const candidate of enclosing.slice(0, 2)) {
      const callerDefinitions = (await operations.lookup(candidate.name)).filter((definition) => definition.name === candidate.name);
      if (callerDefinitions.length !== 1 || relativePath(root, callerDefinitions[0].filePath) !== callerPath) continue;
      if (callerDefinitions[0].startLine > candidate.startLine || callerDefinitions[0].endLine < edge.line) continue;
      callerDefinitionsByName.set(candidate.name, callerDefinitions[0]);
      break;
    }
    await control?.heartbeat?.();
  }
  result.verifiedCallerCount = callerDefinitionsByName.size;
  const lexical = await operations.lexicalFiles([symbol, ...callerDefinitionsByName.keys()], candidates);
  throwIfOperationAborted(control?.signal);
  const allowedFiles = new Set(candidates);
  const selectedFiles = [...new Set(lexical.filePaths.map((filePath) => relativePath(root, filePath))
    .filter((filePath): filePath is string => filePath !== undefined && allowedFiles.has(filePath)))].slice(0, TEST_DISCOVERY_MAX_FILES);
  const fileRanks = new Map(selectedFiles.map((filePath, index) => [path.resolve(root, filePath), index]));
  result.candidateFileCount = selectedFiles.length;
  result.capped ||= lexical.capped;

  const references = new Map<string, TestReferenceResult>();
  const targetTerms = new Set([...referenceTerms(symbol)].filter((term) => term.length >= 3));
  let directCount = 0;
  let relatedCount = 0;
  for (const filePath of selectedFiles) {
    throwIfOperationAborted(control?.signal);
    const testContent = await readSource(root, filePath, markCapped, control);
    const source = testContent === undefined ? undefined : parseSource(filePath, testContent);
    if (!source) continue;
    result.scannedFileCount += 1;
    resolver.seedModule(filePath, testModuleData(filePath, source.content, source.parsed));
    const names = [symbol, ...callerDefinitionsByName.keys()].filter((name) => !declaresName(source, name));
    for (const call of source.calls) {
      if (!names.some((name) => executableReference(call, name))) continue;
      const container = testContainer(source, call);
      if (!container) continue;
      const expectedDefinition = call.calleeName === symbol ? target : callerDefinitionsByName.get(call.calleeName);
      if (!expectedDefinition) continue;
      const reference = await resolver.resolveCallTarget(filePath, source.content, call);
      throwIfOperationAborted(control?.signal);
      if (!resolvedReferenceMatchesDefinition(reference, expectedDefinition, root)) continue;
      const direct = call.calleeName === symbol;
      const startLine = container.startLine;
      const endLine = container.chunk.endLine;
      const key = `${filePath}:${startLine}:${endLine}`;
      const previous = references.get(key);
      if (previous && (previous.evidenceKind === "direct_target_test_reference" || !direct)) continue;
      if ((direct ? directCount : relatedCount) >= TEST_DISCOVERY_MAX_REFERENCES) {
        result.capped = true;
        continue;
      }
      if (previous) relatedCount -= 1;
      if (direct) directCount += 1;
      else relatedCount += 1;
      const content = source.lines.slice(startLine - 1, endLine).join("\n");
      references.set(key, {
        filePath: path.resolve(root, filePath), startLine, endLine,
        content, score: direct ? 1 : relatedReferenceScore(content, targetTerms),
        chunkType: container.chunk.chunkType,
        name: call.calleeName, evidenceKind: direct ? "direct_target_test_reference" : "related_caller_test_reference",
        referencedSymbol: call.calleeName, referenceLine: call.line,
      });
    }
    await control?.heartbeat?.();
  }
  throwIfOperationAborted(control?.signal);
  const ordered = [...references.values()].sort((left, right) => right.score - left.score
    || fileRanks.get(left.filePath)! - fileRanks.get(right.filePath)!
    || left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine
    || left.referenceLine - right.referenceLine || left.referencedSymbol.localeCompare(right.referencedSymbol));
  result.capped ||= ordered.length > TEST_DISCOVERY_MAX_REFERENCES;
  result.results = ordered.slice(0, TEST_DISCOVERY_MAX_REFERENCES);
  return result;
}
