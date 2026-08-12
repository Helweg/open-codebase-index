import { type EmbeddingProvider, type CustomProviderConfig, type BaseModelInfo, type EmbeddingProviderModelInfo, getDefaultModelForProvider, isValidModel, autoDetectProviders, EmbeddingModelName, EMBEDDING_MODELS } from "../config";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";

export interface ProviderCredentials {
  provider: EmbeddingProvider | 'custom';
  apiKey?: string;
  baseUrl?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpires?: number;
}

export interface CustomModelInfo extends BaseModelInfo {
  provider: 'custom';
  timeoutMs: number;
  maxBatchSize?: number;
}

export type ConfiguredProviderInfo = {
  [P in EmbeddingProvider]: {
    provider: P;
    credentials: ProviderCredentials;
    modelInfo: EmbeddingProviderModelInfo[P];
  }
}[EmbeddingProvider] | {
  provider: 'custom';
  credentials: ProviderCredentials;
  modelInfo: CustomModelInfo;
}

interface OpenCodeAuthAPI {
  type: "api";
  key: string;
}

type OpenCodeAuth = OpenCodeAuthAPI;

function getOpenCodeAuthPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function loadOpenCodeAuth(): Record<string, OpenCodeAuth> {
  const authPath = getOpenCodeAuthPath();
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {
    // Ignore auth file read errors
  }
  return {};
}

export async function detectEmbeddingProvider(
  preferredProvider: EmbeddingProvider, model?: EmbeddingModelName
): Promise<ConfiguredProviderInfo> {
  if (preferredProvider === "ollama") {
    return detectOllamaProvider(model);
  }

  const credentials = await getProviderCredentials(preferredProvider);
  if (credentials) {
    if (!model) {
      return {
        provider: preferredProvider,
        credentials,
        modelInfo: getDefaultModelForProvider(preferredProvider),
      } as ConfiguredProviderInfo;
    }
    if (!isValidModel(model, preferredProvider)) {
      throw new Error(
        `Model '${model}' is not supported by provider '${preferredProvider}'`
      );
    }
    const providerModels = EMBEDDING_MODELS[preferredProvider];
    const modelInfo = Object.values(providerModels).find((candidate) => candidate.model === model);
    if (!modelInfo) {
      throw new Error(
        `Model '${model}' is not supported by provider '${preferredProvider}'`
      );
    }
    return {
      provider: preferredProvider,
      credentials,
      modelInfo,
    } as ConfiguredProviderInfo;
  }
  throw new Error(
    `Preferred provider '${preferredProvider}' is not configured or authenticated`
  );
}

export async function tryDetectProvider(): Promise<ConfiguredProviderInfo> {
  for (const provider of autoDetectProviders) {
    if (provider === "ollama") {
      const ollamaProvider = await tryDetectOllamaProvider();
      if (ollamaProvider) {
        return ollamaProvider;
      }
      continue;
    }

    const credentials = await getProviderCredentials(provider);
    if (credentials) {
      return {
        provider,
        credentials,
        modelInfo: getDefaultModelForProvider(provider),
      } as ConfiguredProviderInfo;
    }
  }

  throw new Error(
    `No embedding-capable provider found. Please authenticate with OpenCode using one of: ${autoDetectProviders.join(", ")}.`
  );
}

async function getProviderCredentials(
  provider: EmbeddingProvider
): Promise<ProviderCredentials | null> {
  switch (provider) {
    case "openai":
      return getOpenAICredentials();
    case "google":
      return getGoogleCredentials();
    case "ollama":
      return getOllamaCredentials();
    default:
      return null;
  }
}


function getOpenAICredentials(): ProviderCredentials | null {
  const authData = loadOpenCodeAuth();
  const openaiAuth = authData["openai"];

  if (openaiAuth?.type === "api") {
    return {
      provider: "openai",
      apiKey: openaiAuth.key,
      baseUrl: "https://api.openai.com/v1",
    };
  }

  return null;
}

function getGoogleCredentials(): ProviderCredentials | null {
  const authData = loadOpenCodeAuth();
  const googleAuth = authData["google"] || authData["google-generative-ai"];

  if (googleAuth?.type === "api") {
    return {
      provider: "google",
      apiKey: googleAuth.key,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    };
  }

  return null;
}

