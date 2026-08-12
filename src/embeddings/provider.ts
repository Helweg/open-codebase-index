import { type ConfiguredProviderInfo } from "./detector.js";
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
): import("./provider-types.js").EmbeddingProviderInterface {
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
