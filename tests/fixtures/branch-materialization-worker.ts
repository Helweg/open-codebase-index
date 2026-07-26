import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { withMaterializedBranch } from "../../src/git/branch-materialization.js";

interface ReadyMessage {
  type: "ready";
  branch: string;
}

interface ResultMessage {
  type: "result";
  branch: string;
  commit: string;
  source: string;
  fetched: boolean;
  head: string;
  content: string;
}

interface ErrorMessage {
  type: "error";
  branch: string;
  message: string;
  stack?: string;
}

type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;

const projectRoot = process.env.TEST_PROJECT_ROOT;
const branch = process.env.TEST_BRANCH;
const expectedContent = process.env.TEST_EXPECTED_CONTENT;
const fetchBarrierDir = process.env.TEST_FETCH_BARRIER_DIR;

if (!projectRoot || !branch || !expectedContent || !fetchBarrierDir) {
  throw new Error("TEST_PROJECT_ROOT, TEST_BRANCH, TEST_EXPECTED_CONTENT, and TEST_FETCH_BARRIER_DIR are required");
}

function send(message: WorkerMessage): void {
  if (process.send) process.send(message);
}

function waitForStartMessage(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (message: { type?: string }): void => {
      if (message.type === "start") {
        process.removeListener("message", handler);
        resolve();
      }
    };
    process.on("message", handler);
  });
}

send({ type: "ready", branch });

void (async () => {
  try {
    await waitForStartMessage();
    const result = await withMaterializedBranch(
      { projectRoot, branch },
      async (worktreePath) => {
        const content = fs.readFileSync(path.join(worktreePath, "src", "value.ts"), "utf-8");
        const head = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: worktreePath,
          encoding: "utf-8",
        }).trim();
        if (content !== expectedContent) {
          throw new Error(`Unexpected file content for ${branch}`);
        }
        return { commit: head, source: "materialized", fetched: true, head, content };
      },
    );

    send({
      type: "result",
      branch,
      commit: result.info.commit,
      source: result.info.source,
      fetched: result.info.fetched,
      head: result.value.head,
      content: result.value.content,
    });
  } catch (error) {
    send({
      type: "error",
      branch,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
})();
