import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  type EmbeddingBatchResult,
  type EmbeddingRequestOptions,
  type EmbeddingResult,
  validateEmbeddingVectors,
} from "../provider-types.js";
import {
  createProviderRequestSignal,
  ProviderRequestError,
  raceWithOperationSignal,
  throwIfOperationAborted,
} from "../../utils/operation-control.js";

export class GoogleEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["google"]> {
  private static readonly BATCH_SIZE = 20;
  private static readonly REQUEST_TIMEOUT_MS = 120_000;

  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["google"]
  ) {
    super(credentials, modelInfo);
  }

  public async embedQuery(query: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.model === "gemini-embedding-001" && this.modelInfo.taskAble
      ? "CODE_RETRIEVAL_QUERY"
      : undefined;
    const texts = [
      this.modelInfo.model === "gemini-embedding-2"
        ? `task: code retrieval | query: ${query}`
        : query,
    ];
    const result = await this.embedWithTaskType(texts, taskType, options);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedDocument(document: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.model === "gemini-embedding-001" && this.modelInfo.taskAble
      ? "RETRIEVAL_DOCUMENT"
      : undefined;
    const result = await this.embedWithTaskType([
      this.modelInfo.model === "gemini-embedding-2" ? `title: none | text: ${document}` : document,
    ], taskType, options);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult> {
    const taskType = this.modelInfo.model === "gemini-embedding-001" && this.modelInfo.taskAble
      ? "RETRIEVAL_DOCUMENT"
      : undefined;
    const formattedTexts = this.modelInfo.model === "gemini-embedding-2"
      ? texts.map((text) => `title: none | text: ${text}`)
      : texts;

    return this.embedWithTaskType(formattedTexts, taskType, options);
  }

  private async embedWithTaskType(
    texts: string[],
    taskType?: string,
    options?: EmbeddingRequestOptions,
  ): Promise<EmbeddingBatchResult> {
    throwIfOperationAborted(options?.signal);
    await options?.setPhase?.("embedding");
    throwIfOperationAborted(options?.signal);
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += GoogleEmbeddingProvider.BATCH_SIZE) {
      batches.push(texts.slice(i, i + GoogleEmbeddingProvider.BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const requests = batch.map((text) => ({
          model: `models/${this.modelInfo.model}`,
          content: {
            parts: [{ text }],
          },
          taskType,
          outputDimensionality: this.modelInfo.dimensions,
        }));

        const requestSignal = createProviderRequestSignal(
          options?.signal,
          GoogleEmbeddingProvider.REQUEST_TIMEOUT_MS,
        );
        let responseReceived = false;
        try {
          return await raceWithOperationSignal((async () => {
            const response = await fetch(
              `${this.credentials.baseUrl}/models/${this.modelInfo.model}:batchEmbedContents`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(this.credentials.apiKey && { "x-goog-api-key": this.credentials.apiKey }),
                },
                body: JSON.stringify({ requests }),
                signal: requestSignal.signal,
              }
            );
            responseReceived = true;

            if (!response.ok) {
              await response.text();
              throw new ProviderRequestError({
                statusCode: response.status,
                message: `Google embedding provider returned HTTP ${response.status}.`,
              });
            }

            let data: { embeddings: Array<{ values: number[] }> };
            try {
              data = (await response.json()) as typeof data;
            } catch {
              throw new ProviderRequestError({
                kind: "malformed_response",
                retryable: true,
                message: "Google embedding provider returned malformed JSON.",
              });
            }
            if (!Array.isArray(data.embeddings)) {
              throw new ProviderRequestError({
                kind: "malformed_response",
                retryable: true,
                message: "Google embedding provider returned an invalid response.",
              });
            }
            const embeddings = validateEmbeddingVectors(
              data.embeddings.map((embedding) => embedding?.values),
              batch.length,
              this.modelInfo.dimensions,
            );

            return {
              embeddings,
              tokensUsed: batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
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
              message: "Google embedding provider returned an invalid response.",
            });
          }
          throw new ProviderRequestError({
            retryable: true,
            message: "Google embedding provider request failed.",
          });
        } finally {
          requestSignal.dispose();
        }
      })
    );

    return {
      embeddings: batchResults.flatMap((r) => r.embeddings),
      totalTokensUsed: batchResults.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }
}
