import type { CallSiteData, SymbolData } from "../native/types.js";

import * as path from "node:path";

const JAVASCRIPT_SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;
const JAVASCRIPT_RUNTIME_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TYPESCRIPT_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const DECLARATION_MODIFIERS = new Set(["abstract", "async", "declare"]);
const CLASS_SYMBOL_KINDS = new Set(["class", "class_declaration", "class_definition"]);
const FUNCTION_SYMBOL_KINDS = new Set([
  "arrow_function",
  "function",
  "function_declaration",
  "function_definition",
]);

interface Token {
  kind: "identifier" | "punctuation" | "string";
  value: string;
  braceDepth: number;
}

interface ImportBinding {
  importedName: string;
  source: string;
}

interface NamespaceImportBinding {
  source: string;
}

type ExportBinding =
  | { kind: "local"; localName: string }
  | { kind: "reexport"; importedName: string; source: string };

interface ModuleRecord {
  imports: Map<string, ImportBinding[]>;
  namespaceImports: Map<string, NamespaceImportBinding[]>;
  exports: Map<string, ExportBinding[]>;
  starExports: string[];
}

export interface LocalModulePathAlias {
  pattern: string;
  targets: readonly string[];
  /** Project-relative base directory for aliases inherited from another config. */
  baseUrl?: string;
}

export interface LocalModulePathAliases {
  baseUrl: string;
  aliases: readonly LocalModulePathAlias[];
}

export interface LocalModuleData {
  content: string;
  symbols: readonly SymbolData[];
}

export interface LocalModuleResolverOptions {
  filePaths: readonly string[];
  loadModule: (filePath: string) => Promise<LocalModuleData | undefined>;
  tsConfigPathAliases?: LocalModulePathAliases;
}

export function isJavaScriptFamilyFilePath(filePath: string): boolean {
  return JAVASCRIPT_SOURCE_EXTENSIONS.includes(
    path.posix.extname(normalizeFilePath(filePath)).toLowerCase() as (typeof JAVASCRIPT_SOURCE_EXTENSIONS)[number],
  );
}

function normalizeFilePath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll("\\", "/"));
}

function hasAtMostOneWildcard(value: string): boolean {
  const first = value.indexOf("*");
  return first === -1 || first === value.lastIndexOf("*");
}

