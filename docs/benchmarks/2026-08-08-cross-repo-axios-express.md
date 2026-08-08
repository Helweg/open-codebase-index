# Cross-repo benchmark run: 2026-08-08T19-07-06-480Z

- Source artifact: `benchmarks/results/cross-repo/2026-08-08T19-07-06-480Z/report.md`
- Generated at: `2026-08-08T19:09:34.320Z`
- Output directory: `benchmarks/results/cross-repo/2026-08-08T19-07-06-480Z`
- Command: `npx tsx scripts/cross-repo-benchmark.ts --repos /Users/kenneth/dev/git/demo-repos/axios,/Users/kenneth/dev/git/demo-repos/express --reindex --repeats 3 --codegraph --codebase-memory-mcp`
- Provider setup: local Ollama at default host (`OLLAMA_HOST`), with model `nomic-embed-text`.
- Run options: `--reindex` applied on repeat #1 only, `--repeats 3`.

## Cohorts

- **axios**
  - Repo SHA: `d8233d9e8e9a64bfba9bbe01d475ba417510b82b`
  - Dataset path: `benchmarks/results/cross-repo/2026-08-08T19-07-06-480Z/datasets/axios.json`
  - Parsed files: **212**
  - Query count: **10**

- **express**
  - Repo SHA: `2cd372e34cd6613f4d00836c2ee122f28bddfcb3`
  - Dataset path: `benchmarks/results/cross-repo/2026-08-08T19-07-06-480Z/datasets/express.json`
  - Parsed files: **154**
  - Query count: **10**

## Full cross-repo aggregate (all 20 queries: plugin / ripgrep / ast-grep, scoped 5 ast-grep queries)

| Metric | Plugin | Ripgrep | ast-grep (5/10 queries) |
|---|---:|---:|---:|
| Hit@1 | 70.00% | 0.00% | 40.00% |
| Hit@3 | 80.00% | 5.00% | 40.00% |
| Hit@5 | 80.00% | 5.00% | 40.00% |
| Hit@10 | 85.00% | 5.00% | 40.00% |
| MRR@10 | 0.7389 | 0.0362 | 0.4000 |
| nDCG@10 | 0.7651 | 0.0500 | 0.4000 |
| Latency p50 (ms) | 33.14 | 35.38 | 62.88 |
| Latency p95 (ms) | 75.61 | 42.55 | 66.03 |
| Latency p99 (ms) | 81.36 | 42.93 | 66.26 |

## Fair external comparators (definition scope only)

Total definition-only scoped queries: **6 total** (axios 3/10, express 3/10), with plugin and comparator metrics recomputed from exactly the same query IDs.

- On this scope, generic module-affinity ranking was introduced for duplicate exact definition names. It improved plugin definition-scoped Hit@1/MRR from **83.33%/0.9167** to **100.00%/1.0000**.

- CodeGraph valid repeats: **3/3** for axios, **3/3** for express (6/6 combined)
- codebase-memory-mcp valid repeats: **3/3** for axios, **3/3** for express (6/6 combined)
- Latency is intentionally omitted in both external comparator tables because `npx` startup timing is included in `codegraph query` / `search_graph` measurements.

### Plugin vs CodeGraph (definition scope)

| Metric | Plugin | CodeGraph |
|---|---:|---:|
| Hit@1 | 100.00% | 100.00% |
| Hit@3 | 100.00% | 100.00% |
| Hit@5 | 100.00% | 100.00% |
| Hit@10 | 100.00% | 100.00% |
| MRR@10 | 1.0000 | 1.0000 |
| nDCG@10 | 1.0000 | 1.0000 |

### Plugin vs codebase-memory-mcp (definition scope)

| Metric | Plugin | codebase-memory-mcp |
|---|---:|---:|
| Hit@1 | 100.00% | 83.33% |
| Hit@3 | 100.00% | 100.00% |
| Hit@5 | 100.00% | 100.00% |
| Hit@10 | 100.00% | 100.00% |
| MRR@10 | 1.0000 | 0.9167 |
| nDCG@10 | 1.0000 | 0.9385 |

## Protocol reference

Run configuration and protocol details are documented in [`../benchmarking-cross-repo.md`](../benchmarking-cross-repo.md).
