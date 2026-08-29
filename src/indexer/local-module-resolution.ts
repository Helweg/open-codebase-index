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
const STATIC_ESM_EXPORT_CONDITIONS = new Set(["node", "import", "default"]);
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

/** A project-local package manifest whose source entry points may form graph edges. */
export interface LocalWorkspacePackageExportPattern {
  specifierPath: string;
  targets: readonly string[];
}

export interface LocalWorkspacePackage {
  name: string;
  rootPath: string;
  entryPoints: ReadonlyMap<string, readonly string[]>;
  exportPatterns: readonly LocalWorkspacePackageExportPattern[];
  restrictsSubpaths: boolean;
}

export interface LocalModuleData {
  content: string;
  symbols: readonly SymbolData[];
}

export interface LocalModuleResolverOptions {
  filePaths: readonly string[];
  loadModule: (filePath: string) => Promise<LocalModuleData | undefined>;
  tsConfigPathAliases?: LocalModulePathAliases;
  pathAliasesForImporter?: (filePath: string) => LocalModulePathAliases | undefined;
  workspacePackages?: readonly LocalWorkspacePackage[];
}

export type LocalModuleResolutionConfigState = ReadonlyArray<readonly [path: string, content: string | null]>;

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

/**
 * Lists project-local config files that can affect a root config, including a
 * missing or malformed local `extends` target. Unlike the strict resolver,
 * this is suitable for watch registration: a later create or repair must be
 * observed so module resolution can be recomputed.
 */
