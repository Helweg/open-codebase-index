# Evaluation Harness

This project ships a first-class retrieval evaluation harness with CLI subcommands, versioned golden datasets, comparison mode, parameter sweeps, CI gating, and timestamped artifacts.

## Commands

### Run evaluation

```bash
npm run eval -- --dataset benchmarks/golden/small.json
```

To measure the same automatic definition-versus-concept routing used by the
agent-facing `codebase_context` gateway, run:

```bash
npm run eval:agent
```

Run the pre-edit-context dataset to exercise the edit-context path and any graph-neighbor checks:

```bash
npm run eval:pre-edit
```

Run the agent-facing dataset with its matching quality and context-efficiency gates:

```bash
npm run eval:agent:ci
```

Run the hand-labeled representative retrieval kernel:

```bash
npm run eval:representative
```

`benchmarks/golden/representative.json` is a compact, versioned quality set for
exact and nested definitions, conceptual source discovery, TypeScript, Rust,
Swift, and PHP, scoped file and directory filters, filter-relaxation recovery,
graded multi-file evidence, similarity, keyword-heavy retrieval, and a strict
negative filtered search. It complements the larger existing datasets rather
than replacing them.

Version 2 golden queries can declare:

- `language`, `difficulty`, and bounded `tags` for per-query diagnostics
- `args.symbol`, `args.fileType`, and `args.directory`, which the runner passes
  through the same search/context paths used by production tools
- `args.callerLimit`, `args.calleeLimit`, and `args.tokenBudget`, which control
  `edit-context` graph expansion depth and response budget
- `expected.expectedRoute`, `expected.expectedOutcome`, and
  `expected.recoveryExpectation`
- `expected.gradedEvidence`, whose entries identify a repository-relative path,
  optional exact symbol, and relevance grade from 1 to 3

The pre-edit path additionally supports:

- `expected.graphNeighbor` with:
  - `direction`: `caller` or `callee`
  - one of `filePath` or `symbol` (at least one required)

Hit and reciprocal-rank metrics require both the labeled path and symbol when a
symbol is present. nDCG uses the relevance grades. Legacy `filePath` and
`acceptableFiles` labels remain supported as binary alternatives. Expected
paths are matched as exact repository-relative paths or as suffixes of absolute
result paths, never in the reverse direction. The per-query artifact retains
the declared axes plus route, outcome, and recovery matches for diagnosis.

This kernel measures retrieval and context packing on this repository. It does
not prove end-to-end agent success or universal state-of-the-art quality. Keep
cross-repository, provider-specific, latency, and production telemetry evidence
separate when making broader claims.

Generate the deterministic privacy-safe effectiveness report without embeddings, network access, or repository indexing:

```bash
npm run eval:effectiveness
```

This command evaluates five versioned synthetic scenarios only. Each scenario supplies one fixed ranked result list. Context, peek, and the exact-search snippet baseline receive the same first `maxResults` objects and the same final-response `tokenBudget`. Evidence recall is computed only from evidence markers visibly present in each final budgeted response. Context and peek are metadata-oriented here, so fixture result metadata does not receive hidden source-evidence credit. The oracle baseline emits only exact matching source lines from the capped objects and performs no arbitrary or complete file reads. There are no warmups, one deterministic formatting/token-count run per fixture, no latency measurements, and no embeddings, repository indexing, randomness, clocks, or network calls. Tokens use `cl100k_base`; reports aggregate median and nearest-rank p95 token counts plus mean/median/minimum final-text evidence recall across fixtures. The generator is run twice during validation and the outputs must be byte-identical.

The checked-in report at `benchmarks/baselines/privacy-safe-effectiveness.json` contains aggregate methodology and route statistics only. It contains no fixture source, symbols, paths, repository names, queries, scenario IDs, or evidence identifiers. This is a synthetic formatting comparison with fixed rankings and oracle markers. It excludes discovery cost and does not measure retrieval quality, latency, end-to-end agent success, causal impact, or production-repository performance.

The deterministic local ranker also has a focused fixed-candidate comparison:

```bash
npx vitest run tests/intent-aware-ranking-eval.test.ts
```

