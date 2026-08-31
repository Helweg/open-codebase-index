export interface OperationControl {
  signal?: AbortSignal;
  setPhase?: (phase: string) => void | Promise<void>;
  heartbeat?: () => void | Promise<void>;
  reportProgress?: (progress: number, phase?: string) => void | Promise<void>;
}

export class OperationCancelledError extends Error {
  constructor() {
    super("The operation was cancelled.");
    this.name = "OperationCancelledError";
  }
}

export class OperationStallTimeoutError extends Error {
  constructor() {
    super("The operation stopped reporting activity before the configured deadline.");
    this.name = "OperationStallTimeoutError";
  }
}

export class ProviderRequestError extends Error {
  readonly statusCode?: number;
  readonly timedOut: boolean;
  readonly retryable?: boolean;
  readonly kind?: ProviderRequestKind;

  constructor(options: {
    statusCode?: number;
    timedOut?: boolean;
    retryable?: boolean;
    kind?: ProviderRequestKind;
    message?: string;
  } = {}) {
    super(options.message ?? (options.timedOut === true
      ? "The embedding or reranking provider timed out."
      : "The embedding or reranking provider request failed."));
    this.name = "ProviderRequestError";
    this.statusCode = options.statusCode;
    this.timedOut = options.timedOut === true;
    this.kind = options.kind;
    this.retryable = options.retryable ?? (
      this.timedOut
      || options.statusCode === undefined
      || options.statusCode === 429
      || options.statusCode >= 500
    );
  }
}

export type ProviderRequestKind =
  | "context_length"
  | "endpoint_unavailable"
  | "malformed_response";

export type OperationInterruptionError = OperationCancelledError | OperationStallTimeoutError;

export function getOperationInterruption(error: unknown): OperationInterruptionError | undefined {
  const pending = [error];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (current instanceof OperationCancelledError || current instanceof OperationStallTimeoutError) {
      return current;
    }
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current instanceof AggregateError) {
      pending.unshift(...current.errors);
    }
  }

  return undefined;
}

export function isOperationInterruption(error: unknown): boolean {
  return getOperationInterruption(error) !== undefined;
}

function normalizeAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof OperationCancelledError
    || signal.reason instanceof OperationStallTimeoutError
    || signal.reason instanceof ProviderRequestError) {
    return signal.reason;
  }
  return new OperationCancelledError();
}

export interface ProviderRequestSignal {
  signal: AbortSignal;
  dispose: () => void;
}

export function createProviderRequestSignal(
  source: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ProviderRequestSignal {
  const linked = createLinkedAbortController(source);
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(
        () => linked.controller.abort(new ProviderRequestError({ timedOut: true, retryable: true })),
        timeoutMs,
      );
  return {
    signal: linked.controller.signal,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      linked.dispose();
    },
  };
}

export function throwIfOperationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw normalizeAbortReason(signal);
  }
}

export interface LinkedAbortController {
  controller: AbortController;
  dispose: () => void;
}

export function createLinkedAbortController(
  source: AbortSignal | undefined,
  fallbackReason: Error = new OperationCancelledError(),
): LinkedAbortController {
  const controller = new AbortController();
  if (!source) {
    return { controller, dispose: () => undefined };
  }

  const abort = (): void => {
    const reason = source.reason instanceof OperationCancelledError
      || source.reason instanceof OperationStallTimeoutError
      ? source.reason
      : fallbackReason;
    controller.abort(reason);
  };
  if (source.aborted) {
    abort();
    return { controller, dispose: () => undefined };
  }

  source.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => source.removeEventListener("abort", abort),
  };
}

export async function raceWithOperationSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfOperationAborted(signal);
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(normalizeAbortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function runOperationPhase(
  control: OperationControl | undefined,
  phase: string,
): Promise<void> {
  throwIfOperationAborted(control?.signal);
  await control?.setPhase?.(phase);
  throwIfOperationAborted(control?.signal);
}

export async function operationHeartbeat(control: OperationControl | undefined): Promise<void> {
  throwIfOperationAborted(control?.signal);
  await control?.heartbeat?.();
}
