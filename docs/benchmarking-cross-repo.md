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
- Local Ollama daemon reachable at `OLLAMA_HOST` (default `http://localhost:11434`)
- Installed Ollama embedding model `nomic-embed-text`
- `rg` installed
- `sg` installed (`brew install ast-grep` on macOS)
- `npx` (for opt-in CodeGraph and `codebase-memory-mcp` execution)

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

# Enable codebase-memory-mcp comparator (scoped to definition queries with expected.symbol)
npx tsx scripts/cross-repo-benchmark.ts --repos /path/to/repo1,/path/to/repo2 --codebase-memory-mcp
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

The runner uses `@colbymchenry/codegraph@1.5.0` in a fresh temporary copy for every repeat. It excludes existing `.codegraph`, `.codebase-index`, build outputs, dependencies, and benchmark results. It initializes CodeGraph in that copy, then runs only generated queries that include `expected.symbol`. Exact-definition candidates from known unsupported paths, currently `.github/workflows/`, plus test, fixture, and documentation paths are excluded because the comparison uses the plugin's source-intent definition route. If no supported definition candidates remain, the runner fails instead of publishing an invalid comparison.

The report places this result in a standalone **Fair CodeGraph Comparator** section. Plugin metrics are recomputed from exactly the same query IDs. A failed CodeGraph initialization, query, or strict-output parse disqualifies that repeat and prevents it from being presented as a comparable result. Raw commands, per-query results, scope IDs, and errors are written under `<run>/codegraph/<repo>/repeat-*.json`.

The comparator intentionally omits latency in the CodeGraph row because each `codegraph query` invocation is measured through `npx`, which includes one-shot CLI process startup. This makes the timing comparable only to plugin-side warm eval timings and is not a fair latency comparison without additional normalization.

## codebase-memory-mcp fair comparator

Run the opt-in, fixed-version comparator with `--codebase-memory-mcp`:

```bash
npx tsx scripts/cross-repo-benchmark.ts \
  --repos /path/to/repo \
  --reindex --repeats 3 --codebase-memory-mcp
```

The runner invokes the exact package `codebase-memory-mcp@0.8.1` directly through `npx`; it does not run a separate install command and does not write agent configuration. Every repeat creates one fresh isolated source copy and sets `CBM_CACHE_DIR` to a repeat-local directory inside that copy, so the comparator does not read or write global cache state. It initializes the copy with the package CLI's `index_repository` command and uses the returned `project` value for all `search_graph` calls in that repeat. Generated candidates remain aligned with the runner's existing plugin file sampling and controlled file-size configuration because comparator scope is derived only from the same generated dataset.

The comparator scores only generated `definition` queries with a non-empty `expected.symbol`. Each query uses an anchored, regex-escaped `name_pattern`. Because the CLI returns file-level results without scores or start/end spans, the runner assigns a deterministic rank-derived score (`1 / rank`) and does not fabricate source spans. Result paths must resolve inside the isolated repository or the repeat is disqualified.

The report places results in a standalone **Fair codebase-memory-mcp Comparator** section. Plugin metrics are recomputed from exactly the same query IDs. Malformed init or query JSON, path escapes, and failed init or query invocations disqualify the repeat instead of recording a zero score. Raw commands, stdout, parsed result JSON, file-level candidates, scope IDs, and errors are written under `<run>/codebase-memory-mcp/<repo>/repeat-*.json`. Latency is omitted from the comparison table because each query timing includes one-shot `npx` CLI process startup.

## Output artifacts

Each run writes to:

- `benchmarks/results/cross-repo/<timestamp>/report.md`
- `benchmarks/results/cross-repo/<timestamp>/report.json`
- `benchmarks/results/cross-repo/<timestamp>/repos/<repo>.json`
- `benchmarks/results/cross-repo/<timestamp>/datasets/<repo>.json`
- `benchmarks/results/cross-repo/<timestamp>/codegraph/<repo>/repeat-<n>.json` when `--codegraph` is enabled
- `benchmarks/results/cross-repo/<timestamp>/codebase-memory-mcp/<repo>/repeat-<n>.json` when `--codebase-memory-mcp` is enabled

When `--persist-datasets` is set, auto-generated dataset files are also written to:

- `benchmarks/golden/cross-repo/<repo>.json`
