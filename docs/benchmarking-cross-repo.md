# Cross-repo benchmarking

This guide documents how to run the cross-repo benchmark runner in a portable way.

## What it measures

- Plugin retrieval quality (`codebase-index`) via eval harness
- `ripgrep` keyword baseline
- `ast-grep` structural baseline

Metrics reported per repo and aggregated:

- Hit@1/3/5/10
- MRR@10
- nDCG@10
- Latency p50/p95/p99

## Prerequisites

- Built project dependencies (`npm install`)
- `rg` installed
- `sg` installed (`brew install ast-grep` on macOS)
- `npx` (for `codegraph` execution)

## Configure repositories (required)

You must provide repository paths explicitly.

Option A: CLI flag

```bash
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2
```

Option B: environment variable

```bash
export BENCHMARK_REPOS=/path/to/repo1,/path/to/repo2
npx tsx scripts/cross-repo-benchmark.ts
```

## Reindex modes

- Default: `--no-reindex` behavior (fast iteration, reuses existing index)
- `--reindex` applies on repeat #1 only, then repeat runs measure query-time behavior on a warm index

Examples:

```bash
# Fast iteration (default)
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2

# Clean baseline
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --reindex

# Repeat runs for stable medians (recommended)
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --repeats 20
```

## Sampling and mutability notes

- By default, generated datasets are written under each run output directory (`<run>/datasets/`) to keep committed benchmark inputs immutable.
- Persist generated datasets to `benchmarks/golden/cross-repo/` only when explicitly needed:

```bash
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --persist-datasets
```

- File parsing is capped (`--max-parse-files`, default `2500`). Reports include whether truncation occurred.

## Optional baseline toggles

```bash
# Skip ripgrep baseline
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --skip-ripgrep

# Skip ast-grep baseline
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --skip-sg

# Enable CodeGraph baseline (scoped to queries with expected.symbol)
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --codegraph
```

Ast-grep baseline scope:

- Only `definition` and `keyword-heavy` query types are included for `sg` baseline comparisons.
- This avoids scoring ast-grep against non-structural natural-language query types that are outside AST pattern matching semantics.
- sg metrics are computed on this scoped subset only; report output includes the scoped denominator (`scoped/total`) for transparency.

## CodeGraph fair comparator

Run the opt-in, fixed-version comparator with `--codegraph`:

```bash
npx tsx scripts/cross-repo-benchmark.ts \
  --repos /path/to/repo \
  --reindex --repeats 3 --codegraph
```

The runner uses `@colbymchenry/codegraph@1.5.0` in a fresh temporary copy for every repeat. It excludes existing `.codegraph`, `.codebase-index`, build outputs, dependencies, and benchmark results. It initializes CodeGraph in that copy, then runs only generated queries that include `expected.symbol`.

The report places this result in a standalone **Fair CodeGraph Comparator** section. Plugin metrics are recomputed from exactly the same query IDs. A failed CodeGraph initialization, query, or strict-output parse disqualifies that repeat and prevents it from being presented as a comparable result. Raw commands, per-query results, scope IDs, and errors are written under `<run>/codegraph/<repo>/repeat-*.json`.

## Output artifacts

Each run writes to:

- `benchmarks/results/cross-repo/<timestamp>/report.md`
- `benchmarks/results/cross-repo/<timestamp>/report.json`
- `benchmarks/results/cross-repo/<timestamp>/repos/<repo>.json`
- `benchmarks/results/cross-repo/<timestamp>/datasets/<repo>.json`
- `benchmarks/results/cross-repo/<timestamp>/codegraph/<repo>/<repeat>/summary.json`
- `benchmarks/results/cross-repo/<timestamp>/codegraph/<repo>/<repeat>/per-query.json`

When `--persist-datasets` is set, auto-generated dataset files are also written to:

- `benchmarks/golden/cross-repo/<repo>.json`
