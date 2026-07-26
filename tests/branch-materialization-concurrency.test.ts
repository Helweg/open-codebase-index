import { ChildProcess, fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface WorkerReadyMessage {
  type: "ready";
  branch: string;
}

interface WorkerResultMessage {
  type: "result";
  branch: string;
  commit: string;
  source: string;
  fetched: boolean;
  head: string;
  content: string;
}

interface WorkerErrorMessage {
  type: "error";
  branch: string;
  message: string;
  stack?: string;
}

type WorkerMessage = WorkerReadyMessage | WorkerResultMessage | WorkerErrorMessage;

interface WorkerResult {
  branch: string;
  commit: string;
  source: string;
  fetched: boolean;
  head: string;
  content: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function getAllRefs(cwd: string): string[] {
  return git(cwd, ["for-each-ref", "--format=%(refname)"]).split(/\r?\n/).filter(Boolean);
}

interface MaterializationWorker {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<WorkerResult>;
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const listener = (): void => {
      child.off("exit", listener);
      resolve();
    };

    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    child.once("exit", listener);
    child.kill("SIGKILL");
  });
}

function createMaterializationWorker(
  projectRoot: string,
  branch: string,
  expectedContent: string,
  barrierDir: string,
): MaterializationWorker {
  const workerPath = fileURLToPath(new URL("./fixtures/branch-materialization-worker.ts", import.meta.url));
  const child = fork(workerPath, [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      TEST_PROJECT_ROOT: projectRoot,
      TEST_BRANCH: branch,
      TEST_EXPECTED_CONTENT: expectedContent,
      TEST_FETCH_BARRIER_DIR: barrierDir,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let resultResolve!: (result: WorkerResult) => void;
  let resultReject!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const resultPromise = new Promise<WorkerResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });

  let settled = false;

  const onExit = (): void => {
    if (settled) return;
    settleFromExit(new Error(`Materialization worker for ${branch} exited before returning a result`));
  };

  const settleFromExit = (error: Error): void => {
    settleError(error);
  };

  const settleError = (error: Error): void => {
    if (settled) return;
    settled = true;
    resultReject(error);
    readyReject(error);
  };

  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object") return;
    const typed = message as WorkerMessage;
    if (typed.type === "ready") {
      readyResolve();
      return;
    }
    if (typed.type === "result") {
      if (settled) return;
      settled = true;
      const result: WorkerResult = {
        branch: typed.branch,
        commit: typed.commit,
        source: typed.source,
        fetched: typed.fetched,
        head: typed.head,
        content: typed.content,
      };
      resultResolve(result);
      return;
    }

    if (typed.type === "error") {
      const error = new Error(typed.message);
      if (typed.stack) error.stack = typed.stack;
      settleError(error);
    }
  };

  child.on("message", onMessage);
  child.on("error", (error) => {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    settleError(wrapped);
  });
  child.once("exit", onExit);

  return {
    child,
    ready: readyPromise,
    result: resultPromise,
  };
}

describe("branch materialization concurrency", () => {
  let tempDir: string;
  let repo: string;
  let sourceRepo: string;
  let remote: string;
  let alphaCommit: string;
  let betaCommit: string;
  let uploadPackWrapper: string;

  const alphaBranch = "alpha-branch";
  const betaBranch = "beta-branch";
  const alphaContent = "export const value = 'alpha';\n";
  const betaContent = "export const value = 'beta';\n";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-materialization-concurrency-"));
    sourceRepo = path.join(tempDir, "source");
    repo = path.join(tempDir, "repo");
    remote = path.join(tempDir, "remote.git");
    fs.mkdirSync(sourceRepo);
    fs.mkdirSync(repo);

    git(sourceRepo, ["init", "-b", "main"]);
    git(sourceRepo, ["config", "user.email", "test@example.com"]);
    git(sourceRepo, ["config", "user.name", "Test User"]);
    commitFile(sourceRepo, "src/value.ts", "export const value = 'main';\n", "main");

    git(sourceRepo, ["checkout", "-b", alphaBranch]);
    alphaCommit = commitFile(sourceRepo, "src/value.ts", alphaContent, "alpha");

    git(sourceRepo, ["checkout", "main"]);
    git(sourceRepo, ["checkout", "-b", betaBranch]);
    betaCommit = commitFile(sourceRepo, "src/value.ts", betaContent, "beta");

    git(sourceRepo, ["checkout", "main"]);

    git(tempDir, ["init", "--bare", remote]);
    git(sourceRepo, ["remote", "add", "origin", remote]);
    git(sourceRepo, ["push", "origin", alphaBranch, betaBranch, "main"]);

    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    commitFile(repo, "src/value.ts", "export const value = 'local';\n", "local main");
    git(repo, ["remote", "add", "origin", remote]);

    uploadPackWrapper = path.join(tempDir, "barrier-upload-pack.sh");
    fs.writeFileSync(uploadPackWrapper, `#!/bin/sh
set -eu
marker="$TEST_FETCH_BARRIER_DIR/$$"
touch "$marker"
while [ "$(find "$TEST_FETCH_BARRIER_DIR" -type f | wc -l | tr -d ' ')" -lt 2 ]; do
  sleep 0.01
done
exec git-upload-pack "$@"
`);
    fs.chmodSync(uploadPackWrapper, 0o755);
    git(repo, ["config", "remote.origin.uploadpack", uploadPackWrapper]);
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes two remote branches concurrently in separate processes", async () => {
    for (let index = 0; index < 5; index += 1) {
      git(repo, ["update-ref", "-d", `refs/remotes/origin/${alphaBranch}`]);
      git(repo, ["update-ref", "-d", `refs/remotes/origin/${betaBranch}`]);
      const barrierDir = path.join(tempDir, `barrier-${index}`);
      fs.mkdirSync(barrierDir);
      const alphaWorker = createMaterializationWorker(repo, `origin/${alphaBranch}`, alphaContent, barrierDir);
      const betaWorker = createMaterializationWorker(repo, `origin/${betaBranch}`, betaContent, barrierDir);

      try {
        await Promise.all([alphaWorker.ready, betaWorker.ready]);
        alphaWorker.child.send({ type: "start" });
        betaWorker.child.send({ type: "start" });

        const [alphaResult, betaResult] = await Promise.all([alphaWorker.result, betaWorker.result]);

        expect(alphaResult.branch).toBe(`origin/${alphaBranch}`);
        expect(betaResult.branch).toBe(`origin/${betaBranch}`);
        expect(alphaResult.commit).toBe(alphaCommit);
        expect(betaResult.commit).toBe(betaCommit);
        expect(alphaResult.head).toBe(alphaCommit);
        expect(betaResult.head).toBe(betaCommit);
        expect(alphaResult.content).toBe(alphaContent);
        expect(betaResult.content).toBe(betaContent);
        expect(alphaResult.source).toBe("remote-fetch");
        expect(betaResult.source).toBe("remote-fetch");

        const refs = getAllRefs(repo);
        const lingeringRefs = refs.filter((name) => name.startsWith("refs/codebase-index/") || /^refs\/fetch-/.test(name));
        expect(lingeringRefs).toEqual([]);
      } finally {
        await Promise.all([
          killAndWait(alphaWorker.child),
          killAndWait(betaWorker.child),
        ]);
      }
    }
  });
});
