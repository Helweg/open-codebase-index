import type {
  EmbeddingProvider,
  IndexScope,
  LogLevel,
  ProviderModels,
  RerankerProvider,
  SearchConfig,
} from "./schema.js";

import { EMBEDDING_MODELS } from "./constants.js";
import { substituteEnvString } from "./env-substitution.js";

const VALID_SCOPES: IndexScope[] = ["project", "global"];
const VALID_LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

export function isValidFusionStrategy(value: unknown): value is SearchConfig["fusionStrategy"] {
  return value === "weighted" || value === "rrf";
}

export function isValidRerankerProvider(value: unknown): value is RerankerProvider {
  return value === "cohere" || value === "jina" || value === "custom";
}

export function isValidProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === "string" && Object.keys(EMBEDDING_MODELS).includes(value);
}

export function isValidModel<P extends EmbeddingProvider>(
  value: unknown,
  provider: P
): value is ProviderModels[P] {
  // For ollama, accept any model string — users can run any model locally.
  // The hardcoded catalog is for defaults only, not for restricting user choice.
  if (typeof value === "string" && provider === "ollama" && value.length > 0) {
    return true;
  }
  return typeof value === "string" && Object.keys(EMBEDDING_MODELS[provider]).includes(value);
}

export function isValidScope(value: unknown): value is IndexScope {
  return typeof value === "string" && VALID_SCOPES.includes(value as IndexScope);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function getResolvedString(value: unknown, keyPath: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return substituteEnvString(value, keyPath);
}

export function getResolvedStringArray(value: unknown, keyPath: string): string[] | undefined {
  if (!isStringArray(value)) {
    return undefined;
  }

  return value.map((item, index) => substituteEnvString(item, `${keyPath}[${index}]`));
}

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevel);
}