function normalizePathAliasTarget(rawTarget: string): string {
  const normalized = normalizeFilePath(rawTarget.trim());
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function validateCompilerOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(rawBaseUrl: string | undefined): string | undefined {
  if (!rawBaseUrl) {
    return undefined;
  }

  const trimmedBaseUrl = normalizeFilePath(rawBaseUrl.trim());
  if (trimmedBaseUrl === ".") {
    return ".";
  }
  if (trimmedBaseUrl === "") {
    return ".";
  }
  if (path.posix.isAbsolute(trimmedBaseUrl)) {
    return undefined;
  }
  if (trimmedBaseUrl === ".." || trimmedBaseUrl.startsWith("../") || trimmedBaseUrl.startsWith("./..")) {
    return undefined;
  }
  return trimmedBaseUrl;
}

function removeJsoncComments(configText: string): string {
  const output: string[] = [];
  let inString: string | null = null;
  let isEscaped = false;

  for (let index = 0; index < configText.length; index += 1) {
    const char = configText[index];
    const nextChar = configText[index + 1];

    if (inString !== null) {
      output.push(char);
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"') {
      inString = char;
      output.push(char);
      continue;
    }

    if (char === "/" && nextChar === "/") {
      index += 1;
      while (index + 1 < configText.length && configText[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && nextChar === "*") {
      index += 2;
      while (index + 1 < configText.length) {
        if (configText[index] === "*" && configText[index + 1] === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    output.push(char);
  }

  return output.join("");
}

function removeJsonTrailingCommas(configText: string): string {
  const output: string[] = [];
  let inString: string | null = null;
  let isEscaped = false;

  for (let index = 0; index < configText.length; index += 1) {
    const char = configText[index];

    if (inString !== null) {
      output.push(char);
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"') {
      inString = char;
      output.push(char);
      continue;
    }

    if (char !== ",") {
      output.push(char);
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < configText.length && /\s/u.test(configText[nextIndex])) {
      nextIndex += 1;
    }

    const nextChar = configText[nextIndex];
    if (nextChar === "}" || nextChar === "]" || nextChar === undefined) {
      continue;
    }

    output.push(char);
  }

  return output.join("");
}

function parseJsonConfig(configText: string): unknown {
  const sanitizedJson = removeJsonTrailingCommas(removeJsoncComments(configText));
  return JSON.parse(sanitizedJson);
}

interface TsConfigDocument {
  compilerOptions: Record<string, unknown>;
  extendsPath?: string;
}

function parseTsConfigDocument(configText: string): TsConfigDocument | undefined {
  let rawConfig: unknown;
  try {
    rawConfig = parseJsonConfig(configText);
  } catch {
    return undefined;
  }

  if (!validateCompilerOptionsObject(rawConfig)) {
    return undefined;
  }

  const compilerOptions = rawConfig.compilerOptions;
  if (compilerOptions !== undefined && !validateCompilerOptionsObject(compilerOptions)) {
    return undefined;
  }

  if (rawConfig.extends !== undefined && typeof rawConfig.extends !== "string") {
    return undefined;
  }

  return {
    compilerOptions: compilerOptions ?? {},
    extendsPath: rawConfig.extends,
  };
}

function parsePathAliases(compilerOptions: Record<string, unknown>): LocalModulePathAlias[] | undefined {
  const rawPaths = compilerOptions.paths;
  if (rawPaths === undefined) return [];
  if (!validateCompilerOptionsObject(rawPaths)) return undefined;

  const aliases: LocalModulePathAlias[] = [];
  for (const [pattern, targetsValue] of Object.entries(rawPaths)) {
    const normalizedPattern = normalizePathAliasTarget(pattern);
    if (normalizedPattern.length === 0 || normalizedPattern === ".") {
      return undefined;
    }
    if (!hasAtMostOneWildcard(normalizedPattern)) {
      return undefined;
    }

    if (!Array.isArray(targetsValue)) {
      return undefined;
    }

    const targets: string[] = [];
    for (const target of targetsValue) {
      if (typeof target !== "string") {
        return undefined;
      }
      const normalizedTarget = normalizePathAliasTarget(target);
      if (!hasAtMostOneWildcard(normalizedTarget)) {
        return undefined;
      }
      if (normalizedTarget.startsWith("/") || normalizedTarget === ".." || normalizedTarget.startsWith("../")) {
        return undefined;
      }
      if (normalizedTarget.length === 0) {
        return undefined;
      }
      targets.push(normalizedTarget);
    }

    if (targets.length === 0) {
      return undefined;
    }

    aliases.push({ pattern: normalizedPattern, targets });
  }

  return aliases;
}

export function parseTsConfigForModuleResolution(configText: string): LocalModulePathAliases | undefined {
  const document = parseTsConfigDocument(configText);
  if (!document) return undefined;

  const normalizedBaseUrl = normalizeBaseUrl(
    typeof document.compilerOptions.baseUrl === "string" ? document.compilerOptions.baseUrl : undefined,
  );
  const aliases = parsePathAliases(document.compilerOptions);
  if (!aliases) return undefined;

  if (aliases.length === 0) {
    return undefined;
  }

  return {
    baseUrl: normalizedBaseUrl ?? ".",
    aliases,
  };
}

function resolveLocalExtendsPath(configPath: string, extendsPath: string): string | undefined {
  const trimmed = extendsPath.trim();
  if (!trimmed.startsWith(".") || path.posix.isAbsolute(trimmed)) return undefined;

  const withExtension = path.posix.extname(trimmed) === "" ? `${trimmed}.json` : trimmed;
  if (!withExtension.endsWith(".json")) return undefined;
  const resolved = normalizeFilePath(path.posix.join(path.posix.dirname(configPath), withExtension));
  return isProjectLocalPath(resolved) ? trimLeadingCurrentDir(resolved) : undefined;
}

function resolveConfigBaseUrl(configPath: string, rawBaseUrl: string): string | undefined {
  const normalizedBaseUrl = normalizeFilePath(rawBaseUrl.trim());
  if (normalizedBaseUrl === "" || path.posix.isAbsolute(normalizedBaseUrl)) return undefined;
  const resolved = trimLeadingCurrentDir(normalizeFilePath(
    path.posix.join(path.posix.dirname(configPath), normalizedBaseUrl),
  ));
  return isProjectLocalPath(resolved) ? resolved : undefined;
}

/**
 * Lists a root config and its local relative `extends` chain. Package-based
 * configs deliberately return undefined: resolving those would make graph
 * construction depend on node_modules and TypeScript's full resolver.
 */
export function getTsConfigModuleResolutionConfigPaths(
  configPath: string,
  loadConfig: (configPath: string) => string | undefined,
): readonly string[] | undefined {
  const chain: string[] = [];
  const visiting = new Set<string>();

  const visit = (candidate: string): boolean => {
    const normalized = trimLeadingCurrentDir(normalizeFilePath(candidate));
    if (!isProjectLocalPath(normalized) || visiting.has(normalized)) return false;

    const configText = loadConfig(normalized);
    if (configText === undefined) return false;
    const document = parseTsConfigDocument(configText);
    if (!document) return false;

    visiting.add(normalized);
    if (document.extendsPath !== undefined) {
      const parentPath = resolveLocalExtendsPath(normalized, document.extendsPath);
      if (!parentPath || !visit(parentPath)) return false;
    }
    visiting.delete(normalized);
    chain.push(normalized);
    return true;
  };

  return visit(configPath) ? chain : undefined;
}

/** Resolves aliases through a local relative `extends` chain, parent first. */
export function resolveTsConfigForModuleResolution(
  configPath: string,
  loadConfig: (configPath: string) => string | undefined,
): LocalModulePathAliases | undefined {
  const configPaths = getTsConfigModuleResolutionConfigPaths(configPath, loadConfig);
  if (!configPaths) return undefined;

  let baseUrl = ".";
  let aliases: LocalModulePathAlias[] | undefined;
  for (const currentPath of configPaths) {
    const configText = loadConfig(currentPath);
    if (configText === undefined) return undefined;
    const document = parseTsConfigDocument(configText);
    if (!document) return undefined;

    if (document.compilerOptions.baseUrl !== undefined) {
      if (typeof document.compilerOptions.baseUrl !== "string") return undefined;
      const resolvedBaseUrl = resolveConfigBaseUrl(currentPath, document.compilerOptions.baseUrl);
      if (!resolvedBaseUrl) return undefined;
      baseUrl = resolvedBaseUrl;
    }

    if (document.compilerOptions.paths !== undefined) {
      const currentAliases = parsePathAliases(document.compilerOptions);
      if (!currentAliases) return undefined;
      aliases = currentAliases.map((alias) => ({ ...alias, baseUrl }));
    }
  }

  if (!aliases || aliases.length === 0) return undefined;
  return { baseUrl, aliases };
}

function isProjectLocalPath(candidatePath: string): boolean {
  if (path.posix.isAbsolute(candidatePath) || candidatePath === ".." || candidatePath.startsWith("../")) {
    return false;
  }
  return true;
}

function trimLeadingCurrentDir(candidatePath: string): string {
  if (candidatePath === ".") {
    return ".";
  }
  return candidatePath.startsWith("./") ? candidatePath.slice(2) : candidatePath;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/u.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char);
}

function tokenizeModuleSource(content: string): Token[] {
  const tokens: Token[] = [];
  let braceDepth = 0;
  let index = 0;

  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index + 1 < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(content.length, index + 2);
      continue;
    }

    if (char === "`" || char === "\"" || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < content.length) {
        const current = content[index];
        if (current === "\\") {
          if (index + 1 < content.length) {
            value += content[index + 1];
            index += 2;
          } else {
            index += 1;
          }
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      if (quote !== "`") {
        tokens.push({ kind: "string", value, braceDepth });
      }
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < content.length && isIdentifierPart(content[index])) index += 1;
      tokens.push({ kind: "identifier", value: content.slice(start, index), braceDepth });
      continue;
    }

    tokens.push({ kind: "punctuation", value: char, braceDepth });
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    index += 1;
  }

  return tokens;
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function findFromSource(tokens: readonly Token[], start: number): string | undefined {
  for (let index = start; index + 1 < tokens.length; index += 1) {
    if (tokens[index].braceDepth !== 0) continue;
    if (tokens[index].value === ";") return undefined;
    if (tokens[index].value === "from" && tokens[index + 1]?.kind === "string") {
      return tokens[index + 1].value;
    }
  }
  return undefined;
}

function parseNamedSpecifiers(
  tokens: readonly Token[],
  openBraceIndex: number,
): Array<{ importedName: string; exportedName: string }> {
  const result: Array<{ importedName: string; exportedName: string }> = [];
  const depth = tokens[openBraceIndex].braceDepth + 1;
  let index = openBraceIndex + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === "}" && token.braceDepth === depth) break;
    if (token.braceDepth !== depth || token.value === ",") {
      index += 1;
      continue;
    }

    let typeOnly = false;
    if (token.value === "type") {
      typeOnly = true;
      index += 1;
    }

    const imported = tokens[index];
    if (!imported || imported.kind !== "identifier" || imported.braceDepth !== depth) {
      index += 1;
      continue;
    }
    index += 1;

    let exportedName = imported.value;
    if (tokens[index]?.value === "as" && tokens[index]?.braceDepth === depth) {
      const alias = tokens[index + 1];
      if (alias?.kind === "identifier" && alias.braceDepth === depth) {
        exportedName = alias.value;
        index += 2;
      }
    }

    if (!typeOnly) {
      result.push({ importedName: imported.value, exportedName });
    }
    while (index < tokens.length && tokens[index].braceDepth === depth && tokens[index].value !== ",") {
      index += 1;
    }
  }

  return result;
}

function parseImportDeclaration(tokens: readonly Token[], index: number, record: ModuleRecord): void {
  let cursor = index + 1;
  if (tokens[cursor]?.value === "type") return;
  if (tokens[cursor]?.kind === "string") return;

  const pending: Array<{ importedName: string; localName: string }> = [];
  let namespaceLocalName: string | undefined;

  if (tokens[cursor]?.kind === "identifier") {
    pending.push({ importedName: "default", localName: tokens[cursor].value });
    cursor += 1;
    if (tokens[cursor]?.value === ",") cursor += 1;
  }

  if (tokens[cursor]?.value === "{") {
    for (const specifier of parseNamedSpecifiers(tokens, cursor)) {
      pending.push({ importedName: specifier.importedName, localName: specifier.exportedName });
    }
  } else if (tokens[cursor]?.value === "*" && tokens[cursor + 1]?.value === "as") {
    const local = tokens[cursor + 2];
    if (local?.kind === "identifier") namespaceLocalName = local.value;
  }

  const source = findFromSource(tokens, index + 1);
  if (!source) return;
  for (const binding of pending) {
    appendMapValue(record.imports, binding.localName, { importedName: binding.importedName, source });
  }
  if (namespaceLocalName) {
    appendMapValue(record.namespaceImports, namespaceLocalName, { source });
  }
}

function nextDeclarationToken(tokens: readonly Token[], start: number): number {
  let cursor = start;
  while (DECLARATION_MODIFIERS.has(tokens[cursor]?.value)) cursor += 1;
  return cursor;
}

function parseExportDeclaration(tokens: readonly Token[], index: number, record: ModuleRecord): void {
  let cursor = index + 1;
  if (tokens[cursor]?.value === "type") return;

  if (tokens[cursor]?.value === "*") {
    if (tokens[cursor + 1]?.value === "as") return;
    const source = findFromSource(tokens, cursor + 1);
    if (source) record.starExports.push(source);
    return;
  }

  if (tokens[cursor]?.value === "{") {
    const specifiers = parseNamedSpecifiers(tokens, cursor);
    const source = findFromSource(tokens, cursor + 1);
    for (const specifier of specifiers) {
      const binding: ExportBinding = source
        ? { kind: "reexport", importedName: specifier.importedName, source }
        : { kind: "local", localName: specifier.importedName };
      appendMapValue(record.exports, specifier.exportedName, binding);
    }
    return;
  }

  let isDefault = false;
  if (tokens[cursor]?.value === "default") {
    isDefault = true;
    cursor += 1;
  }
  cursor = nextDeclarationToken(tokens, cursor);

  if (tokens[cursor]?.value === "function" || tokens[cursor]?.value === "class") {
    cursor += 1;
    if (tokens[cursor]?.value === "*") cursor += 1;
    const name = tokens[cursor];
    if (name?.kind === "identifier") {
      appendMapValue(record.exports, isDefault ? "default" : name.value, {
        kind: "local",
        localName: name.value,
      });
    }
    return;
  }

  if (["const", "let", "var", "enum"].includes(tokens[cursor]?.value)) {
    const name = tokens[cursor + 1];
    if (name?.kind === "identifier") {
      appendMapValue(record.exports, isDefault ? "default" : name.value, {
        kind: "local",
        localName: name.value,
      });
    }
    return;
  }

  if (isDefault && tokens[cursor]?.kind === "identifier") {
    appendMapValue(record.exports, "default", { kind: "local", localName: tokens[cursor].value });
  }
}

function parseModuleRecord(content: string): ModuleRecord {
  const record: ModuleRecord = {
    imports: new Map(),
    namespaceImports: new Map(),
    exports: new Map(),
    starExports: [],
  };
  const tokens = tokenizeModuleSource(content);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.braceDepth !== 0 || token.kind !== "identifier") continue;
    if (token.value === "import") parseImportDeclaration(tokens, index, record);
    if (token.value === "export") parseExportDeclaration(tokens, index, record);
  }

  record.starExports.sort();
  return record;
}

