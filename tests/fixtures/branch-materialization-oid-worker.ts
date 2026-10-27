import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { setTimeout as delay } from "node:timers/promises";

import { withMaterializedBranch } from "../../src/git/branch-materialization.js";

interface WorkerRequest {
  projectRoot: string;
  branch: string;
  expectedCommit: string;
}

interface WorkerResult {
  ok: true;
  branch: string;
  commit: string;
  materializedHead: string;
  content: string;
  source: string;
}

async function main(): Promise<void> {
  const request = JSON.parse(process.env.BRANCH_MATERIALIZATION_REQUEST ?? "") as WorkerRequest;
  const result = await withMaterializedBranch(
    {
      projectRoot: request.projectRoot,
      branch: request.branch,
      expectedCommit: request.expectedCommit,
    },
    async (worktreePath, info) => {
      const barrierDir = process.env.MATERIALIZATION_BARRIER_DIR;
      if (barrierDir) {
        fs.writeFileSync(path.join(barrierDir, `materialized.${process.pid}`), "ready\n");
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(path.join(barrierDir, "release-materialization"))) {
          if (Date.now() >= deadline) throw new Error("Concurrent materialization callback barrier timed out");
          await delay(20);
        }
      }
      return {
        branch: request.branch,
        commit: info.commit,
        materializedHead: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: worktreePath,
          encoding: "utf8",
        }).trim(),
        content: fs.readFileSync(path.join(worktreePath, "branch.txt"), "utf8").trim(),
        source: info.source,
      };
    },
  );

  process.send?.({ ok: true, ...result.value } satisfies WorkerResult);
}

main()
  .catch((error: unknown) => {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(() => {
    process.disconnect?.();
  });