export function getTsConfigModuleResolutionConfigDependencyPaths(
  configPath: string,
  loadConfig: (configPath: string) => string | undefined,
): readonly string[] {
  const dependencies: string[] = [];
  const visiting = new Set<string>();

  const visit = (candidate: string): void => {
    const normalized = trimLeadingCurrentDir(normalizeFilePath(candidate));
    if (!isProjectLocalPath(normalized) || visiting.has(normalized)) return;

    visiting.add(normalized);
    dependencies.push(normalized);
    const configText = loadConfig(normalized);
    const document = configText === undefined ? undefined : parseTsConfigDocument(configText);
    if (document?.extendsPath !== undefined) {
      const parentPath = resolveLocalExtendsPath(normalized, document.extendsPath);
      if (parentPath) visit(parentPath);
    }
    visiting.delete(normalized);
  };

  visit(configPath);
  return dependencies;
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

/**
 * Resolves and caches the nearest conventional TypeScript/JavaScript config for
 * each project-relative importer. Config lookup walks importer ancestors only,
 * so monorepos do not require a recursive config-file scan. TypeScript config
 * wins when both conventional config names exist in the same directory.
 */
export class TsConfigPathAliasCache {
  private readonly configTextByPath = new Map<string, string | undefined>();
  private readonly nearestConfigByDirectory = new Map<string, string | undefined>();
  private readonly aliasesByConfigPath = new Map<string, LocalModulePathAliases | undefined>();

  constructor(private readonly loadConfig: (configPath: string) => string | undefined) {}

  getPathAliasesForImporter(importerFilePath: string): LocalModulePathAliases | undefined {
    const configPath = this.findNearestConfigPath(importerFilePath);
    if (!configPath) return undefined;

    if (this.aliasesByConfigPath.has(configPath)) {
      return this.aliasesByConfigPath.get(configPath);
    }

    const aliases = resolveTsConfigForModuleResolution(configPath, (candidate) =>
      this.loadConfigCached(candidate)
    );
    this.aliasesByConfigPath.set(configPath, aliases);
    return aliases;
  }

  getConfigState(importerFilePaths: readonly string[]): LocalModuleResolutionConfigState {
    for (const importerFilePath of importerFilePaths) {
      this.getPathAliasesForImporter(importerFilePath);
    }

    return [...this.configTextByPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([configPath, content]) => [configPath, content ?? null] as const);
  }

  private findNearestConfigPath(importerFilePath: string): string | undefined {
    const normalizedImporter = trimLeadingCurrentDir(normalizeFilePath(importerFilePath));
    if (!isProjectLocalPath(normalizedImporter) || normalizedImporter === ".") return undefined;

    let directory = path.posix.dirname(normalizedImporter);
    const visitedDirectories: string[] = [];
    let nearestConfig: string | undefined;

    while (true) {
      if (this.nearestConfigByDirectory.has(directory)) {
        nearestConfig = this.nearestConfigByDirectory.get(directory);
        break;
      }

      visitedDirectories.push(directory);
      for (const configName of ["tsconfig.json", "jsconfig.json"] as const) {
        const candidate = directory === "." ? configName : path.posix.join(directory, configName);
        if (this.loadConfigCached(candidate) !== undefined) {
          nearestConfig = candidate;
          break;
        }
      }
      if (nearestConfig || directory === ".") break;

      const parentDirectory = path.posix.dirname(directory);
      if (parentDirectory === directory) break;
      directory = parentDirectory;
    }

    for (const visitedDirectory of visitedDirectories) {
      this.nearestConfigByDirectory.set(visitedDirectory, nearestConfig);
    }
    return nearestConfig;
  }

  private loadConfigCached(configPath: string): string | undefined {
    const normalized = trimLeadingCurrentDir(normalizeFilePath(configPath));
    if (!isProjectLocalPath(normalized)) return undefined;
    if (this.configTextByPath.has(normalized)) {
      return this.configTextByPath.get(normalized);
    }

    const configText = this.loadConfig(normalized);
    this.configTextByPath.set(normalized, configText);
    return configText;
  }
}

function isProjectLocalPath(candidatePath: string): boolean {
  if (
    path.posix.isAbsolute(candidatePath)
    || /^[A-Za-z]:\//u.test(candidatePath)
    || candidatePath === ".."
    || candidatePath.startsWith("../")
  ) {
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

const MAX_WORKSPACE_EXPORT_PATTERNS = 256;
const MAX_WORKSPACE_EXPORT_PATH_LENGTH = 512;
const MAX_WORKSPACE_PACKAGE_NAME_LENGTH = 214;
const WORKSPACE_PACKAGE_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

function wildcardCount(value: string): number {
  return [...value].filter((char) => char === "*").length;
}

function hasSafePackagePathSegments(value: string): boolean {
  if (
    value.length === 0
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:\//u.test(value)
  ) {
    return false;
  }

  return value.split("/").every((segment) => {
    if (segment === "") return false;

    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return false;
    }

    const normalizedSegment = decodedSegment.toLowerCase();
    return decodedSegment !== ""
      && !decodedSegment.includes("/")
      && !decodedSegment.includes("\\")
      && !decodedSegment.includes("\0")
      && normalizedSegment !== "."
      && normalizedSegment !== ".."
      && normalizedSegment !== "node_modules";
  });
}

function isSafePackageExportPath(value: string, expectedWildcards: 0 | 1): boolean {
  return value.length <= MAX_WORKSPACE_EXPORT_PATH_LENGTH
    && value.startsWith("./")
    && wildcardCount(value) === expectedWildcards
    && hasSafePackagePathSegments(value.slice(2));
}

function isSafeWorkspacePackageName(value: string): boolean {
  if (
    value.length === 0
    || value.length > MAX_WORKSPACE_PACKAGE_NAME_LENGTH
    || value.includes("*")
    || /\s/u.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  if (value.startsWith("@")) {
    return segments.length === 2
      && segments[0].length > 1
      && WORKSPACE_PACKAGE_NAME_SEGMENT.test(segments[0].slice(1))
      && WORKSPACE_PACKAGE_NAME_SEGMENT.test(segments[1]);
  }
  return segments.length === 1 && WORKSPACE_PACKAGE_NAME_SEGMENT.test(segments[0]);
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  if (rootPath === ".") return isProjectLocalPath(candidatePath);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

interface WorkspacePattern {
  pattern: string;
  excluded: boolean;
}

interface WorkspacePatternSelection {
  declared: boolean;
  patterns: readonly WorkspacePattern[];
}

const MAX_WORKSPACE_PATTERNS = 256;
const MAX_WORKSPACE_PATTERN_LENGTH = 256;
const MAX_WORKSPACE_PATTERN_SEGMENTS = 64;
const UNSUPPORTED_WORKSPACE_GLOB_CHARACTERS = new Set(["[", "]", "{", "}", "(", ")", "\0"]);

/**
 * Supported workspace globs are deliberately small and deterministic:
 * `*` and `?` stay within one path segment, while `**` is accepted only as
 * a complete segment. A single leading `!` excludes matching packages.
 * Provably external and node_modules patterns are ignored. Character classes,
 * braces, extglobs, and ambiguous traversal syntax fail the declaration closed.
 */
function normalizeWorkspacePattern(value: unknown): WorkspacePattern | null | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  const excluded = trimmed.startsWith("!");
  const rawPattern = excluded ? trimmed.slice(1).trim() : trimmed;
  if (
    path.posix.isAbsolute(rawPattern)
    || /^[A-Za-z]:\//u.test(rawPattern)
    || rawPattern === ".."
    || rawPattern.startsWith("../")
    || rawPattern.split("/").includes("node_modules")
  ) {
    return null;
  }
  if (
    !rawPattern
    || rawPattern.startsWith("!")
    || rawPattern.length > MAX_WORKSPACE_PATTERN_LENGTH
    || Array.from(rawPattern).some((character) => UNSUPPORTED_WORKSPACE_GLOB_CHARACTERS.has(character))
  ) {
    return undefined;
  }

  const normalized = trimLeadingCurrentDir(rawPattern.replace(/\/{2,}/gu, "/"));
  const segments = normalized.split("/");
  if (
    normalized === "."
    || !isProjectLocalPath(normalized)
    || segments.length > MAX_WORKSPACE_PATTERN_SEGMENTS
    || segments.some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || (segment.includes("**") && segment !== "**")
    )
  ) {
    return undefined;
  }
  return { pattern: normalized, excluded };
}

function rootWorkspacePatterns(manifestText: string | undefined): WorkspacePatternSelection {
  if (manifestText === undefined) return { declared: false, patterns: [] };

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    return { declared: true, patterns: [] };
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { declared: true, patterns: [] };
  }

  const document = manifest as Record<string, unknown>;
  if (!("workspaces" in document)) return { declared: false, patterns: [] };

  const workspaces = document.workspaces;
  const rawPatterns = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)
      ? (workspaces as Record<string, unknown>).packages
      : undefined;
  if (!Array.isArray(rawPatterns) || rawPatterns.length > MAX_WORKSPACE_PATTERNS) {
    return { declared: true, patterns: [] };
  }

  const patterns = rawPatterns.map(normalizeWorkspacePattern);
  if (patterns.some((pattern) => pattern === undefined)) {
    return { declared: true, patterns: [] };
  }
  const supportedPatterns = patterns.filter((pattern): pattern is WorkspacePattern => pattern !== null);
  return {
    declared: true,
    patterns: [...new Map(supportedPatterns.map((pattern) => [
      `${pattern.excluded}:${pattern.pattern}`,
      pattern,
    ])).values()],
  };
}

