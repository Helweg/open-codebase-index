# Broker/evaluator feasibility, 2026-10-06

**Observed result: the real broker edit path and isolated evaluator work for an owned development-only fixture. A deterministic infrastructure control passed; the sole bounded local-model attempt did not repair the task.** This is not a participant comparison, held-out result, coding-productivity result, or SOTA claim.

The [normalized runtime artifact](../../benchmarks/results/competitive-2026-10-06/broker-evaluator-feasibility.json) preserves the executed harness source, actual commands and command stdout, evaluator outputs, broker calls/results, complete actual Ollama requests/responses, model transcript, source snapshots, and original-byte provenance hashes. The unique temporary workspace and copied runtime were removed after evidence capture. Existing September sources, installations, locks, manifests, and results were read only.

## Historical failure inspected

The latest preserved September attempt, `coding-pilot-v2`, had a successful safety/reference/mutant preflight for both synthetic Axios tasks, but all six task/condition runs failed. Four exhausted the 12-call broker allowance (the rejected thirteenth call is included in attempted-call counts); two reported `This operation was aborted`. Every final source diff was empty and every transcript had zero successful `replace_unique` calls.

Recorded failures include exact replacement text not matching the real file, requests for forbidden test directories, and writes outside the allowed source-path shape. For example, several slash-task replacement strings misplaced the regex delimiter, so `oldText was not found` was correct. Those observations do not justify weakening the broker's exact-match or access gates. The current runner also skips its normal candidate evaluation when the model throws; that is distinct from an evaluator rejecting a successfully submitted patch. Original result/preflight hashes and per-run errors are in the artifact; no historical run was rewritten or retried.

## Available prerequisites and safety

Runtime probes observed:

- `/usr/bin/sandbox-exec` executes on this host. The preliminary `allow default` probe ran only `/usr/bin/true` to detect facility availability; it was **not** the evaluator profile and executed no candidate code.
- The preserved standalone evaluator is Node `v24.16.0`, SHA-256 `1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8`. An owned regular-file copy was verified by the existing runtime verifier before use. The Homebrew host Node was used only to launch the controller with the existing local TypeScript loader.
- Actual loopback Ollama inventory contained `gemma4:26b-a4b-it-q4_K_M` with the existing driver's pinned digest `5571076f3d70050487b26b341705799e0ab29b808164f90d20d4cf84f699d251`.
- Docker's server was reachable (`29.5.3`); Lima had no configured instance. Neither was substituted for the evaluator. No sandbox implementation, image, tool installation, global configuration, or index was changed.

The actual `proveSandboxDenials` function ran under the existing default-deny macOS profile and observed all four denials: outside file read, outside file write, connection to an owned loopback listener, and child-process creation. Its OS-denial probe deliberately runs without Node permissions so the OS sandbox itself must enforce those denials. Candidate evaluations subsequently used both the unchanged OS profile and Node permissions. No security restriction was relaxed to obtain a passing candidate result.

Controller commands used `env -i` with an explicit minimal environment and an owned HOME. No credentials were copied. The evaluator generated its own minimal environment and fresh source copy inside the disjoint private evaluator root. Candidate code ran in the existing import-disabled `vm.SourceTextModule` context, in a separate sandboxed process; it did not execute in the controller.

## Owned fixture and independent evaluation

The fixture was the already-exposed September `axios-rfc3986-scheme` task at Axios revision `d8233d9e8e9a64bfba9bbe01d475ba417510b82b`. Only `lib/helpers/isAbsoluteURL.js` was copied from the preserved public source into unique owned roots. This is a **one-helper development-only source scope**, not a full repository, fresh acquisition, novel task, or realistic repository-scale retrieval benchmark.

Three source roots were separate from the private evaluator root: reference control, deterministic broker control, and model participant. The two candidate roots received identical seeded mutant bytes. The model's broker allowlist contained exactly the single mutant helper. Reference source, expected outputs, and evaluator inputs stayed outside that root and were not supplied through model prompts/messages or tools. An explicit broker attempt to traverse to the reference-control sibling was rejected. Publishing this evidence does not make the task eligible for future holdout claims.

The existing evaluator was invoked directly, without mocked subprocesses, fabricated model/tool outputs, injected evaluator replacements, or a fallback. It copied only the candidate helper into a new private evaluation directory, called its default export with the task's eight evaluator inputs, and compared actual JSON output against the controller's private expected outputs. “Independent” here means evaluation outside participant control, not independent human task curation or novelty approval.

| Actual evaluation | Process exit | Evaluator passed | Actual stdout |
|---|---:|---:|---|
| Reference source, before model execution | 0 | true | `[true,true,true,true,false,false,false,false]` |
| Initial seeded mutant, before model execution | 0 | false | `[true,true,true,true,true,true,false,false]` |
| Deterministic broker-patched candidate | 0 | true | `[true,true,true,true,false,false,false,false]` |
| Final actual model candidate | 0 | false | `[true,true,true,true,true,true,false,false]` |

A zero exit for the mutant demonstrates a behavioral failure, not a crash misclassified as a valid failing initial state. The reference passed before the model was invoked. Evaluator stderr retained the actual Node experimental-VM warning; it was not suppressed.

