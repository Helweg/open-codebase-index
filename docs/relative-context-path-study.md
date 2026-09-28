# Repository-relative context locations: paired answer check

## Decision

Retain commit `13df5d0b4f87584df9d31e94cb1ab5bb3978aa59` against parent `64575ee`. It fixes a concrete locator defect: conceptual `codebase_context` evidence within a configured project root now displays the complete repository-relative path. The public indexed operation returned such a path, and the full build, typecheck, lint and test gate passed (2,432 tests, six skipped). In a fresh, tiny real-host comparison, **exact source support improved on one of two topics and tied on the other; factual coverage tied on both**. This supports a bounded citation/auditability benefit, not a general answer-quality or accuracy claim.

## Prospective comparison

Before model inference, two new path-free conceptual questions and an eight-fact source-backed rubric per question were frozen against corpus commit `675300c129b70ffb3a28e3c454204ee65c422a34`. The questions addressed hybrid search ranking and interprocess index ownership. Parent/candidate packages were separately packed and clean-installed with identical native binding bytes and dependencies. Four fresh, read-only OpenCode 1.18.32 sessions used the same ready, compatible 6,771-chunk indexed corpus, `opencode-go/deepseek-v4.1-flash`, isolated profiles, one intended plugin each, identical full 33-tool contracts and counterbalanced order: parent/candidate, candidate/parent. Each arm allowed 480 seconds, 64 tools, 300,000 observed tokens and USD 0.10 observed cost. These are telemetry caps, not provider billing guarantees.

The first and second runner proposals were rejected before inference because they could not audit treatment exposure and then had a stale failing audit test. A separately named v3 plan and runner passed a realistic context-heading audit test, no-model preparation, actual host parity preflight and independent exact-hash review. All four v3 cells completed, with no retry or authentication failure. Answers were assigned random neutral IDs; two independent graders scored only these answers, the frozen rubric and pinned source before the arm mapping was opened. They disagreed on a hybrid conjunctive fact and on whether single-line shorthand is an invalid reference. Blind adjudication resolved fact coverage conservatively and reports ranges rather than choosing an unsupported exact invalid-reference count.

| Topic | Correct facts, parent | Correct facts, candidate | Exact-supported facts, parent | Exact-supported facts, candidate |
|---|---:|---:|---:|---:|
| Hybrid ranking | 6/8 | 6/8 | 6/8 | 6/8 |
| Mutation ownership | 7/8 | 7/8 | 2/8 | 7/8 |
| **Both** | **13/16** | **13/16** | **8/16** | **13/16** |

The parent produced **75–86** invalid reference occurrences across the two answers versus **24–28** for the candidate, reflecting graders' differing treatment of shorthand fragments. These are not all nonexistent files: basename-only, pathless `:line` references and single-line citations without a full interval account for many. Neither arm had a graded wrong claim. Candidate had one unsupported broad claim; parent had zero to one depending on adjudication of a narrow-deletion heading. The candidate is not factually superior in this sample.

Each arm invoked `codebase_context` exactly once and received a completed result, so retrieval nonuse does not explain the difference. First explicit token budgets were 2,000 for both hybrid answers, 2,500 for candidate ownership and 2,000 for parent ownership. The runner retained only bounded ordered tool names/status, budgets and source-path metadata, not raw tool requests or responses. This proves exposure to a context result but **does not prove which text the model relied upon**. The four calls used 56 tools total, 740,174 reported tokens (including cache as accounted by the runner), and USD **0.033069906** reported model cost. Index preparation, engineering and grading-agent cost are excluded.

## Boundaries and provenance

This is two topics and one completion per arm per topic. Stochastic model behavior, different first-context budgets on ownership, and the fact that both arms also read source files prevent attributing every citation difference exclusively to path formatting. The path correction is retained because its deterministic public behavior is right and this exploratory paired result is directionally consistent on source support without a measured factual loss. Do not advertise universal answer-quality improvement or statistical significance.

Owner-only study artifacts are under `~/.jcode/scratch/ocbi-relative-path-study-20260928/`. Frozen prompt SHA-256 `be5b6ecec50fcbfa997cca8d1511ebf3cb303bf0e32d96ca033ae1d5e192e306`, rubric SHA-256 `8d96a9c82fe26c42bfcfccedd1f3b4c8f2990fe8bd9ac5fa70d3e4bf7e14c555`, approved v3 plan SHA-256 `993491ee676144798d83c2d7d91a58e86a60651ba174dd410ad9b2baa28c1c59`, runner SHA-256 `b80af6c9c1bacad99564aca572cb1f21ff11e6081a9ca3a7563767b42863a4e1`, and pre-unblinding adjudication SHA-256 `7c34a9ae383ee71859a58ed68dd5bfc21d342b3401ef636e3d97bff4d1cc29a8`. The completed ledger is `ledger-068ae464-552f-47c8-abe6-dc8015953809.json`. Earlier rejected plans remain separate and are not pooled.
