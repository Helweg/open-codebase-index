import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ProgressToken,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { isIndexLockContentionError } from "../../indexer/index-lock.js";
import {
  AutoIndexRetrievalUnavailableError,
  getRuntimeConfigForProject,
} from "../../tools/operation-runtime.js";
import type { OperationControl } from "../../utils/operation-control.js";
import {
  getOperationInterruption,
  OperationCancelledError,
  OperationStallTimeoutError,
  ProviderRequestError,
  raceWithOperationSignal,
  throwIfOperationAborted,
} from "../../utils/operation-control.js";
import type { McpServerRuntime } from "./shared.js";

export type McpOperationErrorCode =
  | "OPERATION_TIMEOUT"
  | "OPERATION_CANCELLED"
  | "PROVIDER_ERROR"
  | "INDEX_BUSY"
  | "INDEX_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface McpOperationError {
  schemaVersion: 1;
  code: McpOperationErrorCode;
  operation: string;
  phase: string;
  durationMs: number;
  retryable: boolean;
  nextAction: string;
}

export type McpOperationExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type McpOperationHandler = (control: OperationControl) => CallToolResult | Promise<CallToolResult>;
const DIAGNOSTIC_IO_TIMEOUT_MS = 5_000;

class ReportedToolError extends Error {
  constructor(
    readonly kind: "busy" | "unavailable" | "internal",
    readonly safeText?: string,
  ) {
    super("The operation reported an error result.");
    this.name = "ReportedToolError";
  }
}

class ProgressNotificationError extends Error {
  constructor() {
    super("An MCP progress notification could not be delivered.");
    this.name = "ProgressNotificationError";
  }
}

function normalizePhase(phase: string): string {
  const normalized = phase.trim().toLowerCase().replaceAll(/[\s-]+/g, "_");
  return /^[a-z0-9_:.]{1,64}$/.test(normalized) ? normalized : "working";
}

function getProgressToken(extra: McpOperationExtra): ProgressToken | undefined {
  const token = extra._meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function getText(result: CallToolResult): string {
  return result.content
    .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function errorDetails(
  error: unknown,
  operation: string,
  phase: string,
  durationMs: number,
): McpOperationError {
  const interruption = getOperationInterruption(error);
  let code: McpOperationErrorCode;
  let retryable: boolean;
  let nextAction: string;

  if (interruption instanceof OperationStallTimeoutError) {
    code = "OPERATION_TIMEOUT";
    retryable = true;
    nextAction = "Check index_status for the stalled phase, then retry the operation.";
  } else if (interruption instanceof OperationCancelledError) {
    code = "OPERATION_CANCELLED";
    retryable = true;
    nextAction = "Retry the operation when the client is ready.";
  } else if (error instanceof ProviderRequestError) {
    code = "PROVIDER_ERROR";
    retryable = error.retryable ?? (
      error.timedOut
      || error.statusCode === 429
      || (error.statusCode !== undefined && error.statusCode >= 500)
    );
    nextAction = retryable
      ? "Retry after the provider recovers or reduce the indexing workload."
      : "Check the embedding or reranking provider configuration before retrying.";
  } else if (isIndexLockContentionError(error) || (error instanceof ReportedToolError && error.kind === "busy")) {
    code = "INDEX_BUSY";
    retryable = true;
    nextAction = "Wait for the current index operation to finish, then retry.";
  } else if (error instanceof AutoIndexRetrievalUnavailableError
    || (error instanceof ReportedToolError && error.kind === "unavailable")) {
    code = "INDEX_UNAVAILABLE";
    retryable = true;
    nextAction = "Call index_status, run index_codebase if needed, then retry.";
  } else {
    code = "INTERNAL_ERROR";
    retryable = false;
    nextAction = "Inspect the MCP server logs and index_status diagnostics before retrying.";
  }

  return {
    schemaVersion: 1,
    code,
    operation,
    phase,
    durationMs,
    retryable,
    nextAction,
  };
}

function operationErrorResult(error: McpOperationError, safeText?: string): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: safeText ?? `${error.code}: ${error.nextAction}`,
    }],
    structuredContent: { error },
  };
}

