import type { CustomProviderConfig, EmbeddingFallbackConfig, EmbeddingProvider } from "./schema.js";
import { findCatalogOllamaModel, getResolvedString, isValidProvider } from "./validators.js";
import { validateExternalUrl } from "../utils/url-validation.js";

export function parseEmbeddingFallback(
  value: unknown,
  primaryProvider: EmbeddingProvider | "custom" | "auto",
  primaryModel: string | undefined,
  customProvider: CustomProviderConfig | undefined,
): EmbeddingFallbackConfig | false | undefined {
  if (value === undefined || value === false) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("embeddingFallback must be an object or false.");
  }
  if (primaryProvider === "auto" || (primaryProvider === "ollama" && !primaryModel)) {
    throw new Error("embeddingFallback requires an explicit primary provider and an explicit Ollama model.");
  }
  const raw = value as Record<string, unknown>;
  const provider = getResolvedString(raw.provider, "$root.embeddingFallback.provider");
  const baseUrl = getResolvedString(raw.baseUrl, "$root.embeddingFallback.baseUrl")?.trim().replace(/\/+$/, "");
  const model = getResolvedString(raw.model, "$root.embeddingFallback.model")?.trim();
  const apiKey = getResolvedString(raw.apiKey, "$root.embeddingFallback.apiKey");
  if ((!isValidProvider(provider) && provider !== "custom") || !baseUrl || !model
    || typeof raw.dimensions !== "number" || !Number.isSafeInteger(raw.dimensions) || raw.dimensions <= 0) {
    throw new Error("embeddingFallback requires provider, baseUrl, model and positive integer dimensions.");
  }
  if (!validateExternalUrl(baseUrl).valid || new URL(baseUrl).username || new URL(baseUrl).password) {
    throw new Error("embeddingFallback.baseUrl was rejected by the outbound request policy.");
  }
  if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") {
    throw new Error("embeddingFallback.apiKey must be a string.");
  }
  if (raw.maxTokens !== undefined && (typeof raw.maxTokens !== "number"
    || !Number.isSafeInteger(raw.maxTokens) || raw.maxTokens <= 0)) {
    throw new Error("embeddingFallback.maxTokens must be a positive integer.");
  }
  if ((primaryProvider === "google") !== (provider === "google")) {
    throw new Error("Google embedding fallback requires the Google protocol to preserve query/document task semantics.");
  }
  const expectedModel = customProvider?.model ?? primaryModel;
  // Only native Ollama's existing catalog aliases are equivalent. Quantization tags and
  // arbitrary OpenAI-compatible model identifiers still have to match exactly.
  const canonical = (name: string): string => primaryProvider === "ollama" || provider === "ollama"
    ? findCatalogOllamaModel(name)?.model ?? name
    : name;
  if (expectedModel && canonical(model) !== canonical(expectedModel)) {
    throw new Error("embeddingFallback.model must match the primary model exactly.");
  }
  return { provider, baseUrl, model, dimensions: raw.dimensions, apiKey, maxTokens: raw.maxTokens as number | undefined };
}