async function fetchOllama(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getOllamaCredentials(): Promise<ProviderCredentials | null> {
  const baseUrl = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");

  try {
    const response = await fetchOllama(`${baseUrl}/api/tags`);

    if (response.ok) {
      return {
        provider: "ollama",
        baseUrl,
      };
    }
  } catch {
    return null;
  }

  return null;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

function findCatalogOllamaModel(
  model: string,
): EmbeddingProviderModelInfo["ollama"] | null {
  const stableName = model.endsWith(":latest")
    ? model.slice(0, -":latest".length)
    : model;
  return Object.values(EMBEDDING_MODELS.ollama)
    .find((candidate) => candidate.model === stableName) ?? null;
}

function getPositiveIntegerMetadata(
  modelInfo: Record<string, unknown>,
  suffix: string,
): number | null {
  const values = Object.entries(modelInfo)
    .filter(([key]) => key.endsWith(suffix))
    .map(([, value]) => value)
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);

  return values.length === 1 ? values[0] : null;
}

async function fetchOllamaModelInfo(
  credentials: ProviderCredentials,
  model: string,
): Promise<EmbeddingProviderModelInfo["ollama"] | null> {
  const response = await fetchOllama(`${credentials.baseUrl}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    return null;
  }

  const data = await response.json() as OllamaShowResponse;
  if (!data.capabilities?.includes("embedding") || !data.model_info) {
    return null;
  }

  const dimensions = getPositiveIntegerMetadata(data.model_info, ".embedding_length");
  const maxTokens = getPositiveIntegerMetadata(data.model_info, ".context_length");
  if (!dimensions || !maxTokens) {
    return null;
  }

  return {
    provider: "ollama",
    model,
    dimensions,
    maxTokens,
    costPer1MTokens: 0,
  };
}

async function listOllamaModels(credentials: ProviderCredentials): Promise<string[]> {
  const response = await fetchOllama(`${credentials.baseUrl}/api/tags`);
  if (!response.ok) {
    return [];
  }

  const data = await response.json() as OllamaTagsResponse;
  return [...new Set((data.models ?? [])
    .map((entry) => entry.name ?? entry.model)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0))];
}

async function detectOllamaProvider(model?: string): Promise<ConfiguredProviderInfo> {
  const credentials = await getOllamaCredentials();
  if (!credentials) {
    throw new Error("Preferred provider 'ollama' is not configured or authenticated");
  }

  const requestedModel = model?.trim();
  if (requestedModel) {
    const catalogModel = findCatalogOllamaModel(requestedModel);
    if (catalogModel) {
      return { provider: "ollama", credentials, modelInfo: catalogModel };
    }
  }

  const candidates = requestedModel
    ? [requestedModel]
    : await listOllamaModels(credentials);
  for (const candidate of candidates) {
    const modelInfo = await fetchOllamaModelInfo(credentials, candidate);
    if (modelInfo) {
      return {
        provider: "ollama",
        credentials,
        modelInfo: findCatalogOllamaModel(candidate) ?? modelInfo,
      };
    }
  }

  const detail = model
    ? `Model '${model}' is not installed or is not embedding-capable`
    : "No installed embedding-capable Ollama model was found";
  throw new Error(detail);
}

async function tryDetectOllamaProvider(): Promise<ConfiguredProviderInfo | null> {
  try {
    return await detectOllamaProvider();
  } catch {
    return null;
  }
}

export function getProviderDisplayName(provider: EmbeddingProvider | 'custom'): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "google":
      return "Google (Gemini)";
    case "ollama":
      return "Ollama (Local)";
    case "custom":
      return "Custom (OpenAI-compatible)";
    default:
      return provider;
  }
}

export function createCustomProviderInfo(config: CustomProviderConfig): ConfiguredProviderInfo {
  // Normalize baseUrl defensively — parseConfig() already strips trailing slashes,
  // but direct callers (e.g. tests) may pass unnormalized URLs.
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  return {
    provider: 'custom',
    credentials: {
      provider: 'custom',
      baseUrl,
      apiKey: config.apiKey,
    },
    modelInfo: {
      provider: 'custom',
      model: config.model,
      dimensions: config.dimensions,
      maxTokens: config.maxTokens ?? 8192,
      costPer1MTokens: 0,
      timeoutMs: config.timeoutMs ?? 30_000,
      maxBatchSize: config.maxBatchSize,
    },
  };
}
