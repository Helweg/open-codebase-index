# Conceptual-answer guidance comparison, 2026-09-25

Exploratory comparison of the parent `0b3c053b58a0d055cfd0661b865ba71bc56592ae` and guidance commit `fcc54de2d515df7f885b7946eaf97056d419d292`. This is not evidence of general answer-quality superiority.

Two neutral prompts asked about embedding failover (P1) and MCP idle/resume (P2). The same frozen parent source corpus (386 files, 6,768 indexed chunks), OpenCode 1.18.32, Go DeepSeek V4.1 Flash model, build agent, independent ready indexes, and identical 34-tool inventory were used. The actual host loaded one intended local plugin per arm, with no ambient oh-my-openagent tools. Runs were serialized with fresh sessions in parent-P1, candidate-P2, candidate-P1, parent-P2 order. Both versions invoked `codebase_context` as their first tool on both prompts, so this comparison does not show improved tool uptake.

The first complete four-arm run is **exploratory and post-exposure**: an initial attempt failed with upstream authentication 401 and no answers, then a replacement stopped after the first parent run at the 100,000-token observed cap without final text. After seeing that run's 115,209-token usage, the same observed-token cap was raised symmetrically to 300,000. Both invalid attempts were excluded from grading. The final four arms completed without observed soft-gate termination. The candidate P1 final token total was 306,271, above the nominal 300,000 polling cap despite zero *recorded* overshoot, illustrating that this was not a strict maximum. No further attempt is included here.

Two independent graders assessed anonymized final answers against a frozen source-backed rubric, and disputed items were adjudicated before unblinding. The rubric specifies independent atomic-fact, exact-path citation, and required-source-recall metrics, **not a weighted overall score**:

| Prompt | Arm | Atomic fact net | Exact citations valid | Required sources cited | Tools | Observed tokens | Cost USD | Seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| P1 failover | Parent | 4 / 11 | 6 / 27 | 3 / 4 | 16 | 198,859 | 0.011382 | 94 |
| P1 failover | Guidance | 2 / 11 | 26 / 26 | 3 / 4 | 21 | 306,271 | 0.012821 | 55 |
| P2 idle | Parent | 4 / 10 | 12 / 27 | 2 / 2 | 16 | 276,476 | 0.009895 | 67 |
| P2 idle | Guidance | 5 / 10 | 18 / 21 | 2 / 2 | 18 | 246,560 | 0.009850 | 39 |

Guidance improved exact-path citation validity in both prompts, but factual coverage moved in opposite directions (P1 worsened by two net facts, P2 improved by one). The P1 guidance answer made an unsupported categorical same-protocol claim; neither P1 answer cited the required OpenAI provider implementation. The small, correlated two-prompt sample, stochastic model/tool behavior, non-hard polling caps, and post-exposure budget amendment preclude a broad causal quality claim. Next work should improve factual completeness and conditional-source grounding without losing citation fidelity, then evaluate on fresh unseen prompts with a fully fixed budget and a preregistered composite decision rule if one is wanted.

Frozen source rubric SHA-256: `1d847adeae1914de2faf1943a725bd1135956fc0491baf31f070819aa0ced555`. Reviewed final-run protocol SHA-256: `6739b7839605b0255c828ee857d6319af9fa2c34bc1a9fbb7b123ec91e7df9fe`. The run and anonymized grading artifacts remain owner-only under the local scratch evaluation directory; no credentials or answer bodies are recorded here.