`benchmarks/fixtures/intent-aware-ranking.json` contains eight representative coding-agent queries for exact and Unicode-normalized definitions, test/docs/config/call-flow intent, evidence diversity, and a conceptual-search guardrail. The baseline sorts the supplied candidates by retrieval score and id, while the candidate run applies only the local intent-aware ranker. `benchmarks/baselines/intent-aware-ranking.json` records evidence recall@3 and MRR plus per-query values. The candidate pools and relevance ids are hand-labeled and fixed, so this comparison isolates post-retrieval ordering. It does not measure embedding recall, candidate generation, indexing quality, latency, external rerankers, production repositories, or end-to-end agent success.

The opt-in community signal has a separate transparent comparison:

```bash
npx vitest run tests/community-ranking-eval.test.ts
```

`benchmarks/fixtures/community-aware-ranking.json` compares supplied-score ordering with the local community boost on three fixed pools, including an improvement case and no-regression guardrails. `benchmarks/baselines/community-aware-ranking.json` records aggregate and per-query MRR. This isolates ordering only; it does not measure embedding recall, community-detection quality, indexing latency, or end-to-end agent success.

Opt-in runtime effectiveness counters complement these synthetic reports. `index_metrics` exposes fixed aggregate counters plus bounded per-route outcome, result-count, latency, and returned-token histograms. These route-specific views can reveal that one route has a higher no-result rate or larger response buckets, but they remain process-memory-only and contain no queries, paths, symbols, source, repository identity, or raw measurements. They cannot establish causal end-to-end agent success or compare trends across process restarts.

Evaluation comparisons require the same dataset name, version, query count, and dataset
fingerprint. Summaries created before fingerprints were added are intentionally rejected,
because matching metadata alone cannot prove that labels and query text are identical. Re-run
the trusted evaluation and follow the baseline blessing workflow below to regenerate a legacy
summary. Use the agent-context budget rather than the default search baseline when evaluating
`agent-context.json`.

Context-mode evaluation applies the production evidence packer with its default
1200-token response budget. The pack contains location evidence only, removes
overlapping same-file candidates, and round-robins across files before selecting
additional locations from the same file. Agents should drill into chosen
locations with `implementation_lookup`, `codebase_search`, or targeted file reads.

Optional flags:

- `--project <path>`: project root (default: current directory)
- `--config <path>`: config JSON path
- `--output <path>`: output root (default: `benchmarks/results`)
- `--reindex`: force a full reindex before evaluation
- `--fusionStrategy <rrf|weighted>`
- `--hybridWeight <0-1>`
- `--rrfK <number>`
- `--rerankTopN <number>`

### Eval config validation and path resolution

The eval runner accepts `--config <path>` and loads the same config shape used by the main plugin, but it now validates that shape earlier and with file-specific errors.

Expected field shapes at the eval config boundary:

- `knowledgeBases`, `additionalInclude`, `include`, `exclude` must be arrays of strings
- `customProvider`, `indexing`, `search`, `debug`, `effectivenessMetrics`, `reranker` must be objects when present
- malformed JSON fails with a file-specific parse error before evaluation starts

Relative path handling during eval config materialization is also important when `--reindex` creates a local `.opencode/codebase-index.json` boundary:

- `knowledgeBases` entries are rebased relative to the source config file location
- `additionalInclude` entries are rebased the same way

This means explicit eval config files outside the project root can safely use relative `knowledgeBases` and `additionalInclude` entries; the generated local eval config preserves the correct paths for the eval project root.

### Compare against baseline

```bash
npm run eval:compare -- --against benchmarks/baselines/eval-baseline-summary.json --dataset benchmarks/golden/medium.json
```

This runs a fresh evaluation and writes `compare.json` with metric deltas.

If the referenced baseline summary file contains malformed JSON, compare mode now fails with a file-specific summary parse error instead of a raw JSON exception.

### CI gate mode

```bash
npm run eval:ci
```

