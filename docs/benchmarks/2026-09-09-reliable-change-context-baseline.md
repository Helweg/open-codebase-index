# Baseline Representative Benchmark - 2026-09-09 Reliable Change Context

## Run envelope
- **Results location:** `/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative/2026-09-09T18-48-55-366Z`
- **Project snapshot:** `/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/baseline-project`
- **Baseline git:** `e8e947f8359ee92b2fa2cea9d85efe00cd878f30`
- **Command:**
  ```bash
  public node dist/cli.js eval run --project SNAPSHOT --config SNAPSHOT/.github/eval-ollama-full-config.json --dataset SNAPSHOT/benchmarks/golden/representative.json --output RESULTS --reindex
  ```
  where `SNAPSHOT=/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/baseline-project`
- **Node/runtime:** `ACTUAL26.6.0` on `macOS ARM64`
- **Dataset:** `representative-retrieval` version `2.2.0`
- **Query count:** 17 (negative query `negative-strict-directory-filter` is in artifact and excluded from positive-hit denominator)
- **Mode mix:** `search` 3, `context` 14, `edit-context` 0, `architecture` 0
- **Artifacts used:**
  - [Summary JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative/2026-09-09T18-48-55-366Z/summary.json)
  - [Per-query JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative/2026-09-09T18-48-55-366Z/per-query.json)
  - [Config](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/baseline-project/.github/eval-ollama-full-config.json)

## Config and capability snapshot
- `embeddingProvider`: `ollama`
- `embeddingModel`: `nomic-embed-text`
- `indexing.autoIndex`: `false`
- `indexing.watchFiles`: `false`
- `indexing.respectGitignore`: `true`
- `indexing.semanticOnly`: `false`
- `indexing.requireProjectMarker`: `false`
- `search.maxResults`: `10`
- `search.minScore`: `0`
- `search.hybridWeight`: `0.4`
- `search.fusionStrategy`: `rrf`
- `search.rrfK`: `60`
- `search.rerankTopN`: `20`
- `search.enableCrossLanguage`: `true`
- `debug.enabled`: `false`
- `debug.logLevel`: `info`
- `debug.metrics`: `true`

## Measured metrics (from `summary.json`)
- `Hit@1`: 56.25%
- `Hit@3`: 75.00%
- `Hit@5`: 75.00%
- `Hit@10`: 75.00%
- `MRR@10`: `0.6354166666666666` (rounded `0.6354`)
- `nDCG@10`: `0.5922462240666881`
- `latencyMs.p50`: `271.859375`
- `latencyMs.p95`: `332.189741`
- `latencyMs.p99`: `404.001981`
- `embedding.callCount`: `437`
- `embedding.estimatedCostUsd`: `0`
- `tokenEstimate.embeddingTokensUsed`: `1108669`
- `graphNeighborRecall`: `0`
- `distinctTop3Ratio`: `0.9411764705882353`
- `rawDistinctTop3Ratio`: `0.8627450980392156`
- `context.responseTokens.total`: `7782`
- `context.responseTokens.avg`: `555.8571428571429`
- `context.responseTokens.p95`: `603.15`
- `context.responseTokens.max`: `609`
- `context.duplicateCandidateRatio`: `0.1919357372728885`
- `context.selectedFileRatio`: `0.8678571428571429`

## Failure buckets and concrete IDs (from `per-query.json`)
- **wrong-file (3):** `file-watcher-implementation`, `keyword-search-knobs`, `mcp-registration-concept`
- **wrong-symbol (3):** `crashed-index-lock-recovery`, `embedding-failure-recovery-flow`, `similarity-rrf-fusion`
- **docs/tests outranking source (0):** none
- **no relevant hit in top-k (1):** `duplicate-definition-path-disambiguation`
- **negative control (excluded from positive denominator):** `negative-strict-directory-filter`

## Derived checks
- `queryCount` in artifact is 17, with one negative-only control query.
- Positive-hit denominator excluding the negative control is `16`.
- `per-query` latencies sum to `3526.137413999968`ms across 17 queries.

## Additional measured runs (same saved isolated index, no `--reindex`)

### 1) `baseline-representative-repeat` repeat run
- **Results location:** `/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative-repeat/2026-09-09T18-51-41-103Z`
- **Artifacts:**
  - [Summary JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative-repeat/2026-09-09T18-51-41-103Z/summary.json)
  - [Per-query JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative-repeat/2026-09-09T18-51-41-103Z/per-query.json)
- **Observed metrics:** `Hit@5` `75.00%`, `MRR@10` `0.6354` (raw `0.6354166666666666`), latency `p95 340.137ms`, wall-time annotation from agent `95340.137ms`.
- **Failure buckets:**
  - `wrong-file` (3): `file-watcher-implementation`, `keyword-search-knobs`, `mcp-registration-concept`
  - `wrong-symbol` (3): `crashed-index-lock-recovery`, `embedding-failure-recovery-flow`, `similarity-rrf-fusion`
  - `docs/tests outranking source` (0)
  - `no relevant hit in top-k` (1): `duplicate-definition-path-disambiguation`

### 2) `baseline-pre-edit` pre-edit dataset run
- **Results location:** `/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-pre-edit/2026-09-09T18-51-41-970Z`
- **Dataset:** `pre-edit-context` (`3` queries).
- **Artifacts:**
  - [Summary JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-pre-edit/2026-09-09T18-51-41-970Z/summary.json)
  - [Per-query JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-pre-edit/2026-09-09T18-51-41-970Z/per-query.json)
- **Observed metrics:** `Hit@5` `100.00%`, `MRR@10` `0.8333` (raw `0.8333333333333334`), latency `p95 120.134ms`, wall-time annotation from agent `95120.134ms`.
- **Failure buckets:**
  - `docs/tests outranking source` (1): `edit-context-unresolved-fallback`
  - `wrong-file` (0)
  - `wrong-symbol` (0)
  - `no relevant hit in top-k` (0)

## Observed run context and caveats
- User-provided run annotation reports one run not showing superiority and wall-time-style figure of `95332.190ms`; this value is not present in `summary.json` and is retained here only as external run context.
- All benchmark claims in this document are **measurement-only** and not implementation-complete claims.
- Full scope includes the original representative baseline and additional non-cold saved-index runs.
- No source or changelog edits were performed.
