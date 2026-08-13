# 100-query cross-repository Nomic baseline

**Date:** 2026-08-13  
**Cohort:** `benchmarks/golden/expanded-cross-repo/cohort.json` version 1.4.0  
**Model:** local Ollama `nomic-embed-text`  
**Runner:** `scripts/cross-repo-benchmark.ts` with `--reindex`, one repeat, and the default plugin, ripgrep, and ast-grep comparators.

## Scope

The run used all nine repositories at the pinned revisions from the cohort manifest:
Axios, Express, Click, Cobra, ripgrep, Gson, Newtonsoft.Json, Symfony Console,
and Sinatra. The datasets contain 100 reviewed mixed-intent queries in total.

All repositories were fully sampled under the runner's 2,500-file cap. None were
truncated.

## Aggregate plugin result

| Metric | Result |
| --- | ---: |
| Hit@1 | 74.53% |
| Hit@3 | 86.78% |
| Hit@5 | 89.21% |
| Hit@10 | 89.21% |
| MRR@10 | 80.62% |
| nDCG@10 | 74.42% |
| Query latency p50 | 254.66 ms |
| Query latency p95 | 276.93 ms |
| Query latency p99 | 298.12 ms |
| Embedding calls | 3,322 |
| Embedding tokens | 578,493 |
| Estimated embedding cost | $0.00, local Ollama |

The baseline is a single reproducible run, not a release threshold. Future
changes should be compared with the same pinned revisions, model, runner
options, and a fresh reindex. Repeat runs are appropriate when interpreting a
small delta.

## Per-repository plugin results

| Repository | Queries | Hit@1 | Hit@3 | Hit@5 | MRR@10 | nDCG@10 | p50 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Axios | 9 | 88.89% | 100.00% | 100.00% | 92.59% | 93.04% | 233 ms |
| Express | 9 | 100.00% | 100.00% | 100.00% | 100.00% | 96.28% | 216 ms |
| Click | 9 | 88.89% | 100.00% | 100.00% | 94.44% | 88.36% | 228 ms |
| Cobra | 9 | 77.78% | 100.00% | 100.00% | 87.04% | 87.83% | 156 ms |
| ripgrep | 9 | 77.78% | 100.00% | 100.00% | 87.04% | 84.60% | 258 ms |
| Gson | 9 | 66.67% | 77.78% | 88.89% | 75.19% | 59.03% | 353 ms |
| Newtonsoft.Json | 18 | 55.56% | 72.22% | 77.78% | 65.43% | 61.77% | 333 ms |
| Symfony Console | 9 | 88.89% | 88.89% | 88.89% | 88.89% | 68.76% | 273 ms |
| Sinatra | 19 | 26.32% | 42.11% | 47.37% | 34.77% | 28.64% | 243 ms |

The expanded Sinatra and Newtonsoft.Json portions intentionally make this
cohort materially harder than the prior 81-query pilot. Their lower scores are
useful diagnostic signals rather than a reason to relax or replace their
reviewed evidence.

## Reproduction

Prepare the nine repositories at the revisions in `cohort.json`, then run:

```bash
npx tsx scripts/cross-repo-benchmark.ts \
  --repos /path/to/axios,/path/to/express,/path/to/click,/path/to/cobra,/path/to/ripgrep,/path/to/gson,/path/to/newtonsoft-json,/path/to/symfony-console,/path/to/sinatra \
  --dataset-dir benchmarks/golden/expanded-cross-repo \
  --embedding-model nomic-embed-text \
  --reindex
```

The raw local artifacts for this run were written under
`$JCODE_SCRATCH_DIR/cross-repo-100-query-nomic-baseline/2026-08-13T14-11-33-769Z`.
They are intentionally not committed because they include machine-specific
paths and generated index outputs.
