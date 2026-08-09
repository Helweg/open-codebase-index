# Expanded cross-repo mixed-intent benchmark pilot

This reproducible local benchmark expands the frozen five-repository definition pilot with keyword-heavy, implementation-intent, and conceptual retrieval. It measures a wider range of search behavior without using a remote model or paid API.

## Cohort and protocol

- **Inputs:** [`benchmarks/golden/expanded-cross-repo/`](../../benchmarks/golden/expanded-cross-repo/), nine reviewed queries per repository, 45 total.
- **Intent mix:** 25 exact-definition queries, 10 keyword-heavy production-code queries, five implementation-intent queries, and five conceptual queries across JavaScript, Python, Go, and Rust.
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

Local artifact retained at `benchmarks/results/cross-repo/2026-08-09T17-26-32-926Z/report.md`.

### All 45 queries

The plugin and ripgrep scored all nine queries for every repository. ast-grep scored the five definition and two keyword-heavy queries, 35 queries total. These are useful local baselines, not equivalent semantic-comparator claims.

| Metric | Plugin | Ripgrep | ast-grep |
|---|---:|---:|---:|
| Hit@1 | **86.67%** | 6.67% | 0.00% |
| Hit@3 | **100.00%** | 8.89% | 0.00% |
| Hit@5 | **100.00%** | 20.00% | 0.00% |
| MRR@10 | **0.9222** | 0.1139 | 0.0000 |
| nDCG@10 | **0.9002** | 0.1277 | 0.0000 |

The plugin now has no top-five miss in the 45-query cohort. The earlier Cobra flag-group query exposed that Go `_test.go` files were not recognized as tests by source-intent ranking. Test-path detection now covers Go, Rust, and Python filename conventions, and source-intent searches retain a wider candidate pool before applying production-code prioritization. The correction was verified with the real Cobra run before the full rerun.

### Exact-definition comparator scope

CodeGraph and codebase-memory-mcp currently accept exact symbol queries only. They therefore each received the same five definition queries per repository, 25 queries total. Plugin metrics below are recomputed over exactly those query IDs. Every external repeat was valid, 3/3 for every repository. Latency is excluded because one-shot external CLI startup is not comparable with in-process plugin search.

| Metric | Plugin | CodeGraph | codebase-memory-mcp |
|---|---:|---:|---:|
| Hit@1 | **96.00%** | 92.00% | 72.00% |
| Hit@3 | **100.00%** | **100.00%** | 92.00% |
| Hit@5 | **100.00%** | **100.00%** | **100.00%** |
| MRR@10 | **0.9800** | 0.9600 | 0.8400 |
| nDCG@10 | **0.9852** | 0.9705 | 0.8806 |

## Interpretation and limits

The mixed cohort is a stronger regression signal than the earlier definition-only pilot, but it is still small and hand-reviewed. It supports two bounded conclusions: the plugin leads the tested definition scope at Hit@1, and it returns reviewed production evidence in the top five for all 45 mixed queries. It does **not** establish general superiority, and it does not compare CodeGraph or codebase-memory-mcp on keyword-heavy, implementation, or conceptual retrieval because their public interfaces do not support that scope. A broader comparison should preregister more independently reviewed queries and use a common mixed-intent interface where available.
