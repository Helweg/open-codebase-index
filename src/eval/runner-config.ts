import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { getDefaultModelForProvider } from "../config/index.js";
import { getGlobalIndexPath, resolveProjectConfigPath, resolveProjectIndexPath } from "../config/paths.js";
import { rebasePathEntries, resolveInheritedKnowledgeBaseEntries } from "../config/rebase.js";
import { parseConfig, type SearchConfig as ConfigSearchConfig } from "../config/schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateEvalConfigShape(rawConfig: unknown, filePath: string): Record<string, unknown> {
  if (!isRecord(rawConfig)) {
    throw new Error(`Eval config at ${filePath} must contain a JSON object at the root.`);
  }

  const config = rawConfig;

  if (config.knowledgeBases !== undefined && !isStringArray(config.knowledgeBases)) {
    throw new Error(`Eval config at ${filePath} field 'knowledgeBases' must be an array of strings.`);
  }
  if (config.additionalInclude !== undefined && !isStringArray(config.additionalInclude)) {
    throw new Error(`Eval config at ${filePath} field 'additionalInclude' must be an array of strings.`);
  }
  if (config.include !== undefined && !isStringArray(config.include)) {
    throw new Error(`Eval config at ${filePath} field 'include' must be an array of strings.`);
  }
  if (config.exclude !== undefined && !isStringArray(config.exclude)) {
    throw new Error(`Eval config at ${filePath} field 'exclude' must be an array of strings.`);
  }

  for (const section of ["customProvider", "indexing", "search", "debug", "reranker"] as const) {
    const value = config[section];
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`Eval config at ${filePath} field '${section}' must be an object.`);
    }
  }

  return config;
}

function parseJsonConfigFile(filePath: string): unknown {
  try {
    return validateEvalConfigShape(JSON.parse(readFileSync(filePath, "utf-8")), filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Eval config at ")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse eval config JSON at ${filePath}: ${message}`);
  }
}

export function toAbsolute(projectRoot: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(projectRoot, maybeRelative);
}

function isProjectScopedConfigPath(configPath: string): boolean {
  return path.basename(configPath) === "codebase-index.json"
    && path.basename(path.dirname(configPath)) === ".opencode";
}

function normalizeEvalConfigKnowledgeBases(
  rawConfig: unknown,
  projectRoot: string,
  resolvedConfigPath: string,
): Record<string, unknown> {
  const config = rawConfig && typeof rawConfig === "object"
    ? { ...(rawConfig as Record<string, unknown>) }
    : {};

  const rebaseEntries = (values: unknown): string[] => isProjectScopedConfigPath(resolvedConfigPath)
    ? resolveInheritedKnowledgeBaseEntries(
        values,
        path.dirname(path.dirname(resolvedConfigPath)),
        projectRoot,
      )
    : rebasePathEntries(
        values,
        path.dirname(resolvedConfigPath),
        projectRoot,
      );

  if (Array.isArray(config.knowledgeBases)) {
    config.knowledgeBases = rebaseEntries(config.knowledgeBases);
  }

  if (Array.isArray(config.additionalInclude)) {
    config.additionalInclude = rebaseEntries(config.additionalInclude);
  }

  return config;
}

function loadRawConfig(projectRoot: string, configPath?: string): unknown {
  const fromPath = configPath ? toAbsolute(projectRoot, configPath) : null;
  if (fromPath && existsSync(fromPath)) {
    return normalizeEvalConfigKnowledgeBases(
      parseJsonConfigFile(fromPath),
      projectRoot,
      fromPath,
    );
  }

  const projectConfig = resolveProjectConfigPath(projectRoot, "opencode");
  if (existsSync(projectConfig)) {
    return normalizeEvalConfigKnowledgeBases(
      parseJsonConfigFile(projectConfig),
      projectRoot,
      projectConfig,
    );
  }

  const globalConfig = path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
  if (existsSync(globalConfig)) {
    return parseJsonConfigFile(globalConfig);
  }

  return {};
}

function getIndexRootPath(projectRoot: string, scope: "project" | "global"): string {
  return scope === "global"
    ? getGlobalIndexPath("opencode")
    : resolveProjectIndexPath(projectRoot, scope, "opencode");
}

function getLocalProjectIndexRoot(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", "index");
}

function getLocalProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", "codebase-index.json");
}

export function clearIndexRoot(projectRoot: string, scope: "project" | "global"): void {
  const indexRoot = scope === "global"
    ? getIndexRootPath(projectRoot, scope)
    : getLocalProjectIndexRoot(projectRoot);
  if (existsSync(indexRoot)) {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

export function ensureLocalEvalProjectConfig(projectRoot: string, configPath?: string): string | undefined {
  const localConfigPath = getLocalProjectConfigPath(projectRoot);
  const resolvedConfigPath = configPath
    ? toAbsolute(projectRoot, configPath)
    : resolveProjectConfigPath(projectRoot, "opencode");

  if (!configPath && existsSync(localConfigPath)) {
    return localConfigPath;
  }

  if (!existsSync(resolvedConfigPath) || resolvedConfigPath === localConfigPath) {
    return resolvedConfigPath;
  }

  const sourceConfig = normalizeEvalConfigKnowledgeBases(
    parseJsonConfigFile(resolvedConfigPath),
    projectRoot,
    resolvedConfigPath,
  );

  mkdirSync(path.dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, JSON.stringify(sourceConfig, null, 2), "utf-8");
  return localConfigPath;
}

export function loadParsedConfig(projectRoot: string, configPath?: string): ReturnType<typeof parseConfig> {
  const raw = loadRawConfig(projectRoot, configPath);
  return parseConfig(raw);
}

export function resolveSearchConfig(
  parsedConfig: ReturnType<typeof parseConfig>,
  overrides?: Partial<Pick<ConfigSearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">>
): ReturnType<typeof parseConfig> {
  const nextSearch: ConfigSearchConfig = {
    ...parsedConfig.search,
  };

  if (overrides?.fusionStrategy !== undefined) {
    nextSearch.fusionStrategy = overrides.fusionStrategy;
  }
  if (overrides?.hybridWeight !== undefined) {
    nextSearch.hybridWeight = overrides.hybridWeight;
  }
  if (overrides?.rrfK !== undefined) {
    nextSearch.rrfK = overrides.rrfK;
  }
  if (overrides?.rerankTopN !== undefined) {
    nextSearch.rerankTopN = overrides.rerankTopN;
  }

  return {
    ...parsedConfig,
    search: nextSearch,
  };
}

export function getEmbeddingCostPer1MTokens(
  embeddingProvider: ReturnType<typeof parseConfig>["embeddingProvider"],
): number {
  return embeddingProvider === "custom" || embeddingProvider === "auto"
    ? 0
    : getDefaultModelForProvider(embeddingProvider).costPer1MTokens;
}
