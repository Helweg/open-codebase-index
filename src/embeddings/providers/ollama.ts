import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import { BaseEmbeddingProvider, type EmbeddingBatchResult } from "../provider-types.js";

export class OllamaEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["ollama"]> {
  private static readonly MIN_TRUNCATION_CHARS = 512;
  private static readonly REQUEST_TIMEOUT_MS = 120_000;

  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["ollama"]
  ) {
    super(credentials, modelInfo);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private truncateToCharLimit(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, Math.max(0, maxChars - 17))}\n... [truncated]`;
  }

  private isContextLengthError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (message.includes("context length") && (message.includes("exceed") || message.includes("exceeded") || message.includes("too long")))
      || message.includes("input length exceeds the context length")
      || message.includes("context length exceeded");
  }

  private buildTruncationCandidates(text: string): string[] {
    const baseMaxChars = Math.max(1, this.modelInfo.maxTokens * 4);
    const candidateLimits = new Set<number>();
    const baselineLimit = text.length > baseMaxChars
      ? baseMaxChars
      : Math.max(
          OllamaEmbeddingProvider.MIN_TRUNCATION_CHARS,
          Math.floor(text.length * 0.9)
        );

    if (baselineLimit < text.length) {
      candidateLimits.add(baselineLimit);
    }

    for (const factor of [0.75, 0.6, 0.45, 0.35, 0.25]) {
      const scaledLimit = Math.max(
        OllamaEmbeddingProvider.MIN_TRUNCATION_CHARS,
        Math.floor(baselineLimit * factor)
      );
      if (scaledLimit < text.length) {
        candidateLimits.add(scaledLimit);
      }
    }

    candidateLimits.add(Math.min(text.length - 1, OllamaEmbeddingProvider.MIN_TRUNCATION_CHARS));

    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const limit of [...candidateLimits].sort((a, b) => b - a)) {
      if (limit <= 0 || limit >= text.length) {
        continue;
      }

      const truncated = this.truncateToCharLimit(text, limit);
      if (truncated === text || seen.has(truncated)) {
        continue;
      }

      seen.add(truncated);
      candidates.push(truncated);
    }

    return candidates;
  }

  private async embedSingleWithFallback(text: string): Promise<{ embedding: number[]; tokensUsed: number }> {
    try {
      return await this.embedSingle(text);
    } catch (error) {
      if (!this.isContextLengthError(error)) {
        throw error;
      }

      let lastError: unknown = error;
      for (const truncated of this.buildTruncationCandidates(text)) {
        try {
          return await this.embedSingle(truncated);
        } catch (retryError) {
          if (!this.isContextLengthError(retryError)) {
            throw retryError;
          }
          lastError = retryError;
        }
      }

      throw lastError;
    }
  }

  private async embedSingle(text: string): Promise<{ embedding: number[]; tokensUsed: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      OllamaEmbeddingProvider.REQUEST_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(`${this.credentials.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelInfo.model,
          prompt: text,
          truncate: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Ollama embedding request timed out after ${OllamaEmbeddingProvider.REQUEST_TIMEOUT_MS}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const error = (await response.text()).slice(0, 500);
      throw new Error(`Ollama embedding API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as { embedding?: unknown };
    if (
      !Array.isArray(data.embedding)
      || data.embedding.length !== this.modelInfo.dimensions
      || data.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(
        `Ollama returned an invalid embedding; expected ${this.modelInfo.dimensions} finite dimensions`,
      );
    }

    return {
      embedding: data.embedding,
      tokensUsed: this.estimateTokens(text),
    };
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const results: Array<{ embedding: number[]; tokensUsed: number }> = [];

    for (const text of texts) {
      results.push(await this.embedSingleWithFallback(text));
    }

    return {
      embeddings: results.map((r) => r.embedding),
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }
}
