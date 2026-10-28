import type { SearchResult, KeywordFileCandidateResult } from "../indexer/index.js";
import type { CallGraphDataResult } from "./operations.js";
import type { CallEdgeData, ModuleCallData, ParsedFile, SymbolData } from "../native/index.js";
import type { OperationControl } from "../utils/operation-control.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseFiles } from "../native/index.js";
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
const TEST_SOURCE_EXTENSIONS: Record<string, true> = {
  ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
  ".ts": true, ".tsx": true, ".mts": true, ".cts": true,
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
  /** Selects the implementation only; returned tests retain their own scope. */
  targetFilePath?: string;
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
type SourceDeclaration = ParsedFile["symbols"][number];

const CLASS_DECLARATION_KINDS: Record<string, true> = { class_declaration: true, abstract_class_declaration: true };

function containsSourcePosition(declaration: SourceDeclaration, line: number, column: number): boolean {
  return (declaration.startLine < line || (declaration.startLine === line && declaration.startCol <= column))
    && (declaration.endLine > line || (declaration.endLine === line && declaration.endCol >= column));
}

function containsDeclaration(outer: SourceDeclaration, inner: SourceDeclaration): boolean {
  return (outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startCol <= inner.startCol))
    && (outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endCol >= inner.endCol));
}

function innermostDeclarationContaining(candidates: SourceDeclaration[]): SourceDeclaration | undefined {
  const innermost = candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate && containsDeclaration(candidate, other)));
  return innermost.length === 1 ? innermost[0] : undefined;
}

function isExactExportedConstructorOwner(
  source: SourceEvidence,
  edge: CallEdgeData,
  candidate: SourceDeclaration,
  call: ModuleCallData,
): boolean {
  if (!CLASS_DECLARATION_KINDS[candidate.kind] || edge.fromSymbolName !== "constructor") return false;
  const owner = call.constructorOwner;
  if (!owner) return false;
  const declarations = source.parsed.symbols;
  const constructors = declarations.filter((declaration) => declaration.kind === "method_definition"
    && declaration.name === "constructor" && declaration.startLine === owner.startLine
    && declaration.startCol === owner.startCol && declaration.endLine === owner.endLine
    && declaration.endCol === owner.endCol && containsSourcePosition(declaration, edge.line, edge.col));
  if (constructors.length !== 1) return false;
  const constructor = constructors[0];
  const nearestClass = innermostDeclarationContaining(declarations.filter((declaration) =>
    CLASS_DECLARATION_KINDS[declaration.kind] && containsDeclaration(declaration, constructor)));
  return nearestClass === candidate;
}

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
  calls: ModuleCallData[];
  containersByCall: Map<ModuleCallData, TestContainer>;
  containerContents: Map<TestContainer, string>;
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
  if (!TEST_SOURCE_EXTENSIONS[path.extname(filePath).toLowerCase()]) return undefined;
  const [parsed] = parseFiles([{ path: filePath, content }], undefined, undefined, true);
  if (!parsed || parsed.parseFailed || !parsed.testSyntax?.valid || !parsed.moduleSyntax?.valid) return undefined;
  const calls = parsed.moduleSyntax.calls;
  const containers = parsed.testSyntax.containers.sort((left, right) =>
    left.bodyStartLine - right.bodyStartLine || left.bodyStartCol - right.bodyStartCol
    || right.bodyEndLine - left.bodyEndLine || right.bodyEndCol - left.bodyEndCol);
  const containersByCall = new Map<ModuleCallData, TestContainer>();
  if (containers.length > 0) {
    for (let index = 1; index < calls.length; index += 1) {
      const previous = calls[index - 1];
      const current = calls[index];
      if (previous.line > current.line || (previous.line === current.line && previous.column > current.column)) {
        calls.sort((left, right) => left.line - right.line || left.column - right.column);
        break;
      }
    }
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
  }
  return { parsed, content, calls, containersByCall, containerContents: new Map() };
}

function resolvedReferenceMatchesDefinition(reference: SymbolData | undefined, declaration: SourceEvidence["parsed"]["symbols"][number], filePath: string): boolean {
  return reference !== undefined && reference.filePath === filePath && reference.name === declaration.name
    && reference.kind === declaration.kind && reference.startLine === declaration.startLine && reference.startCol === declaration.startCol
    && reference.endLine === declaration.endLine && reference.endCol === declaration.endCol;
}