function classifyReportedResult(result: CallToolResult): ReportedToolError {
  const text = getText(result);
  if (text.startsWith("INDEX_BUSY:")) return new ReportedToolError("busy", text);
  if (/index (?:is )?(?:not found|unavailable|not ready)/i.test(text)) {
    return new ReportedToolError("unavailable");
  }
  return new ReportedToolError("internal");
}

function waitForDiagnosticIo(promise: Promise<void>, stallTimeoutMs: number): Promise<void> {
  const timeoutMs = stallTimeoutMs > 0
    ? Math.min(stallTimeoutMs, DIAGNOSTIC_IO_TIMEOUT_MS)
    : DIAGNOSTIC_IO_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("MCP operation diagnostics did not settle."));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function executeMcpOperation(
  runtime: McpServerRuntime,
  operation: string,
  extra: McpOperationExtra,
  handler: McpOperationHandler,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const operationController = new AbortController();
  const abortForClient = (): void => {
    if (!operationController.signal.aborted) {
      operationController.abort(new OperationCancelledError());
    }
  };
  if (extra.signal.aborted) abortForClient();
  else extra.signal.addEventListener("abort", abortForClient, { once: true });

  let tracked: Awaited<ReturnType<typeof runtime.diagnostics.begin>>;
  let initializationPromise: ReturnType<typeof runtime.diagnostics.begin> | undefined;
  let stallTimeoutMs: number;
  let initializationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    stallTimeoutMs = getRuntimeConfigForProject(runtime.projectRoot, runtime.host).mcp.stallTimeoutMs;
    if (stallTimeoutMs > 0 && !operationController.signal.aborted) {
      initializationTimer = setTimeout(() => {
        operationController.abort(new OperationStallTimeoutError());
      }, stallTimeoutMs);
    }
    initializationPromise = runtime.diagnostics.begin(operation);
    tracked = await raceWithOperationSignal(
      initializationPromise,
      operationController.signal,
    );
  } catch (error: unknown) {
    extra.signal.removeEventListener("abort", abortForClient);
    if (initializationPromise) {
      void initializationPromise.then(
        (lateTracked) => waitForDiagnosticIo(
          Promise.resolve().then(() => lateTracked.complete()),
          stallTimeoutMs,
        ),
        () => undefined,
      ).catch(() => undefined);
    }
    const classified = operationController.signal.aborted
      && operationController.signal.reason instanceof Error
      ? operationController.signal.reason
      : getOperationInterruption(error) ?? new Error("MCP operation initialization failed.");
    return operationErrorResult(errorDetails(
      classified,
      operation,
      "starting",
      Math.max(0, Date.now() - startedAt),
    ));
  } finally {
    if (initializationTimer) clearTimeout(initializationTimer);
  }
  let phase = "starting";
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let executionFailure: Error | undefined;
  let closed = false;
  let activityQueue = Promise.resolve();
  let notificationQueue = Promise.resolve();
  let lastProgress = -1;
  const progressToken = getProgressToken(extra);

  const resetStallTimer = (): void => {
    if (closed) return;
    if (stallTimer) clearTimeout(stallTimer);
    if (stallTimeoutMs > 0 && !operationController.signal.aborted) {
      stallTimer = setTimeout(() => {
        operationController.abort(new OperationStallTimeoutError());
      }, stallTimeoutMs);
    }
  };

  const failExecution = (error: unknown): void => {
    executionFailure ??= error instanceof Error ? error : new Error("MCP operation tracking failed.");
    if (!operationController.signal.aborted) {
      operationController.abort(new OperationCancelledError());
    }
  };

  const scheduleActivity = (task: () => Promise<void>): Promise<void> => {
    if (closed) return Promise.resolve();
    resetStallTimer();
    const scheduled = activityQueue.then(task);
    const handled = scheduled.catch(failExecution);
    activityQueue = handled;
    return handled;
  };

  const setPhase = (nextPhase: string): Promise<void> => {
    if (closed) return Promise.resolve();
    const normalizedPhase = normalizePhase(nextPhase);
    if (normalizedPhase === phase) return heartbeat();
    phase = normalizedPhase;
    return scheduleActivity(() => tracked.setPhase(normalizedPhase));
  };

  const heartbeat = (): Promise<void> => closed
    ? Promise.resolve()
    : scheduleActivity(() => tracked.heartbeat());

  const sendProgress = (progress: number): Promise<void> => {
    if (closed
      || executionFailure
      || operationController.signal.aborted
      || progressToken === undefined
      || progress <= lastProgress) {
      return Promise.resolve();
    }
    lastProgress = progress;
    const notification = Promise.resolve().then(() => extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        total: 100,
      },
    }));
    return notification.catch(() => failExecution(new ProgressNotificationError()));
  };

  const reportProgress = async (rawProgress: number, nextPhase?: string): Promise<void> => {
    if (closed || executionFailure || operationController.signal.aborted) return;
    if (nextPhase) await setPhase(nextPhase);
    else await heartbeat();
    if (!Number.isFinite(rawProgress)) return;
    const progress = Math.min(100, Math.max(0, Math.floor(rawProgress)));
    const scheduled = notificationQueue.then(() => sendProgress(progress));
    notificationQueue = scheduled;
    await scheduled;
  };

  resetStallTimer();
  let result: CallToolResult;
  let operationFailed = false;
  let handlerPromise: Promise<CallToolResult> | undefined;
  try {
    throwIfOperationAborted(operationController.signal);
    if (progressToken !== undefined) {
      await raceWithOperationSignal(
        reportProgress(0, "starting"),
        operationController.signal,
      );
    }
    if (executionFailure) throw executionFailure;
    const control: OperationControl = {
      signal: operationController.signal,
      setPhase,
      heartbeat,
      reportProgress,
    };
    throwIfOperationAborted(operationController.signal);
    handlerPromise = Promise.resolve().then(() => handler(control));
    result = await raceWithOperationSignal(handlerPromise, operationController.signal);
    await raceWithOperationSignal(activityQueue, operationController.signal);
    await raceWithOperationSignal(notificationQueue, operationController.signal);
    if (executionFailure) throw executionFailure;
    if (result.isError === true) throw classifyReportedResult(result);
    if (progressToken !== undefined) {
      await raceWithOperationSignal(
        reportProgress(100, "completed"),
        operationController.signal,
      );
      if (executionFailure) throw executionFailure;
    }
    if (operation === "index_status") {
      const diagnostics = await raceWithOperationSignal(
        runtime.diagnostics.snapshot(tracked.id, stallTimeoutMs),
        operationController.signal,
      );
      result = {
        ...result,
        structuredContent: {
          ...(result.structuredContent ?? {}),
          mcpDiagnostics: diagnostics,
        },
      };
    }
  } catch (error: unknown) {
    operationFailed = true;
    const classifiedError = executionFailure ?? (
      operationController.signal.aborted && operationController.signal.reason instanceof Error
        ? operationController.signal.reason
        : error
    );
    const details = errorDetails(
      classifiedError,
      operation,
      phase,
      Math.max(0, Date.now() - startedAt),
    );
    result = operationErrorResult(
      details,
      classifiedError instanceof ReportedToolError ? classifiedError.safeText : undefined,
    );
  } finally {
    closed = true;
    if (stallTimer) clearTimeout(stallTimer);
    extra.signal.removeEventListener("abort", abortForClient);
    if (operationFailed) {
      const completeTracked = (): Promise<void> => waitForDiagnosticIo(
        Promise.resolve().then(() => tracked.complete()),
        stallTimeoutMs,
      );
      if (handlerPromise) {
        void handlerPromise.then(
          completeTracked,
          completeTracked,
        ).catch(() => undefined);
      } else {
        void completeTracked().catch(() => undefined);
      }
    } else {
      try {
        await waitForDiagnosticIo(
          Promise.resolve().then(() => tracked.complete()),
          stallTimeoutMs,
        );
      } catch {
        result = operationErrorResult(errorDetails(
          new Error("MCP operation tracking failed."),
          operation,
          phase,
          Math.max(0, Date.now() - startedAt),
        ));
      }
    }
  }

  return result;
}
