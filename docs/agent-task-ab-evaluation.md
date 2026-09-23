# Multi-repository agent-task A/B scaffold

This scaffold defines a narrow contract for comparing the same coding agent with
Open Codebase Index disabled (`no-ocbi`) and enabled (`ocbi`) on fresh tasks that
require evidence or changes across at least two repositories.

It complements the retrieval harness in [evaluation.md](evaluation.md) and the
fairness and disclosure requirements in
[public-benchmark-matrix.md](public-benchmark-matrix.md). It does not replace
either document.

## Current boundary

`src/eval/agent-task-ab.ts` is a library scaffold, not a registered CLI. It
provides:

- strict runtime validation for datasets
- deterministic, seed-controlled, balanced arm ordering
- an injectable isolated-workspace preparation contract
- an injectable process execution contract with time and transcript limits
- trial records containing agent/verifier status, duration, optional bounded
  transcripts, optional token/tool usage, and optional repository patches
- paired comparison with complete-pair checks and an exact two-sided sign test

The included tests exercise the contract with fake adapters. They do not run a
real agent, clone repositories, establish index readiness, execute third-party
verifiers, or constitute end-to-end acceptance evidence. A public executable
adapter remains a follow-up. This is intentionally stated rather than implying
that a real A/B experiment has run.

## Dataset contract

A version `1.0.0` dataset contains:

- a preregistration id and creation time
- primary metric `task-success`
- analysis `paired-exact-sign-test`
- at least two repositories, each pinned to a full 40-character commit hash
- tasks referencing at least two of those repositories
- a task prompt and deterministic verifier command

The schema rejects unknown fields. In particular, task records cannot embed
`expectedOutcome`, arm-specific hints, or claimed results. Repository URLs and
commit hashes identify inputs, not outcomes.

Example shape, with placeholders rather than invented benchmark tasks:

```json
{
  "version": "1.0.0",
  "name": "preregistered-cross-repo-agent-tasks",
  "preregistration": {
    "id": "replace-before-running",
    "createdAt": "2026-09-23T15:00:00Z",
    "primaryMetric": "task-success",
    "analysis": "paired-exact-sign-test"
  },
  "repositories": [
    {
      "id": "repo-a",
      "url": "REVIEWED_LOCAL_OR_REMOTE_URL",
      "revision": "FULL_40_CHARACTER_COMMIT_HASH"
    },
    {
      "id": "repo-b",
      "url": "REVIEWED_LOCAL_OR_REMOTE_URL",
      "revision": "FULL_40_CHARACTER_COMMIT_HASH"
    }
  ],
  "tasks": [
    {
      "id": "fresh-task-id",
      "repositoryIds": ["repo-a", "repo-b"],
      "prompt": "PREREGISTERED_TASK_PROMPT",
      "verifier": {
        "command": "REVIEWED_EXECUTABLE",
        "args": ["REVIEWED_ARGUMENT"]
      }
    }
  ]
}
```

Do not publish a placeholder manifest as a benchmark dataset.

## Required experimental protocol

Before observing either arm:

1. Create genuinely fresh tasks. Existing golden datasets, holdouts, previous
   benchmark tasks, and tasks used during development are not fresh evidence.
2. Pin every repository revision and preregister the task set, seed, primary
   metric, exclusions, timeout policy, and analysis.
3. Review every prompt and verifier independently of arm assignment. Verifiers
   must assess observable task requirements across all referenced repositories.
4. Use the same agent, model, prompt, task set, token cap, tool-call cap, time
   cap, environment, and repository revisions in both arms. Only OCBI
   availability/configuration may differ.
5. Prepare a clean isolated workspace for every task-arm pair. Never let one
   arm observe the other arm's files, transcript, index, or result.
6. Build/check indexes before timing separately. Index readiness is owned by the
   experiment operator and is not implemented by this scaffold.
7. Use the declared public seed. Ordering is balanced so the first arm differs
   by at most one task when the task count is odd.
8. Grade with the preregistered verifier. Where human judgment is necessary,
   blind graders to the arm and use a written rubric plus disagreement process.
9. Retain enough evidence for audit: verifier output, exit status, duration,
   token/tool counts when the agent exposes them, and reviewed patches. Report
   missing metadata as missing rather than estimating it.
10. Report all preregistered tasks, failures, exclusions, and protocol changes.

The comparator rejects missing/duplicate arms, dataset fingerprint mismatches,
repository mismatches, unequal run controls, and success flags inconsistent
with agent/verifier status.

## Security and evidence handling

A dataset verifier is trusted executable code. Do not execute an unreviewed
third-party manifest. A future CLI must require explicit opt-in, invoke commands
without a shell, verify pinned local checkouts, bound output, and isolate each
trial.

Transcripts and patches can contain credentials or private source. Execution
adapters should omit them by default unless required, cap them with
`maxTranscriptBytes`, redact secrets before persistence, and store artifacts in
an access-controlled location. Never serialize environment variables or auth
material into trial records. The library passes only declared evaluation
metadata to the adapter and does not itself persist results.

## Interpretation

`task-success` means the independent task verifier passed after the agent exited
successfully. It is not the retrieval harness's `minOutcomeAccuracy`, which
measures whether a context-routing result matched a declared retrieval outcome.

Every comparison is marked `exploratory: true`. The success-rate difference and
exact sign-test p-value describe only the preregistered paired sample. They do
not establish causality outside the protocol, generalize to other repositories
or agents, or support automatic state-of-the-art claims. Synthetic adapter tests
are contract tests only and cannot be the sole evidence for product claims.
