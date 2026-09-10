import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_SNAPSHOT_ATTEMPTS = 3;

interface ArtifactFingerprint {
  database: string;
  wal: string;
}

export interface WorkspaceDatabaseSnapshot {
  databasePath: string;
  close: () => Promise<void>;
}

export interface WorkspaceSnapshotOptions {
  maxAttempts?: number;
  afterCopyAttempt?: (attempt: number) => void | Promise<void>;
}

async function fileFingerprint(filePath: string): Promise<string> {
  try {
    const value = await stat(filePath, { bigint: true });
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    return `unavailable:${code}`;
  }
}

async function fingerprint(databasePath: string): Promise<ArtifactFingerprint> {
  return {
    database: await fileFingerprint(databasePath),
    wal: await fileFingerprint(`${databasePath}-wal`),
  };
}

function isMissing(fingerprintValue: string): boolean {
  return fingerprintValue === "unavailable:ENOENT";
}

function isUnavailable(fingerprintValue: string): boolean {
  return fingerprintValue.startsWith("unavailable:");
}

function fingerprintsEqual(left: ArtifactFingerprint, right: ArtifactFingerprint): boolean {
  return left.database === right.database && left.wal === right.wal;
}

export async function createWorkspaceDatabaseSnapshot(
  sourceDatabasePath: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceDatabaseSnapshot> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_SNAPSHOT_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Snapshot attempts must be a positive integer.");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "cbi-workspace-status-"));
    const snapshotDatabasePath = path.join(snapshotRoot, "codebase.db");
    try {
      const before = await fingerprint(sourceDatabasePath);
      if (isUnavailable(before.database)) throw new Error("Workspace index database is missing or unreadable.");
      if (isUnavailable(before.wal) && !isMissing(before.wal)) {
        throw new Error("Workspace index WAL is unreadable.");
      }
      await copyFile(sourceDatabasePath, snapshotDatabasePath);
      if (!isMissing(before.wal)) {
        await copyFile(`${sourceDatabasePath}-wal`, `${snapshotDatabasePath}-wal`);
      }
      await options.afterCopyAttempt?.(attempt);
      const after = await fingerprint(sourceDatabasePath);
      if (fingerprintsEqual(before, after)) {
        return {
          databasePath: snapshotDatabasePath,
          close: async () => rm(snapshotRoot, { recursive: true, force: true }),
        };
      }
    } catch (error) {
      await rm(snapshotRoot, { recursive: true, force: true });
      if (error instanceof Error && (
        error.message === "Workspace index database is missing or unreadable."
        || error.message === "Workspace index WAL is unreadable."
      )) throw error;
      if (attempt === maxAttempts) throw new Error("Workspace index database changed during status inspection.");
      continue;
    }
    await rm(snapshotRoot, { recursive: true, force: true });
  }

  throw new Error("Workspace index database changed during status inspection.");
}
