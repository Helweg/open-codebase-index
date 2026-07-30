import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleIndexCommand, parseIndexArgs } from "../src/adapters/mcp/cli.js";

describe("mcp cli index arg parsing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-index-cli-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses index defaults", () => {
    expect(parseIndexArgs([], tempDir)).toEqual({
      project: tempDir,
      host: "opencode",
      config: undefined,
      force: false,
      estimateOnly: false,
      verbose: false,
    });
  });

  it("parses index flags and path-like args", () => {
    const result = parseIndexArgs(
      [
        "--project",
        "./repo",
        "--host",
        "jcode",
        "--config",
        "./my.config.json",
        "--force",
        "--estimate-only",
        "--verbose",
      ],
      tempDir,
    );

    expect(result).toEqual({
      project: path.join(tempDir, "repo"),
      host: "jcode",
      config: path.join(tempDir, "my.config.json"),
      force: true,
      estimateOnly: true,
      verbose: true,
    });
  });

  it("rejects unknown index options", () => {
    expect(() => parseIndexArgs(["--bad-option"], tempDir)).toThrow("Unknown index option: --bad-option");
  });

  it("rejects missing values for valued index flags", () => {
    expect(() => parseIndexArgs(["--project"], tempDir)).toThrow("--project requires a value.");
    expect(() => parseIndexArgs(["--project", "--force"], tempDir)).toThrow("--project requires a value.");
    expect(() => parseIndexArgs(["--config"], tempDir)).toThrow("--config requires a value.");
    expect(() => parseIndexArgs(["--config", "--verbose"], tempDir)).toThrow("--config requires a value.");
    expect(() => parseIndexArgs(["--host"], tempDir)).toThrow("--host requires a value.");
    expect(() => parseIndexArgs(["--host", "--force"], tempDir)).toThrow("--host requires a value.");
  });

  it("rejects invalid host values", () => {
    expect(() => parseIndexArgs(["--host", "bad"], tempDir)).toThrow("Invalid host mode: bad.");
  });
});

describe("mcp cli index command execution", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-index-cli-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes diagnostics to stderr and final text to stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runIndex = vi.fn(async (_projectRoot: string | undefined, _host: string, _args: Record<string, unknown>, onProgress?: (title: string, metadata: Record<string, unknown>) => Promise<void> | void) => {
      if (onProgress) {
        await onProgress("scan", { phase: "collect", files: 12, apiKey: "should-not-leak" });
      }
      return { text: "ok" };
    });

    const exitCode = await handleIndexCommand(
      ["--force", "--verbose", "--estimate-only"],
      tempDir,
      {
        runIndex,
        printStdout: (text) => stdout.push(text),
        printStderr: (text) => stderr.push(text),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["ok"]);
    expect(stderr.join("\n")).toContain("scan phase=collect files=12");
    expect(stderr.join("\n")).toContain("apiKey=[REDACTED]");
    expect(stderr.join("\n")).not.toContain("should-not-leak");
    expect(runIndex).toHaveBeenCalledWith(tempDir, "opencode", {
      force: true,
      estimateOnly: true,
      verbose: true,
    }, expect.any(Function));
  });

  it("prints busy and exits non-zero on index errors", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runIndex = vi.fn(async () => ({ text: "indexer already running", isError: true }));

    const exitCode = await handleIndexCommand(["--project", tempDir], tempDir, {
      runIndex,
      printStdout: (text) => stdout.push(text),
      printStderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("indexer already running");
  });

  it("exits non-zero when indexing throws", async () => {
    const stderr: string[] = [];
    const exitCode = await handleIndexCommand([], tempDir, {
      runIndex: vi.fn(async () => { throw new Error("embedding provider unavailable"); }),
      printStderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual(["embedding provider unavailable"]);
  });

  it("exits non-zero when an explicit config file is missing", async () => {
    const stderr: string[] = [];
    const configPath = path.join(tempDir, "missing.json");
    const exitCode = await handleIndexCommand(["--config", configPath], tempDir, {
      readCliConfigFile: () => null,
      printStderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([`Config file not found: ${configPath}`]);
  });

  it("uses explicit --config with initializeTools before running index", async () => {
    const configFile = path.join(tempDir, "index-config.json");
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:8080/v1",
            model: "test-embed",
            dimensions: 1024,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const initialized: Array<{ projectRoot: string; host: string; provider: string }> = [];
    const runIndex = vi.fn(async () => ({ text: "ok" }));
    const initializeRuntimeForConfig = vi.fn((projectRoot: string, parsedConfig: { embeddingProvider: string }, host: string) => {
      initialized.push({ projectRoot, host, provider: parsedConfig.embeddingProvider });
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await handleIndexCommand(
      ["--config", configFile],
      tempDir,
      {
        runIndex,
        initializeRuntimeForConfig,
        printStdout: (text) => stdout.push(text),
        printStderr: (text) => stderr.push(text),
      },
    );

    expect(exitCode).toBe(0);
    expect(initialized).toEqual([{ projectRoot: tempDir, host: "opencode", provider: "custom" }]);
    expect(runIndex).toHaveBeenCalledWith(tempDir, "opencode", { force: false, estimateOnly: false, verbose: false }, expect.any(Function));
    expect(stdout).toEqual(["ok"]);
    expect(stderr).toEqual([]);
  });

  it("returns usage and exits zero on --help", async () => {
    const stderr: string[] = [];
    const exitCode = await handleIndexCommand(["--help"], tempDir, {
      printStderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(stderr.join("\n")).toContain("Usage:");
  });
});