function deduplicateSymbols(symbols: readonly SymbolData[]): SymbolData[] {
  const byId = new Map<string, SymbolData>();
  for (const symbol of symbols) byId.set(symbol.id, symbol);
  return [...byId.values()].sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.startLine - right.startLine
    || left.startCol - right.startCol
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  );
}

function filterCallTargetCandidates(callType: string, symbols: readonly SymbolData[]): SymbolData[] {
  if (callType === "Constructor") {
    return symbols.filter((symbol) => CLASS_SYMBOL_KINDS.has(symbol.kind));
  }
  if (callType === "Call") {
    return symbols.filter((symbol) => FUNCTION_SYMBOL_KINDS.has(symbol.kind));
  }
  return [...symbols];
}

function namespaceQualifier(content: string, site: CallSiteData): string | undefined {
  const line = content.split(/\r?\n/u)[site.line - 1];
  if (!line) return undefined;
  const prefix = line.slice(0, site.column);
  return prefix.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?\.|\.)\s*$/u)?.[1];
}

export class LocalModuleCallResolver {
  private readonly modulePaths = new Set<string>();
  private readonly loadModule: LocalModuleResolverOptions["loadModule"];
  private readonly moduleData = new Map<string, Promise<LocalModuleData | undefined>>();
  private readonly moduleRecords = new Map<string, Promise<ModuleRecord | undefined>>();
  private readonly exportCache = new Map<string, SymbolData[]>();
  private readonly baseUrl?: string;
  private readonly pathAliases: ReadonlyArray<LocalModulePathAlias> = [];