The scheduled/manual `Eval Quality Gate` uses real embeddings and uploads the generated `summary.json`, `summary.md`, and `per-query.json` diagnostics for 14 days even when a budget fails. The daily smoke tier rejects Hit@5 below 0.75 or MRR@10 below 0.65. To keep CPU-only Ollama runs bounded, it indexes the relevant `src/indexer`, `src/adapters/opencode`, and `src/config` TypeScript source areas for four queries. A weekly full tier indexes the entire repository and runs the 14-query representative dataset across TypeScript, Rust, Swift, and PHP. Its separate measured budget keeps the same 0.75 Hit@5 floor and uses a 0.55 MRR@10 floor for the harder query mix. Contract tests ensure the smoke corpus covers its expectations and every representative evidence path and symbol remains current. The workflow also writes the latest summary to the GitHub Actions job summary. These artifacts contain the repository's checked-in evaluation dataset and result paths, not runtime effectiveness telemetry or user repository data.

Default script (explicitly scoped to the smoke dataset):

```bash
npx tsx src/cli.ts eval run --dataset benchmarks/golden/small.json --ci --budget benchmarks/budgets/default.json --against benchmarks/baselines/eval-baseline-summary.json
```

CI mode fails fast when a reindex run produces no searchable vectors, and the command exits non-zero when configured thresholds regress beyond tolerance.

### CI integration in GitHub Actions

There are two CI levels:

1. **Main CI (`ci.yml`)** runs `npm run eval:smoke` with a local mock embedding server (`scripts/eval-mock-embeddings-server.mjs`) and `.github/eval-config.json`.
   - Purpose: verify eval harness integrity (CLI, schema validation, artifact writing, report generation) without external dependencies.
   - This is **not** a retrieval-quality signal.

2. **Quality gate workflow (`eval-quality.yml`)** runs the real retrieval evaluation with a local Ollama provider or explicit provider secrets.
   - Purpose: enforce actual quality/latency regressions against baselines/budgets.
   - The focused smoke tier runs daily at 03:00 UTC.
   - The full-repository representative tier runs Sundays at 04:00 UTC.
   - Manual runs expose a required `smoke` or `full` tier selector.
   - By default, both tiers install Ollama on the runner and pull `nomic-embed-text`. Smoke uses `benchmarks/budgets/ollama.json`; full uses `benchmarks/budgets/representative.json`.
   - If `EVAL_EMBED_BASE_URL` and `EVAL_EMBED_API_KEY` are both set, those explicit provider credentials override Ollama. Smoke uses the stricter baseline-driven budget in `benchmarks/budgets/default.json`; full retains its representative absolute budget because the checked-in baseline targets the smoke dataset.

This split keeps regular CI stable while preserving meaningful retrieval-quality gating.

### Authentication for `eval-quality.yml`

Default path (no API key required):

- The workflow installs and starts Ollama on the GitHub-hosted runner.
- Model: `nomic-embed-text`
- Dimensions: `768`
- Budgets: `benchmarks/budgets/ollama.json` for smoke and `benchmarks/budgets/representative.json` for full

GitHub Models was retired on July 30, 2026. The local Ollama path replaces that retired service and keeps the scheduled gate independent of external embedding credentials. It uses an absolute-floor budget instead of a provider-specific relative baseline.

Optional override for another OpenAI-compatible provider:

Configure these GitHub repository secrets:

- `EVAL_EMBED_BASE_URL` (required for override) — OpenAI-compatible base URL ending in `/v1` when applicable
- `EVAL_EMBED_API_KEY` (required for override)
- `EVAL_EMBED_MODEL` (optional, default `text-embedding-3-small`)
- `EVAL_EMBED_DIMENSIONS` (optional, default `1536`)

If you set one of `EVAL_EMBED_BASE_URL` or `EVAL_EMBED_API_KEY`, you must set both. Partial override configuration fails fast.

The workflow materializes `.github/eval-quality-config.json` for the selected provider and runs:

```bash
npx tsx src/cli.ts eval run --dataset benchmarks/golden/small.json --config .github/eval-quality-config.json --reindex --ci --budget benchmarks/budgets/default.json --against benchmarks/baselines/eval-baseline-summary.json
```

#### Example values

- Ollama in Actions (default):
  - installed and started by the workflow
  - model `nomic-embed-text`
  - uses `benchmarks/budgets/ollama.json`

