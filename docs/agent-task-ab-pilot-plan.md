# Proposed real-agent, cross-repository pilot

Status: **candidate protocol, not preregistered and not run**. This document records a connected public repository pair and the remaining gates. It is not a benchmark result.

## Candidate repositories

- Provider: `Helweg/open-codebase-index`, local commit `c786280772aedfb58af875c290cd73cc87fb0c8e` (package version 0.31.1). This checkout is ahead of its public remote; publish the exact source revision before a reproducible external run.
- Consumer: `Helweg/github-reviewer`, commit `6a9604e63509a03efa62b38a0135a5bf5d8633f6`. Its `src/pr-impact.js` invokes the provider's MCP CLI and its manifest currently pins `open-codebase-index@0.25.0`. Confirm which provider version the task actually uses and whether the proposed change is compatible before preregistration.

A possible cross-repository task is to make a specific `pr_impact` unavailable/malformed-result failure contract explicit in the provider and ensure the consumer fails closed under that exact condition. This is **not yet a task statement**: check novelty against existing tests and behavior, write a precise observable failure case, and create an independent verifier that exercises both pinned repositories before exposing it to either arm. Do not reuse any existing golden/holdout task as fresh evidence.

## Gates before running

1. Independently review and freeze at least two genuine cross-repository tasks, each with a deterministic verifier that checks both repositories. Pin full commit IDs, prompts, seed, exclusions and analysis before observing outputs.
2. Resolve the 0.25.0 versus 0.31.1 compatibility difference. Make the chosen latest source build available only through the treatment tool configuration, not as an accidental change to the consumer baseline.
3. Verify a disposable agent home truly isolates sessions, MCP registrations and credentials. The existing runner starts each trial with a fresh `HOME` and an allowlisted environment, so normal user authentication does not automatically work. Use an explicitly reviewed credential mechanism equally in both arms. Never embed credentials in argv, manifests or result files.
4. Audit actual configurations and tool exposure, not just differing argv digests. Match agent, model, prompts, time/token/tool budgets and non-OCBI tools. Verify treatment index readiness outside the measured agent run, and confirm the control cannot reach that index.
5. Enable protected evidence capture only with explicit authorization for potentially sensitive transcripts and patches. Use a separate protected ledger for raw agent/verifier output, configuration hashes, usage, task-level diffs and grade decisions; inspect for secrets before sharing.
6. Run a small pilot first and report every result, timeout and exclusion. Compare paired task success but do not make a state-of-the-art or general causal claim from a tiny exploratory sample.

## Observed feasibility so far

`jcode run --json --provider openai --model gpt-6-luna --tool-profile none` returned `READY` and token usage under the normal user home. A read-only `jcode auth status --json` with a fresh private `HOME`, `JCODE_HOME`, XDG config home and empty inherited environment reported no configured providers. This confirms the public agent interface works here but the isolated runner cannot authenticate using the existing login. No credentials were copied and no real paired trial has run. The status probe emitted an anonymous-telemetry notice, so a telemetry side effect cannot be excluded.
