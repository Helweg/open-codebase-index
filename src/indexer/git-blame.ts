import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";

import { throwIfOperationAborted } from "../utils/operation-control.js";

const execFileAsync = promisify(execFile);

export interface GitBlameMetadata {
  readonly sha: string;
  readonly author: string;
  readonly authorEmail: string;
  readonly committedAt: number;
  readonly summary: string;
}

interface MutableBlameMetadata {
  sha: string;
  author: string;
  authorEmail: string;
  committedAt: number;
  summary: string;
  lines: number;
}

export function parseGitBlamePorcelain(output: string): GitBlameMetadata | undefined {
  const commits = new Map<string, MutableBlameMetadata>();
  let current: MutableBlameMetadata | undefined;

  for (const line of output.split("\n")) {
    if (/^[0-9a-f]{40} /.test(line)) {
      const sha = line.slice(0, 40);
      current = commits.get(sha) ?? {
        sha,
        author: "",
        authorEmail: "",
        committedAt: 0,
        summary: "",
        lines: 0,
      };
      commits.set(sha, current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("author ")) {
      current.author = line.slice("author ".length);
    } else if (line.startsWith("author-mail ")) {
      current.authorEmail = line.slice("author-mail ".length).replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      current.committedAt = Number.parseInt(line.slice("author-time ".length), 10);
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
    } else if (line.startsWith("\t")) {
      current.lines += 1;
    }
  }

  return Array.from(commits.values())
    .filter((commit) => commit.lines > 0)
    .sort((a, b) => b.lines - a.lines || b.committedAt - a.committedAt)[0];
}

export async function getChunkGitBlame(
  projectRoot: string,
  filePath: string,
  startLine: number,
  endLine: number,
  signal?: AbortSignal,
): Promise<GitBlameMetadata | undefined> {
  throwIfOperationAborted(signal);
  const relativePath = path.relative(projectRoot, filePath);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["blame", "--line-porcelain", "-L", `${startLine},${endLine}`, "--", relativePath],
      { cwd: projectRoot, timeout: 30000, signal }
    );
    throwIfOperationAborted(signal);
    return parseGitBlamePorcelain(stdout);
  } catch {
    throwIfOperationAborted(signal);
    return undefined;
  }
}
