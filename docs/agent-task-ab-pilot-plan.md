# Exploratory real-agent, cross-repository pilot

Status: **protocol in preparation, no paired task outcome yet**. The task and independent verifier are frozen in private scratch, but a default-agent versus default-plus-OCBI run has not completed. This is not evidence of state-of-the-art performance.

## Candidate repositories and task

- Provider task repository: `Helweg/open-codebase-index`, pinned at `fb09d8f5c76e75aec11f1940875c5383b99aa3aa` (source package 0.31.1). The experimental retrieval tool is separately pinned to the published **`open-codebase-index@0.32.1` OpenCode plugin**, not this checkout's MCP server.
- Consumer task repository: `Helweg/github-reviewer`, pinned at `6a9604e63509a03efa62b38a0135a5bf5d8633f6`. Its manifest pins the provider package at 0.25.0. The task's baseline remains pinned while only treatment receives the current plugin.

The frozen exploratory task asks for structured `pr_impact` risk in the provider and bounded risk preservation in `collectPrImpactEvidence` in the consumer, retaining legacy MCP compatibility. An offline independent verifier exercises the provider MCP boundary with a controlled Indexer result and the consumer's public evidence method against a disposable Git fixture. Its pinned baseline fails eight intended checks for LOW/MEDIUM/HIGH and adversarial structured-vs-text conflicts, while legacy text compatibility passes. This verifies the failure mode, not actual graph-risk accuracy. The task and verifier are stored outside the source repositories to avoid leaking grader details to solving agents.

## Gates before reporting a result

1. Run the frozen task in two disposable pinned clones using the same **default OpenCode agent**, updated OpenCode Go DeepSeek V4.1 Flash model, prompt and budgets. The sole treatment difference must be the installed OCBI 0.32.1 native OpenCode plugin and its prebuilt index. Do not use an MCP-only integration for this comparison.
2. Audit the resolved agents, plugins, permissions and tools in fresh isolated homes and a **private project root outside the user home**. The ambient Orca `OPENCODE_CONFIG_DIR` and a home-ancestor `.opencode/opencode.json` both load Oh My OpenAgent. An empty inherited environment and explicit `OPENCODE_CONFIG` do not reliably neutralize the latter. Require an empty/default control and a treatment whose only additional plugin is OCBI before proceeding.
3. Use the same explicitly selected working OpenCode Go credential profile in both isolated arms without copying or logging its contents. A separate default-agent response-only smoke succeeded, but the original default auth profile returned HTTP 401. Do not embed credentials in argv, manifests or artifacts.
4. Confirm a native plugin tool call and index readiness outside the measured agent task. The published 0.32.1 CLI built a compatible OpenCode-hosted index with 7,235 chunks in disposable trial storage; importing its plugin and resolving plugin config alone does not prove tool invocation.
5. Capture protected transcripts and patches with explicit opt-in. Inspect for sensitive data before sharing. Grade trial clones independently, record all errors/timeouts/exclusions and review code beyond the controlled-Indexer verifier.
6. Report the single paired result as exploratory. A one-task sign test cannot establish statistical superiority, multi-repository generality or state-of-the-art status.

## Observed feasibility so far

OpenCode was updated to 1.18.32. The primary model's isolated default-agent response-only smoke succeeded through an existing OpenCode Go profile. Homebrew Pi was updated to its latest formula version, 0.86.1, as an unused fallback. The published OCBI plugin version 0.32.1 imported successfully and its CLI produced a ready index over the disposable pinned provider clone and consumer knowledge base. A treatment native `index_status` call reported that index ready with 7,235 chunks. No paired coding task has run. An initial control configuration inherited Oh My OpenAgent from the ambient Orca configuration and from a home-ancestor project config. Independent non-pure OpenCode config probes in a private `/Users/Shared` root resolved no control plugin and only OCBI in treatment. The trial must use that non-home root, and a status call does not yet prove retrieval or a completed task.
