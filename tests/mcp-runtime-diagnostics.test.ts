import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpRuntimeDiagnostics } from "../src/adapters/mcp/runtime-diagnostics.js";

describe("MCP runtime diagnostics", () => {
  let tempDir: string;
  let indexRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-diagnostics-"));
    indexRoot = path.join(tempDir, "index");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes private atomic process state and removes normally completed operations", async () => {
    const diagnostics = new McpRuntimeDiagnostics(indexRoot);
    const operation = await diagnostics.begin("index_codebase");
    const runtimeDir = path.join(indexRoot, "mcp-runtime");
    const files = fs.readdirSync(runtimeDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{16}-\d+-[a-f0-9]{32}\.json$/);
    expect(fs.statSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(runtimeDir, files[0])).mode & 0o777).toBe(0o600);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);

    await operation.complete();
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
    await expect(diagnostics.snapshot(undefined, 1000)).resolves.toEqual({
      schemaVersion: 1,
      activeOperations: [],
    });
  });

  it("corrects permissions on an existing runtime directory", async () => {
    const runtimeDir = path.join(indexRoot, "mcp-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(runtimeDir, 0o755);

    const operation = await new McpRuntimeDiagnostics(indexRoot).begin("index_status");
    expect(fs.statSync(runtimeDir).mode & 0o777).toBe(0o700);
    await operation.complete();
  });

  it("tracks concurrent operations and marks stale activity only as suspected", async () => {
    const diagnostics = new McpRuntimeDiagnostics(indexRoot);
    const first = await diagnostics.begin("codebase_context");
    const second = await diagnostics.begin("index_codebase");
    await first.setPhase("embedding_query");
    await second.setPhase("embedding");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const snapshot = await diagnostics.snapshot(first.id, 1);
    expect(snapshot.activeOperations).toEqual([
      expect.objectContaining({
        operation: "index_codebase",
        phase: "embedding",
        status: "suspected_stall",
      }),
    ]);
    expect(snapshot.latestInterruptedOperation).toBeUndefined();

    await first.complete();
    await second.complete();
  });

  it("marks active calls interrupted during ordered shutdown", async () => {
    const diagnostics = new McpRuntimeDiagnostics(indexRoot);
    const operation = await diagnostics.begin("index_codebase");
    await operation.setPhase("embedding");
    await diagnostics.markOrderedShutdown();

    const observer = new McpRuntimeDiagnostics(indexRoot);
    const snapshot = await observer.snapshot(undefined, 1000);
    expect(snapshot.activeOperations).toEqual([]);
    expect(snapshot.latestInterruptedOperation).toMatchObject({
      operation: "index_codebase",
      phase: "embedding",
      cause: "ordered_shutdown",
    });
  });

  it("infers interruption only when a local PID is confirmed absent", async () => {
    const runtimeDir = path.join(indexRoot, "mcp-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const hostnameHash = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
    const startupToken = "a".repeat(32);
    const startedAt = new Date(Date.now() - 2000).toISOString();
    fs.writeFileSync(
      path.join(runtimeDir, `${hostnameHash}-2147483647-${startupToken}.json`),
      JSON.stringify({
        schemaVersion: 1,
        hostnameHash,
        pid: 2147483647,
        startupToken,
        updatedAt: new Date().toISOString(),
        activeOperations: [{
          id: "operation-id",
          sessionId: "session-id",
          operation: "index_codebase",
          phase: "embedding",
          startedAt,
          lastActivityAt: startedAt,
        }],
      }),
      { mode: 0o600 },
    );

    const snapshot = await new McpRuntimeDiagnostics(indexRoot).snapshot(undefined, 1000);
    expect(snapshot.activeOperations).toEqual([]);
    expect(snapshot.latestInterruptedOperation).toMatchObject({
      operation: "index_codebase",
      phase: "embedding",
      cause: "process_exit",
    });
  });

  it("does not infer remote process death and purges records older than seven days", async () => {
    const runtimeDir = path.join(indexRoot, "mcp-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const activeToken = "b".repeat(32);
    const oldToken = "c".repeat(32);
    const operation = {
      id: "operation-id",
      sessionId: "session-id",
      operation: "codebase_context",
      phase: "embedding_query",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    const remotePath = path.join(runtimeDir, `${"d".repeat(16)}-12345-${activeToken}.json`);
    fs.writeFileSync(remotePath, JSON.stringify({
      schemaVersion: 1,
      hostnameHash: "d".repeat(16),
      pid: 12345,
      startupToken: activeToken,
      updatedAt: new Date().toISOString(),
      activeOperations: [operation],
    }));
    const oldPath = path.join(runtimeDir, `${"e".repeat(16)}-12346-${oldToken}.json`);
    fs.writeFileSync(oldPath, JSON.stringify({
      schemaVersion: 1,
      hostnameHash: "e".repeat(16),
      pid: 12346,
      startupToken: oldToken,
      updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      activeOperations: [operation],
    }));

    const snapshot = await new McpRuntimeDiagnostics(indexRoot).snapshot(undefined, 1000);
    expect(snapshot.activeOperations).toEqual([
      expect.objectContaining({ operation: "codebase_context" }),
    ]);
    expect(snapshot.latestInterruptedOperation).toBeUndefined();
    expect(fs.existsSync(remotePath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it("allows for disk heartbeat granularity when inspecting another process", async () => {
    const runtimeDir = path.join(indexRoot, "mcp-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const hostnameHash = "d".repeat(16);
    const startupToken = "f".repeat(32);
    const recordPath = path.join(runtimeDir, `${hostnameHash}-12345-${startupToken}.json`);
    const writeRecord = (lastActivityAt: string): void => {
      fs.writeFileSync(recordPath, JSON.stringify({
        schemaVersion: 1,
        hostnameHash,
        pid: 12345,
        startupToken,
        updatedAt: new Date().toISOString(),
        activeOperations: [{
          id: "operation-id",
          sessionId: "session-id",
          operation: "index_codebase",
          phase: "embedding",
          startedAt: lastActivityAt,
          lastActivityAt,
        }],
      }));
    };

    writeRecord(new Date(Date.now() - 2000).toISOString());
    const diagnostics = new McpRuntimeDiagnostics(indexRoot);
    await expect(diagnostics.snapshot(undefined, 1000)).resolves.toMatchObject({
      activeOperations: [{ status: "active" }],
    });

    writeRecord(new Date(Date.now() - 7000).toISOString());
    await expect(diagnostics.snapshot(undefined, 1000)).resolves.toMatchObject({
      activeOperations: [{ status: "suspected_stall" }],
    });
  });

  it("reconstructs persisted next actions instead of trusting file content", async () => {
    const runtimeDir = path.join(indexRoot, "mcp-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const hostnameHash = "e".repeat(16);
    const startupToken = "a".repeat(32);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(
      path.join(runtimeDir, `${hostnameHash}-12346-${startupToken}.json`),
      JSON.stringify({
        schemaVersion: 1,
        hostnameHash,
        pid: 12346,
        startupToken,
        updatedAt: timestamp,
        activeOperations: [],
        latestInterruptedOperation: {
          operation: "index_codebase",
          phase: "embedding",
          startedAt: timestamp,
          lastActivityAt: timestamp,
          cause: "ordered_shutdown",
          nextAction: "Expose /private/path and secret=abc",
        },
      }),
    );

    const snapshot = await new McpRuntimeDiagnostics(indexRoot).snapshot(undefined, 1000);
    expect(snapshot.latestInterruptedOperation?.nextAction).toBe(
      "Retry the operation from a connected MCP client.",
    );
    expect(JSON.stringify(snapshot)).not.toContain("/private/path");
    expect(JSON.stringify(snapshot)).not.toContain("secret=abc");
  });
});
