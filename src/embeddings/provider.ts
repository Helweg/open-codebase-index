import { type ConfiguredProviderInfo } from "./detector.js";
import type { EmbeddingFallbackConfig } from "../config/schema.js";
import type { ProviderRequestError } from "../utils/operation-control.js";
import { parseEmbeddingFallback } from "../config/embedding-fallback.js";
import { FallbackEmbeddingProvider, reportEmbeddingFallback } from "./fallback.js";
import { CustomEmbeddingProvider } from "./providers/custom.js";
import { GoogleEmbeddingProvider } from "./providers/google.js";
import { OllamaEmbeddingProvider } from "./providers/ollama.js";
import { OpenAIEmbeddingProvider } from "./providers/openai.js";

export {
  BaseEmbeddingProvider,
  CustomProviderNonRetryableError,
  type EmbeddingBatchResult,
  type EmbeddingProviderInterface,
  type EmbeddingResult,
} from "./provider-types.js";

export function createEmbeddingProvider(
  configuredProviderInfo: ConfiguredProviderInfo,
  fallback?: EmbeddingFallbackConfig | false,
  onFallback: (error: ProviderRequestError) => void = reportEmbeddingFallback,
): import("./provider-types.js").EmbeddingProviderInterface {
  fallback = parseEmbeddingFallback(fallback, configuredProviderInfo.provider, configuredProviderInfo.modelInfo.model, undefined);
  if (fallback) {
    const primary = configuredProviderInfo;
    if (fallback.dimensions !== primary.modelInfo.dimensions
      || (fallback.maxTokens !== undefined && fallback.maxTokens !== primary.modelInfo.maxTokens)) {
      throw new Error("Embedding fallback dimensions and maxTokens must match the primary contract.");
    }
    const credentials = { provider: fallback.provider, baseUrl: fallback.baseUrl, apiKey: fallback.apiKey };
    const modelInfo = { ...primary.modelInfo, provider: fallback.provider, model: fallback.model };
    let secondary: ConfiguredProviderInfo;
    switch (fallback.provider) {
      case "custom":
        secondary = {
          provider: "custom", credentials,
          modelInfo: { ...modelInfo, provider: "custom", timeoutMs: primary.provider === "custom" ? primary.modelInfo.timeoutMs : 120_000 },
        };
        break;
      case "google":
        if (primary.provider !== "google") throw new Error("Google fallback requires a Google primary.");
        // Model and dimensions already match exactly; preserve Google's task metadata.
        secondary = { provider: "google", credentials, modelInfo: primary.modelInfo };
        break;
      case "ollama":
        secondary = { provider: "ollama", credentials, modelInfo: { ...modelInfo, provider: "ollama" } };
        break;
      case "openai":
        secondary = { provider: "openai", credentials, modelInfo: { ...modelInfo, provider: "openai" } };
        break;
    }
    return new FallbackEmbeddingProvider(createEmbeddingProvider(primary), createEmbeddingProvider(secondary), onFallback);
  }
  switch (configuredProviderInfo.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "google":
      return new GoogleEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "ollama":
      return new OllamaEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "custom":
      return new CustomEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    default: {
      const _exhaustive: never = configuredProviderInfo;
      throw new Error(`Unsupported embedding provider: ${(_exhaustive as ConfiguredProviderInfo).provider}`);
    }
  }
}
