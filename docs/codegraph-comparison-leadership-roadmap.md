# CodeGraph Comparison Leadership Roadmap

This is a public roadmap for the next comparison cycle against CodeGraph using the project’s existing evidence and tooling constraints. It is not a superiority claim. It is a plan for fair, reproducible, and useful public comparisons.

## Grounded evidence base

- Strong local retrieval stack already in place: `codebase_context`, `codebase_search`, and `implementation_lookup` are documented as the core workflow and are backed by local semantic + keyword retrieval with local ranking and branch-aware indexing.
- Strong graph support in the product: `call_graph`, `call_graph_path`, and `pr_impact` exist as first-class, host-exposed tools with local graph data.
- Host portability is already in the docs: installation covers OpenCode, Jcode, Pi, Codex, Claude, and generic MCP clients with host-aware paths.
- Reproducibility requirements are already formalized in the matrix: fixed repository revision pins, fixed tool revisions, matching budgets, and fixed query order are mandatory.
- External comparator visibility (CodeGraph): use only public baselines with published benchmark pages and explicit language-coverage statements so external claims remain auditable.

## Near-term roadmap (prioritized)

### 1) Fair benchmark infrastructure (highest priority)

Use one shared harness path across local and public runs with strict controls:

- Fixed pinned revisions for each matrix cell and one commit hash per run.
- Shared query sets with fixed seeds, fixed budgets, and fixed filtering.
- Cold/warm indexing policy, retries, and failure treatment encoded in `benchmarks/` artifacts.
- Per-cell medians from at least two repeats.

**Exit criteria:**
- Any published row includes a machine/runtime block, command lines, seed list, budgets, repository SHAs, and exclusion rationale.
- At least one baseline comparator cell includes full disclosures from this matrix format before publication.
- No row uses unpinned revision state or implicit defaults for query order.

### 2) Language coverage selection driven by measured demand

Build the comparison set from measured demand, not anecdotal assumptions:

- Measure query-language concentration from checked-in benchmark datasets and repo composition.
- Add or skip languages in the comparison matrix only when parser/analyzer support is already measurable and stable.
- Prefer a small set of high-demand languages first so results are timely and repeatable.

**Exit criteria:**
- Publish a language-demand table with:
  - parser-support percentage (repo-level),
  - query share per family,
  - coverage gaps flagged per language.
- Every planned matrix cohort has at least one committed dataset and one fixed-revision dataset run.

### 3) Install/onboarding polish

Reduce setup friction across hosts before adding broader comparisons:

- Create a single onboarding path from install -> `/status` -> first benchmark-sized query.
- Align host docs so each supported host (OpenCode, Jcode, Pi, Codex, Claude, generic MCP) has the same minimum ready-check sequence.

**Exit criteria:**
- New host onboarding documentation uses an identical 4-step readiness checklist.
- A fresh contributor can complete local setup and run one evaluation task using only docs.
- At least one verification checklist item in each host guide includes failure-safe fallback behavior.

### 4) Public benchmark publication

Publish only after quality gates pass and evidence is reproducible:

- Publish matrix output as versioned artifacts (per run, with dataset fingerprints).
- Maintain a changelog note per comparison cycle describing any scope or config changes.
- Make assumptions and caveats explicit in the publication.

**Exit criteria:**
- Each public artifact contains `disclosure`, reproducibility metadata, and unmeasured columns filled as `N/A` with reason.
- Every published page references the fixed-revision matrix entries and points to the corresponding local scripts.

## Non-goal

Do not state global winners from single metrics. Compare families and constraints separately, and publish confidence and caveats with each claim.

## Related docs

- [Public Benchmark Matrix](public-benchmark-matrix.md)
- [Evaluation harness](evaluation.md)
- [Installation and host setup](installation.md)

