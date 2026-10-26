import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryError } from "../src/history/config.js";
import { GitHubApiError, type HistoryApi } from "../src/history/github.js";
import { createHistoryRequestScheduler } from "../src/history/request-scheduler.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  return promise.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
}
function capturedError(run: () => void): unknown {
  try { run(); } catch (error) { return error; }
  return undefined;
}
function harness() {
  const starts: { kind: string; time: number; gate: Deferred }[] = [];
  let active = 0;
  let peak = 0;
  async function request<T>(kind: string, value: T): Promise<T> {
    const gate = deferred();
    starts.push({ kind, time: Date.now(), gate });
    peak = Math.max(peak, ++active);
    try { await gate.promise; return value; }
    finally { active--; }
  }
  const api: HistoryApi = {
    get: (endpoint, etag) => request(`get ${endpoint} ${etag ?? ""}`, { status: 200 as const, etag: '"fixture"', value: { endpoint } }),
    access: () => request("access", { hostname: "github.com", repositoryId: "42", repositoryName: "example/repository", principalId: "viewer" }),
    discover: (kind, after) => request(`discover ${kind} ${after}`, { nodes: [], endCursor: null, hasNextPage: false }),
  };
  return { api, starts, get active() { return active; }, get peak() { return peak; }, release() { for (const start of starts) start.gate.resolve(); } };
}

afterEach(() => { vi.useRealTimers(); });

