import type { BaseModelInfo } from "../config/schema.js";
import type { EmbeddingBatchResult, EmbeddingProviderInterface, EmbeddingRequestOptions, EmbeddingResult } from "./provider-types.js";
import { isOperationInterruption, ProviderRequestError, throwIfOperationAborted } from "../utils/operation-control.js";

export function reportEmbeddingFallback(error: ProviderRequestError): void {
  console.warn("[codebase-index] Using fallback embeddings after a primary request failed.", {
    statusCode: error.statusCode,
    timedOut: error.timedOut,
  });
}

/** HTTP statuses that make a primary failure eligible for the replica. */
export function isFallbackEligibleStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 429 || statusCode >= 500;
}

export function shouldFallbackEmbeddingRequest(error: unknown): error is ProviderRequestError {
  if (!(error instanceof ProviderRequestError) || isOperationInterruption(error) || error.kind) return false;
  return error.timedOut || (error.statusCode === undefined && error.retryable === true)
    || (error.statusCode !== undefined && isFallbackEligibleStatus(error.statusCode));
}

export class EmbeddingFallbackError extends ProviderRequestError {
  public constructor(public readonly primaryError: unknown, public readonly fallbackError: unknown) {
    super({
      message: "Both primary and fallback embedding requests failed.",
      statusCode: fallbackError instanceof ProviderRequestError ? fallbackError.statusCode : undefined,
      timedOut: fallbackError instanceof ProviderRequestError && fallbackError.timedOut,
      retryable: fallbackError instanceof ProviderRequestError ? fallbackError.retryable : false,
      kind: fallbackError instanceof ProviderRequestError ? fallbackError.kind : undefined,
    });
  }
}

/** Each call starts on the primary. No shared routing state or background probes. */
export class FallbackEmbeddingProvider implements EmbeddingProviderInterface {
  public constructor(
    private readonly primary: EmbeddingProviderInterface,
    private readonly fallback: EmbeddingProviderInterface,
    private readonly onFallback: (error: ProviderRequestError) => void,
  ) {}

  public getModelInfo(): BaseModelInfo {
    return this.primary.getModelInfo();
  }

  private async execute<T>(
    call: (provider: EmbeddingProviderInterface) => Promise<T>,
    options?: EmbeddingRequestOptions,
  ): Promise<T> {
    throwIfOperationAborted(options?.signal);
    try {
      // The provider finishes its own recovery before an error reaches this wrapper.
      return await call(this.primary);
    } catch (primaryError: unknown) {
      throwIfOperationAborted(options?.signal);
      if (!shouldFallbackEmbeddingRequest(primaryError)) throw primaryError;
      this.onFallback(primaryError);
      try {
        throwIfOperationAborted(options?.signal);
        return await call(this.fallback);
      } catch (fallbackError: unknown) {
        throwIfOperationAborted(options?.signal);
        if (isOperationInterruption(fallbackError)) throw fallbackError;
        throw new EmbeddingFallbackError(primaryError, fallbackError);
      }
    }
  }

  public embedQuery(query: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    return this.execute((provider) => provider.embedQuery(query, options), options);
  }

  public embedDocument(document: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    return this.execute((provider) => provider.embedDocument(document, options), options);
  }

  public embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    return this.execute((provider) => provider.embedBatch(texts, options), options);
  }
}
