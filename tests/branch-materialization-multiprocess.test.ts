import type { ChildProcess } from "child_process";
import { execFileSync, fork } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface WorkerSuccess {
  ok: true;
  branch: string;
  commit: string;
  materializedHead: string;
  content: string;
  source: string;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

type WorkerMessage = WorkerSuccess | WorkerFailure;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitBranchValue(repo: string, value: string, message: string): string {
  fs.writeFileSync(path.join(repo, "branch.txt"), `${value}\n`);
  git(repo, ["add", "--", "branch.txt"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runWorker(
  workerPath: string,
  request: { projectRoot: string; branch: string; expectedCommit: string },
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; result: Promise<WorkerSuccess> } {
  const child = fork(workerPath, [], {
    cwd: path.dirname(path.dirname(workerPath)),
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      ...env,
      BRANCH_MATERIALIZATION_REQUEST: JSON.stringify(request),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  const result = new Promise<WorkerSuccess>((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("message", (message: WorkerMessage) => {
      if (message.ok) {
        resolve(message);
      } else {
        reject(new Error(message.error));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with ${String(code)}: ${stderr}`));
      }
    });
  });

  return { child, result };
}

async function waitForReadyFiles(barrierDir: string, expected: number): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = fs.readdirSync(barrierDir).filter((entry) => entry.startsWith("ready."));
    if (ready.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected} concurrent fetches.`);
}

const describeMultiprocess = process.platform === "win32" ? describe.skip : describe;

describeMultiprocess("branch materialization multiprocess fetch isolation", () => {
  let tempDir: string;
  let repo: string;
  let remote: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-materialization-multiprocess-"));
    repo = path.join(tempDir, "repo");
    remote = path.join(tempDir, "remote.git");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    commitBranchValue(repo, "main", "main");
    git(repo, ["checkout", "-b", "alpha"]);
    commitBranchValue(repo, "alpha", "alpha");
    git(repo, ["checkout", "main"]);
    git(repo, ["checkout", "-b", "beta"]);
    commitBranchValue(repo, "beta", "beta");
    git(repo, ["checkout", "main"]);
    git(tempDir, ["init", "--bare", remote]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "alpha", "beta"]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns each invocation-local OID during real overlapping fetches and cleans temporary refs", async () => {
    const alphaCommit = git(repo, ["rev-parse", "alpha"]);
    const betaCommit = git(repo, ["rev-parse", "beta"]);
    git(repo, ["branch", "-D", "alpha"]);
    git(repo, ["branch", "-D", "beta"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/alpha"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/beta"]);
    git(repo, ["reflog", "expire", "--expire=now", "--all"]);
    git(repo, ["gc", "--prune=now"]);

    const fetchHeadPath = path.join(repo, ".git", "FETCH_HEAD");
    fs.writeFileSync(fetchHeadPath, "multiprocess-sentinel\n");
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);

    const barrierDir = path.join(tempDir, "barrier");
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(barrierDir);
    fs.mkdirSync(binDir);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(binDir, "git");
    fs.writeFileSync(wrapper, `#!/bin/sh
REAL_GIT=${shellQuote(realGit)}
if [ "$1" = "fetch" ]; then
  "$REAL_GIT" "$@"
  status=$?
  : > "$BARRIER_DIR/ready.$$"
  count=0
  while [ ! -f "$BARRIER_DIR/release" ] && [ "$count" -lt 1500 ]; do
    sleep 0.01
    count=$((count + 1))
  done
  exit "$status"
fi
exec "$REAL_GIT" "$@"
`);
    fs.chmodSync(wrapper, 0o755);

    const workerPath = fileURLToPath(new URL("./fixtures/branch-materialization-oid-worker.ts", import.meta.url));
    const childEnv = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      BARRIER_DIR: barrierDir,
    };
    const alpha = runWorker(workerPath, {
      projectRoot: repo,
      branch: "origin/alpha",
      expectedCommit: alphaCommit,
    }, childEnv);
    const beta = runWorker(workerPath, {
      projectRoot: repo,
      branch: "origin/beta",
      expectedCommit: betaCommit,
    }, childEnv);

    try {
      await waitForReadyFiles(barrierDir, 2);
      fs.writeFileSync(path.join(barrierDir, "release"), "release\n");
      const [alphaResult, betaResult] = await Promise.all([alpha.result, beta.result]);

      expect(alphaResult).toMatchObject({
        branch: "origin/alpha",
        commit: alphaCommit,
        materializedHead: alphaCommit,
        content: "alpha",
        source: "remote-fetch",
      });
      expect(betaResult).toMatchObject({
        branch: "origin/beta",
        commit: betaCommit,
        materializedHead: betaCommit,
        content: "beta",
        source: "remote-fetch",
      });
    } finally {
      fs.writeFileSync(path.join(barrierDir, "release"), "release\n");
      for (const child of [alpha.child, beta.child]) {
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    }

    expect(fs.readFileSync(fetchHeadPath, "utf8")).toBe("multiprocess-sentinel\n");
    expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/codebase-index"])).toBe("");
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
  }, 30000);
});
