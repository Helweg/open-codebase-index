import { type EmbeddingProvider, type CustomProviderConfig, type BaseModelInfo, getDefaultModelForProvider, isValidModel, autoDetectProviders, EmbeddingModelName, EMBEDDING_MODELS } from "../config";
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
    modelInfo: (typeof EMBEDDING_MODELS)[P][keyof (typeof EMBEDDING_MODELS)[P]];
  }
}[EmbeddingProvider] | {
  provider: 'custom';
  credentials: ProviderCredentials;
  modelInfo: CustomModelInfo;
}

interface OpenCodeAuthOAuth {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  enterpriseUrl?: string;
}

interface OpenCodeAuthAPI {
  type: "api";
  key: string;
}

type OpenCodeAuth = OpenCodeAuthOAuth | OpenCodeAuthAPI;

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

export async function detectEmbeddingProvider<P extends EmbeddingProvider>(
  preferredProvider: P, model?: EmbeddingModelName
): Promise<ConfiguredProviderInfo> {
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
    return {
      provider: preferredProvider,
      credentials,
      modelInfo: providerModels[model],
    } as ConfiguredProviderInfo;
  }
  throw new Error(
    `Preferred provider '${preferredProvider}' is not configured or authenticated`
  );
}

export async function tryDetectProvider(): Promise<ConfiguredProviderInfo> {
  for (const provider of autoDetectProviders) {
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
    case "github-copilot":
      return getGitHubCopilotCredentials();
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

function getGitHubCopilotCredentials(): ProviderCredentials | null {
  const authData = loadOpenCodeAuth();
  const copilotAuth = authData["github-copilot"] || authData["github-copilot-enterprise"];

  if (!copilotAuth || copilotAuth.type !== "oauth") {
    return null;
  }

  // Use GitHub Models API for embeddings (models.github.ai)
  // Enterprise uses different URL pattern
  const auth = copilotAuth as OpenCodeAuthOAuth;
  const baseUrl = auth.enterpriseUrl
    ? `https://copilot-api.${auth.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : "https://models.github.ai";

  return {
    provider: "github-copilot",
    baseUrl,
    refreshToken: copilotAuth.refresh,
    accessToken: copilotAuth.access,
    tokenExpires: copilotAuth.expires,
  };
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

async function getOllamaCredentials(): Promise<ProviderCredentials | null> {
  const baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json() as { models?: Array<{ name: string }> };
      const hasEmbeddingModel = data.models?.some(
        (m: { name: string }) =>
          m.name.includes("embed") ||
          m.name.includes("minilm") ||
          m.name.includes("e5-") ||
          m.name.includes("bge-")
      );

      if (hasEmbeddingModel) {
        return {
          provider: "ollama",
          baseUrl,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function getProviderDisplayName(provider: EmbeddingProvider | 'custom'): string {
  switch (provider) {
    case "github-copilot":
      return "GitHub Copilot";
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
