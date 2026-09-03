import { type CustomModelInfo, type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  CustomProviderNonRetryableError,
  type EmbeddingBatchResult,
  type EmbeddingRequestOptions,
  validateEmbeddingVectors,
} from "../provider-types.js";
import { validateExternalUrl } from "../../utils/url-validation.js";
import {
  createProviderRequestSignal,
  ProviderRequestError,
  raceWithOperationSignal,
  throwIfOperationAborted,
} from "../../utils/operation-control.js";

export class CustomEmbeddingProvider extends BaseEmbeddingProvider<CustomModelInfo> {
  public constructor(credentials: ProviderCredentials, modelInfo: CustomModelInfo) {
    super(credentials, modelInfo);
  }

  private splitIntoRequestBatches(texts: string[]): string[][] {
    const maxBatchSize = this.modelInfo.maxBatchSize;

    if (!maxBatchSize || texts.length <= maxBatchSize) {
      return [texts];
    }

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += maxBatchSize) {
      batches.push(texts.slice(i, i + maxBatchSize));
    }
    return batches;
  }

  private async embedRequest(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return {
        embeddings: [],
        totalTokensUsed: 0,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.credentials.apiKey) {
      headers.Authorization = `Bearer ${this.credentials.apiKey}`;
    }

    const baseUrl = this.credentials.baseUrl ?? "";
    const fullUrl = `${baseUrl}/embeddings`;

    const urlCheck = validateExternalUrl(fullUrl);
    if (!urlCheck.valid) {
      throw new CustomProviderNonRetryableError(
        "Custom embedding provider URL was rejected by the outbound request policy."
      );
    }

    const timeoutMs = this.modelInfo.timeoutMs;
    const requestSignal = createProviderRequestSignal(options?.signal, timeoutMs);

    let responseReceived = false;
    try {
      return await raceWithOperationSignal((async () => {
        const response = await fetch(fullUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.modelInfo.model,
            input: texts,
          }),
          signal: requestSignal.signal,
        });
        responseReceived = true;

        if (!response.ok) {
          await response.text();
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new CustomProviderNonRetryableError(
              `Custom embedding provider returned HTTP ${response.status}.`,
              response.status,
            );
          }
          throw new ProviderRequestError({
            statusCode: response.status,
            message: `Custom embedding provider returned HTTP ${response.status}.`,
          });
        }

        let data: {
          data?: Array<{ embedding: number[] }>;
          usage?: { total_tokens: number };
        };
        try {
          data = await response.json() as typeof data;
        } catch {
          throw new ProviderRequestError({
            kind: "malformed_response",
            retryable: true,
            message: "Custom embedding provider returned malformed JSON.",
          });
        }

        if (data.data && Array.isArray(data.data)) {
          const embeddings = validateEmbeddingVectors(
            data.data.map((entry) => entry?.embedding),
            texts.length,
            this.modelInfo.dimensions,
          );

          return {
            embeddings,
            totalTokensUsed: data.usage?.total_tokens ?? texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
          };
        }

        throw new CustomProviderNonRetryableError(
          "Custom embedding API returned unexpected response format. Expected OpenAI-compatible format with data[].embedding.",
        );
      })(), requestSignal.signal);
    } catch (error: unknown) {
      if (requestSignal.signal.aborted) {
        if (options?.signal?.aborted) throwIfOperationAborted(options.signal);
        throw new ProviderRequestError({
          timedOut: true,
          retryable: true,
          message: `Custom embedding provider request timed out after ${timeoutMs}ms.`,
        });
      }
      if (error instanceof CustomProviderNonRetryableError || error instanceof ProviderRequestError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderRequestError({
          timedOut: true,
          retryable: true,
          message: `Custom embedding provider request timed out after ${timeoutMs}ms.`,
        });
      }
      if (responseReceived) {
        throw new ProviderRequestError({
          kind: "malformed_response",
          retryable: true,
          message: "Custom embedding provider returned an invalid response.",
        });
      }
      throw new ProviderRequestError({
        retryable: true,
        message: "Custom embedding provider request failed.",
      });
    } finally {
      requestSignal.dispose();
    }
  }

  public async embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    throwIfOperationAborted(options?.signal);
    await options?.setPhase?.("embedding");
    throwIfOperationAborted(options?.signal);
    const requestBatches = this.splitIntoRequestBatches(texts);
    const embeddings: number[][] = [];
    let totalTokensUsed = 0;

    for (const batch of requestBatches) {
      throwIfOperationAborted(options?.signal);
      const result = await this.embedRequest(batch, options);
      embeddings.push(...result.embeddings);
      totalTokensUsed += result.totalTokensUsed;
    }

    return {
      embeddings,
      totalTokensUsed,
    };
  }
}
