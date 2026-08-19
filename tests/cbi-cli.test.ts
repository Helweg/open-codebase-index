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
});
