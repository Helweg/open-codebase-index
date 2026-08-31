import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  type EmbeddingBatchResult,
  type EmbeddingRequestOptions,
  validateEmbeddingVectors,
} from "../provider-types.js";
import {
  createProviderRequestSignal,
  ProviderRequestError,
  raceWithOperationSignal,
  throwIfOperationAborted,
} from "../../utils/operation-control.js";

export class OpenAIEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["openai"]> {
  private static readonly REQUEST_TIMEOUT_MS = 120_000;

  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["openai"]
  ) {
    super(credentials, modelInfo);
  }

  public async embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    throwIfOperationAborted(options?.signal);
    await options?.setPhase?.("embedding");
    throwIfOperationAborted(options?.signal);
    const requestSignal = createProviderRequestSignal(
      options?.signal,
      OpenAIEmbeddingProvider.REQUEST_TIMEOUT_MS,
    );
    let responseReceived = false;
    try {
      return await raceWithOperationSignal((async () => {
        const response = await fetch(`${this.credentials.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.credentials.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.modelInfo.model,
            input: texts,
          }),
          signal: requestSignal.signal,
        });
        responseReceived = true;

        if (!response.ok) {
          await response.text();
          throw new ProviderRequestError({
            statusCode: response.status,
            message: `OpenAI embedding provider returned HTTP ${response.status}.`,
          });
        }

        let data: {
          data: Array<{ embedding: number[] }>;
          usage: { total_tokens: number };
        };
        try {
          data = await response.json() as typeof data;
        } catch {
          throw new ProviderRequestError({
            kind: "malformed_response",
            retryable: true,
            message: "OpenAI embedding provider returned malformed JSON.",
          });
        }
        if (!Array.isArray(data.data) || typeof data.usage?.total_tokens !== "number") {
          throw new ProviderRequestError({
            kind: "malformed_response",
            retryable: true,
            message: "OpenAI embedding provider returned an invalid response.",
          });
        }
        const embeddings = validateEmbeddingVectors(
          data.data.map((entry) => entry?.embedding),
          texts.length,
          this.modelInfo.dimensions,
        );

        return {
          embeddings,
          totalTokensUsed: data.usage.total_tokens,
        };
      })(), requestSignal.signal);
    } catch (error: unknown) {
      if (requestSignal.signal.aborted) {
        if (options?.signal?.aborted) throwIfOperationAborted(options.signal);
        throw new ProviderRequestError({ timedOut: true, retryable: true });
      }
      if (error instanceof ProviderRequestError) throw error;
      if (responseReceived) {
        throw new ProviderRequestError({
          kind: "malformed_response",
          retryable: true,
          message: "OpenAI embedding provider returned an invalid response.",
        });
      }
      throw new ProviderRequestError({
        retryable: true,
        message: "OpenAI embedding provider request failed.",
      });
    } finally {
      requestSignal.dispose();
    }
  }
}
