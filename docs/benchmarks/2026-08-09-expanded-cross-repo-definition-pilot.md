# Expanded cross-repo definition benchmark pilot

This is a reproducible comparison of exact-definition retrieval across five public repositories. It expands the earlier Axios and Express check to JavaScript, Python, Go, and Rust.

## Cohort and protocol

- **Inputs:** [`benchmarks/golden/expanded-cross-repo/`](../../benchmarks/golden/expanded-cross-repo/), five reviewed definition queries per repository, 25 queries total.
- **Pinned revisions:** recorded in [`cohort.json`](../../benchmarks/golden/expanded-cross-repo/cohort.json).
- **Repositories:** Axios, Express, Click, Cobra, and ripgrep.
- **Plugin embeddings:** local Ollama with `nomic-embed-text`.
- **Comparators:** `@colbymchenry/codegraph@1.5.0` and `codebase-memory-mcp@0.8.1`.
- **Execution:** three repeats per repository, median per repository, then average across repositories. Reindexing was applied only to the first repeat.
- **Fair scope:** all 25 frozen queries are exact-definition queries with `expected.symbol`. Plugin metrics are recomputed on exactly the query IDs passed to each comparator.
- **Isolation:** both comparators use a fresh source copy per repeat and exclude pre-existing generated index directories, including `.opencode`.

The run used:

```bash
npx tsx scripts/cross-repo-benchmark.ts \
  --repos <axios>,<express>,<click>,<cobra>,<ripgrep> \
  --dataset-dir benchmarks/golden/expanded-cross-repo \
  --reindex --repeats 3 --skip-ripgrep --skip-sg \
  --codegraph --codebase-memory-mcp
```

## Result

Local artifact retained at `benchmarks/results/cross-repo/2026-08-09T08-05-15-123Z/report.md`.

Every comparator repeat was valid: **3/3 for every repository**. External CLI startup makes latency incomparable, so the comparator tables intentionally omit it.

| Metric | Plugin | CodeGraph | codebase-memory-mcp |
|---|---:|---:|---:|
| Hit@1 | **92.00%** | 88.00% | 72.00% |
| Hit@3 | **100.00%** | **100.00%** | 96.00% |
| Hit@5 | **100.00%** | **100.00%** | **100.00%** |
| MRR@10 | **0.9600** | 0.9400 | 0.8347 |
| nDCG@10 | **0.9705** | 0.9557 | 0.8764 |

The plugin ties CodeGraph at Hit@5, leads it by one query at Hit@1, and leads codebase-memory-mcp at Hit@1 and Hit@3. By repository, the plugin leads CodeGraph only on ripgrep at Hit@1 (80% versus 60%), ties it on the other four repositories, and leads or ties codebase-memory-mcp on every repository.

## Interpretation and limits

This is an expanded, frozen **pilot**, not a claim of general superiority. Its 25 hand-reviewed queries are definition-only and small enough that one query changes Hit@1 by four percentage points. It is suitable as a reproducible regression signal and shows that the prior two-repository tie is not masking a clear loss on this multilingual cohort. A broader conclusion needs a preregistered larger cohort with independently reviewed queries, mixed retrieval intents, and a separately normalized latency protocol.
