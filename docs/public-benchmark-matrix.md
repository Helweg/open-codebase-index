# Public Benchmark Matrix

This document defines a reproducible, public-facing comparison plan for
`open-codebase-index` against retrieval alternatives for code location and context
retrieval quality tasks.

For this comparison framing and prioritized near-term priorities, see
[CodeGraph Comparison Leadership Roadmap](codegraph-comparison-leadership-roadmap.md).

Do not use this document to claim unmeasured performance.
All comparisons must be grounded in the artifacts and scripts in this repository.

## Goal

Compare comparable, fixed-task behavior for:

- symbol-location and definition discovery
- conceptual retrieval under constrained context budgets
- call-neighbor follow-up evidence (where supported by the query type)
- execution cost and latency in the same local environment

## Scope and comparison families

Compare toolchains only on the same generated or checked-in task families.
Do not compare across families with different semantics in a single aggregate.

1. `definition`: authoritative symbol lookup tasks
2. `implementation-intent`: implementation-targeted definition lookup
3. `conceptual`: behavior- or intent-oriented location tasks
4. `keyword-heavy`: literal/keyword-oriented search tasks
5. `similarity`: embedding-driven semantic retrieval tasks
6. `edit-context`: edit-oriented context tasks with graph-neighbor assertions

## Repository and revision selection criteria

Select repositories before evaluation and keep that list fixed in the matrix run.
A repository is eligible when:

- it is publicly available and stable for the test window
- it is at least 80% analyzable with the repository’s active parser set
- it has a nontrivial mix of application and library-style code
- it has at least 5k non-empty lines of source
- it is independent of `open-codebase-index` internals

For each repository, pin the revision explicitly in the run artifact:

- repository URL
- commit SHA (full 40-char SHA)
- checkout date and UTC timestamp

Do not run comparisons on moving branches.

## Fixed tool revisions and environment

- Use one commit of `open-codebase-index` for the full matrix run.
- Use one committed version of each alternative baseline for the run.
- Record:
  - package version or binary hash
  - indexer/toolchain config file path
  - Node.js runtime version
  - CPU, memory, OS, and kernel version

If tooling revisions change, start a new matrix entry.

## Metrics recorded

Report both aggregate and per-query values.

- Hit@1, Hit@3, Hit@5, Hit@10
- MRR@10
- nDCG@10
- Latency p50, p95, p99 (query runtime only)
- Query token estimate (where applicable)
- Returned response tokens
- Duplicate-candidate ratio
- Selected-file ratio
- Graph-neighbor recall (only for `edit-context` queries with `expected.graphNeighbor`)

## Fairness controls

Apply identical controls to every compared method.

- fixed dataset fingerprints and query order per family
- fixed random seeds (when applicable)
- single cold/warm indexing policy documented explicitly
- equal candidate caps and budgets where possible
- equal timeouts and retry policy
- identical directory/file filters
- same host machine for all methods in a matrix cell
- at least 2 repeats per cell with median aggregation
- clear treatment of failures, parse truncation, and empty results

## Disclosure rules

Each published matrix result must include:

- full command lines used
- number of runs and chosen aggregates
- repository list and pinned SHAs
- exact budget values (`tokenBudget`, `topK`, ranking settings)
- number of excluded queries and exclusion reasons
- unmeasured columns, if any (left blank is not acceptable)
- known caveats:
  - query families that were out-of-scope for a comparator
  - parsing/index caps
  - availability differences in graph-neighbor output

No section should state global superiority from a single metric.

## Phased gates

Run gates in order and stop on gate failure.

1. **Smoke gate**
   - one repository
   - one baseline against one alternative
   - minimal repeats
   - checks script execution, schema validation, and basic quality floors

2. **Expanded gate**
   - all selected repositories
   - all task families
   - repeats with median aggregation
   - checks quality and latency regressions against previous matrix row

3. **Publication gate**
   - publish only if all above gates pass
   - include raw artifacts and `disclosure` block
   - keep scripts and inputs unchanged after execution

## Comparator interface requirements

Automated per-query retrieval metrics require structured result output from each comparator.

Tools that only provide text-only contextual exploration must be evaluated in a separate
agent-level arm or through a disclosed deterministic parser. This keeps the benchmark
from granting hidden result-credit.
