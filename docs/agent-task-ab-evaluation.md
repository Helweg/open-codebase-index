# Multi-repository agent-task A/B scaffold

This scaffold defines a narrow contract for comparing the same coding agent with
Open Codebase Index disabled (`no-ocbi`) and enabled (`ocbi`) on fresh tasks that
require evidence or changes across at least two repositories.

It complements the retrieval harness in [evaluation.md](evaluation.md) and the
fairness and disclosure requirements in
[public-benchmark-matrix.md](public-benchmark-matrix.md). It does not replace
either document.

## Current boundary

`src/eval/agent-task-ab.ts` provides the reusable contract. The public
`ocbi-agent-task-ab` executable, also available from a source checkout as
`npm run eval:agent-task-ab --`, runs that contract against reviewed local Git
repositories.

## Executable path

Create two JSON files containing argv arrays. They must be materially distinct
and must configure the same agent/model with OCBI unavailable in the control
arm and available in the treatment arm. For example, the treatment argv may
name an explicitly reviewed agent configuration that registers the OCBI MCP
server, while the control argv names the matching configuration without it.
The runner uses a fresh `HOME` for every trial, so ambient user agent/plugin
configuration is not loaded.

An agent that relies on credentials in the normal home directory will not
authenticate in this environment. Configure credentials through a separately
reviewed, non-serialized mechanism for both arms before attempting a real run;
do not put secrets in argv JSON or the task manifest.

```sh
ocbi-agent-task-ab \
  --manifest ./reviewed-tasks.json \
  --no-ocbi-argv ./agent-control-argv.json \
  --ocbi-argv ./agent-treatment-argv.json \
  --artifacts ./private-results/run-001 \
  --seed published-seed \
  --agent reviewed-agent-name \
  --model pinned-model-id \
  --max-duration-ms 600000 \
  --max-output-bytes 65536 \
  --allow-verifiers
```

Each argv file is a JSON string array, not a shell command. The executable is
spawned directly without shell expansion. Repository `url` fields must be local
paths and every revision must be a full pinned commit. The output directory
must not exist. It is created mode `0700`; `result.json` is mode `0600` and
contains status/duration/comparison metadata only. Raw stdout, stderr, argv,
environment, patches, workspace paths, and repository contents are omitted.
SHA-256 digests of the two argv arrays are retained for auditability without
serializing their potentially sensitive contents. Record exact agent, model,
and OCBI versions in the external preregistration/run ledger.

The default remains metadata-only. To explicitly consent to retaining bounded
audit evidence, add `--capture-audit-evidence`. This creates an
`audit-evidence/` directory with mode `0700` and one JSON file per trial with
mode `0600`. Each file contains bounded agent/verifier stdout and stderr, plus
bounded `git status --porcelain` and `git diff HEAD` output for every referenced
repository. Every captured field records whether it was truncated at
`--max-output-bytes`. `result.json` remains metadata-only and lists only the
relative evidence-file paths. Status records untracked paths, but Git diff does
not include untracked file contents. Diff collection disables external diff and
text-conversion helpers.

Audit evidence can contain credentials, tokens, private source, prompts, or
other sensitive material. The runner does not automatically redact it. Use the
flag only after reviewing the agent, verifier, repositories, output location,
retention policy, and who can access the files. The runner never serializes the
argv arrays or process environment into either `result.json` or evidence files.
If requested repository evidence cannot be collected, the run fails instead of
writing a result that implies complete evidence capture.

`--allow-verifiers` is mandatory because verifier entries are trusted code.
Agent/verifier processes are time-bounded and captured output is byte-bounded.
`maxTokens` and `maxToolCalls` are declared controls passed to the agent, not
enforced by the runner unless the chosen agent honors them. Operators must
audit both argv configurations before the run and verify that OCBI availability
is the only intended difference. Distinct argv is a guard against identical
arms, not proof of experimental isolation.

The implementation provides:

- strict runtime validation for datasets
- deterministic, seed-controlled, balanced arm ordering
- an injectable isolated-workspace preparation contract
- an injectable process execution contract with time and transcript limits
- trial records containing agent/verifier status, duration, optional bounded
  transcripts, optional token/tool usage, and optional repository patches
- paired comparison with complete-pair checks and an exact two-sided sign test

The included acceptance test invokes the executable with temporary pinned Git
repositories and a safe fake agent/verifier. This validates the runner, not a
real agent experiment, benchmark task, or product claim.

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
      "url": "REVIEWED_LOCAL_REPOSITORY_PATH",
      "revision": "FULL_40_CHARACTER_COMMIT_HASH"
    },
    {
      "id": "repo-b",
      "url": "REVIEWED_LOCAL_REPOSITORY_PATH",
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
9. Retain enough evidence for audit outside the runner's metadata-only report:
   protected agent/verifier transcripts, exit status, duration, token/tool counts
   when the agent exposes them, and reviewed patches. The opt-in
   `--capture-audit-evidence` mode can retain bounded process output and Git
   status/diff evidence, but it is not automatically redacted and does not
   capture token/tool usage that the agent does not report. Without suitable
   access controls and a reviewed evidence ledger, results remain exploratory.
   Report missing metadata as missing rather than estimating it.
10. Report all preregistered tasks, failures, exclusions, and protocol changes.

The comparator rejects missing/duplicate arms, dataset fingerprint mismatches,
repository mismatches, unequal run controls, and success flags inconsistent
with agent/verifier status.

## Security and evidence handling

A dataset verifier is trusted executable code. Do not execute an unreviewed
third-party manifest. The CLI requires explicit opt-in, invokes commands without
a shell, verifies pinned local checkouts, bounds output/time, and isolates each
trial.

Transcripts and patches can contain credentials or private source. The CLI omits
them by default. Its explicit audit-evidence mode caps captured fields and uses
protected filesystem modes, but it does not detect or redact secrets. Operators
must apply any required review or redaction before sharing retained evidence.
Never serialize environment variables or auth material into trial records. The
library passes only declared evaluation metadata to the adapter and does not
itself persist results.

## Interpretation

`task-success` means the independent task verifier passed after the agent exited
successfully. It is not the retrieval harness's `minOutcomeAccuracy`, which
measures whether a context-routing result matched a declared retrieval outcome.

Every comparison is marked `exploratory: true`. The success-rate difference and
exact sign-test p-value describe only the preregistered paired sample. They do
not establish causality outside the protocol, generalize to other repositories
or agents, or support automatic state-of-the-art claims. Synthetic adapter tests
are contract tests only and cannot be the sole evidence for product claims.