  constructor(options: LocalModuleResolverOptions) {
    for (const filePath of options.filePaths) {
      const normalized = normalizeFilePath(filePath);
      if (isJavaScriptFamilyFilePath(normalized)) this.modulePaths.add(normalized);
    }
    this.loadModule = options.loadModule;
    if (options.tsConfigPathAliases) {
      this.baseUrl = options.tsConfigPathAliases.baseUrl;
      this.pathAliases = options.tsConfigPathAliases.aliases;
    }
  }

  seedModule(filePath: string, data: LocalModuleData): void {
    const normalized = normalizeFilePath(filePath);
    if (!this.modulePaths.has(normalized)) return;
    this.moduleData.set(normalized, Promise.resolve(data));
    this.moduleRecords.set(normalized, Promise.resolve(parseModuleRecord(data.content)));
    for (const key of this.exportCache.keys()) {
      if (key.startsWith(`${normalized}\0`)) this.exportCache.delete(key);
    }
  }

  async resolveCallTarget(
    importerFilePath: string,
    importerContent: string,
    site: CallSiteData,
  ): Promise<SymbolData | undefined> {
    const importer = normalizeFilePath(importerFilePath);
    if (!this.modulePaths.has(importer)) return undefined;
    const record = await this.getModuleRecord(importer, importerContent);
    if (!record) return undefined;

    const candidates: SymbolData[] = [];
    const qualifier = namespaceQualifier(importerContent, site);
    if (!qualifier) {
      for (const binding of record.imports.get(site.calleeName) ?? []) {
        candidates.push(...await this.resolveImportedBinding(importer, binding, site.callType));
      }
    } else {
      const namespaceCallType = site.callType === "MethodCall" ? "Call" : site.callType;
      for (const binding of record.namespaceImports.get(qualifier) ?? []) {
        candidates.push(...await this.resolveImportedBinding(
          importer,
          { importedName: site.calleeName, source: binding.source },
          namespaceCallType,
        ));
      }
    }

    const unique = deduplicateSymbols(candidates);
    return unique.length === 1 ? unique[0] : undefined;
  }