describe("sync-local history request budget", () => {
  it("shares four active slots and a strict rolling eight-start budget across GET, access, and discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const raw = harness();
    const requests = createHistoryRequestScheduler(raw.api);
    const calls = Array.from({ length: 20 }, (_, index) => {
      switch (index % 3) {
        case 0: return observe(requests.api.get(`endpoint-${index}`, '"conditional"'));
        case 1: return observe(requests.api.access());
        default: return observe(requests.api.discover("pullRequests", `cursor-${index}`));
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(raw.starts).toHaveLength(4);
      expect(raw.active).toBe(4);
      await vi.advanceTimersByTimeAsync(600);
      raw.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(raw.starts).toHaveLength(8);
      raw.release();
      await vi.advanceTimersByTimeAsync(399);
      expect(raw.starts).toHaveLength(8);
      await vi.advanceTimersByTimeAsync(2);
      expect(raw.starts).toHaveLength(12);
      raw.release();
      await vi.advanceTimersByTimeAsync(0);
      // A fixed-window limiter would admit another four here, although the
      // starts at 600 ms are still inside the rolling window.
      expect(raw.starts).toHaveLength(12);
      await vi.advanceTimersByTimeAsync(600);
      expect(raw.starts).toHaveLength(16);
      raw.release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(raw.starts).toHaveLength(20);
      raw.release();
      const results = await Promise.all(calls);
      expect(results[1].value).toEqual({ hostname: "github.com", repositoryId: "42", repositoryName: "example/repository", principalId: "viewer" });
      expect(results[2].value).toEqual({ nodes: [], endCursor: null, hasNextPage: false });
      await requests.drain();
      expect(results.every((result) => result.error === undefined)).toBe(true);
      expect(raw.peak).toBe(4);
      expect(raw.starts.some((start) => start.kind === "access")).toBe(true);
      expect(raw.starts.some((start) => start.kind === "discover pullRequests cursor-2")).toBe(true);
      expect(raw.starts[0].kind).toBe('get endpoint-0 "conditional"');
      expect(results[0].value).toEqual({ status: 200, etag: '"fixture"', value: { endpoint: "endpoint-0" } });
      for (const start of raw.starts) {
        expect(raw.starts.filter((other) => other.time > start.time - 1000 && other.time <= start.time).length).toBeLessThanOrEqual(8);
      }
    } finally {
      requests.stop(new Error("test cleanup"));
      raw.release();
      await vi.runAllTimersAsync();
      await Promise.all(calls);
      await requests.drain();
    }
  });

  it("closes admission without discarding queued promises or draining a genuinely running call early", async () => {
    vi.useFakeTimers();
    const raw = harness();
    const requests = createHistoryRequestScheduler(raw.api);
    const calls = Array.from({ length: 9 }, (_, index) => observe(requests.api.get(`endpoint-${index}`)));
    let drained = false;
    let draining: Promise<void> | undefined;
    const failure = new GitHubApiError(429, true);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(raw.starts).toHaveLength(4);
      requests.stop(failure);
      expect((await observe(requests.api.access())).error).toBe(failure);
      draining = requests.drain().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(3000);
      expect(drained).toBe(false);
      expect(raw.active).toBe(4);
      raw.release();
      await vi.runAllTimersAsync();
      const outcomes = await Promise.all(calls);
      await draining;
      expect(raw.starts).toHaveLength(4);
      expect(outcomes.slice(0, 4).every((result) => result.error === undefined)).toBe(true);
      expect(outcomes.slice(4).every((result) => result.error === failure)).toBe(true);
      expect(capturedError(() => requests.throwIfStopped())).toBe(failure);
      expect(drained).toBe(true);
    } finally {
      requests.stop(failure);
      raw.release();
      await vi.runAllTimersAsync();
      await Promise.all(calls);
      await requests.drain();
    }
  });

  it("does not invoke rate-waiting calls after cancellation or let cancellation settle running transports", async () => {
    vi.useFakeTimers();
    const raw = harness();
    const controller = new AbortController();
    const requests = createHistoryRequestScheduler(raw.api, { signal: controller.signal });
    const calls = Array.from({ length: 12 }, (_, index) => observe(requests.api.get(`endpoint-${index}`)));
    let drained = false;
    try {
      await vi.advanceTimersByTimeAsync(0);
      raw.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(raw.starts).toHaveLength(8);
      controller.abort();
      const draining = requests.drain().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(raw.starts).toHaveLength(8);
      expect(drained).toBe(false);
      expect(raw.active).toBe(4);
      expect((await observe(requests.api.access())).error).toBeInstanceOf(OperationCancelledError);
      raw.release();
      await vi.runAllTimersAsync();
      const outcomes = await Promise.all(calls);
      await draining;
      expect(outcomes.slice(0, 8).every((result) => result.error === undefined)).toBe(true);
      expect(outcomes.slice(8).every((result) => result.error instanceof OperationCancelledError)).toBe(true);
      expect(raw.starts).toHaveLength(8);
    } finally {
      controller.abort();
      raw.release();
      await vi.runAllTimersAsync();
      await Promise.all(calls);
      await requests.drain();
    }
  });

  it.each(["stop", "cancel"] as const)("settles rate-waiting callbacks without invoking transport after %s", async (mode) => {
    vi.useFakeTimers();
    const raw = harness();
    const controller = new AbortController();
    const requests = createHistoryRequestScheduler(raw.api, { signal: controller.signal });
    const calls = Array.from({ length: 12 }, (_, index) => observe(requests.api.get(`endpoint-${index}`)));
    const failure = new GitHubApiError(500, false);
    let drained = false;
    try {
      await vi.advanceTimersByTimeAsync(0);
      raw.release();
      await vi.advanceTimersByTimeAsync(0);
      raw.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(raw.starts).toHaveLength(8);
      expect(raw.active).toBe(0);
      if (mode === "stop") requests.stop(failure);
      else controller.abort();
      const draining = requests.drain().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(drained).toBe(false);
      expect(raw.starts).toHaveLength(8);
      await vi.advanceTimersByTimeAsync(2);
      const outcomes = await Promise.all(calls);
      await draining;
      expect(drained).toBe(true);
      expect(raw.starts).toHaveLength(8);
      expect(outcomes.slice(0, 8).every((result) => result.error === undefined)).toBe(true);
      for (const outcome of outcomes.slice(8)) {
        if (mode === "stop") expect(outcome.error).toBe(failure);
        else expect(outcome.error).toBeInstanceOf(OperationCancelledError);
      }
    } finally {
      requests.stop(failure);
      controller.abort();
      raw.release();
      await vi.runAllTimersAsync();
      await Promise.all(calls);
      await requests.drain();
    }
  });

  it("rejects already-aborted work before it reaches the shared queue", async () => {
    const raw = harness();
    const controller = new AbortController();
    controller.abort();
    const requests = createHistoryRequestScheduler(raw.api, { signal: controller.signal });
    const results = await Promise.all([
      observe(requests.api.get("unused")), observe(requests.api.access()), observe(requests.api.discover("issues", null)),
    ]);
    expect(results.every((result) => result.error instanceof OperationCancelledError)).toBe(true);
    await requests.drain();
    expect(raw.starts).toEqual([]);
  });

  it("leaves endpoint-specific recovery to the caller instead of stopping on every rejected request", async () => {
    const failure = new GitHubApiError(404, false);
    const api: HistoryApi = {
      get: async () => { throw failure; },
      access: async () => ({ hostname: "github.com", repositoryId: "42", repositoryName: "example/repository", principalId: "viewer" }),
      discover: async () => ({ nodes: [], endCursor: null, hasNextPage: false }),
    };
    const requests = createHistoryRequestScheduler(api);
    expect((await observe(requests.api.get("missing-entity"))).error).toBe(failure);
    expect(() => requests.throwIfStopped()).not.toThrow();
    await expect(requests.api.access()).resolves.toMatchObject({ repositoryId: "42" });
    await requests.drain();
  });

  it("upgrades cancellation to ordinary failure, incompleteness, and denial while preserving the first object within each rank", async () => {
    const requests = createHistoryRequestScheduler(harness().api);
    const groups = [
      [new OperationCancelledError(), new HistoryError("HISTORY_CANCELLED", "later cancellation")],
      [new GitHubApiError(429, true), new GitHubApiError(500, false), new Error("later failure")],
      [new HistoryError("HISTORY_INCOMPLETE", "first incomplete"), new HistoryError("HISTORY_INCOMPLETE", "later incomplete")],
      [new GitHubApiError(403, false), new GitHubApiError(401, false), new GitHubApiError(404, false), new HistoryError("HISTORY_INACCESSIBLE", "identity changed")],
    ];
    for (const group of groups) {
      for (const error of group) {
        requests.stop(error);
        expect(capturedError(() => requests.throwIfStopped())).toBe(group[0]);
      }
      for (const previous of groups.slice(0, groups.indexOf(group))) {
        requests.stop(previous[0]);
        expect(capturedError(() => requests.throwIfStopped())).toBe(group[0]);
      }
    }
    await requests.drain();
  });

  it.each([
    new GitHubApiError(401, false), new GitHubApiError(403, false), new GitHubApiError(404, false),
    new HistoryError("HISTORY_INACCESSIBLE", "principal changed"),
  ])("preserves a received access/identity failure even when the host signal has also aborted (%s)", async (denial) => {
    const controller = new AbortController();
    const requests = createHistoryRequestScheduler(harness().api, { signal: controller.signal });
    requests.stop(new OperationCancelledError());
    controller.abort();
    requests.stop(denial);
    requests.stop(new GitHubApiError(403, true));
    expect(capturedError(() => requests.throwIfStopped())).toBe(denial);
    await requests.drain();
  });
});
