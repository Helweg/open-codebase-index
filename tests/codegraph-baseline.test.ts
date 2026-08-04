import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createIsolatedSourceCopy,
  parseCodeGraphOutput,
  withIsolatedSourceCopy,
} from "../scripts/codegraph-baseline.js";

const tempDirs: string[] = [];

function withTempRepo(builder: (root: string) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-baseline-fixture-"));
  tempDirs.push(root);
  builder(root);
  return root;
}

function withTempFile(filePath: string): string {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filePath, "ok", "utf-8");
  return filePath;
}

describe("codegraph baseline foundation", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const root = tempDirs.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("parses strict CodeGraph result shape and resolves in-repo node paths", () => {
    const source = withTempRepo((root) => {
      withTempFile(path.join(root, "src", "index.ts"));
    });
    const queryOutput = JSON.stringify([
      {
        node: {
          filePath: "src/index.ts",
          startLine: 1,
          endLine: 2,
          kind: "function_declaration",
          name: "main",
        },
        score: 0.98,
      },
    ]);

    const parsed = parseCodeGraphOutput(queryOutput, source);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.node.filePath).toBe(path.join(source, "src/index.ts"));
    expect(parsed[0]!.score).toBe(0.98);
  });

  it("fails closed for malformed JSON output", () => {
    const source = withTempRepo(() => {});

    expect(() => parseCodeGraphOutput("not-json", source)).toThrowError(/Malformed CodeGraph output/);
    expect(() => parseCodeGraphOutput("{}", source)).toThrowError(/Malformed CodeGraph output/);
    expect(() =>
      parseCodeGraphOutput(
        JSON.stringify([
          {
            node: {
              filePath: "src/index.ts",
              startLine: 1,
              endLine: 2,
              kind: "function_declaration",
              name: "main",
            },
          },
        ]),
        source,
      ),
    ).toThrowError(/missing node or score/);
    expect(() =>
      parseCodeGraphOutput(
        JSON.stringify([
          {
            node: {
              filePath: "src/index.ts",
              startLine: 1,
              endLine: 0,
              kind: "function_declaration",
              name: "main",
            },
            score: 0.5,
          },
        ]),
        source,
      ),
    ).toThrowError(/invalid line span/);
  });

  it("rejects filePath values outside isolated repo", () => {
    const source = withTempRepo((root) => {
      withTempFile(path.join(root, "src", "index.ts"));
    });

    const relativeTraversal = path.join("..", "outside.ts");
    const absoluteOutside = path.join(os.tmpdir(), "outside.ts");

    expect(() =>
      parseCodeGraphOutput(
        JSON.stringify([
          {
            node: {
              filePath: relativeTraversal,
              startLine: 1,
              endLine: 1,
              kind: "function_declaration",
              name: "x",
            },
            score: 0.1,
          },
        ]),
        source,
      ),
    ).toThrowError(/outside isolated repo/);

    expect(() =>
      parseCodeGraphOutput(
        JSON.stringify([
          {
            node: {
              filePath: absoluteOutside,
              startLine: 1,
              endLine: 1,
              kind: "function_declaration",
              name: "x",
            },
            score: 0.1,
          },
        ]),
        source,
      ),
    ).toThrowError(/outside isolated repo/);
  });

  it("creates an isolated copy while excluding benchmark and tool directories", () => {
    const source = withTempRepo((root) => {
      withTempFile(path.join(root, "src", "index.ts"));
      withTempFile(path.join(root, "README.md"));
      withTempFile(path.join(root, ".git", "HEAD"));
      withTempFile(path.join(root, ".codegraph", "config.json"));
      withTempFile(path.join(root, ".codebase-index", "state.json"));
      withTempFile(path.join(root, "node_modules", "pkg", "index.js"));
      withTempFile(path.join(root, "dist", "bundle.js"));
      withTempFile(path.join(root, "build", "out.js"));
      withTempFile(path.join(root, "target", "cache.txt"));
      withTempFile(path.join(root, "coverage", "coverage.txt"));
      withTempFile(path.join(root, "benchmarks", "results", "query.json"));
      withTempFile(path.join(root, "benchmarks", "other", "fixture.json"));
    });

    const isolated = createIsolatedSourceCopy(source);
    try {
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "src/index.ts"))).toBe(true);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "benchmarks", "other", "fixture.json"))).toBe(true);

      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, ".git"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, ".codegraph"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, ".codebase-index"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "dist"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "build"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "target"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "coverage"))).toBe(false);
      expect(fs.existsSync(path.join(isolated.isolatedRepoPath, "benchmarks", "results"))).toBe(false);
    } finally {
      isolated.cleanup();
    }

    expect(fs.existsSync(isolated.isolatedRepoPath)).toBe(false);
  });

  it("always cleans up isolated copies when callback throws", () => {
    const source = withTempRepo((root) => {
      withTempFile(path.join(root, "src", "index.ts"));
    });

    let isolatedCopy = "";

    expect(() =>
      withIsolatedSourceCopy(source, (isolatedRepoPath) => {
        isolatedCopy = isolatedRepoPath;
        expect(fs.existsSync(path.join(isolatedRepoPath, "src/index.ts"))).toBe(true);
        throw new Error("fail-closed");
      }),
    ).toThrowError("fail-closed");

    expect(isolatedCopy).not.toBe("");
    expect(fs.existsSync(isolatedCopy)).toBe(false);
  });
});
