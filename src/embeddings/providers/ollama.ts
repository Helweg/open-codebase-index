import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import { BaseEmbeddingProvider, type EmbeddingBatchResult } from "../provider-types.js";

export class OllamaEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["ollama"]> {
  private static readonly MIN_TRUNCATION_CHARS = 512;
  private static readonly REQUEST_TIMEOUT_MS = 120_000;

  // Set when /api/embed returns 404 so subsequent multi-text batches skip the
  // batched endpoint and go straight to the legacy per-text path (one probe per
  // old ollama install, not one probe per batch).
  private batchEndpointUnavailable = false;

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

  // True for a 404 from the newer /api/embed endpoint, i.e. an ollama version that
  // does not provide it. embedBatch uses this to fall back to the legacy per-text
  // /api/embeddings path so old ollama installs do not regress.
  private isBatchEndpointUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Ollama /api/embed not available");
  }

  // True for a malformed /api/embed response (wrong vector count or a bad vector).
  // embedBatch falls back to the per-text path on this so a bad batch response
  // re-embeds each text cleanly. A text that then fails per-text is not isolated
  // here; it is isolated on the recovery run, which re-embeds one text per request.
  private isBatchValidationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("invalid embedding batch");
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

  // Embeds many texts in one POST /api/embed request (input: string[]). Ollama
  // encodes each input independently, so the model context length applies per input
  // (the upstream splitter already bounds each input), not over the batch. This
  // amortizes N HTTP round-trips into one.
  private async embedMany(texts: string[]): Promise<EmbeddingBatchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      OllamaEmbeddingProvider.REQUEST_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(`${this.credentials.baseUrl}/api/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelInfo.model,
          input: texts,
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
      if (response.status === 404) {
        throw new Error(`Ollama /api/embed not available: ${response.status} - ${error}`);
      }
      throw new Error(`Ollama embedding API error: ${response.status} - ${error}`);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // Invalid JSON (e.g. an empty or truncated 200 body) -> treat as a malformed
      // batch so embedBatch falls back to the per-text path instead of propagating
      // a parse error that skips the fallback.
      throw new Error(
        `Ollama returned an invalid embedding batch; expected ${texts.length} vectors of ${this.modelInfo.dimensions} finite dimensions`,
      );
    }
    const data = (parsed && typeof parsed === "object" ? parsed : {}) as { embeddings?: unknown };
    if (
      !Array.isArray(data.embeddings)
      || data.embeddings.length !== texts.length
      || data.embeddings.some(
        (value) =>
          !Array.isArray(value)
          || value.length !== this.modelInfo.dimensions
          || value.some((v) => typeof v !== "number" || !Number.isFinite(v)),
      )
    ) {
      throw new Error(
        `Ollama returned an invalid embedding batch; expected ${texts.length} vectors of ${this.modelInfo.dimensions} finite dimensions`,
      );
    }

    return {
      embeddings: data.embeddings,
      totalTokensUsed: texts.reduce((sum, text) => sum + this.estimateTokens(text), 0),
    };
  }

  // Per-text /api/embeddings path shared by the single-text fast path and the
  // batch fallback. Uses the legacy endpoint one text at a time, so each text gets
  // its own truncation safety net and a vector validated on its own. A text that
  // hard-fails per-text throws here and fails the whole request batch; the recovery
  // run re-embeds one text per request to isolate it.
  private async embedOneByOne(texts: string[]): Promise<EmbeddingBatchResult> {
    const results: Array<{ embedding: number[]; tokensUsed: number }> = [];
    for (const text of texts) {
      results.push(await this.embedSingleWithFallback(text));
    }

    return {
      embeddings: results.map((r) => r.embedding),
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return { embeddings: [], totalTokensUsed: 0 };
    }

    // A single-text batch gets no batching benefit; send it to the legacy per-text
    // path directly so its truncation/timeout/error behavior stays unchanged and no
    // /api/embed probe runs. Once /api/embed is known unavailable, multi-text batches
    // also skip the probe (see batchEndpointUnavailable).
    if (texts.length === 1 || this.batchEndpointUnavailable) {
      return this.embedOneByOne(texts);
    }

    try {
      return await this.embedMany(texts);
    } catch (error) {
      // Fall back to the per-text /api/embeddings path when the batched endpoint is
      // unavailable (old ollama, 404), a single input overflowed the model context
      // length (per-text truncation net), or the batch response was malformed (so a
      // bad batch response re-embeds each text cleanly). This is not in-run per-text
      // isolation: a text that hard-fails per-text throws and fails the whole request
      // batch, and is isolated only on the recovery run, which re-embeds one text per
      // request. Other errors propagate for the indexer's pRetry to handle.
      if (this.isBatchEndpointUnavailableError(error)) {
        // Old ollama without /api/embed: cache the result so later batches skip the probe.
        this.batchEndpointUnavailable = true;
        return this.embedOneByOne(texts);
      }

      if (
        !this.isContextLengthError(error)
        && !this.isBatchValidationError(error)
      ) {
        throw error;
      }

      return this.embedOneByOne(texts);
    }
  }
}