function executableReference(call: ModuleCallData): boolean {
  return !call.qualifier && call.bindingIndex !== undefined && (call.callType === "Call" || call.callType === "Constructor");
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
  let targetFilePath: string | undefined;
  if (scope.targetFilePath !== undefined) {
    const canonicalRoot = await fs.realpath(root);
    throwIfOperationAborted(control?.signal);
    const requestedPath = path.resolve(root, scope.targetFilePath);
    const requestedRelative = relativePath(root, requestedPath);
    const canonicalTarget = await fs.realpath(requestedPath).catch(() =>
      requestedRelative ? path.resolve(canonicalRoot, requestedRelative) : requestedPath);
    throwIfOperationAborted(control?.signal);
    targetFilePath = relativePath(canonicalRoot, canonicalTarget);
    if (!targetFilePath) throw new Error("Test discovery targetFilePath must remain inside the project root.");
  }
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
  const runtimeDefinitions = async (name: string, expectedPath?: string): Promise<{ candidates: RuntimeDefinition[]; complete: boolean }> => {
    const definitions = await operations.lookup(name);
    throwIfOperationAborted(control?.signal);
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
      if (expectedPath && filePath !== expectedPath) continue;
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
  const targetLookup = await runtimeDefinitions(symbol, targetFilePath);
  const unique = targetLookup.candidates;
  if (!targetLookup.complete || unique.length !== 1) {
    result.resolution = !targetLookup.complete || unique.length > 1 ? "ambiguous" : "not_found";
    return result;
  }
  const { definition: target, declaration: targetDeclaration, source: targetSource, filePath: targetPath } = unique[0];
  result.resolution = "resolved";

  const graph = await operations.graph(symbol, target.filePath);
  throwIfOperationAborted(control?.signal);
  const targetSymbolId = graph.resolution.status === "resolved" ? graph.resolution.symbolId : undefined;
  const callers = graph.resolution.status === "resolved" && graph.resolution.name === symbol
    && relativePath(root, graph.resolution.filePath) === targetPath
    ? graph.callers.filter((edge) => edge.fromSymbolName && edge.fromSymbolFilePath
      && (edge.targetName === symbol || edge.toSymbolId === targetSymbolId)
      && (edge.callType === "Call" || edge.callType === "Constructor"))
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
  const callerDefinitions = new Map<string, RuntimeDefinition>();
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
    const sourceCall = source.calls.find((call) => executableReference(call)
      && call.line === edge.line && call.column === edge.col && call.callType === edge.callType);
    if (!sourceCall) continue;
    resolver.moduleResolver.seedModule(callerPath, testModuleData(callerPath, source.content, source.parsed));
    const targetReference = await resolver.resolveCallTarget(callerPath, source.content, {
      calleeName: sourceCall.name,
      line: sourceCall.line,
      column: sourceCall.column,
      callType: sourceCall.callType,
      confidence: "Direct",
    });
    throwIfOperationAborted(control?.signal);
    if (!resolvedReferenceMatchesDefinition(targetReference, targetDeclaration, targetPath)) continue;
    const exportedSymbols = await resolver.moduleResolver.exportedRuntimeSymbols(callerPath);
    throwIfOperationAborted(control?.signal);
    const exportedCandidates = new Set<SourceEvidence["parsed"]["symbols"][number]>();
    const enclosing = source.parsed.symbols.filter((candidate) => {
      if (candidate.name === symbol || !containsSourcePosition(candidate, edge.line, edge.col)) return false;
      const exported = exportedSymbols.some((reference) => resolvedReferenceMatchesDefinition(reference, candidate, callerPath));
      if (exported && CLASS_DECLARATION_KINDS[candidate.kind]
        && !isExactExportedConstructorOwner(source, edge, candidate, sourceCall)) return false;
      if (exported) exportedCandidates.add(candidate);
      return exported || candidate.name === edge.fromSymbolName;
    }).sort((left, right) => Number(exportedCandidates.has(right)) - Number(exportedCandidates.has(left))
      || left.endLine - left.startLine - (right.endLine - right.startLine));
    // Anonymous callback owners may use their source-verified enclosing export, never a filename guess.
    if (enclosing.length > 2) result.capped = true;
    for (const candidate of enclosing.slice(0, 2)) {
      const callerLookup = await runtimeDefinitions(candidate.name, callerPath);
      if (!callerLookup.complete || callerLookup.candidates.length !== 1) continue;
      const caller = callerLookup.candidates[0];
      if (caller.declaration.kind !== candidate.kind || caller.declaration.startLine !== candidate.startLine
        || caller.declaration.startCol !== candidate.startCol || caller.declaration.endLine !== candidate.endLine
        || caller.declaration.endCol !== candidate.endCol) continue;
      callerDefinitions.set(`${callerPath}\0${candidate.name}`, caller);
      break;
    }
    await control?.heartbeat?.();
  }
  result.verifiedCallerCount = callerDefinitions.size;
  const referenceDefinitions = [unique[0], ...callerDefinitions.values()];
  const canonicalNames = new Set(referenceDefinitions.map((definition) => definition.declaration.name));
  const lexical = await operations.lexicalFiles([...canonicalNames], candidates);
  throwIfOperationAborted(control?.signal);
  const remainingFiles = new Set(candidates);
  const selectedFiles = [...new Set(lexical.filePaths.map((filePath) => relativePath(root, filePath))
    .filter((filePath): filePath is string => filePath !== undefined && remainingFiles.has(filePath)))].slice(0, TEST_DISCOVERY_MAX_FILES);
  await resolver.loadImporters(selectedFiles);
  // Remaining files also track unranked importers whose configuration has not been loaded.
  for (const filePath of selectedFiles) remainingFiles.delete(filePath);
  // Tiny import/require headers can be absent from chunks; verify the whole inventory when it fits.
  if (candidates.length <= TEST_DISCOVERY_MAX_FILES) selectedFiles.push(...remainingFiles);
  const fileRanks = new Map(selectedFiles.map((filePath, index) => [path.resolve(root, filePath), index]));
  result.candidateFileCount = selectedFiles.length;
  result.capped ||= lexical.capped;

  const references = new Map<string, TestReferenceResult>();
  const targetTerms = new Set([...referenceTerms(symbol)].filter((term) => term.length >= 3));
  const compareReferences = (left: TestReferenceResult, right: TestReferenceResult): number => right.score - left.score
    || fileRanks.get(left.filePath)! - fileRanks.get(right.filePath)!
    || left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine
    || left.referenceLine - right.referenceLine || left.referencedSymbol.localeCompare(right.referencedSymbol);
  const verifyCalls = async (filePath: string, canonicalNamesOnly: boolean): Promise<void> => {
    throwIfOperationAborted(control?.signal);
    const source = await currentSource(filePath);
    if (!source) return;
    if (canonicalNamesOnly) {
      result.scannedFileCount += 1;
      resolver.moduleResolver.seedModule(filePath, testModuleData(filePath, source.content, source.parsed));
    }
    for (const call of source.calls) {
      if (!executableReference(call) || canonicalNames.has(call.name) !== canonicalNamesOnly) continue;
      const container = source.containersByCall.get(call);
      if (!container) continue;
      const key = `${filePath}:${container.startByte}:${container.endByte}`;
      const previous = references.get(key);
      if (previous?.evidenceKind === "direct_target_test_reference") continue;
      if (remainingFiles.delete(filePath)) await resolver.loadImporters([filePath]);
      const reference = await resolver.resolveCallTarget(filePath, source.content, {
        calleeName: call.name,
        line: call.line,
        column: call.column,
        callType: call.callType,
        confidence: "Direct",
      });
      throwIfOperationAborted(control?.signal);
      const expectedDefinition = referenceDefinitions.find((definition) =>
        resolvedReferenceMatchesDefinition(reference, definition.declaration, definition.filePath));
      if (!expectedDefinition) continue;
      const direct = expectedDefinition === unique[0];
      const startLine = container.startLine;
      const endLine = container.endLine;
      if (previous && !direct) continue;
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
        name: call.name, evidenceKind: direct ? "direct_target_test_reference" : "related_caller_test_reference",
        referencedSymbol: expectedDefinition.declaration.name, referenceLine: call.line,
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
  };
  // Preserve canonical-spelling proofs before unrelated alias calls can spend their shared budgets.
  for (const filePath of selectedFiles) await verifyCalls(filePath, true);
  for (const filePath of selectedFiles) await verifyCalls(filePath, false);
  throwIfOperationAborted(control?.signal);
  result.results = [...references.values()].sort(compareReferences);
  return result;
}
