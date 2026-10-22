import { setImmediate } from "node:timers/promises";
import type { OperationControl } from "../utils/operation-control.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";

/** Let host I/O deliver cancellation before inspecting the signal again. */
export async function checkpointHistoryWork(control?: OperationControl): Promise<void> {
  throwIfOperationAborted(control?.signal);
  await setImmediate();
  throwIfOperationAborted(control?.signal);
  await control?.heartbeat?.();
  throwIfOperationAborted(control?.signal);
}
