import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireIndexLock,
  completeLeaseRecovery,
  createLeaseTemporaryPath,
  IndexLockContentionError,
  recoverLeaseArtifacts,
  releaseIndexLock,
  withIndexLock,
  type IndexLockOwner,
} from "../src/indexer/index-lock.js";

describe("index mutation lease", () => {
  let tempDir: string;
  let indexPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-lock-test-"));
    indexPath = path.join(tempDir, "index");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquires atomically and records the complete owner", () => {
    const lease = acquireIndexLock(indexPath, "index");
    const ownerPath = path.join(indexPath, "indexing.lock", "owner.json");
    const stored = JSON.parse(fs.readFileSync(ownerPath, "utf-8")) as IndexLockOwner;

    expect(stored).toEqual(lease.owner);
    expect(stored.pid).toBe(process.pid);
    expect(stored.hostname).toBe(os.hostname());
    expect(stored.operation).toBe("index");
    expect(stored.token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number.isNaN(Date.parse(stored.startedAt))).toBe(false);
    expect(fs.readdirSync(indexPath).some((name) => name.startsWith("indexing.lock.candidate."))).toBe(false);

    expect(releaseIndexLock(lease)).toBe(true);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
  });

  it("canonicalizes aliases to the same lock", () => {
    fs.mkdirSync(indexPath, { recursive: true });
    const aliasPath = path.join(tempDir, "index-alias");
    fs.symlinkSync(indexPath, aliasPath, "dir");
    const lease = acquireIndexLock(indexPath, "index");

    expect(() => acquireIndexLock(aliasPath, "health-check")).toThrow(IndexLockContentionError);
    releaseIndexLock(lease);
  });

  it("never steals a live lock because of an old timestamp", () => {
    const lease = acquireIndexLock(indexPath, "index");
    const ownerPath = path.join(indexPath, "indexing.lock", "owner.json");
    fs.writeFileSync(ownerPath, JSON.stringify({
      ...lease.owner,
      startedAt: "2000-01-01T00:00:00.000Z",
    }));
    const before = fs.readFileSync(ownerPath, "utf-8");

    expect(() => acquireIndexLock(indexPath, "clear")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY" }),
    );
    expect(fs.readFileSync(ownerPath, "utf-8")).toBe(before);

    releaseIndexLock({ ...lease, owner: JSON.parse(before) as IndexLockOwner });
  });

  it.each([
    ["pid", (owner: IndexLockOwner) => ({ ...owner, pid: owner.pid + 1 })],
    ["hostname", (owner: IndexLockOwner) => ({ ...owner, hostname: `${owner.hostname}-other` })],
    ["token", (owner: IndexLockOwner) => ({ ...owner, token: "00000000-0000-4000-8000-000000000000" })],
  ])("does not allow another %s to release the lock", (_field, changeOwner) => {
    const lease = acquireIndexLock(indexPath, "index");
    const wrongLease = {
      ...lease,
      owner: changeOwner(lease.owner),
    };

    expect(releaseIndexLock(wrongLease)).toBe(false);
    expect(fs.existsSync(lease.lockPath)).toBe(true);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("releases in finally when the callback fails", async () => {
    await expect(withIndexLock(indexPath, "index", async () => {
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");

    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
  });

  it("reports both callback and release failures", async () => {
    const result = withIndexLock(indexPath, "index", async (lease) => {
      const ownerPath = path.join(lease.lockPath, "owner.json");
      fs.writeFileSync(ownerPath, JSON.stringify({ ...lease.owner, token: "replacement-token" }));
      throw new Error("callback failure");
    });

    await expect(result).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      return error.errors.some((item) => item instanceof Error && item.message === "callback failure")
        && error.errors.some((item) => item instanceof Error && item.message.includes("Lost ownership"));
    });
  });

  it("recovers a lock whose local owner has exited", () => {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(child.pid).toBeTypeOf("number");

    const lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: child.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "11111111-1111-4111-8111-111111111111",
    } satisfies IndexLockOwner));

    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map(({ owner }) => owner.pid)).toEqual([child.pid]);
    expect(lease.owner.token).not.toBe("11111111-1111-4111-8111-111111111111");
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("returns and completes every pending recovery marker", () => {
    fs.mkdirSync(indexPath, { recursive: true });
    const deadProcesses = [
      spawnSync(process.execPath, ["-e", "process.exit(0)"]),
      spawnSync(process.execPath, ["-e", "process.exit(0)"]),
    ];
    const owners = deadProcesses.map((child, index) => ({
      pid: child.pid!,
      hostname: os.hostname(),
      startedAt: new Date(Date.now() + index).toISOString(),
      operation: "index" as const,
      token: index === 0
        ? "77777777-7777-4777-8777-777777777777"
        : "88888888-8888-4888-8888-888888888888",
    } satisfies IndexLockOwner));

    for (const owner of owners) {
      const markerPath = path.join(indexPath, `indexing.lock.recovery.${owner.token}`);
      fs.mkdirSync(markerPath);
      fs.writeFileSync(path.join(markerPath, "owner.json"), JSON.stringify(owner));
    }
    const incompleteCandidatePath = path.join(
      indexPath,
      `indexing.lock.recovery.${owners[0].token}.candidate.${deadProcesses[0].pid}.99999999-9999-4999-8999-999999999999`,
    );
    fs.mkdirSync(incompleteCandidatePath);

    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map(({ owner }) => owner.token)).toEqual(owners.map(({ token }) => token));
    expect(fs.existsSync(incompleteCandidatePath)).toBe(false);

    completeLeaseRecovery(lease);
    expect(fs.readdirSync(indexPath).filter((name) => name.startsWith("indexing.lock.recovery."))).toEqual([]);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("preserves recovery markers when a lease only coordinates another mutation", async () => {
    fs.mkdirSync(indexPath, { recursive: true });
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const owner = {
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index" as const,
      token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } satisfies IndexLockOwner;
    const markerPath = path.join(indexPath, `indexing.lock.recovery.${owner.token}`);
    fs.mkdirSync(markerPath);
    fs.writeFileSync(path.join(markerPath, "owner.json"), JSON.stringify(owner));

    await withIndexLock(indexPath, "force-index", async () => undefined, { completeRecoveries: false });

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
  });

  it("fails closed when a recovery marker name does not match its owner token", () => {
    fs.mkdirSync(indexPath, { recursive: true });
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const owner = {
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index" as const,
      token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    } satisfies IndexLockOwner;
    const markerPath = path.join(indexPath, "indexing.lock.recovery.dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    fs.mkdirSync(markerPath);
    fs.writeFileSync(path.join(markerPath, "owner.json"), JSON.stringify(owner));

    expect(() => acquireIndexLock(indexPath, "recovery")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY", reason: "unknown-owner" }),
    );
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
  });

  it("recovers when both the owner and a previous reclaimer have exited", () => {
    const deadOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadReclaimer = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(deadOwner.pid).toBeTypeOf("number");
    expect(deadReclaimer.pid).toBeTypeOf("number");

    const owner = {
      pid: deadOwner.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "33333333-3333-4333-8333-333333333333",
    } satisfies IndexLockOwner;
    const lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
    const reclaimPath = path.join(lockPath, "reclaiming");
    fs.mkdirSync(reclaimPath);
    fs.writeFileSync(path.join(reclaimPath, "owner.json"), JSON.stringify({
      pid: deadReclaimer.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: "55555555-5555-4555-8555-555555555555",
      expectedOwnerToken: owner.token,
    }));

    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map(({ owner: recoveredOwner }) => recoveredOwner)).toEqual([owner]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("does not steal a reclaim marker whose process is alive", () => {
    const deadOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const owner = {
      pid: deadOwner.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "44444444-4444-4444-8444-444444444444",
    } satisfies IndexLockOwner;
    const lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
    const reclaimPath = path.join(lockPath, "reclaiming");
    fs.mkdirSync(reclaimPath);
    fs.writeFileSync(path.join(reclaimPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: "66666666-6666-4666-8666-666666666666",
      expectedOwnerToken: owner.token,
    }));

    expect(() => acquireIndexLock(indexPath, "recovery")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY", reason: "reclaiming" }),
    );
    expect(fs.existsSync(reclaimPath)).toBe(true);
  });

  it("does not reclaim malformed or foreign lock owners", () => {
    const lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");

    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY" }),
    );

    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 999_999,
      hostname: "another-host",
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "22222222-2222-4222-8222-222222222222",
    } satisfies IndexLockOwner));

    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY" }),
    );
  });

  it("does not reclaim a dead owner whose token is not a UUID", () => {
    const lockPath = path.join(indexPath, "indexing.lock");
    const ownerPath = path.join(lockPath, "owner.json");
    fs.mkdirSync(lockPath, { recursive: true });
    const contents = JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "../invalid-token",
    });
    fs.writeFileSync(ownerPath, contents);

    expect(() => acquireIndexLock(indexPath, "recovery")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY", owner: null }),
    );
    expect(fs.readFileSync(ownerPath, "utf-8")).toBe(contents);
  });

  it("restores backups and removes only temporaries from the recovered owner", () => {
    fs.mkdirSync(indexPath, { recursive: true });
    const owner: IndexLockOwner = {
      pid: 1234,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "33333333-3333-4333-8333-333333333333",
    };
    const targetPath = path.join(indexPath, "vectors");
    const backupPath = createLeaseTemporaryPath(targetPath, owner, "bak");
    const ownedTemporaryPath = createLeaseTemporaryPath(path.join(indexPath, "file-hashes.json"), owner, "tmp");
    const foreignTemporaryPath = path.join(indexPath, "file-hashes.json.tmp.9999.44444444-4444-4444-8444-444444444444.1");
    fs.writeFileSync(targetPath, "partial-new-store");
    fs.writeFileSync(backupPath, "complete-old-store");
    fs.writeFileSync(ownedTemporaryPath, "owned");
    fs.writeFileSync(foreignTemporaryPath, "foreign");

    recoverLeaseArtifacts(indexPath, owner, [targetPath]);

    expect(fs.readFileSync(targetPath, "utf-8")).toBe("complete-old-store");
    expect(fs.existsSync(backupPath)).toBe(false);
    expect(fs.existsSync(ownedTemporaryPath)).toBe(false);
    expect(fs.existsSync(foreignTemporaryPath)).toBe(true);
  });

  it("creates owner-specific temporary paths", () => {
    const lease = acquireIndexLock(indexPath, "index");
    const targetPath = path.join(indexPath, "file-hashes.json");
    const first = createLeaseTemporaryPath(targetPath, lease.owner, "tmp");
    const second = createLeaseTemporaryPath(targetPath, lease.owner, "tmp");

    expect(first).not.toBe(second);
    expect(first).toContain(`.tmp.${process.pid}.${lease.owner.token}.`);
    expect(first).not.toBe(`${targetPath}.tmp`);
    expect(createLeaseTemporaryPath(targetPath, lease.owner, "bak")).toBe(
      `${targetPath}.bak.${process.pid}.${lease.owner.token}`,
    );
    releaseIndexLock(lease);
  });
});
