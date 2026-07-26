import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { acquireIndexLock, IndexLockContentionError } from "../src/indexer/index-lock.js";

describe("legacy crash recovery", () => {
  let tempDir: string;
  let indexPath: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-"));
    indexPath = path.join(tempDir, "index");
    lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(indexPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not overwrite a live 0.14.0 lock file", () => {
    const contents = JSON.stringify({
      pid: process.pid,
      startedAt: "2025-01-19T12:00:00.000Z",
    });
    fs.writeFileSync(lockPath, contents, { mode: 0o600 });

    expect(() => acquireIndexLock(indexPath, "recovery")).toThrow(
      expect.objectContaining<Partial<IndexLockContentionError>>({
        code: "INDEX_BUSY",
        reason: "legacy-lock",
        owner: expect.objectContaining({ pid: process.pid }),
      }),
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(contents);
    expect(fs.lstatSync(lockPath).isFile()).toBe(true);
  });

  it("requires explicit migration control before removing a dead legacy lock", () => {
    const deadPid = 2_147_483_647;
    const contents = JSON.stringify({
      pid: deadPid,
      startedAt: "2025-01-19T12:00:00.000Z",
    });
    fs.writeFileSync(lockPath, contents, { mode: 0o600 });

    expect(() => acquireIndexLock(indexPath, "recovery")).toThrow(
      expect.objectContaining<Partial<IndexLockContentionError>>({
        code: "INDEX_BUSY",
        reason: "legacy-lock",
        owner: expect.objectContaining({ pid: deadPid }),
      }),
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(contents);
  });

  it("does not overwrite an unreadable legacy lock", () => {
    fs.writeFileSync(lockPath, "not-json", { mode: 0o600 });

    expect(() => acquireIndexLock(indexPath, "recovery")).toThrow(
      expect.objectContaining<Partial<IndexLockContentionError>>({
        code: "INDEX_BUSY",
        reason: "legacy-lock",
        owner: null,
      }),
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe("not-json");
  });
});
