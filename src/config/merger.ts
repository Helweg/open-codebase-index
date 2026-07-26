import { existsSync, readFileSync } from "fs";
import * as path from "path";

import { resolveGlobalConfigPath, resolveProjectConfigPath } from "./paths.js";
import type { HostMode } from "./host.js";
import { resolveInheritedKnowledgeBaseEntries } from "./rebase.js";

const PROJECT_OVERRIDE_KEYS = [
  "embeddingProvider",
  "customProvider",
  "embeddingModel",
  "reranker",
  "include",
  "exclude",
  "indexing",
  "search",
  "debug",
  "scope",
] as const;

const MERGE_ARRAY_KEYS = ["knowledgeBases", "additionalInclude"] as const;

type ProjectOverrideKey = (typeof PROJECT_OVERRIDE_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function applyProjectOverride(
  merged: Record<string, unknown>,
  normalizedProjectConfig: Record<string, unknown>,
  globalConfig: Record<string, unknown>,
  key: ProjectOverrideKey,
): void {
  if (key in normalizedProjectConfig) {
    merged[key] = normalizedProjectConfig[key];
    return;
  }

  if (key in globalConfig) {
    merged[key] = globalConfig[key];
  }
}

function mergeUniqueStringArray(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()))];
}

function normalizeKnowledgeBasePath(value: unknown): string {
  let normalized = path.normalize(String(value).trim());
  const root = path.parse(normalized).root;

  while (normalized.length > root.length && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function mergeKnowledgeBasePaths(values: unknown[]): string[] {
  return [...new Set(values.map((value) => normalizeKnowledgeBasePath(value)).filter((value) => value.length > 0))];
}

function validateConfigLayerShape(rawConfig: unknown, filePath: string): Record<string, unknown> {
  if (!isRecord(rawConfig)) {
    throw new Error(`Config file ${filePath} must contain a JSON object at the root.`);
  }

  if (rawConfig.knowledgeBases !== undefined && !isStringArray(rawConfig.knowledgeBases)) {
    throw new Error(`Config file ${filePath} field 'knowledgeBases' must be an array of strings.`);
  }
  if (rawConfig.additionalInclude !== undefined && !isStringArray(rawConfig.additionalInclude)) {
    throw new Error(`Config file ${filePath} field 'additionalInclude' must be an array of strings.`);
  }
  if (rawConfig.include !== undefined && !isStringArray(rawConfig.include)) {
    throw new Error(`Config file ${filePath} field 'include' must be an array of strings.`);
  }
  if (rawConfig.exclude !== undefined && !isStringArray(rawConfig.exclude)) {
    throw new Error(`Config file ${filePath} field 'exclude' must be an array of strings.`);
  }

  for (const section of ["customProvider", "indexing", "search", "debug", "reranker"] as const) {
    const value = rawConfig[section];
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`Config file ${filePath} field '${section}' must be an object.`);
    }
  }

  return rawConfig;
}

function loadJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return validateConfigLayerShape(JSON.parse(content), filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Config file ")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file ${filePath}: ${message}`);
  }

}

export function loadConfigFile(filePath: string): unknown {
  return loadJsonFile(filePath);
}

export function loadProjectConfigLayer(projectRoot: string, host: HostMode = "opencode"): Record<string, unknown> {
  const projectConfigPath = resolveProjectConfigPath(projectRoot, host);
  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;

  if (!projectConfig) {
    return {};
  }

  const normalizedConfig: Record<string, unknown> = { ...projectConfig };
  const projectConfigBaseDir = path.dirname(path.dirname(projectConfigPath));

  if (Array.isArray(normalizedConfig.knowledgeBases)) {
    normalizedConfig.knowledgeBases = resolveInheritedKnowledgeBaseEntries(
      normalizedConfig.knowledgeBases,
      projectConfigBaseDir,
      projectRoot,
    );
  }

  return normalizedConfig;
}

/**
 * Loads and merges global and project configs.
 * 
 * Merge rules:
 * - Global config is the base
 * - For most fields: project overrides global if set, otherwise load global (fallback)
 * - For knowledgeBases: merge arrays (union, deduplicated)
 * - For additionalInclude: merge arrays (union, deduplicated)
 * - For include/exclude: project overrides global if set, otherwise load global
 */
export function loadMergedConfig(projectRoot: string, host: HostMode = "opencode"): unknown {
  const globalConfigPath = resolveGlobalConfigPath(host);
  const projectConfigPath = resolveProjectConfigPath(projectRoot, host);
  let globalConfig: Record<string, unknown> | null = null;
  let globalConfigError: Error | null = null;

  try {
    globalConfig = loadJsonFile(globalConfigPath) as Record<string, unknown> | null;
  } catch (error: unknown) {
    globalConfigError = error instanceof Error ? error : new Error(String(error));
  }

  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;
  const normalizedProjectConfig = loadProjectConfigLayer(projectRoot, host);

  if (globalConfigError) {
    if (!projectConfig) {
      throw globalConfigError;
    }
    globalConfig = null;
  }

  if (!globalConfig && !projectConfig) {
    return {};
  }

  if (!projectConfig && globalConfig) {
    return globalConfig;
  }

  if (!globalConfig && projectConfig) {
    return normalizedProjectConfig;
  }

  if (!globalConfig || !projectConfig) {
    return globalConfig ?? normalizedProjectConfig;
  }


  const merged: Record<string, unknown> = { ...globalConfig };

  for (const key of PROJECT_OVERRIDE_KEYS) {
    applyProjectOverride(merged, normalizedProjectConfig, globalConfig, key);
  }

  // For other config sections: project overrides if set, otherwise use global
  if (projectConfig) {
    for (const key of Object.keys(projectConfig)) {
      if (
        PROJECT_OVERRIDE_KEYS.includes(key as ProjectOverrideKey) ||
        MERGE_ARRAY_KEYS.includes(key as (typeof MERGE_ARRAY_KEYS)[number])
      ) {
        continue; // Already handled above
      }
      merged[key] = normalizedProjectConfig[key];
    }
  }

  // For knowledgeBases: merge arrays (union, deduplicated)
  const globalKbs = globalConfig && Array.isArray(globalConfig.knowledgeBases) ? globalConfig.knowledgeBases : [];
  const projectKbs = projectConfig
    ? (Array.isArray(normalizedProjectConfig.knowledgeBases) ? normalizedProjectConfig.knowledgeBases as string[] : [])
    : [];
  const allKbs = [...globalKbs, ...projectKbs];
  merged.knowledgeBases = mergeKnowledgeBasePaths(allKbs);

  // For additionalInclude: merge arrays (union, deduplicated)
  const globalAdditional = globalConfig && Array.isArray(globalConfig.additionalInclude) ? globalConfig.additionalInclude : [];
  const projectAdditional = projectConfig && Array.isArray(projectConfig.additionalInclude) ? projectConfig.additionalInclude : [];
  const allAdditional = [...globalAdditional, ...projectAdditional];
  merged.additionalInclude = mergeUniqueStringArray(allAdditional);

  return merged;
}