- OpenAI direct:
  - `EVAL_EMBED_BASE_URL=https://api.openai.com/v1`
  - `EVAL_EMBED_API_KEY=<your OpenAI-compatible API key>`
  - `EVAL_EMBED_MODEL=text-embedding-3-small`
  - `EVAL_EMBED_DIMENSIONS=1536`
  - uses `benchmarks/budgets/default.json` plus `benchmarks/baselines/eval-baseline-summary.json`

- Gateway/proxy (LiteLLM, vLLM, OpenRouter-like OpenAI-compatible endpoint):
  - `EVAL_EMBED_BASE_URL=https://your-gateway.example.com/v1`
  - `EVAL_EMBED_MODEL=<gateway embedding model id>`
  - `EVAL_EMBED_DIMENSIONS=<model output dimensions>`

If dimensions do not match returned vectors, eval fails fast with a clear mismatch error.

### Ollama quality gate (manual/local)

If you do not have OpenAI API access, run the quality gate locally with Ollama:

- Config: `.github/eval-ollama-config.json`
- Command: `npm run eval:ci:ollama`

Prerequisites:

1. Ollama installed and available in `PATH`
2. `ollama serve` running on `127.0.0.1:11434`
3. `nomic-embed-text` pulled (`ollama pull nomic-embed-text`)

### Parameter sweeps

Run sweeps by passing comma-separated values:

```bash
npm run eval -- \
  --dataset benchmarks/golden/small.json \
  --sweepFusionStrategy rrf,weighted \
  --sweepHybridWeight 0.3,0.5,0.7 \
  --sweepRrfK 30,60 \
  --sweepRerankTopN 10,20
```

The harness emits an aggregate `compare.json` containing all runs and best configurations.

## Golden dataset schema

Golden sets are versioned JSON files:

- `benchmarks/golden/small.json`
- `benchmarks/golden/medium.json`
- `benchmarks/golden/large.json`
- `benchmarks/golden/agent-context.json`
- `benchmarks/golden/pre-edit-context.json`

Schema:

```json
{
  "version": "1.0.0",
  "name": "small",
  "description": "optional",
  "queries": [
    {
      "id": "def-rank-hybrid-results",
      "query": "where is rankHybridResults implementation",
      "queryType": "definition",
      "retrievalMode": "context",
      "expected": {
        "filePath": "src/indexer/index.ts",
        "acceptableFiles": ["src/indexer/index.ts"],
        "symbol": "rankHybridResults",
        "branch": "optional-branch-name"
      }
    }
  ]
}
```

### `queryType`

Allowed values:

- `definition`
- `implementation-intent`
- `similarity`
- `keyword-heavy`
- `conceptual`

### `retrievalMode`

- `search` (default) evaluates the raw hybrid search path.
- `context` evaluates agent-facing gateway behavior. Confident symbol queries
  use authoritative definition lookup; other questions use conceptual search.
- `edit-context` evaluates the edit workflow context path. If symbol resolution is
  successful, route and resolved-route metrics will report `definition`.
  Otherwise they remain `search`. This mode passes through
  `args.tokenBudget`, `args.callerLimit`, and `args.calleeLimit`.

The per-query artifact records both `resolvedRoute` and `routedQuery`, making
automatic routing decisions visible rather than hiding them inside aggregate
quality scores.

### `expected.graphNeighbor`

`expected.graphNeighbor` is a single-hop follow-up assertion used by
`graphNeighborRecall`. The evaluator matches a result when:

- `graphDirection` equals `expected.direction`
- `filePath` matches the expected path (exact or suffix)
- if `symbol` is provided, chunk `name` equals that symbol

Important caveats:

- Only queries that declare `expected.graphNeighbor` are included in the
  `graphNeighborRecall` denominator.
- In non-`edit-context` retrieval modes, graph direction metadata is typically
  absent, so this metric is usually not recoverable there.
- `callee` matching depends on successful edit-context target resolution and
  emitted callee detail.

### `expected`

Required: at least one of:

- `expected.filePath` (exact target)
- `expected.acceptableFiles` (acceptable target list)

Optional:

- `expected.symbol`
- `expected.branch`
- `expected.graphNeighbor`

