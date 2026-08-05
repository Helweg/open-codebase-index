import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BenchmarkManifest,
  ensurePreparedWorkspace,
  executeBenchmark,
  parseCliArgs,
  parseManifest,
  planSummary,
  prepareRepositories,
} from "../scripts/run-codegraph-official-agent-benchmark.js";

interface MockCall {
  command: string;
  args: string[];
  cwd?: string;
}

function makeCommandRunner(
  callMap: MockCall[],
  options: { gitHeadByPath?: Record<string, string>; defaultGitHead?: string },
): (command: string, args: string[], runnerOptions?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }> {
  return async (
    command: string,
    args: string[],
    runnerOptions?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> => {
    callMap.push({ command, args: [...args], cwd: runnerOptions?.cwd });

    if (
      command === "git" &&
      args.includes("rev-parse") &&
      args.includes("HEAD") &&
      args.includes("-C")
    ) {
      const repoIndex = args.indexOf("-C");
      const repoPath = repoIndex >= 0 ? args[repoIndex + 1] : "";
      const head = options.gitHeadByPath?.[repoPath] ?? options.defaultGitHead;
      return { stdout: `${head ?? ""}\n`, stderr: "" };
    }

    if (command === "claude") {
      return { stdout: "{\"type\":\"final\"}\n", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  };
}

function miniManifest(): BenchmarkManifest {
  return {
    version: 1,
    source: {
      name: "Mini benchmark",
      methodologyRepository: "https://github.com/colbymchenry/codegraph.git",
      methodologyCommit: "a".repeat(40),
      codegraphPackage: "@colbymchenry/codegraph@1.5.0",
      defaultRuns: 2,
      defaultTurns: 1,
      model: "sonnet",
      effort: "high",
    },
    repositories: [
      {
        id: "mini",
        url: "https://github.com/example/example.git",
        commit: "b".repeat(40),
        questions: ["What happens next?"],
      },
    ],
  };
}

function buildSevenRepoManifest(): BenchmarkManifest {
  return {
    version: 1,
    source: {
      name: "CodeGraph README agent benchmark",
      methodologyRepository: "https://github.com/colbymchenry/codegraph",
      methodologyCommit: "a".repeat(40),
      codegraphPackage: "@colbymchenry/codegraph@1.5.0",
      defaultRuns: 4,
      defaultTurns: 3,
      model: "sonnet",
      effort: "high",
    },
    repositories: [
      { id: "vscode", url: "https://github.com/microsoft/vscode.git", commit: "b".repeat(40), questions: ["How?", "Why?", "What?"] },
      { id: "excalidraw", url: "https://github.com/excalidraw/excalidraw.git", commit: "c".repeat(40), questions: ["How?", "Why?", "What?"] },
      { id: "django", url: "https://github.com/django/django.git", commit: "d".repeat(40), questions: ["How?", "Why?", "What?"] },
      { id: "tokio", url: "https://github.com/tokio-rs/tokio.git", commit: "e".repeat(40), questions: ["How?", "Why?", "What?"] },
      { id: "okhttp", url: "https://github.com/square/okhttp.git", commit: "f".repeat(40), questions: ["How?", "Why?", "What?"] },
      { id: "gin", url: "https://github.com/gin-gonic/gin.git", commit: "1".repeat(40), questions: ["How?", "Why?", "What?"] },
      { id: "alamofire", url: "https://github.com/Alamofire/Alamofire.git", commit: "2".repeat(40), questions: ["How?", "Why?", "What?"] },
    ],
  };
}

function withManifestFile(manifest: BenchmarkManifest, apply?: (obj: BenchmarkManifest) => BenchmarkManifest): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "codebase-bench-manifest-"));
  const file = path.join(root, "manifest.json");

  const data = apply ? apply({ ...manifest }) : manifest;
  fs.writeFileSync(file, JSON.stringify(data), "utf-8");
  return file;
}