  private async getModuleData(filePath: string): Promise<LocalModuleData | undefined> {
    const normalized = normalizeFilePath(filePath);
    const existing = this.moduleData.get(normalized);
    if (existing) return existing;
    const loaded = this.loadModule(normalized);
    this.moduleData.set(normalized, loaded);
    return loaded;
  }

  private async getModuleRecord(filePath: string, knownContent?: string): Promise<ModuleRecord | undefined> {
    const normalized = normalizeFilePath(filePath);
    if (knownContent !== undefined) {
      const parsed = Promise.resolve(parseModuleRecord(knownContent));
      this.moduleRecords.set(normalized, parsed);
      return parsed;
    }
    const existing = this.moduleRecords.get(normalized);
    if (existing) return existing;
    const parsed = this.getModuleData(normalized).then((data) => data ? parseModuleRecord(data.content) : undefined);
    this.moduleRecords.set(normalized, parsed);
    return parsed;
  }

  private resolveModuleSpecifier(importerFilePath: string, specifier: string): string[] {
    if (specifier.startsWith(".")) {
      const base = normalizeFilePath(path.posix.join(path.posix.dirname(importerFilePath), specifier));
      return this.resolveModuleCandidates(base);
    }

    const aliasCandidates = this.resolveModuleSpecifierFromAliases(specifier);
    if (aliasCandidates !== undefined) {
      return aliasCandidates;
    }

    if (this.pathAliases.length === 0) {
      return [];
    }

    return [];
  }

