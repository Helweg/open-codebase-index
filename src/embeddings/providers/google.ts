import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  type EmbeddingBatchResult,
  type EmbeddingResult,
} from "../provider-types.js";

export class GoogleEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["google"]> {
  private static readonly BATCH_SIZE = 20;

  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["google"]
  ) {
    super(credentials, modelInfo);
  }

  public async embedQuery(query: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.model === "gemini-embedding-001" && this.modelInfo.taskAble
      ? "CODE_RETRIEVAL_QUERY"
      : undefined;
    const texts = [
      this.modelInfo.model === "gemini-embedding-2"
        ? `task: code retrieval | query: ${query}`
        : query,
    ];
    const result = await this.embedWithTaskType(texts, taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedDocument(document: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.model === "gemini-embedding-001" && this.modelInfo.taskAble
      ? "RETRIEVAL_DOCUMENT"
      : undefined;
    const result = await this.embedWithTaskType([
      this.modelInfo.model === "gemini-embedding-2" ? `title: none | text: ${document}` : document,
    ], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const taskType = this.modelInfo.model === "gemini-embedding-001" && this.modelInfo.taskAble
      ? "RETRIEVAL_DOCUMENT"
      : undefined;
    const formattedTexts = this.modelInfo.model === "gemini-embedding-2"
      ? texts.map((text) => `title: none | text: ${text}`)
      : texts;

    return this.embedWithTaskType(formattedTexts, taskType);
  }

  private async embedWithTaskType(
    texts: string[],
    taskType?: string
  ): Promise<EmbeddingBatchResult> {
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

        const response = await fetch(
          `${this.credentials.baseUrl}/models/${this.modelInfo.model}:batchEmbedContents`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this.credentials.apiKey && { "x-goog-api-key": this.credentials.apiKey }),
            },
            body: JSON.stringify({ requests }),
          }
        );

        if (!response.ok) {
          const error = (await response.text()).slice(0, 500);
          throw new Error(`Google embedding API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as {
          embeddings: Array<{ values: number[] }>;
        };

        return {
          embeddings: data.embeddings.map((e) => e.values),
          tokensUsed: batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        };
      })
    );

    return {
      embeddings: batchResults.flatMap((r) => r.embeddings),
      totalTokensUsed: batchResults.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }
}