describe("run-codegraph-official-agent benchmark manifest parser", () => {
  it("parses and validates the committed JSON manifest", () => {
    const manifest = buildSevenRepoManifest();
    const manifestPath = withManifestFile(manifest);

    try {
      const parsed = parseManifest(manifestPath);
      expect(parsed.version).toBe(1);
      expect(parsed.source.codegraphPackage).toBe("@colbymchenry/codegraph@1.5.0");
      expect(parsed.repositories).toHaveLength(7);
    } finally {
      rmSync(path.dirname(manifestPath), { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level and repository fields", () => {
    const fixturePath = withManifestFile(buildSevenRepoManifest());
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-bench-top-"));
    const topPath = path.join(tempDir, "top.json");

    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as {
      repositories: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

    const mutatedTop = { ...fixture, unexpected: true };
    const mutatedRepo = {
      ...fixture.repositories[0],
      unexpectedRepoField: 5,
    };
    const mutatedSource = {
      ...fixture,
      repositories: [mutatedRepo],
    };
    const repoPath = path.join(tempDir, "repo.json");

    try {
      fs.writeFileSync(topPath, JSON.stringify(mutatedTop), "utf-8");
      expect(() => parseManifest(topPath)).toThrow(/unexpected top-level field/i);

      fs.writeFileSync(repoPath, JSON.stringify(mutatedSource), "utf-8");
      expect(() => parseManifest(repoPath)).toThrow(/unexpected field/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(path.dirname(fixturePath), { recursive: true, force: true });
    }
  });
});

describe("run-codegraph-official-agent benchmark CLI args", () => {
  it("accepts explicit mode flags and keeps defaults", () => {
    const args = parseCliArgs(["--dry-run"]);
    expect(args.mode).toBe("dry-run");
    expect(args.runs).toBe(0);
    expect(args.turns).toBe(0);
  });

  it("enforces mutually exclusive --prepare and --execute", () => {
    expect(() => parseCliArgs(["--prepare", "--execute"])).toThrow(/Cannot combine/);
  });

  it("parses run and turn overrides", () => {
    const args = parseCliArgs(["--runs", "2", "--turns", "1", "--max-budget", "7.5"]);
    expect(args.runs).toBe(2);
    expect(args.turns).toBe(1);
    expect(args.maxBudgetUsd).toBe(7.5);
  });
});

describe("run-codegraph-official-agent benchmark planning", () => {
  const manifest = buildSevenRepoManifest();

  it("prints total sessions for three-arm plan", () => {
    const summary = planSummary(manifest, 4, 3, 4);
    expect(summary).toContain("Three-arm plan");
    expect(summary).toContain("Repos: 7");
    expect(summary).toContain("Runs per repo: 4");
    expect(summary).toContain("Turns per run: 3");
    expect(summary).toContain("Total planned agent sessions: 84");
    expect(summary).toContain("Max budget ceiling: $4.00 per session");
  });
});

describe("run-codegraph-official-agent benchmark execution plumbing", () => {
  it("enforces prepared-workspace precondition for execute", async () => {
    const manifest = miniManifest();
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "codebase-bench-no-prepare-"));

    await expect(
      executeBenchmark(manifest, outputDir, 1, 1, 4, async () => ({ stdout: "", stderr: "" })),
    ).rejects.toMatchObject({
      message: expect.stringContaining("No prepared repos found"),
    });

    rmSync(outputDir, { recursive: true, force: true });
  });

  it("prepares repositories and executes with strict MCP configs and jsonl outputs", async () => {
    const manifest = miniManifest();
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "codebase-bench-prepare-run-"));
    const commands: MockCall[] = [];
    const runner = makeCommandRunner(commands, { defaultGitHead: manifest.repositories[0].commit });

    try {
      const repoPath = path.join(outputDir, "prepared", "mini");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "file.txt"), "ready", "utf-8");

      await prepareRepositories(manifest, outputDir, undefined, runner);

      const preparedStatePath = path.join(outputDir, "prepared.json");
      expect(fs.existsSync(preparedStatePath)).toBe(true);

      await executeBenchmark(manifest, outputDir, 1, 1, 4, runner);

      const runsRoot = path.join(outputDir, "runs");
      const runDirs = fs.readdirSync(runsRoot);
      expect(runDirs).toHaveLength(1);

      const runRoot = path.join(runsRoot, runDirs[0]);
      const armRoots = ["baseline", "codegraph", "open-codebase-index"];
      for (const arm of armRoots) {
        const armConfig = path.join(runRoot, "mini", arm, "run-1", `mcp-config-${arm}.json`);
        expect(fs.existsSync(armConfig)).toBe(true);

        const armArtifact = path.join(runRoot, "mini", arm, "run-1", "turn-1.jsonl");
        expect(fs.existsSync(armArtifact)).toBe(true);

        const text = fs.readFileSync(armArtifact, "utf-8");
        expect(text).toContain("\"type\":\"final\"");
      }

      const openCodebaseConfig = JSON.parse(
        fs.readFileSync(
          path.join(runRoot, "mini", "open-codebase-index", "run-1", "mcp-config-open-codebase-index.json"),
          "utf-8",
        ),
      ) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(openCodebaseConfig.mcpServers["open-codebase-index"]).toEqual(
        expect.objectContaining({
          command: "node",
        }),
      );

      const claudeCalls = commands.filter((entry) => entry.command === "claude");
      expect(claudeCalls).toHaveLength(3);
      for (const call of claudeCalls) {
        const text = call.args.join(" ");
        expect(text).toContain("--model sonnet");
        expect(text).toContain("--effort high");
        expect(text).toContain("--output-format stream-json");
        expect(text).toContain("--strict-mcp-config");
        expect(text).toContain("--permission-mode bypassPermissions");
        expect(text).toContain("--max-budget-usd 4");
        expect(call.cwd).toContain(path.join("run-1", "workspace"));
      }

      expect(commands.some((entry) => entry.command === "npx" && entry.args.includes("init"))).toBe(true);
      expect(commands.some((entry) => entry.command === "node" && entry.args.includes("index"))).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects prepared state whose commit no longer matches current manifest", async () => {
    const manifest = miniManifest();
    const mismatchCommit = "c".repeat(40);
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-bench-mismatch-"));
    const marker = {
      manifestPath: path.join(tempDir, "manifest.json"),
      source: manifest.source,
      repositories: [
        {
          id: manifest.repositories[0].id,
          path: path.join(tempDir, "repo"),
          commit: mismatchCommit,
        },
      ],
      preparedAt: new Date().toISOString(),
    };

    fs.mkdirSync(marker.repositories[0].path, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "prepared.json"), JSON.stringify(marker), "utf-8");
    await expect(
      ensurePreparedWorkspace(
        manifest,
        tempDir,
        async () => ({
          stdout: `${manifest.repositories[0].commit}\n`,
          stderr: "",
        }),
      ),
    ).rejects.toThrowError(/commit mismatch/i);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