  private resolveModuleSpecifierFromAliases(specifier: string): string[] | undefined {
    if (this.pathAliases.length === 0) return undefined;

    const matchedAliasTargets = new Set<string>();
    let anyAliasMatched = false;

    for (const alias of this.pathAliases) {
      const wildcard = this.matchPathAliasPattern(specifier, alias.pattern);
      if (wildcard === undefined) {
        continue;
      }
      anyAliasMatched = true;

      for (const targetPattern of alias.targets) {
        const target = this.replaceWildcard(targetPattern, wildcard);
        const rawPath = normalizeFilePath(path.posix.join(alias.baseUrl ?? this.baseUrl ?? ".", target));
        if (!isProjectLocalPath(rawPath)) continue;
        for (const candidate of this.resolveModuleCandidates(trimLeadingCurrentDir(rawPath))) {
          matchedAliasTargets.add(candidate);
        }
      }
    }

    if (!anyAliasMatched) return undefined;
    return [...matchedAliasTargets].sort();
  }

  private resolveModuleCandidates(base: string): string[] {
    if (!isProjectLocalPath(base)) return [];

    const candidates = new Set<string>();
    const normalizedBase = trimLeadingCurrentDir(base);
    if (this.modulePaths.has(normalizedBase)) {
      candidates.add(normalizedBase);
    }

    const extension = path.posix.extname(normalizedBase).toLowerCase();
    if (JAVASCRIPT_RUNTIME_EXTENSIONS.has(extension)) {
      const withoutExtension = normalizedBase.slice(0, -extension.length);
      for (const sourceExtension of TYPESCRIPT_SOURCE_EXTENSIONS) {
        const candidate = `${withoutExtension}${sourceExtension}`;
        if (this.modulePaths.has(candidate)) candidates.add(candidate);
      }
      return [...candidates].sort();
    }

    if (extension.length > 0 && JAVASCRIPT_SOURCE_EXTENSIONS.includes(extension as (typeof JAVASCRIPT_SOURCE_EXTENSIONS)[number])) {
      if (this.modulePaths.has(normalizedBase)) {
        return [...candidates].sort();
      }
    }

    if (extension.length !== 0) return [...candidates].sort();

    for (const sourceExtension of JAVASCRIPT_SOURCE_EXTENSIONS) {
      const fileCandidate = `${normalizedBase}${sourceExtension}`;
      const indexCandidate = path.posix.join(normalizedBase, `index${sourceExtension}`);
      if (this.modulePaths.has(fileCandidate)) candidates.add(fileCandidate);
      if (this.modulePaths.has(indexCandidate)) candidates.add(indexCandidate);
    }

    return [...candidates].sort();
  }

