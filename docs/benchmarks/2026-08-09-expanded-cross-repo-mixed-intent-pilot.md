# Expanded cross-repo mixed-intent benchmark pilot

This reproducible local benchmark expands the frozen five-repository definition pilot with keyword-heavy retrieval. It measures a wider range of search behavior without using a remote model or paid API.

## Cohort and protocol

- **Inputs:** [`benchmarks/golden/expanded-cross-repo/`](../../benchmarks/golden/expanded-cross-repo/), seven reviewed queries per repository, 35 total.
- **Intent mix:** 25 exact-definition queries and 10 keyword-heavy production-code queries across JavaScript, Python, Go, and Rust.
- **Pinned revisions:** recorded in [`cohort.json`](../../benchmarks/golden/expanded-cross-repo/cohort.json).
- **Repositories:** Axios, Express, Click, Cobra, and ripgrep.
- **Plugin embeddings:** local Ollama with `nomic-embed-text`.
- **Execution:** three repeats per repository, median per repository, then average across repositories. Reindexing was applied only to the first repeat.
- **Isolation:** CodeGraph and codebase-memory-mcp each use a fresh source copy and exclude generated index directories, including `.opencode`.

The completed run used:

```bash
npx tsx scripts/cross-repo-benchmark.ts \
  --repos <axios>,<express>,<click>,<cobra>,<ripgrep> \
  --dataset-dir benchmarks/golden/expanded-cross-repo \
  --reindex --repeats 3 --codegraph --codebase-memory-mcp
```

## Results

Local artifact retained at `benchmarks/results/cross-repo/2026-08-09T14-57-06-897Z/report.md`.

### All 35 queries

The plugin, ripgrep, and ast-grep scored all seven queries for every repository. These are useful local baselines, not equivalent semantic-comparator claims.

| Metric | Plugin | Ripgrep | ast-grep |
|---|---:|---:|---:|
| Hit@1 | **94.29%** | 5.71% | 0.00% |
| Hit@3 | **97.14%** | 11.43% | 0.00% |
| Hit@5 | **97.14%** | 20.00% | 0.00% |
| MRR@10 | **0.9571** | 0.1010 | 0.0000 |
| nDCG@10 | **0.9225** | 0.1163 | 0.0000 |

The only top-five miss was Cobra's `cobra-flag-group-validation` keyword-heavy query. Its top result was the related `flag_groups_test.go`; none of its reviewed production evidence files appeared in the top ten. The frozen cohort records that failure rather than tuning the ranking to this one result.

### Exact-definition comparator scope

CodeGraph and codebase-memory-mcp currently accept exact symbol queries only. They therefore each received the same five definition queries per repository, 25 queries total. Plugin metrics below are recomputed over exactly those query IDs. Every external repeat was valid, 3/3 for every repository. Latency is excluded because one-shot external CLI startup is not comparable with in-process plugin search.

| Metric | Plugin | CodeGraph | codebase-memory-mcp |
|---|---:|---:|---:|
| Hit@1 | **96.00%** | 92.00% | 72.00% |
| Hit@3 | **100.00%** | **100.00%** | 96.00% |
| Hit@5 | **100.00%** | **100.00%** | **100.00%** |
| MRR@10 | **0.9800** | 0.9600 | 0.8413 |
| nDCG@10 | **0.9852** | 0.9705 | 0.8817 |

## Interpretation and limits

The mixed cohort is a stronger regression signal than the earlier definition-only pilot, but it is still small and hand-reviewed. It supports two bounded conclusions: the plugin leads the tested definition scope at Hit@1, and it returns reviewed production evidence in the top five for 34 of 35 mixed queries. It does **not** establish general superiority, and it does not compare CodeGraph or codebase-memory-mcp on keyword-heavy retrieval because their public interfaces do not support that scope. A broader comparison should preregister more independently reviewed queries and use a common mixed-intent interface where available.
