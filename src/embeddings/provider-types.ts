import { type BaseModelInfo } from "../config/schema.js";

import { type ProviderCredentials } from "./detector.js";
import { ProviderRequestError } from "../utils/operation-control.js";

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  setPhase?: (phase: string) => void | Promise<void>;
  heartbeat?: () => void | Promise<void>;
}

export function validateEmbeddingVectors(
  value: unknown,
  expectedCount: number,
  expectedDimensions: number,
): number[][] {
  if (!Array.isArray(value)
    || value.length !== expectedCount
    || value.some((embedding) => !Array.isArray(embedding)
      || embedding.length !== expectedDimensions
      || embedding.some((component) => typeof component !== "number" || !Number.isFinite(component)))) {
    throw new ProviderRequestError({
      kind: "malformed_response",
      retryable: false,
      message: "The embedding provider returned vectors that do not match the configured contract.",
    });
  }
  return value as number[][];
}

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  totalTokensUsed: number;
}

export interface EmbeddingProviderInterface {
  embedQuery(query: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult>;
  embedDocument(document: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult>;
  embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult>;
  getModelInfo(): BaseModelInfo;
}

export abstract class BaseEmbeddingProvider<TModelInfo extends BaseModelInfo>
  implements EmbeddingProviderInterface {
  public constructor(
    protected readonly credentials: ProviderCredentials,
    protected readonly modelInfo: TModelInfo
  ) { }

  public async embedQuery(query: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query], options);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedDocument(document: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document], options);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public getModelInfo(): TModelInfo {
    return this.modelInfo;
  }

  public abstract embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult>;
}

/**
 * Thrown by CustomEmbeddingProvider for HTTP 4xx errors (except 429 rate limit).
 * The Indexer's pRetry config uses instanceof to bail immediately on these errors
 * instead of retrying — preventing long retry loops on bad API keys or invalid models.
 */
export class CustomProviderNonRetryableError extends ProviderRequestError {
  public constructor(message: string, statusCode?: number) {
    super({ message, statusCode, retryable: false });
    this.name = "CustomProviderNonRetryableError";
  }
}