## Real broker edit path: infrastructure control

The controller exercised the actual `PilotBroker` with the actual `literalSearchAdapter`: list, search, read, rejected reference-root traversal, then `replace_unique`. The fifth call accepted one exact replacement in the existing allowed helper:

```diff
-  return /^([a-z\d][a-z\d+\-.]*:)?\/\//i.test(url);
+  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
```

The fresh private evaluator then passed that candidate. This proves the broker can apply the intended source edit and the independent execution path can recognize the repaired behavior. **The replacement text came from the controller's reference task: it is a deterministic infrastructure control, not model-driven repair success.** The control was never copied into the model participant root.

The full `runCompetitivePilot` comparison runner was inspected but not executed. There was no condition-order replay, current-participant indexing, or larger comparison. These observations exercise the shared concrete broker/model/evaluator implementations, not the full runner's adapter orchestration or all its patch-validity cases. No permanent change to either pilot script or its tests was required for this proof.

## Actual local-model attempt

After the control passed, exactly one attempt ran through the unchanged actual `OllamaModelDriver` on the separate still-broken participant root, using the task's existing public prompt and literal-search tools. No gold path, reference patch, oracle output, or private test was added to its messages. Ollama HTTP responses were real; the fetch wrapper only recorded actual requests/responses and enforced a request cap. It did not replace tool/model output.

The executed harness declared the following bounds before model execution:

| Bound | Value |
|---|---:|
| Attempts / condition | 1 / literal-unindexed only |
| Maximum actual chat requests | 4 |
| Aggregate generated-token allowance | 2,048 |
| Model wall deadline | 120 seconds |
| Per-request timeout | 60 seconds |
| Existing broker tool allowance | 12 |

The existing pinned model, system/task prompts, seed `20260910`, temperature `0`, context `32768`, and `think: high` were retained. These **lower, feasibility-only** time/token limits plus the four-chat cap differ from September's frozen 20-minute/16,000-token pilot; this is not a matched historical rerun or comparison. No cap was increased and no failed attempt was retried. The model window was serialized with the participant-calibration worker so it did not overlap that worker's indexing/model calls.

Observed model duration was **39,167 ms**, with **four chat responses**, **588 generated tokens**, and **2,496 prompt tokens** reported by Ollama across those responses. These are reported inference counts, not measured billing or independent context-size measurements. The model issued four broker calls: list the root, read the helper, request forbidden `test`, and search `isAbsoluteURL`. The forbidden request failed as intended. It made **no `replace_unique` request** and left the file byte-identical to its initial mutant.

The predeclared wrapper refused a fifth chat request before sending it, producing `predeclared feasibility chat-request cap exhausted`. The final candidate was still evaluated independently and failed behaviorally. The controller process itself exited zero because it successfully captured this failed attempt; that exit is not a repair-success signal. The artifact reports `modelDrivenSuccess: false` and an invalid unchanged patch.

## Reproduction and provenance

The artifact's `commands` field records the actual sanitized-environment invocation structure and stdout. Its `executedHarnessSource` contains the exact controller used for both phases. To reproduce with the already-exposed source and verified frozen runtime available:

1. Create a new unique owned directory, outside participant/private evaluator roots from other runs.
2. Extract `executedHarnessSource` from the JSON to that directory as `probe.mjs`.
3. Set `REPO`, `OWNED`, `RUNTIME_SOURCE`, and `SOURCE_FILE` to the matching local paths. The recorded original-byte hashes identify the required runtime, source, scripts, and historical artifacts.
4. Execute the recorded mechanics command with the existing local `tsx` loader. Only if it passes, execute the recorded model command with `--model`, once, under the same declared limits. Retain failures rather than selectively retrying them.
5. Capture and normalize evidence before removing only that invocation's owned directory.

Published provenance substitutes `${REPO}`, `${STUDY}`, `${OWNED}`, `${HOST_NODE}`, `${HOST_BUN}`, `${HOST_OLLAMA}`, and `${OLLAMA_MODEL_STORAGE_HOME}` for private absolute machine paths, including paths nested in raw JSON response strings. This normalization is explicitly disclosed in the artifact. SHA-256 digests identify **original bytes before normalization**; published normalized strings are not claimed byte-identical to private originals. Responses, errors, inference counts, process IDs, timings, and source content are otherwise preserved. The artifact retains the throwaway harness as evidence, not as a new permanent runner or an alternative implementation.

## Remaining gate

There was **no missing sandbox, evaluator-runtime, or pinned-model prerequisite on this host**. The successful deterministic control establishes mechanics only. The bounded model attempt provides no repair success, even on its reduced one-helper scope; it does not establish coding-task feasibility under a full matched study configuration. Before any larger coding-productivity evaluation, obtain actual model-produced valid repairs under uniformly frozen task scope and budgets, plus the independently curated and approved fresh cohort described in the [evidence plan](2026-10-06-competitive-evidence-plan.md). No such cohort approval is supplied here.

Only the explicitly authorized runtime probes were executed. Builds, lint, test suites, and formatters were not run for this addition.
