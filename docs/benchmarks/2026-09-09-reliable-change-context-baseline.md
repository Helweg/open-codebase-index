# Reliable change-context baseline, 2026-09-09

## Scope and environment

- Implementation and source corpus: `e8e947f8359ee92b2fa2cea9d85efe00cd878f30`.
- Exact `git archive` extracted to a new task-specific scratch directory, with `git init -b main`. No existing user index was reindexed or deleted.
- Actual runtime: Node **26.6.0**, macOS ARM64. This is not a Node 22/24 compatibility result.
- Local Ollama `nomic-embed-text`, [existing evaluation configuration](../../.github/eval-ollama-full-config.json), unchanged defaults for unspecified settings.
- RRF fusion, weight 0.4, k=60, rerankTopN=20, maxResults=10, minScore=0. Automatic indexing and watchers disabled. No external reranker configured.
- Representative dataset v2.2.0: 17 queries, including one negative control excluded from positive-hit denominators. Fourteen context queries and three search queries.
- Pre-edit dataset v1.0.0: three edit-context queries. This is evidence retrieval, not a coding-task success evaluation.

## Reproduction

Build the baseline revision before running its CLI. Set `SNAPSHOT` to the isolated source directory and `RESULTS` to a separate artifact directory:

```bash
node dist/cli.js eval run --project "$SNAPSHOT" \
  --config "$SNAPSHOT/.github/eval-ollama-full-config.json" \
  --dataset "$SNAPSHOT/benchmarks/golden/representative.json" \
  --output "$RESULTS/baseline-representative" --reindex

node dist/cli.js eval run --project "$SNAPSHOT" \
  --config "$SNAPSHOT/.github/eval-ollama-full-config.json" \
  --dataset "$SNAPSHOT/benchmarks/golden/representative.json" \
  --output "$RESULTS/baseline-representative-repeat"

node dist/cli.js eval run --project "$SNAPSHOT" \
  --config "$SNAPSHOT/.github/eval-ollama-full-config.json" \
  --dataset "$SNAPSHOT/benchmarks/golden/pre-edit-context.json" \
  --output "$RESULTS/baseline-pre-edit"
```

The repeat and pre-edit runs reuse the saved index in new CLI processes. They are not independent cold indexing runs.

## Observed results

All three commands exited 0. No CI budget gate was requested, so exit success alone does not establish a quality threshold.

| Metric | Representative initial | Representative repeat | Pre-edit |
|---|---:|---:|---:|
| Queries | 17 | 17 | 3 |
| Hit@1 | 56.25% | 56.25% | 66.67% |
| Hit@5 | 75.00% | 75.00% | 100.00% |
| MRR@10 | 0.635417 | 0.635417 | 0.833333 |
| nDCG@10 | 0.592246 | 0.592246 | 0.876977 |
| Query latency p50 | 271.859 ms | 265.779 ms | 85.759 ms |
| Query latency p95 | 332.190 ms | 340.137 ms | 120.134 ms |
| Embedding requests | 437 | 16 | 3 |
| Reported embedding tokens | 1,108,669 | 214 | 32 |
| Context response tokens | 7,782 | 7,782 | 1,110 |

The initial embedding counts include indexing work and are not directly comparable to the saved-index query-only repeat. Reported local embedding monetary cost is zero, not zero CPU, memory or energy cost. Latencies are query latencies, not total indexing time.

## Failure inspection

Representative artifact buckets:

- `wrong-file`: `file-watcher-implementation`, `keyword-search-knobs`, `mcp-registration-concept`.
- `wrong-symbol`: `crashed-index-lock-recovery`, `embedding-failure-recovery-flow`, `similarity-rrf-fusion`.
- `no-relevant-hit-top-k`: `duplicate-definition-path-disambiguation`.
- No `docs-tests-outranking-source` bucket in representative runs.
- Negative control: `negative-strict-directory-filter`.

Buckets classify different ranking issues and are not interchangeable with the count of positive queries missing at Hit@5. The repeat has identical aggregate quality and failure buckets. Pre-edit reports graph-neighbor recall 1.0 on its small applicable set and one `docs-tests-outranking-source` bucket. A zero-valued metric with no applicable expectations is not proof of failed behavior.

## Artifact identifiers

Artifacts are retained locally under the task scratch root `ocbi-competitive-implementation-20260909/results/`, not published as portable links:

- `baseline-representative/2026-09-09T18-48-55-366Z/`
- `baseline-representative-repeat/2026-09-09T18-51-41-103Z/`
- `baseline-pre-edit/2026-09-09T18-51-41-970Z/`

Each contains `summary.json`, `summary.md` and `per-query.json`.

Dataset fingerprints reported by the evaluator:

- Representative: `674e97b28e8dd7264b63be9d1e0b6df13322a70ec1dc172a138f6a23a7220c02`.
- Pre-edit: `3eff0eeeed2703d1b0e482b1b603a81d47dca50763113dfe2e4e79804acd412e`.

## Interpretation

This establishes a reproducible current OCBI retrieval baseline and a small pre-edit baseline. It does not establish competitive superiority, completed coding-task success, whole-platform performance, or implementation completion. Post-change comparisons must retain the fixed corpus, dataset and configuration and inspect per-query deltas, not merely aggregate passing-test counts.
