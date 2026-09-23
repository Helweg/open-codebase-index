# Exploratory OpenCode plus OCBI cross-repository pilot, 2026-09-23

This is **one paired task**, not a state-of-the-art benchmark or evidence of a general improvement. The preregistered task, independent verifier and protected result are retained locally. The public source checkout was not changed by either trial.

## Matched setup

| Component | Both arms | Treatment-only difference |
| --- | --- | --- |
| Agent | OpenCode 1.18.32, default `build` agent | None |
| Model | OpenCode Go `deepseek-v4.1-flash` | None |
| Task source | OCBI `fb09d8f5c76e75aec11f1940875c5383b99aa3aa`; github-reviewer `6a9604e63509a03efa62b38a0135a5bf5d8633f6` | None |
| Workspace | Separate pinned clones under private, non-home 0700 roots | None |
| Tooling | Default OpenCode built-ins | Published `open-codebase-index@0.32.1` native OpenCode plugin with an independently prepared local index |
| Task | Add structured `pr_impact` risk and preserve risk under bounded reviewer evidence, including legacy compatibility | None |

The non-home workspace matters: OpenCode discovers `~/.opencode/opencode.json` when a project is nested beneath the user's home, even with an empty inherited environment and explicit config. Independent preflight in non-home directories resolved zero control plugins and exactly one treatment plugin. Both selected the default `build` agent and had the same scoped access to the reviewer checkout. The adapter appended an identical workspace-instruction template to the frozen task prompt; the literal absolute clone path necessarily differed by arm. Treatment preparation used Ollama `nomic-embed-text` for the local index, outside measured agent execution. The generation model and agent were identical.

The frozen manifest SHA-256 was `5a8a0bc757bca318a182eb93bac498c68646cda7c7b3e1ca78b97194830c4206`; verifier SHA-256 was `5127ccbbb29a5c4aa5a00c6869def268316f4ddd09d1e2aed64961aa97473685`; seed was `20260923`. The verifier baseline failed eight intended risk-preservation checks and passed legacy text-only compatibility before agent exposure. It exercised the provider's real MCP tool boundary and the consumer's public evidence API using a controlled Indexer response and disposable Git fixture. It did **not** establish production graph-risk accuracy.

An initial run was excluded: the outer shell execution envelope killed the runner after exactly 600 seconds, before paired result serialization. A treatment child continued and was inspected only as an unpaired diagnostic. A fresh run with the same pinned task and seed used a detached supervisor and produced the following complete paired result.

## Observed result

| Arm | Agent process | Independent verifier | Task success | Agent duration |
| --- | --- | --- | --- | ---: |
| Default | Exit 0 | Exit 1 | No | 477.7 seconds |
| Default + OCBI 0.32.1 | Exit 0 | Exit 1 | No | 291.3 seconds |

Both arms changed both repositories and passed the verifier's LOW, MEDIUM and HIGH bounded-risk cases and legacy text-only case. Both failed the same adversarial case: when structured risk says HIGH but the intact text misleadingly says LOW, the consumer trusted the text. The exact paired sign test has zero discordant pairs and two-sided `p = 1`; the observed success-rate difference is zero. The duration difference is not evidence of a speedup from a single order-sensitive task. Neither result meets full task acceptance.

Protected audit evidence and result files have 0600 permissions inside a 0700 directory. The agent JSON transcripts were truncated at the configured byte limit. No OCBI calls appeared among retained invocation names, but this does not establish full-session nonuse. The runner's token and tool-call budgets were declared but not enforced by the agent. One task, a controlled Indexer fixture, an existing consumer dependency on OCBI 0.25.0, a locally pinned provider commit, and arm-specific clone paths limit generalization. The pilot is useful as a measured negative/tie and an instrumentation lesson, not as a claim that OCBI is already SOTA.

## Next evaluation gate

Record complete bounded tool-name counts independent of transcript truncation, verify actual treatment retrieval calls, then preregister a larger fresh and diverse cohort with a production-path grader where possible. Keep the default agent, model, prompts and budgets matched and report all exclusions and per-task outcomes rather than changing verifier thresholds to manufacture a win.
