import type { HistoryApi } from "./github.js";
import type { OperationControl } from "../utils/operation-control.js";
import PQueue from "p-queue";
import { HistoryError } from "./config.js";
import { GitHubApiError } from "./github.js";
import { OperationCancelledError, throwIfOperationAborted } from "../utils/operation-control.js";

export interface HistoryRequestScheduler {
  api: HistoryApi;
  stop(error: unknown): void;
  throwIfStopped(): void;
  drain(): Promise<void>;
}

function failurePriority(error: unknown): number {
  if (error instanceof GitHubApiError && !error.rateLimited && [401, 403, 404].includes(error.status)
    || error instanceof HistoryError && error.code === "HISTORY_INACCESSIBLE") return 0;
  if (error instanceof HistoryError && error.code === "HISTORY_INCOMPLETE") return 1;
  if (error instanceof OperationCancelledError
    || error instanceof HistoryError && error.code === "HISTORY_CANCELLED") return 3;
  return 2;
}

export function createHistoryRequestScheduler(api: HistoryApi, control?: OperationControl): HistoryRequestScheduler {
  const queue = new PQueue({ concurrency: 4, intervalCap: 8, interval: 1000, strict: true });
  let stopped = false;
  let failure: unknown;
  let priority = Infinity;

  function throwIfStopped(): void {
    if (stopped) throw failure;
  }

  function checkAdmission(): void {
    throwIfStopped();
    throwIfOperationAborted(control?.signal);
  }

  async function schedule<T>(request: () => Promise<T>): Promise<T> {
    checkAdmission();
    // No queue timeout/signal: its slot must cover the real transport lifetime.
    return queue.add(async () => {
      checkAdmission();
      return request();
    });
  }

  return {
    api: {
      get: (endpoint, etag) => schedule(() => api.get(endpoint, etag)),
      access: () => schedule(() => api.access()),
      discover: (kind, after) => schedule(() => api.discover(kind, after)),
    },
    stop(error) {
      const nextPriority = failurePriority(error);
      if (!stopped || nextPriority < priority) {
        failure = error;
        priority = nextPriority;
      }
      stopped = true;
    },
    throwIfStopped,
    drain: () => queue.onIdle(),
  };
}