  private matchPathAliasPattern(specifier: string, pattern: string): string | undefined {
    const wildcard = pattern.indexOf("*");
    if (wildcard === -1) {
      return specifier === pattern ? "" : undefined;
    }

    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    if (specifier.length < prefix.length + suffix.length) {
      return undefined;
    }
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      return undefined;
    }

    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }

  private replaceWildcard(target: string, wildcard: string): string {
    const wildcardIndex = target.indexOf("*");
    if (wildcardIndex === -1) {
      return target;
    }
    return `${target.slice(0, wildcardIndex)}${wildcard}${target.slice(wildcardIndex + 1)}`;
  }

  private async resolveImportedBinding(
    importerFilePath: string,
    binding: ImportBinding,
    callType: string,
  ): Promise<SymbolData[]> {
    const candidates: SymbolData[] = [];
    for (const targetModule of this.resolveModuleSpecifier(importerFilePath, binding.source)) {
      candidates.push(...await this.resolveExport(targetModule, binding.importedName, callType, new Set()));
    }
    return deduplicateSymbols(candidates);
  }

  private async resolveExport(
    moduleFilePath: string,
    exportedName: string,
    callType: string,
    visiting: Set<string>,
  ): Promise<SymbolData[]> {
    const normalized = normalizeFilePath(moduleFilePath);
    const cacheKey = `${normalized}\0${exportedName}\0${callType}`;
    const cached = this.exportCache.get(cacheKey);
    if (cached) return cached;
    if (visiting.has(cacheKey)) return [];

    const nextVisiting = new Set(visiting);
    nextVisiting.add(cacheKey);
    const record = await this.getModuleRecord(normalized);
    const data = await this.getModuleData(normalized);
    if (!record || !data) return [];

    const candidates: SymbolData[] = [];
    const explicitBindings = record.exports.get(exportedName);
    if (explicitBindings) {
      for (const binding of explicitBindings) {
        if (binding.kind === "local") {
          candidates.push(...data.symbols.filter((symbol) => symbol.name === binding.localName));
          continue;
        }
        for (const targetModule of this.resolveModuleSpecifier(normalized, binding.source)) {
          candidates.push(...await this.resolveExport(
            targetModule,
            binding.importedName,
            callType,
            nextVisiting,
          ));
        }
      }
    } else if (exportedName !== "default") {
      for (const source of record.starExports) {
        for (const targetModule of this.resolveModuleSpecifier(normalized, source)) {
          candidates.push(...await this.resolveExport(targetModule, exportedName, callType, nextVisiting));
        }
      }
    }

    const filtered = filterCallTargetCandidates(callType, deduplicateSymbols(candidates));
    const result = deduplicateSymbols(filtered);
    this.exportCache.set(cacheKey, result);
    return result;
  }
}
