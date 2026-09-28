# Unsupported-claim follow-up

The blinded [relative-path study](relative-context-path-study.md) retained its locator fix, but found one candidate answer with a broad unsupported statement. This note diagnoses that statement without changing the frozen grades, prompts or result.

## Observed failure

The candidate's hybrid-ranking answer correctly cited and explained several conditional diversity stages, then summarized: with default configuration, a neutral query "fuses both lanes and interleaves by file." That final conjunction is not guaranteed. `src/indexer/search-ranking.ts:154-160` returns the original entries when diversification is disabled **or there are at most two entries**; `src/indexer/index.ts:3223-3224` disables external-rerank band diversification when identifier hints are present. Other ranking and failure-path gates can prevent either lane or that stage from running. The adjudicated result marked this as one unsupported broad claim, not a wrong factual-key response. Both arms scored 13/16 keyed facts, while the candidate improved exact-supported keyed facts from 8/16 to 13/16 across two topics.

The answer itself discussed the conditional gates before the overbroad summary. This is therefore not evidence that the index failed to retrieve the guarded implementation or that clipped paths were the cause. The existing answer guidance already asks the agent to trace guards and qualify conditional outcomes (`src/routing-hints.ts`). A separate prospective wording addition was tested on 32 fresh answers and made all six fixed quality endpoints worse; it was removed. Adding another untested instruction would repeat that risk.

## Safe next experiment

A reliable claim-support gate would need to inspect each final claim against its cited source, including the conditions under which the claim holds. File existence and line-range checks are useful but cannot establish semantic entailment or catch a summary that contradicts guards discussed earlier. The current OpenCode adapter's input/system and tool-after hooks do not establish an automatic final-answer rejection path. An opt-in verifier would require a defined host integration, source-access and privacy policy, extra inference/cost limits, and a separate failure behavior for uncertain claims.

Before shipping such a verifier, freeze fresh unseen questions about conditional behavior, source-backed facts and claim-support rubrics. Compare it with the retained locator version through the actual installed host, grade factual coverage, exact support, wrong and unsupported claims separately, and retain it only if support improves without factual regression. The two-topic prior study is development evidence, not this acceptance test. No runtime change is justified by the single observed claim alone.
