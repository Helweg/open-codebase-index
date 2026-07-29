import { existsSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";

import { loadMergedConfig, loadProjectConfigLayer } from "../config/merger.js";
import { resolveWritableProjectConfigPath } from "../config/paths.js";
import { resolveConfigPathValue, serializeConfigPathValue } from "./knowledge-base-paths.js";
import type { HostMode } from "../config/host.js";

function normalizeKnowledgeBasePaths(
  config: Record<string, unknown>,
  projectRoot: string,
): Record<string, unknown> {
  const normalized = { ...config };

  if (Array.isArray(normalized.knowledgeBases)) {
    normalized.knowledgeBases = (normalized.knowledgeBases as string[]).map((kb) =>
      resolveConfigPathValue(kb, projectRoot)
    );
  }

  return normalized;
}

function toConfigRecord(rawConfig: unknown): Record<string, unknown> {
  if (!rawConfig || typeof rawConfig !== "object") {
    return {};
  }

  return { ...(rawConfig as Record<string, unknown>) };
}

export function getConfigPath(projectRoot: string, host: HostMode): string {
  return resolveWritableProjectConfigPath(projectRoot, host);
}

export function loadRuntimeConfig(projectRoot: string, host: HostMode): Record<string, unknown> {
  return normalizeKnowledgeBasePaths(toConfigRecord(loadMergedConfig(projectRoot, host)), projectRoot);
}

export function loadEditableConfig(projectRoot: string, host: HostMode): Record<string, unknown> {
  return normalizeKnowledgeBasePaths(toConfigRecord(loadProjectConfigLayer(projectRoot, host)), projectRoot);
}

export function saveConfig(projectRoot: string, config: Record<string, unknown>, host: HostMode): void {
  const configPath = getConfigPath(projectRoot, host);
  const configDir = path.dirname(configPath);
  const configBaseDir = path.dirname(configDir);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const serializableConfig: Record<string, unknown> = { ...config };

  if (Array.isArray(serializableConfig.knowledgeBases)) {
    serializableConfig.knowledgeBases = (serializableConfig.knowledgeBases as string[]).map((kb) =>
      serializeConfigPathValue(kb, configBaseDir)
    );
  }

  writeFileSync(configPath, JSON.stringify(serializableConfig, null, 2) + "\n", "utf-8");
}