Validation errors are surfaced with clear path-specific messages (e.g. `queries[2].expected.acceptableFiles must be an array of strings`).

## Metrics

The harness computes:

Context response budgets and response-token metrics use the `cl100k_base` tokenizer rather than a character heuristic.

- Hit@1, Hit@3, Hit@5, Hit@10
- MRR@10
- nDCG@10
- Graph-neighbor recall (for queries declaring `expected.graphNeighbor`)
- Latency p50/p95/p99
- Token estimate + embedding call counts + estimated embedding cost
- Context response-token total/average/p95/max
- Context duplicate-candidate and selected-file ratios
- Context Hit@5 and MRR@10 per 1,000 returned response tokens
- Failure buckets:
  - `wrong-file`
  - `wrong-symbol`
  - `docs-tests-outranking-source`
  - `no-relevant-hit-top-k`

The separate `npm run eval:effectiveness` report uses:

- median and nearest-rank p95 returned-token counts across synthetic fixtures
- final-text evidence recall = expected literal evidence markers visible after route budgeting / expected evidence markers
- a versioned oracle exact-search snippet baseline that emits matching lines only and excludes discovery cost
- byte-stable JSON output with no network calls and no raw fixture content in the report

## Artifact layout

Each run writes to:

`benchmarks/results/<timestamp>/`

Files:

- `summary.json` — machine-readable summary
- `summary.md` — human markdown report
- `per-query.json` — per-query details and top-k hits
- `compare.json` — baseline deltas or sweep aggregate (when baseline/sweep used)

For reproducible multi-repository comparison methodology and disclosure controls,
see [Public Benchmark Matrix](./public-benchmark-matrix.md).

## Baseline blessing workflow

1. Run a trusted evaluation:

   ```bash
   npm run eval -- --dataset benchmarks/golden/medium.json
   ```

2. Copy the generated `summary.json` into the baseline path:

   ```bash
   cp benchmarks/results/<timestamp>/summary.json benchmarks/baselines/eval-baseline-summary.json
   ```

3. Re-run compare:

   ```bash
   npm run eval:compare -- --against benchmarks/baselines/eval-baseline-summary.json
   ```

4. If deltas are expected and acceptable, keep the updated baseline in version control.

## CI budget tuning

Budget file: `benchmarks/budgets/default.json`

Example:

```json
{
  "name": "default-eval-budget",
  "baselinePath": "benchmarks/baselines/eval-baseline-summary.json",
  "failOnMissingBaseline": true,
  "thresholds": {
    "hitAt5MaxDrop": 0.03,
    "mrrAt10MaxDrop": 0.03,
    "p95LatencyMaxMultiplier": 1.35,
    "p95LatencyMaxAbsoluteMs": 4000,
    "minHitAt5": 0.4,
    "minMrrAt10": 0.25,
    "minRouteAccuracy": 0.75,
    "minOutcomeAccuracy": 0.75,
    "maxContextResponseTokensAverage": 1000,
    "maxContextResponseTokensP95": 1200,
    "maxContextResponseTokensMax": 1200,
    "maxContextDuplicateCandidateRatio": 0.5,
    "minContextSelectedFileRatio": 0.5,
    "minContextHitAt5Per1kResponseTokens": 0.5,
    "minContextMrrAt10Per1kResponseTokens": 0.25
  }
}
```

Guidance:

- Tighten `hitAt5MaxDrop` / `mrrAt10MaxDrop` gradually.
- Keep `p95LatencyMaxMultiplier` tolerant enough for CI variance.
- Use absolute floor metrics (`minHitAt5`, `minMrrAt10`) to prevent silent quality drift.
- Keep context response caps at or below the production default unless a dataset intentionally exercises a larger `tokenBudget`.
- Add route/outcome gates (`minRouteAccuracy`, `minOutcomeAccuracy`) for datasets that assert `expectedRoute`/`expectedOutcome` so fallback behavior is enforced as an observable quality signal.
- Track quality-per-token floors together with absolute quality so smaller responses do not pass by becoming less useful.
- Duplicate-candidate gates measure retrieval waste before packing; the selected-file floor prevents evidence from concentrating in too few files.
