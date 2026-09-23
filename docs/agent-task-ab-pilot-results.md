# Exploratory OpenCode plus OCBI cross-repository pilot, 2026-09-23

**Validity correction:** The first two attempts are excluded from OCBI efficacy analysis. The first lacked a paired result after an outer timeout. A post-run check of the second attempt's treatment package failed with `ERR_MODULE_NOT_FOUND: tiktoken`; config discovery did not prove plugin startup, and retained traces showed no OCBI calls. Its numbers describe agent attempts, **not a valid default-versus-working-OCBI comparison**. After installing the complete package, the published 0.32.1 CLI built a fresh ready 7,235-chunk index, and an isolated native OpenCode `codebase_search` call completed and returned `src/eval/agent-task-ab.ts`. A third paired run used the repaired package.

This is **one task in three attempted runs**, with one evaluable plugin-available pair, not a state-of-the-art benchmark or evidence of a general improvement. The preregistered task, independent verifier and protected results are retained locally. The public source checkout was not changed by either arm.

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

An initial run was excluded: the outer shell execution envelope killed the runner after exactly 600 seconds, before paired result serialization. A treatment child continued and was inspected only as an unpaired diagnostic. The second run produced the following paired agent attempts, **excluded** because its treatment plugin installation lacked a required dependency.

## Observed result

| Arm | Agent process | Independent verifier | Task success | Agent duration |
| --- | --- | --- | --- | ---: |
| Default | Exit 0 | Exit 1 | No | 477.7 seconds |
| Default + OCBI 0.32.1 | Exit 0 | Exit 1 | No | 291.3 seconds |

The second attempt had zero discordant outcomes, but **no efficacy statistic is valid because its treatment installation was incomplete**. Both arms changed both repositories and passed the verifier's LOW, MEDIUM and HIGH bounded-risk cases and legacy text-only case. Both failed the same adversarial case: when structured risk says HIGH but the intact text misleadingly says LOW, the consumer trusted the text. The recorded duration difference is not evidence of a speedup. Neither result meets full task acceptance.

Protected audit evidence and result files have 0600 permissions inside a 0700 directory. The agent JSON transcripts were truncated at the configured byte limit. No OCBI calls appeared among retained invocation names, but this does not establish full-session nonuse. The runner's token and tool-call budgets were declared but not enforced by the agent. One task, a controlled Indexer fixture, an existing consumer dependency on OCBI 0.25.0, a locally pinned provider commit, and arm-specific clone paths limit generalization. This excluded attempt exposed a package-readiness and telemetry gap; it is **not** a measured negative/tie for OCBI.

## Repaired-package paired result

A third run used the same task, pinned source revisions, seed, default OpenCode `build` agent, DeepSeek V4.1 Flash model and duration/output controls. The treatment plugin and dependencies were installed completely before launch; the separate non-home runtime smoke had completed an actual `codebase_search` against a ready index. The agent workspaces were fresh disposable clones.

| Arm | Agent process | Independent verifier | Task success | Agent duration | Emitted tool-use events |
| --- | --- | --- | --- | ---: | ---: |
| Default | Exit 0 | Exit 1 | No | 247.8 seconds | 63 built-in or other, 0 OCBI |
| Default + OCBI 0.32.1 | Exit 0 | Exit 1 | No | 466.0 seconds | 61 built-in or other, **0 OCBI** |

The treatment agent had OCBI available but emitted **no OCBI tool-use events**. Thus this is an intention-to-treat observation of *availability*, not a test of whether retrieval helps when used. Both agents changed provider and reviewer code plus tests. The control failed five verifier assertions: LOW/MEDIUM/HIGH bounded-risk retention and two authoritative-structured-risk adversarial cases. The treatment failed only the adversarial conflict where structured HIGH risk contradicts visible LOW text. Neither met full task acceptance. The single pair has zero discordant successes (exploratory paired sign-test p=1); its duration difference cannot establish a speed effect. The transcript artifacts were truncated, but the runner's bounded streaming event counters covered output as it arrived. These counters reflect emitted events rather than independently audited tool execution. A generic plugin initialization warning appeared in the separate successful retrieval smoke and in the treatment trial, so warning-free startup remains unverified.

## Next evaluation gate

Create several independently verified, fresh tasks across distinct repositories and task types, confirm treatment tool invocation and actual retrieval quality, and compare outcome and cost with the default agent. Report the nonuse rate separately from tool-mediated results; do not force a different prompt in treatment. Keep agent, model, prompts and budgets matched and report all exclusions and per-task outcomes rather than changing verifier thresholds to manufacture a win.
