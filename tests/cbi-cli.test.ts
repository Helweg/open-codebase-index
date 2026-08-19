import { describe, expect, it } from "vitest";

import { parseCbiCommandArgs, runCbiCli } from "../src/adapters/cbi.js";

describe("cbi CLI", () => {
  it("parses search options without treating option values as positional arguments", () => {
    expect(parseCbiCommandArgs("search", ["retry logic", "--limit", "3", "--project", "repo", "--host", "jcode"], "/tmp"))
      .toMatchObject({ positionals: ["retry logic"], limit: 3, project: "/tmp/repo", host: "jcode" });
  });

  it("prints status through the shared status operation", async () => {
    const stdout: string[] = [];
    const exitCode = await runCbiCli(["node", "cbi", "status", "--project", "/repo", "--host", "jcode"], "/tmp", {
      runStatus: async () => ({ text: "Indexed chunks: 10" }),
      printStdout: (text) => stdout.push(text),
      printStderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["Indexed chunks: 10"]);
  });

  it("dispatches search, definition, and graph commands with parsed inputs", async () => {
    const calls: string[] = [];
    const deps = {
      runSearch: async (_root: string | undefined, _host: string, query: string, limit: number) => {
        calls.push(`search:${query}:${limit}`);
        return { text: "search result" };
      },
      runDefinition: async (_root: string | undefined, _host: string, query: string) => {
        calls.push(`definition:${query}`);
        return { text: "definition result" };
      },
      runCallGraph: async (_root: string | undefined, _host: string, symbol: string, direction: "callers" | "callees", filePath?: string) => {
        calls.push(`graph:${direction}:${symbol}:${filePath}`);
        return { text: "graph result" };
      },
      printStdout: () => undefined,
      printStderr: () => undefined,
    };

    await runCbiCli(["node", "cbi", "search", "retry", "--limit=2"], "/tmp", deps);
    await runCbiCli(["node", "cbi", "definition", "Indexer"], "/tmp", deps);
    await runCbiCli(["node", "cbi", "graph", "callees", "Indexer", "--file", "src/index.ts"], "/tmp", deps);

    expect(calls).toEqual(["search:retry:2", "definition:Indexer", "graph:callees:Indexer:/tmp/src/index.ts"]);
  });

  it("parses search options placed around the positional query without leaking values into positionals", () => {
    const cwd = "/tmp";

    const before = parseCbiCommandArgs("search", ["project-query", "--project", "repo", "--host", "jcode", "--config", "ci.json", "--limit", "3"], cwd);
    expect(before).toMatchObject({
      positionals: ["project-query"],
      project: "/tmp/repo",
      host: "jcode",
      config: "/tmp/ci.json",
      limit: 3,
    });

    const after = parseCbiCommandArgs("search", ["project-query", "--limit", "3", "--project", "repo", "--host", "jcode", "--config", "ci.json"], cwd);
    expect(after).toMatchObject({
      positionals: ["project-query"],
      project: "/tmp/repo",
      host: "jcode",
      config: "/tmp/ci.json",
      limit: 3,
    });
  });

  it("parses definition options before and after the positional symbol without treating values as positionals", () => {
    const before = parseCbiCommandArgs("definition", ["--project", "repo", "--host", "jcode", "--config", "ci.json", "CodebaseIndex"], "/tmp");
    expect(before.positionals).toEqual(["CodebaseIndex"]);
    expect(before.project).toBe("/tmp/repo");
    expect(before.host).toBe("jcode");
    expect(before.config).toBe("/tmp/ci.json");

    const after = parseCbiCommandArgs("definition", ["CodebaseIndex", "--config", "ci.json", "--project", "repo", "--host", "jcode"], "/tmp");
    expect(after.positionals).toEqual(["CodebaseIndex"]);
    expect(after.project).toBe("/tmp/repo");
    expect(after.host).toBe("jcode");
    expect(after.config).toBe("/tmp/ci.json");
  });

  it("parses graph --file and shared global options before and after required args", () => {
    const first = parseCbiCommandArgs("graph", ["callers", "codebaseContext", "--file", "src/index.ts", "--project", "repo", "--host", "jcode", "--config", "cli.json"], "/tmp");
    expect(first.positionals).toEqual(["callers", "codebaseContext"]);
    expect(first.filePath).toBe("/tmp/src/index.ts");
    expect(first.project).toBe("/tmp/repo");
    expect(first.host).toBe("jcode");
    expect(first.config).toBe("/tmp/cli.json");

    const second = parseCbiCommandArgs("graph", ["--file", "src/index.ts", "--project", "repo", "--host", "jcode", "callers", "codebaseContext", "--config", "cli.json"], "/tmp");
    expect(second.positionals).toEqual(["callers", "codebaseContext"]);
    expect(second.filePath).toBe("/tmp/src/index.ts");
    expect(second.project).toBe("/tmp/repo");
    expect(second.host).toBe("jcode");
    expect(second.config).toBe("/tmp/cli.json");
  });
});
