import type { Indexer } from "../indexer/index.js";
import { isTransientIndexLockContention } from "../indexer/index-lock.js";

type AutoIndexTarget = Pick<Indexer, "index">;

interface AutoIndexState {
  retryDelayMs: number;
}

const INITIAL_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 500;
const autoIndexStates = new WeakMap<AutoIndexTarget, AutoIndexState>();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runAutoIndex(indexer: AutoIndexTarget, projectRoot: string, state: AutoIndexState): void {
  void indexer.index().then(() => {
    autoIndexStates.delete(indexer);
  }).catch((error: unknown) => {
    if (!isTransientIndexLockContention(error)) {
      autoIndexStates.delete(indexer);
      console.error(`[codebase-index] Auto-index failed for "${projectRoot}": ${getErrorMessage(error)}`);
      return;
    }

    const retryDelayMs = state.retryDelayMs;
    state.retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    const retryTimer = setTimeout(() => {
      runAutoIndex(indexer, projectRoot, state);
    }, retryDelayMs);
    retryTimer.unref?.();
  });
}

export function startAutoIndex(indexer: AutoIndexTarget, projectRoot: string): void {
  if (autoIndexStates.has(indexer)) return;

  const state: AutoIndexState = {
    retryDelayMs: INITIAL_RETRY_DELAY_MS,
  };
  autoIndexStates.set(indexer, state);
  runAutoIndex(indexer, projectRoot, state);
}
