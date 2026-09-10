import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/adapters/mcp/cli-options.js";

type Message = { id?: string | number; method?: string; result?: { pid: number; payload?: string }; error?: { message: string }; params?: Record<string, unknown> };
const processes: ChildProcessWithoutNullStreams[] = [];
const directories: string[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function client(args: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/mcp-idle/runner.ts", import.meta.url)), ...args]);
  processes.push(child);
  const messages: Message[] = [];
  const errors: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line) as Message));
  const send = (message: Message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const wait = async (predicate: (message: Message) => boolean): Promise<Message> => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return messages.splice(index, 1)[0];
      await delay(10);
    }
    throw new Error(`Message timed out: ${errors.join("")}`);
  };
  const request = (id: number, name: string) => { send({ id, method: "tools/call", params: { name } }); return wait((m) => m.id === id); };
  send({ id: "init", method: "initialize", params: {} });
  const initialization = await wait((m) => m.id === "init");
  send({ method: "notifications/initialized" });
  return { child, send, wait, request, errors, initialization, messages };
}

afterEach(async () => {
  await Promise.all(processes.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    await exited;
  }));
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe("MCP idle supervisor", () => {
  it("validates timeout seconds without changing legacy parseArgs results", () => {
    expect(parseArgs(["node", "cli", "--host", "codex"]).mcpIdleTimeout).toBeUndefined();
    expect(parseArgs(["node", "cli", "--mcp-idle-timeout", "0"]).mcpIdleTimeout).toBe(0);
    for (const value of [undefined, "-1", "1.5", "abc", "9007199254740992"]) {
      expect(() => parseArgs(["node", "cli", "--mcp-idle-timeout", ...(value ? [value] : [])])).toThrow("non-negative integer");
    }
  });
  it("sleeps and resumes concurrent calls with one new engine, while pings stay local", async () => {
    const c = await client();
    const initial = await c.request(1, "index_status");
    await delay(350);
    c.send({ id: 2, method: "ping" });
    expect((await c.wait((m) => m.id === 2)).error).toBeUndefined();
    const [first, second] = await Promise.all([c.request(3, "index_status"), c.request(4, "index_status")]);
    expect(first.result?.pid).not.toBe(initial.result?.pid);
    expect(first.result?.pid).toBe(second.result?.pid);
  });
  it("does not interrupt a request longer than the idle timeout", async () => {
    const c = await client();
    const initial = await c.request(1, "index_status");
    const slow = await c.request(2, "slow");
    expect(slow.result?.pid).toBe(initial.result?.pid);
    expect(slow.error).toBeUndefined();
  });
  it("retries index_status once after a crash and does not replay a different submitted operation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-supervisor-"));
    directories.push(directory);
    const c = await client(["--crash-once", path.join(directory, "marker")]);
    expect((await c.request(1, "index_status")).result?.pid).toBeTypeOf("number");
    expect((await c.request(2, "crash")).error?.message).toContain("not replayed");
    expect((await c.request(3, "index_status")).result?.pid).toBeTypeOf("number");
  });
  it("relays server requests, progress and cancellation notifications", async () => {
    const c = await client();
    const result = c.request(1, "reverse");
    const reverse = await c.wait((m) => m.method === "roots/list");
    c.send({ id: reverse.id, result: { pid: 0 } });
    expect((await c.wait((m) => m.params?.progressToken === "reverse-reply")).method).toBe("notifications/progress");
    c.send({ method: "notifications/cancelled", params: { requestId: 1 } });
    await c.wait((m) => m.params?.progressToken === "cancelled");
    expect((await result).error).toBeUndefined();
  });
  it("keeps numeric and string reverse request IDs distinct", async () => {
    const c = await client();
    const pending = c.request(1, "distinct-reverse");
    const first = await c.wait((m) => m.method === "roots/list");
    const second = await c.wait((m) => m.method === "roots/list");
    expect(first.id).not.toBe(second.id);
    c.send({ id: first.id, result: { pid: 0 } });
    c.send({ id: second.id, result: { pid: 0 } });
    await c.wait((m) => m.params?.progressToken === "number:1");
    await c.wait((m) => m.params?.progressToken === "string:1");
    expect((await pending).error).toBeUndefined();
  });
  it("does not replay buffered reverse replies into a replacement engine", async () => {
    const c = await client();
    const pending = c.request(1, "stale-reverse");
    const first = await c.wait((m) => m.method === "roots/list");
    const second = await c.wait((m) => m.method === "roots/list");
    c.send({ id: first.id, result: { pid: 0, payload: "x".repeat(1024 * 1024) } });
    c.send({ id: second.id, result: { pid: 0, payload: "x".repeat(1024 * 1024) } });
    expect((await pending).error).toBeDefined();
    expect((await c.request(2, "index_status")).error).toBeUndefined();
    c.child.stdin.end();
    await new Promise<void>((resolve) => c.child.once("exit", () => resolve()));
    expect(c.messages.some((message) => message.params?.progressToken === "stale-replayed")).toBe(false);
  });
  it("bounds a burst against a stalled worker and still cancels queued calls", async () => {
    const c = await client(["--stall-input"]);
    for (let id = 1; id <= 160; id++) {
      c.send({ id, method: "tools/call", params: { name: "index_status", padding: "x".repeat(32 * 1024) } });
    }
    expect((await c.wait((m) => m.id === 160)).error?.message).toContain("overloaded");
    c.send({ method: "notifications/cancelled", params: { requestId: 100 } });
    expect((await c.wait((m) => m.id === 100)).error?.message).toContain("cancelled before");
  });
  it("resumes responses after the client stops reading a large response burst", async () => {
    const c = await client();
    c.child.stdout.pause();
    for (let id = 1; id <= 100; id++) c.send({ id, method: "tools/call", params: { name: "large" } });
    await delay(200);
    c.child.stdout.resume();
    for (let id = 1; id <= 100; id++) expect((await c.wait((m) => m.id === id)).error).toBeUndefined();
  });
  it("holds calls during quiescence and resumes them when background work rejects sleep", async () => {
    const c = await client(["--reject-sleep"]);
    const initial = await c.request(1, "index_status");
    await vi.waitFor(() => expect(c.errors.join("")).toContain("fixture preparing sleep"));
    expect((await c.request(2, "index_status")).result?.pid).toBe(initial.result?.pid);
  });
  it("bounds index_status crash recovery to one retry", async () => {
    const c = await client(["--always-crash"]);
    expect((await c.request(1, "index_status")).error?.message).toContain("not replayed");
    await delay(250);
    expect(c.errors.join("").match(/engine (starting|resuming)/g)).toHaveLength(2);
  });
  it("cancels a queued request during wake without submitting it", async () => {
    const c = await client(["--slow-start"]);
    await c.request(1, "index_status");
    await delay(350);
    const pending = c.request(2, "crash");
    c.send({ method: "notifications/cancelled", params: { requestId: 2 } });
    expect((await pending).error?.message).toContain("cancelled before");
    expect((await c.request(3, "index_status")).result?.pid).toBeTypeOf("number");
  });
  it("reports failed initialization without repeatedly spawning", async () => {
    const c = await client(["--startup-failure"]);
    expect(c.initialization.error?.message).toContain("not replayed");
    await delay(250);
    expect(c.errors.join("").match(/engine starting/g)).toHaveLength(1);
  });
});
