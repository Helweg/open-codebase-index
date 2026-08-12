# Local embedding model comparison

This note records a local-only comparison of tested Ollama embedding models.
It is guidance for choosing a model, not a claim of general retrieval
superiority. Model quality, latency, memory use, and index size depend on the
repository, hardware, and query mix.

## Recommendation

| Use case | Model | Why |
|---|---|---|
| Default and smallest tested download | `nomic-embed-text` | Fastest tested cross-repository latency and the project default |
| Balanced local quality | `embeddinggemma` | Best representative MRR and a cross-repository MRR tie with Qwen 0.6B |
| Maximum tested local quality | `qwen3-embedding:0.6b` | Best measured cross-repository nDCG |

All three models achieved 100% Hit@5 in the frozen five-repository cohort, so
the ranking differences below are small. Use Nomic when minimizing local model
storage and latency matters more than those differences. Changing a model
requires rebuilding the index.

## Representative cohort

- **Inputs:** 17 reviewed retrieval queries from the representative v2.2.0
  dataset.
- **Protocol:** local Ollama, RRF search configuration, forced reindex per
  model, then warm query measurements.
- **Environment:** local Apple silicon development machine on 2026-08-12.

| Model | Download size | Hit@5 | MRR@10 | p95 query latency |
|---|---:|---:|---:|---:|
| `nomic-embed-text` | 274 MB | 68.75% | 0.5818 | 406 ms |
| `embeddinggemma` | 621 MB | 81.25% | **0.6667** | 513 ms |
| `mxbai-embed-large` | 669 MB | 81.25% | 0.5693 | 439 ms |
| `bge-m3` | 1.2 GB | 81.25% | 0.5885 | 538 ms |
| `qwen3-embedding:0.6b` | 639 MB | **87.50%** | 0.5703 | 532 ms |

`qwen3-embedding:4b` was also downloaded, but the full representative run did
not finish inside the 10-minute evaluation timeout. It is therefore excluded
from comparisons and recommendations.

## Frozen cross-repository cohort

- **Inputs:** five pinned repositories, Axios, Express, Click, Cobra, and
  ripgrep. The frozen cohort contains nine reviewed queries per repository, 45
  total, across JavaScript, Python, Go, and Rust.
- **Inputs and revisions:**
  [`benchmarks/golden/expanded-cross-repo/`](../../benchmarks/golden/expanded-cross-repo/).
- **Protocol:** one forced-reindex run per model, followed by warm retrieval
  queries. Results are equal-repository averages, not a pooled query average.
- **Comparability:** all three models had Hit@5 of 100%. The Qwen run was split
  after the five-repository harness reached its 10-minute process timeout on
  the final repository. Its first four repository artifacts and the separately
  completed ripgrep run used the same frozen inputs and protocol.

| Model | Hit@5 | MRR@10 | nDCG@10 | Per-repo p95 query latency |
|---|---:|---:|---:|---:|
| `nomic-embed-text` | 100.00% | 0.9222 | 0.9002 | 292 to 306 ms |
| `embeddinggemma` | 100.00% | **0.9407** | 0.9038 | 382 to 398 ms |
| `qwen3-embedding:0.6b` | 100.00% | **0.9407** | **0.9203** | 308 to 448 ms |

The cohort is deliberately small and hand-reviewed. Treat it as a regression
signal and a starting point for local selection, then reproduce it against
your repositories with the cross-repository benchmark runner:

```bash
ollama pull qwen3-embedding:0.6b
npx tsx scripts/cross-repo-benchmark.ts \
  --repos /path/to/repo1,/path/to/repo2 \
  --dataset-dir benchmarks/golden/expanded-cross-repo \
  --embedding-model qwen3-embedding:0.6b \
  --reindex --skip-ripgrep --skip-sg
```
