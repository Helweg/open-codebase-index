import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RpcLines } from "./rpc-lines.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_REQUESTS = 128;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}
interface PendingRequest {
  message: RpcMessage;
  retried: boolean;
}
interface Generation {
  child: ChildProcess;
  pending: Map<string | number, PendingRequest>;
  reverse: Map<string | number, string | number>;
  ready: boolean;
  sleeping: boolean;
  failed: boolean;
  internalId: string;
  inputBlocked: boolean;
  output?: RpcLines;
  timer: ReturnType<typeof setTimeout>;
}

/** Keep the client transport alive while a disposable indexing process sleeps. */
export async function runIdleSupervisor(workerUrl: URL, args: string[], idleMs: number): Promise<void> {
  let generation: Generation | undefined;
  let initialize: RpcMessage | undefined;
  let initialized = false;
  let queue: PendingRequest[] = [];
  let sequence = 0;
  let reverseSequence = 0;
  let closing = false;
  let lastActivity = Date.now();
  let busy = true;
  let closeConnection: () => void = () => { closing = true; };
  let clientBlocked = false;
  const writeClient = (message: RpcMessage): void => {
    if (closing) return;
    if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
      clientBlocked = true;
      input.pause();
      generation?.output?.pause();
    }
  };
  const error = (request: PendingRequest, reason: string): void => {
    if (request.message.id === undefined) return;
    writeClient({ jsonrpc: "2.0", id: request.message.id, error: { code: -32603, message: reason } });
  };
  const log = (event: string): void => { console.error(`[codebase-index] MCP engine ${event}.`); };
  const send = (current: Generation, message: RpcMessage): void => {
    if (current.child.stdin?.write(`${JSON.stringify(message)}\n`) === false) current.inputBlocked = true;
  };
  const enqueue = (request: PendingRequest, priority = false): void => {
    const retained = [...queue, ...(generation?.pending.values() ?? [])];
    const size = (entry: PendingRequest): number => Buffer.byteLength(JSON.stringify(entry.message));
    if (retained.length >= MAX_REQUESTS || retained.reduce((total, entry) => total + size(entry), size(request)) > MAX_RETAINED_BYTES) {
      if (request.message.id !== undefined && request.message.method) {
        error(request, "MCP supervisor overloaded: maximum 128 pending messages or 16 MiB. Retry after outstanding calls finish.");
      } else {
        console.error("[codebase-index] MCP notification queue overloaded; closing the connection without silently dropping notifications.");
        closeConnection();
      }
      return;
    }
    if (priority) queue.unshift(request);
    else queue.push(request);
  };
  const stopChild = (current: Generation): void => {
    if (current.child.connected) current.child.send({ type: "shutdown" });
    else current.child.kill("SIGTERM");
    const timer = setTimeout(() => current.child.kill("SIGKILL"), 5000);
    timer.unref();
    current.child.once("close", () => clearTimeout(timer));
  };
  const fail = (current: Generation, reason: string): void => {
    if (generation !== current || current.failed) return;
    current.failed = true;
    clearTimeout(current.timer);
    log(`interrupted: ${reason}`);
    const retry: PendingRequest[] = [];
    for (const request of current.pending.values()) {
      if (initialized && !request.retried && request.message.method === "tools/call"
        && request.message.params?.name === "index_status") {
        retry.push({ ...request, retried: true });
      } else {
        error(request, `${reason} The submitted request was not replayed.`);
      }
    }
    current.pending.clear();
    for (const id of current.reverse.keys()) {
      writeClient({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "MCP engine interrupted." } });
    }
    current.reverse.clear();
    // Buffered replies belong to reverse requests from this engine only.
    queue = queue.filter((request) => request.message.method !== undefined
      && request.message.method !== "notifications/cancelled");
    // Failed startup must finish queued calls, rather than silently loop on them.
    if (!current.ready) {
      for (const request of queue) error(request, reason);
      queue = [];
    } else {
      queue.unshift(...retry);
    }
    stopChild(current);
  };
  const flush = (current: Generation): void => {
    if (!current.ready || current.sleeping || current.failed) return;
    while (queue.length > 0 && !current.inputBlocked && !clientBlocked) {
      const request = queue.shift()!;
      if (request.message.id !== undefined && request.message.method) current.pending.set(request.message.id, request);
      send(current, request.message);
      lastActivity = Date.now();
    }
  };
  const start = (): void => {
    if (generation || closing || !initialize) return;
    log(initialized ? "resuming" : "starting");
    busy = true;
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(workerUrl), ...args], {
      cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "inherit", "ipc"],
    });
    const current: Generation = {
      child, pending: new Map(), reverse: new Map(), ready: false, sleeping: false, failed: false,
      internalId: `__codebase_initialize_${++sequence}`, inputBlocked: false,
      timer: setTimeout(() => fail(current, "MCP engine initialization timed out after 10 seconds."), 10_000),
    };
    generation = current;
    child.stdin!.on("drain", () => {
      if (generation !== current || current.failed) return;
      current.inputBlocked = false;
      flush(current);
    });
    child.stdin!.on("error", () => fail(current, "MCP engine input closed."));
    child.on("error", () => fail(current, "MCP engine could not start."));
    child.on("message", (message: unknown) => {
      if (generation !== current || current.failed || !message || typeof message !== "object") return;
      const activity = message as { type?: string; busy?: boolean; lastActivity?: number };
      if (activity.type === "activity") {
        busy = activity.busy !== false;
        if (typeof activity.lastActivity === "number") lastActivity = Math.max(lastActivity, activity.lastActivity);
      } else if (activity.type === "sleep-rejected") {
        if (!current.sleeping) return;
        clearTimeout(current.timer);
        current.sleeping = false;
        lastActivity = Date.now();
        flush(current);
      } else if (activity.type === "sleep-accepted") {
        if (!current.sleeping) return;
        clearTimeout(current.timer);
        log("sleeping");
        stopChild(current);
      }
    });
    const output = new RpcLines(child.stdout!, MAX_MESSAGE_BYTES, (line) => {
      if (generation !== current || current.failed) return;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { fail(current, "MCP engine returned invalid JSON."); return; }
      if (!message || message.jsonrpc !== "2.0") { fail(current, "MCP engine returned an invalid message."); return; }
      if (!current.ready && initialized && message.id === current.internalId && !message.method) {
        if (message.error) { fail(current, "MCP engine initialization failed."); return; }
        send(current, { jsonrpc: "2.0", method: "notifications/initialized" });
        current.ready = true;
        clearTimeout(current.timer);
        lastActivity = Date.now();
        flush(current);
        return;
      }
      if (message.id !== undefined && !message.method) {
        const request = current.pending.get(message.id);
        if (!request) return;
        current.pending.delete(message.id);
        if (request?.message.method === "initialize" && !message.error) {
          current.ready = true;
          clearTimeout(current.timer);
        }
        lastActivity = Date.now();
      } else if (message.id !== undefined) {
        if (current.reverse.size >= MAX_REQUESTS) { fail(current, "MCP engine exceeded 128 pending reverse requests."); return; }
        const clientId = `__codebase_reverse_${sequence}_${++reverseSequence}`;
        current.reverse.set(clientId, message.id);
        message = { ...message, id: clientId };
      }
      if (message.method === "notifications/cancelled") {
        const reverse = [...current.reverse].find(([, originalId]) => originalId === message.params?.requestId);
        if (!reverse) return;
        current.reverse.delete(reverse[0]);
        message = { ...message, params: { ...message.params, requestId: reverse[0] } };
      }
      writeClient(message);
      flush(current);
    }, () => fail(current, "MCP engine message exceeded 8 MiB or its output stream failed."), () => undefined);
    current.output = output;
    if (clientBlocked) output.pause();
    child.on("close", () => {
      clearTimeout(current.timer);
      output.close();
      if (generation !== current) return;
      if (!closing && !current.sleeping && !current.failed) fail(current, "MCP engine exited unexpectedly.");
      generation = undefined;
      if (!closing && queue.length > 0) start();
    });
    if (initialized) {
      send(current, { ...initialize, id: current.internalId });
    } else {
      const request = queue.find((entry) => entry.message.method === "initialize");
      if (request) {
        queue = queue.filter((entry) => entry !== request);
        if (request.message.id !== undefined && request.message.method) current.pending.set(request.message.id, request);
        send(current, request.message);
      }
    }
  };
  const interval = setInterval(() => {
    const current = generation;
    if (!current?.ready || !initialized || current.failed || current.sleeping || busy
      || current.pending.size || current.reverse.size || queue.length
      || Date.now() - lastActivity < idleMs) return;
    current.sleeping = true;
    current.timer = setTimeout(() => fail(current, "MCP engine sleep negotiation timed out after 5 seconds."), 5000);
    current.child.send({ type: "prepare-sleep", idleSince: lastActivity, idleMs });
  }, Math.min(1000, Math.max(10, idleMs / 4)));

  const input = new RpcLines(process.stdin, MAX_MESSAGE_BYTES, (line) => {
    if (closing) return;
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; }
    catch { writeClient({ jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON." } }); return; }
    if (!message || message.jsonrpc !== "2.0") {
      writeClient({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid JSON-RPC message." } }); return;
    }
    if (message.method === "ping" && initialized) {
      writeClient({ jsonrpc: "2.0", id: message.id, result: {} }); return;
    }
    if (message.method === "initialize") initialize = message;
    if (message.method === "notifications/initialized") initialized = true;
    const current = generation;
    if (message.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      if (typeof id !== "string" && typeof id !== "number") return;
      const queued = queue.find((request) => request.message.method && request.message.id === id);
      if (queued) {
        queue = queue.filter((request) => request !== queued);
        error(queued, "Request cancelled before the MCP engine received it.");
        return;
      }
      // The SDK sends no response after cancellation. Execution stays busy in the worker until cleanup settles.
      if (!current || current.failed || !current.pending.delete(id)) return;
    }
    if (!message.method && message.id !== undefined) {
      // Only the engine which asked a reverse request may receive its answer.
      const originalId = current?.reverse.get(message.id);
      if (current && originalId !== undefined && !current.failed) {
        current.reverse.delete(message.id);
        enqueue({ message: { ...message, id: originalId }, retried: false }, true);
        flush(current);
      }
      return;
    }
    if (!initialize) {
      if (message.id !== undefined) error({ message, retried: false }, "Initialize the MCP connection first.");
      return;
    }
    if (message.id !== undefined) enqueue({ message, retried: false });
    else if (current && !current.sleeping && !current.failed && !current.inputBlocked && queue.length === 0) send(current, message);
    else if (message.method !== "notifications/initialized") enqueue({ message, retried: false }, message.method === "notifications/cancelled");
    if (!current) start();
    else flush(current);
  }, () => {
    console.error("[codebase-index] MCP client message exceeded 8 MiB or its input stream failed; closing the connection.");
    closeConnection();
  }, () => closeConnection());
  const onClientDrain = (): void => {
    clientBlocked = false;
    input.resume();
    if (!clientBlocked) generation?.output?.resume();
    if (generation) flush(generation);
  };
  process.stdout.on("drain", onClientDrain);

  await new Promise<void>((resolve) => {
    const close = (): void => {
      if (closing) return;
      closing = true;
      clearInterval(interval);
      input.close();
      process.stdout.removeListener("drain", onClientDrain);
      process.stdin.pause();
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
      process.removeListener("SIGHUP", close);
      if (generation) {
        clearTimeout(generation.timer);
        generation.child.once("close", resolve);
        stopChild(generation);
      } else resolve();
    };
    closeConnection = close;
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.once("SIGHUP", close);
  });
}
