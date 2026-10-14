import type { SearchResult, KeywordFileCandidateResult } from "../indexer/index.js";
import type { CallGraphDataResult } from "./operations.js";
import type { CallSiteData, ParsedFile, SymbolData } from "../native/index.js";
import type { OperationControl } from "../utils/operation-control.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { extractCalls, parseFiles } from "../native/index.js";
import { isTestPath } from "../indexer/intent-aware-ranking.js";
import { tokenizeTextForRanking } from "../indexer/definition-ranking.js";
import { isJavaScriptRuntimeSourceFilePath } from "../indexer/local-module-resolution.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { createTestBindingResolver, testModuleData } from "./test-binding-resolution.js";

export const TEST_DISCOVERY_MAX_CALLERS = 8;
export const TEST_DISCOVERY_MAX_FILES = 200;
export const TEST_DISCOVERY_MAX_DEFINITIONS = 100;
export const TEST_DISCOVERY_MAX_FILE_BYTES = 256 * 1024;
export const TEST_DISCOVERY_MAX_REFERENCES = 20;
const LANGUAGES: Record<string, string> = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
};

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

type TestContainer = NonNullable<ParsedFile["testSyntax"]>["containers"][number];

async function readConfiguration(root: string, filePath: string, markCapped: () => void, control?: OperationControl): Promise<{ content?: string; confirmedAbsent: boolean }> {
  throwIfOperationAborted(control?.signal);
  try {
    await fs.lstat(path.resolve(root, filePath));
  } catch (error: unknown) {
    return { confirmedAbsent: error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR") };
  }
  return { content: await readSource(root, filePath, markCapped, control), confirmedAbsent: false };
}

interface SourceEvidence {
  parsed: ParsedFile;
  calls: CallSiteData[];
  containersByCall: Map<CallSiteData, TestContainer>;
  containerContents: Map<TestContainer, string>;
  directCalls: Set<string>;
  sourceBytes?: Buffer;
  content: string;
}

interface RuntimeDefinition {
  definition: SearchResult;
  declaration: ParsedFile["symbols"][number];
  source: SourceEvidence;
  filePath: string;
}

function parseSource(filePath: string, content: string): SourceEvidence | undefined {
  const language = LANGUAGES[path.extname(filePath).toLowerCase()];
  if (!language) return undefined;
  const [parsed] = parseFiles([{ path: filePath, content }], undefined, undefined, true);
  if (!parsed || parsed.parseFailed || !parsed.testSyntax?.valid || !parsed.moduleSyntax?.valid) return undefined;
  const calls = extractCalls(content, language).sort((left, right) => left.line - right.line || left.column - right.column);
  const containers = parsed.testSyntax.containers.sort((left, right) =>
    left.bodyStartLine - right.bodyStartLine || left.bodyStartCol - right.bodyStartCol
    || right.bodyEndLine - left.bodyEndLine || right.bodyEndCol - left.bodyEndCol);
  const containersByCall = new Map<CallSiteData, TestContainer>();
  const active: TestContainer[] = [];
  let nextContainer = 0;
  for (const call of calls) {
    while (nextContainer < containers.length) {
      const candidate = containers[nextContainer];
      if (candidate.bodyStartLine > call.line || (candidate.bodyStartLine === call.line && candidate.bodyStartCol > call.column)) break;
      while (active.length > 0) {
        const previous = active[active.length - 1];
        if (previous.bodyEndLine > candidate.bodyStartLine || (previous.bodyEndLine === candidate.bodyStartLine && previous.bodyEndCol > candidate.bodyStartCol)) break;
        active.pop();
      }
      active.push(candidate);
      nextContainer += 1;
    }
    while (active.length > 0) {
      const candidate = active[active.length - 1];
      if (candidate.bodyEndLine > call.line || (candidate.bodyEndLine === call.line && candidate.bodyEndCol > call.column)) break;
      active.pop();
    }
    if (active.length > 0) containersByCall.set(call, active[active.length - 1]);
  }
  const containerContents = new Map<TestContainer, string>();
  const directCalls = new Set(parsed.moduleSyntax.calls.filter((call) => !call.qualifier
    && (call.callType === "Call" || call.callType === "Constructor")).map((call) =>
    `${call.line}:${call.column}:${call.callType}`));
  return { parsed, content, calls, containersByCall, containerContents, directCalls };
}

function resolvedReferenceMatchesDefinition(reference: SymbolData | undefined, declaration: SourceEvidence["parsed"]["symbols"][number], filePath: string): boolean {
  return reference !== undefined && reference.filePath === filePath && reference.name === declaration.name
    && reference.kind === declaration.kind && reference.startLine === declaration.startLine && reference.startCol === declaration.startCol
    && reference.endLine === declaration.endLine && reference.endCol === declaration.endCol;
}

function executableReference(source: SourceEvidence, call: CallSiteData, name: string): boolean {
  return call.calleeName === name && source.directCalls.has(`${call.line}:${call.column}:${call.callType}`);
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
  const sources = new Map<string, Promise<SourceEvidence | undefined>>();
  const currentSource = (filePath: string): Promise<SourceEvidence | undefined> => {
    let pending = sources.get(filePath);
    if (!pending) {
      pending = readSource(root, filePath, markCapped, control).then((content) =>
        content === undefined ? undefined : parseSource(filePath, content));
      sources.set(filePath, pending);
    }
    return pending;
  };
  const runtimeDefinitions = async (name: string): Promise<{ candidates: RuntimeDefinition[]; complete: boolean }> => {
    const definitions = await operations.lookup(name);
    const executable: RuntimeDefinition[] = [];
    let complete = definitions.length < TEST_DISCOVERY_MAX_DEFINITIONS;
    if (!complete) {
      markCapped();
      return { candidates: executable, complete };
    }
    for (const definition of definitions) {
      throwIfOperationAborted(control?.signal);
      if (definition.name !== name) continue;
      const filePath = relativePath(root, definition.filePath);
      if (!filePath) { complete = false; continue; }
      if (/\.d\.(?:ts|mts|cts)$/iu.test(filePath)) continue;
      if (!isJavaScriptRuntimeSourceFilePath(filePath)) { complete = false; continue; }
      const source = await currentSource(filePath);
      if (!source) { complete = false; continue; }
      const declarations = source.parsed.symbols.filter((declaration) => declaration.name === name
        && declaration.kind === definition.chunkType && declaration.startLine === definition.startLine
        && declaration.endLine === definition.endLine && declaration.startCol === definition.startCol
        && declaration.endCol === definition.endCol);
      if (declarations.length !== 1) { complete = false; continue; }
      const declaration = declarations[0];
      const bindings = source.parsed.moduleSyntax!.bindings.filter((binding) => binding.name === name
        && binding.startLine === declaration.startLine && binding.startCol === declaration.startCol
        && binding.endLine === declaration.endLine && binding.endCol === declaration.endCol);
      if (bindings.some((binding) => (binding.callable || binding.constructable) && !binding.mutated)) {
        executable.push({ definition, declaration, source, filePath });
      } else if (!["type_alias_declaration", "interface_declaration", "enum_declaration", "function_signature"].includes(declaration.kind)
        && !bindings.some((binding) => binding.kind === "ambient" && !binding.mutated)) {
        complete = false;
      }
    }
    if (!complete) markCapped();
    return { candidates: [...new Map(executable.map((candidate) => [
      `${candidate.filePath}:${candidate.declaration.startLine}:${candidate.declaration.startCol}`, candidate,
    ])).values()], complete };
  };
  const targetLookup = await runtimeDefinitions(symbol);
  const unique = targetLookup.candidates;
  if (!targetLookup.complete || unique.length !== 1) {
    result.resolution = !targetLookup.complete || unique.length > 1 ? "ambiguous" : "not_found";
    return result;
  }
  const { definition: target, declaration: targetDeclaration, source: targetSource, filePath: targetPath } = unique[0];
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
    && isJavaScriptRuntimeSourceFilePath(filePath) && inScope(filePath, scope));
  if (candidates.length === 0) return result;
  const navigationFiles = callers.slice(0, TEST_DISCOVERY_MAX_CALLERS)
    .map((edge) => relativePath(root, edge.fromSymbolFilePath!))
    .filter((filePath): filePath is string => Boolean(filePath));
  const resolver = await createTestBindingResolver(inventory, [targetPath, ...navigationFiles],
    (filePath) => readSource(root, filePath, markCapped, control),
    (filePath) => readConfiguration(root, filePath, markCapped, control), markCapped, control);
  resolver.moduleResolver.seedModule(targetPath, testModuleData(targetPath, targetSource.content, targetSource.parsed));
  const callerDefinitionsByName = new Map<string, (typeof unique)[number]>();
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
    const source = await currentSource(callerPath);
    if (!source) continue;
    const sourceCall = source.calls.find((call) => executableReference(source, call, symbol)
      && call.line === edge.line && call.column === edge.col && call.callType === edge.callType);
    if (!sourceCall) continue;
    resolver.moduleResolver.seedModule(callerPath, testModuleData(callerPath, source.content, source.parsed));
    const targetReference = await resolver.resolveCallTarget(callerPath, source.content, sourceCall);
    throwIfOperationAborted(control?.signal);
    if (!resolvedReferenceMatchesDefinition(targetReference, targetDeclaration, targetPath)) continue;
    const exportedSymbols = await resolver.moduleResolver.exportedFunctionSymbols(callerPath);
    throwIfOperationAborted(control?.signal);
    const exportedCandidates = new Set<SourceEvidence["parsed"]["symbols"][number]>();
    const enclosing = source.parsed.symbols.filter((candidate) => {
      if (candidate.name === symbol || candidate.startLine > edge.line || candidate.endLine < edge.line) return false;
      const exported = exportedSymbols.some((reference) => resolvedReferenceMatchesDefinition(reference, candidate, callerPath));
      if (exported) exportedCandidates.add(candidate);
      return exported || candidate.name === edge.fromSymbolName;
    }).sort((left, right) => Number(exportedCandidates.has(right)) - Number(exportedCandidates.has(left))
      || left.endLine - left.startLine - (right.endLine - right.startLine));
    // Anonymous callback owners may use their source-verified enclosing export, never a filename guess.
    if (enclosing.length > 2) result.capped = true;
    for (const candidate of enclosing.slice(0, 2)) {
      const callerLookup = await runtimeDefinitions(candidate.name);
      const callerDefinitions = callerLookup.candidates;
      if (!callerLookup.complete || callerDefinitions.length !== 1 || callerDefinitions[0].filePath !== callerPath) continue;
      const caller = callerDefinitions[0];
      if (caller.declaration.kind !== candidate.kind || caller.declaration.startLine !== candidate.startLine
        || caller.declaration.startCol !== candidate.startCol || caller.declaration.endLine !== candidate.endLine
        || caller.declaration.endCol !== candidate.endCol) continue;
      callerDefinitionsByName.set(candidate.name, caller);
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
  await resolver.loadImporters(selectedFiles);

  const references = new Map<string, TestReferenceResult>();
  const targetTerms = new Set([...referenceTerms(symbol)].filter((term) => term.length >= 3));
  const compareReferences = (left: TestReferenceResult, right: TestReferenceResult): number => right.score - left.score
    || fileRanks.get(left.filePath)! - fileRanks.get(right.filePath)!
    || left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine
    || left.referenceLine - right.referenceLine || left.referencedSymbol.localeCompare(right.referencedSymbol);
  for (const filePath of selectedFiles) {
    throwIfOperationAborted(control?.signal);
    const source = await currentSource(filePath);
    if (!source) continue;
    result.scannedFileCount += 1;
    resolver.moduleResolver.seedModule(filePath, testModuleData(filePath, source.content, source.parsed));
    const names = [symbol, ...callerDefinitionsByName.keys()];
    for (const call of source.calls) {
      if (!names.some((name) => executableReference(source, call, name))) continue;
      const container = source.containersByCall.get(call);
      if (!container) continue;
      const expectedDefinition = call.calleeName === symbol ? unique[0] : callerDefinitionsByName.get(call.calleeName);
      if (!expectedDefinition) continue;
      const direct = call.calleeName === symbol;
      const startLine = container.startLine;
      const endLine = container.endLine;
      const key = `${filePath}:${container.startByte}:${container.endByte}`;
      const previous = references.get(key);
      if (previous && (previous.evidenceKind === "direct_target_test_reference" || !direct)) continue;
      const reference = await resolver.resolveCallTarget(filePath, source.content, call);
      throwIfOperationAborted(control?.signal);
      if (!resolvedReferenceMatchesDefinition(reference, expectedDefinition.declaration, expectedDefinition.filePath)) continue;
      let content = source.containerContents.get(container);
      if (content === undefined) {
        source.sourceBytes ??= Buffer.from(source.content);
        content = source.sourceBytes.subarray(container.startByte, container.endByte).toString("utf8");
        source.containerContents.set(container, content);
      }
      const candidate: TestReferenceResult = {
        filePath: path.resolve(root, filePath), startLine, endLine,
        content, score: direct ? 1 : relatedReferenceScore(content, targetTerms),
        chunkType: "expression_statement" as TestReferenceResult["chunkType"],
        name: call.calleeName, evidenceKind: direct ? "direct_target_test_reference" : "related_caller_test_reference",
        referencedSymbol: call.calleeName, referenceLine: call.line,
      };
      if (!previous && references.size >= TEST_DISCOVERY_MAX_REFERENCES) {
        result.capped = true;
        let weakestKey: string | undefined;
        let weakest: TestReferenceResult | undefined;
        for (const [retainedKey, retained] of references) {
          if (!weakest || compareReferences(retained, weakest) > 0) {
            weakest = retained;
            weakestKey = retainedKey;
          }
        }
        if (compareReferences(candidate, weakest!) >= 0) continue;
        references.delete(weakestKey!);
      }
      references.set(key, candidate);
    }
    await control?.heartbeat?.();
  }
  throwIfOperationAborted(control?.signal);
  result.results = [...references.values()].sort(compareReferences);
  return result;
}
