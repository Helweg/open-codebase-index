import { BaseModelInfo } from "../config/schema.js";
import { getProviderDisplayName, ConfiguredProviderInfo } from "../embeddings/detector.js";

export interface CostEstimate {
  filesCount: number;
  totalSizeBytes: number;
  estimatedChunks: number;
  estimatedTokens: number;
  estimatedCost: number;
  provider: string;
  model: string;
  isFree: boolean;
}

// Result of a dry-run index_codebase pass: parse the real file set, build the
// embedding text for every indexable chunk, and sum estimateTokens over those
// texts without calling the embedding provider or writing to the index.
//
// The token sum uses the local estimate (estimateTokens = ceil(len/4)). It
// equals the live "Tokens used" counter only for providers that report usage
// on the same basis (ollama counts ceil(len/4)); for providers that report a
// server tokenizer count (OpenAI, Gemini, custom) it is only an estimate.
//
// For a matching provider and a project-scoped force index, the force pass
// clears its own cached embeddings, so the live counter climbs to this sum. A
// force index on a shared global index can reuse cached embeddings from other
// projects, and an incremental index counts cached chunks that are not
// re-embedded; in both cases the dry-run value is an upper bound.
export interface DryRunEstimate {
  filesCount: number;
  chunksCount: number;
  tokensToEmbed: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateChunksFromFiles(
  files: Array<{ path: string; size: number }>
): number {
  let totalChunks = 0;

  for (const file of files) {
    const avgChunkSize = 400;
    const chunksPerFile = Math.max(1, Math.ceil(file.size / avgChunkSize));
    totalChunks += chunksPerFile;
  }

  return totalChunks;
}

export function estimateCost(
  estimatedTokens: number,
  modelInfo: BaseModelInfo
): number {
  return (estimatedTokens / 1_000_000) * modelInfo.costPer1MTokens;
}

export function createCostEstimate(
  files: Array<{ path: string; size: number }>,
  provider: ConfiguredProviderInfo
): CostEstimate {
  const filesCount = files.length;
  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const estimatedChunks = estimateChunksFromFiles(files);
  const avgTokensPerChunk = 150;
  const estimatedTokens = estimatedChunks * avgTokensPerChunk;
  const estimatedCost = estimateCost(estimatedTokens, provider.modelInfo);

  return {
    filesCount,
    totalSizeBytes,
    estimatedChunks,
    estimatedTokens,
    estimatedCost,
    provider: getProviderDisplayName(provider.provider),
    model: provider.modelInfo.model,
    isFree: provider.modelInfo.costPer1MTokens === 0,
  };
}

export function formatCostEstimate(estimate: CostEstimate): string {
  const sizeFormatted = formatBytes(estimate.totalSizeBytes);
  const filesFormatted = `${estimate.filesCount.toLocaleString()} files`;
  const costFormatted = estimate.isFree
    ? "Free"
    : `~$${estimate.estimatedCost.toFixed(4)}`;

  return `
┌─────────────────────────────────────────────────────────────────┐
│  📊 Indexing Estimate                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Files to index:     ${filesFormatted.padEnd(40)}│
│  Total size:         ${sizeFormatted.padEnd(40)}│
│  Estimated chunks:   ${("~" + estimate.estimatedChunks.toLocaleString() + " chunks").padEnd(40)}│
│  Estimated tokens:   ${("~" + estimate.estimatedTokens.toLocaleString() + " tokens").padEnd(40)}│
│                                                                 │
│  Provider: ${estimate.provider.padEnd(52)}│
│  Model:    ${estimate.model.padEnd(52)}│
│  Cost:     ${costFormatted.padEnd(52)}│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
`;
}

export function formatDryRunEstimate(estimate: DryRunEstimate): string {
  return `Dry run: parsed the file set to measure the embedding workload. No embeddings were written and the index was not changed.

  Files to embed:   ${estimate.filesCount.toLocaleString()}
  Chunks to embed:  ${estimate.chunksCount.toLocaleString()}
  Tokens to embed:  ${estimate.tokensToEmbed.toLocaleString()}

The "Tokens to embed" value uses the local estimateTokens(text) = ceil(len/4). It
matches the live "Tokens used" counter only for providers that report usage on the
same basis (ollama); for providers that report a server tokenizer count (OpenAI,
Gemini, custom) it is only an estimate.

For a matching provider and a project-scoped force index, the force pass clears its
own cached embeddings, so the live counter climbs to this number. A force index on a
shared global index can reuse cached embeddings from other projects, and an
incremental index counts cached chunks that are not re-embedded; in both cases this
number is an upper bound on the live counter, so a progress percent against this
total tops out below 100%.
`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}


export interface ConfirmationResult {
  confirmed: boolean;
  rememberChoice: boolean;
}

export function formatConfirmationPrompt(): string {
  return `
Proceed with indexing? [Y/n/always]

  Y      - Index now
  n      - Cancel
  always - Index now and don't ask again for this project
`;
}

export function parseConfirmationResponse(response: string): ConfirmationResult {
  const normalized = response.toLowerCase().trim();

  if (normalized === "" || normalized === "y" || normalized === "yes") {
    return { confirmed: true, rememberChoice: false };
  }

  if (normalized === "always" || normalized === "a") {
    return { confirmed: true, rememberChoice: true };
  }

  return { confirmed: false, rememberChoice: false };
}