function workspaceSegmentMatches(candidate: string, pattern: string): boolean {
  let candidateIndex = 0;
  let patternIndex = 0;
  let wildcardIndex = -1;
  let wildcardCandidateIndex = -1;

  while (candidateIndex < candidate.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || pattern[patternIndex] === candidate[candidateIndex])) {
      candidateIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      wildcardIndex = patternIndex;
      wildcardCandidateIndex = candidateIndex;
      patternIndex += 1;
    } else if (wildcardIndex !== -1) {
      patternIndex = wildcardIndex + 1;
      wildcardCandidateIndex += 1;
      candidateIndex = wildcardCandidateIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function workspacePathMatches(candidatePath: string, pattern: string): boolean {
  const candidateSegments = candidatePath.split("/");
  const patternSegments = pattern.split("/");
  const memo = new Map<string, boolean>();

  const matches = (candidateIndex: number, patternIndex: number): boolean => {
    const key = `${candidateIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = candidateIndex === candidateSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      result = matches(candidateIndex, patternIndex + 1)
        || (candidateIndex < candidateSegments.length && matches(candidateIndex + 1, patternIndex));
    } else {
      result = candidateIndex < candidateSegments.length
        && workspaceSegmentMatches(candidateSegments[candidateIndex], patternSegments[patternIndex])
        && matches(candidateIndex + 1, patternIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return matches(0, 0);
}

function isSafeWorkspaceManifestPath(manifestPath: string): boolean {
  const normalized = trimLeadingCurrentDir(normalizeFilePath(manifestPath));
  return isProjectLocalPath(normalized)
    && path.posix.basename(normalized) === "package.json"
    && !normalized.split("/").includes("node_modules");
}

/**
 * Whether a project-local manifest is owned by the root package manager workspace.
 * Nested manifests never contribute workspace patterns. Without a root declaration,
 * ancestor-based discovery remains available for backwards compatibility.
 */
export function isLocalWorkspacePackageManifestPath(
  manifestPath: string,
  rootManifestText: string | undefined,
): boolean {
  const normalized = trimLeadingCurrentDir(normalizeFilePath(manifestPath));
  if (!isSafeWorkspaceManifestPath(normalized)) return false;
  if (normalized === "package.json") return true;

  const selection = rootWorkspacePatterns(rootManifestText);
  if (!selection.declared) return true;

  const packageDirectory = path.posix.dirname(normalized);
  const matchingPatterns = selection.patterns.filter(({ pattern }) =>
    workspacePathMatches(packageDirectory, pattern)
  );
  return matchingPatterns.some(({ excluded }) => !excluded)
    && !matchingPatterns.some(({ excluded }) => excluded);
}

function resolveWorkspacePackageTarget(rootPath: string, target: string): string | undefined {
  if (!isSafePackageExportPath(target, 0)) return undefined;
  const resolved = trimLeadingCurrentDir(normalizeFilePath(path.posix.join(rootPath, target)));
  return isProjectLocalPath(resolved) && isPathWithinRoot(resolved, rootPath) ? resolved : undefined;
}

type PackageExportTargetResolution =
  | { kind: "blocked" | "no-match" | "unsupported" }
  | { kind: "resolved"; target: string };

function isValidPackageConditionName(condition: string): boolean {
  return condition.length > 0
    && !condition.startsWith(".")
    && !condition.includes(",")
    && !/^(?:0|[1-9][0-9]*)$/u.test(condition);
}

function resolveStaticEsmPackageExportTarget(value: unknown): PackageExportTargetResolution {
  if (typeof value === "string") return { kind: "resolved", target: value };
  if (value === null) return { kind: "blocked" };
  if (typeof value !== "object" || Array.isArray(value)) return { kind: "unsupported" };

  const conditions = value as Record<string, unknown>;
  if (!Object.keys(conditions).every(isValidPackageConditionName)) return { kind: "unsupported" };

  // Node resolves the first active condition in declaration order. Static ESM
  // call graphs activate only the built-in node, import, and default branches.
  for (const [condition, target] of Object.entries(conditions)) {
    if (!STATIC_ESM_EXPORT_CONDITIONS.has(condition)) continue;
    const resolution = resolveStaticEsmPackageExportTarget(target);
    if (resolution.kind !== "no-match") return resolution;
  }
  return { kind: "no-match" };
}

function comparePackageExportPatterns(
  left: LocalWorkspacePackageExportPattern,
  right: LocalWorkspacePackageExportPattern,
): number {
  const leftWildcard = left.specifierPath.indexOf("*");
  const rightWildcard = right.specifierPath.indexOf("*");
  const leftBaseLength = leftWildcard === -1 ? left.specifierPath.length : leftWildcard + 1;
  const rightBaseLength = rightWildcard === -1 ? right.specifierPath.length : rightWildcard + 1;
  return rightBaseLength - leftBaseLength
    || right.specifierPath.length - left.specifierPath.length;
}

function matchPackageExportPattern(specifierPath: string, pattern: string): string | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1 || wildcard !== pattern.lastIndexOf("*")) return undefined;

  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (
    specifierPath.length < prefix.length + suffix.length
    || !specifierPath.startsWith(prefix)
    || !specifierPath.endsWith(suffix)
  ) {
    return undefined;
  }
  return specifierPath.slice(prefix.length, specifierPath.length - suffix.length);
}

/**
 * Parses only source-facing, project-local package metadata. It deliberately
 * excludes package-manager lookup and arbitrary export conditions so callers
 * never resolve a graph edge through node_modules or an unsafe path.
 */
export function parseLocalWorkspacePackage(
  manifestPath: string,
  manifestText: string | undefined,
): LocalWorkspacePackage | undefined {
  if (manifestText === undefined) return undefined;

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;

  const document = manifest as Record<string, unknown>;
  const name = typeof document.name === "string" ? document.name.trim() : "";
  const manifestPathWithoutCurrentDir = trimLeadingCurrentDir(manifestPath);
  if (!hasSafePackagePathSegments(manifestPathWithoutCurrentDir)) return undefined;
  const normalizedManifestPath = trimLeadingCurrentDir(normalizeFilePath(manifestPathWithoutCurrentDir));
  if (
    !isSafeWorkspacePackageName(name)
    || !isProjectLocalPath(normalizedManifestPath)
    || path.posix.basename(normalizedManifestPath) !== "package.json"
  ) {
    return undefined;
  }

  const rootPath = path.posix.dirname(normalizedManifestPath);
  const entryPoints = new Map<string, readonly string[]>();
  const exportPatterns: LocalWorkspacePackageExportPattern[] = [];
  let exportPatternsOverflowed = false;
  const addEntryPoint = (specifierPath: string, value: unknown, preserveDeclaration = false): void => {
    const resolution = resolveStaticEsmPackageExportTarget(value);
    const target = resolution.kind === "resolved"
      ? resolveWorkspacePackageTarget(rootPath, resolution.target)
      : undefined;
    if (target !== undefined) {
      entryPoints.set(specifierPath, [target]);
    } else if (preserveDeclaration) {
      entryPoints.set(specifierPath, []);
    }
  };
  const addExportPattern = (specifierPath: string, value: unknown): void => {
    if (!isSafePackageExportPath(specifierPath, 1)) return;
    if (exportPatterns.length >= MAX_WORKSPACE_EXPORT_PATTERNS) {
      exportPatternsOverflowed = true;
      return;
    }

    const resolution = resolveStaticEsmPackageExportTarget(value);
    exportPatterns.push({
      specifierPath,
      targets: resolution.kind === "resolved" && isSafePackageExportPath(resolution.target, 1)
        ? [resolution.target]
        : [],
    });
  };

  const hasExports = Object.hasOwn(document, "exports");
  const exportsValue = document.exports;
  let restrictsSubpaths = false;
  if (hasExports) {
    restrictsSubpaths = true;
    if (typeof exportsValue === "string") {
      addEntryPoint(".", exportsValue, true);
    } else if (typeof exportsValue === "object" && exportsValue !== null && !Array.isArray(exportsValue)) {
      const exportMap = exportsValue as Record<string, unknown>;
      const keys = Object.keys(exportMap);
      const hasSubpathKeys = keys.some((key) => key.startsWith("."));
      const hasConditionKeys = keys.some((key) => !key.startsWith("."));
      const hasInvalidSubpathKeys = keys.some((key) => key.startsWith(".")
        && key !== "."
        && !key.startsWith("./"));
      if (!hasInvalidSubpathKeys && !(hasSubpathKeys && hasConditionKeys)) {
        if (hasSubpathKeys) {
          for (const [specifierPath, target] of Object.entries(exportMap)) {
            if (specifierPath === "." || isSafePackageExportPath(specifierPath, 0)) {
              addEntryPoint(specifierPath, target, true);
            } else if (isSafePackageExportPath(specifierPath, 1)) {
              addExportPattern(specifierPath, target);
            }
          }
        } else {
          addEntryPoint(".", exportsValue, true);
        }
      }
    }
  }

  if (!hasExports && !entryPoints.has(".")) {
    for (const field of ["types", "module", "main"] as const) {
      if (typeof document[field] === "string") addEntryPoint(".", document[field]);
    }
  }

  return {
    name,
    rootPath,
    entryPoints,
    exportPatterns: exportPatternsOverflowed ? [] : exportPatterns.sort(comparePackageExportPatterns),
    restrictsSubpaths,
  };
}

/**
 * Discovers package manifests only on ancestor paths of indexed source files,
 * then applies root-owned package-manager workspace patterns when declared.
 * This is bounded by known project sources and never scans node_modules.
 */
export function getLocalWorkspacePackageManifestPaths(
  importerFilePaths: readonly string[],
  loadManifest: (manifestPath: string) => string | undefined,
): readonly string[] {
  const manifestPaths = new Set<string>();
  for (const importerFilePath of importerFilePaths) {
    const normalized = trimLeadingCurrentDir(normalizeFilePath(importerFilePath));
    if (
      !isProjectLocalPath(normalized)
      || normalized === "."
      || normalized.split("/").includes("node_modules")
    ) {
      continue;
    }

    let directory = path.posix.dirname(normalized);
    while (true) {
      const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
      if (isSafeWorkspaceManifestPath(manifestPath)) manifestPaths.add(manifestPath);
      if (directory === ".") break;
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  const rootManifestText = loadManifest("package.json");
  return [...manifestPaths]
    .filter((manifestPath) => isLocalWorkspacePackageManifestPath(manifestPath, rootManifestText))
    .sort();
}

export function getLocalWorkspacePackages(
  importerFilePaths: readonly string[],
  loadManifest: (manifestPath: string) => string | undefined,
): readonly LocalWorkspacePackage[] {
  return getLocalWorkspacePackageManifestPaths(importerFilePaths, loadManifest)
    .map((manifestPath) => parseLocalWorkspacePackage(manifestPath, loadManifest(manifestPath)))
    .filter((workspacePackage): workspacePackage is LocalWorkspacePackage => workspacePackage !== undefined);
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
  private readonly tsConfigPathAliases?: LocalModulePathAliases;
  private readonly pathAliasesForImporter?: LocalModuleResolverOptions["pathAliasesForImporter"];
  private readonly workspacePackages = new Map<string, LocalWorkspacePackage | null>();

  constructor(options: LocalModuleResolverOptions) {
    for (const filePath of options.filePaths) {
      const normalized = normalizeFilePath(filePath);
      if (isJavaScriptFamilyFilePath(normalized)) this.modulePaths.add(normalized);
    }
    this.loadModule = options.loadModule;
    this.tsConfigPathAliases = options.tsConfigPathAliases;
    this.pathAliasesForImporter = options.pathAliasesForImporter;
    for (const workspacePackage of options.workspacePackages ?? []) {
      const existing = this.workspacePackages.get(workspacePackage.name);
      this.workspacePackages.set(workspacePackage.name, existing === undefined ? workspacePackage : null);
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

    const pathAliases = this.pathAliasesForImporter
      ? this.pathAliasesForImporter(importerFilePath)
      : this.tsConfigPathAliases;
    const aliasCandidates = this.resolveModuleSpecifierFromAliases(specifier, pathAliases);
    if (aliasCandidates !== undefined) {
      return aliasCandidates;
    }

    return this.resolveModuleSpecifierFromWorkspacePackage(specifier);
  }

  private resolveModuleSpecifierFromWorkspacePackage(specifier: string): string[] {
    const packageNames = [...this.workspacePackages.keys()]
      .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length || left.localeCompare(right));
    const packageName = packageNames[0];
    if (!packageName) return [];

    const workspacePackage = this.workspacePackages.get(packageName);
    if (!workspacePackage) return [];

    const suffix = specifier.slice(packageName.length);
    const exportPath = suffix.length === 0 ? "." : `.${suffix}`;
    if (exportPath !== "." && !isSafePackageExportPath(exportPath, 0)) return [];

    if (workspacePackage.entryPoints.has(exportPath)) {
      const entryPoints = workspacePackage.entryPoints.get(exportPath) ?? [];
      return [...new Set(entryPoints.flatMap((entryPoint) => this.resolveModuleCandidates(entryPoint)))].sort();
    }

    const matchedPattern = workspacePackage.exportPatterns
      .map((exportPattern) => ({
        exportPattern,
        wildcard: matchPackageExportPattern(exportPath, exportPattern.specifierPath),
      }))
      .find((match) => match.wildcard !== undefined);
    if (matchedPattern?.wildcard !== undefined) {
      const wildcard = matchedPattern.wildcard;
      const targets = matchedPattern.exportPattern.targets.flatMap((targetPattern) => {
        const target = resolveWorkspacePackageTarget(
          workspacePackage.rootPath,
          this.replaceWildcard(targetPattern, wildcard),
        );
        return target ? this.resolveModuleCandidates(target) : [];
      });
      return [...new Set(targets)].sort();
    }
    if (workspacePackage.restrictsSubpaths) return [];
    if (suffix.length === 0) return [];

    return this.resolveModuleCandidates(path.posix.join(workspacePackage.rootPath, suffix));
  }

  private resolveModuleSpecifierFromAliases(
    specifier: string,
    pathAliases: LocalModulePathAliases | undefined,
  ): string[] | undefined {
    if (!pathAliases || pathAliases.aliases.length === 0) return undefined;

    const matchedAliasTargets = new Set<string>();
    let anyAliasMatched = false;

    for (const alias of pathAliases.aliases) {
      const wildcard = this.matchPathAliasPattern(specifier, alias.pattern);
      if (wildcard === undefined) {
        continue;
      }
      anyAliasMatched = true;

      for (const targetPattern of alias.targets) {
        const target = this.replaceWildcard(targetPattern, wildcard);
        const rawPath = normalizeFilePath(path.posix.join(alias.baseUrl ?? pathAliases.baseUrl, target));
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
