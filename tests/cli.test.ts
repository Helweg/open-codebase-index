import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isCliEntrypoint, loadCliRawConfig, parseArgs } from "../src/cli.js";

describe("cli config loading", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "cli-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads explicit --config file instead of merged host config", () => {
    const configPath = path.join(tempDir, "custom-config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ embeddingProvider: "ollama", include: ["custom/**/*.ts"] }, null, 2),
      "utf-8",
    );

    const args = parseArgs(["node", "dist/cli.js", "--project", tempDir, "--host", "codex", "--config", configPath]);
    const rawConfig = loadCliRawConfig(args) as Record<string, unknown>;

    expect(rawConfig.embeddingProvider).toBe("ollama");
    expect(rawConfig.include).toEqual(["custom/**/*.ts"]);
  });

  it("loads jcode host parser options while still honoring explicit config", () => {
    const configPath = path.join(tempDir, "custom-config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ embeddingProvider: "ollama", include: ["custom/**/*.ts"] }, null, 2),
      "utf-8",
    );

    const args = parseArgs(["node", "dist/cli.js", "--host", "jcode", "--project", tempDir, "--config", configPath]);
    const rawConfig = loadCliRawConfig(args) as Record<string, unknown>;

    expect(args.host).toBe("jcode");
    expect(rawConfig.embeddingProvider).toBe("ollama");
    expect(rawConfig.include).toEqual(["custom/**/*.ts"]);
  });

  it("throws for unknown --host values", () => {
    expect(() => parseArgs(["node", "dist/cli.js", "--host", "bad-host"]))
      .toThrow("Invalid host mode: bad-host. Allowed values: opencode, codex, claude, pi, jcode.");
  });

  it("recognizes npm bin symlinks as the CLI entrypoint", () => {
    const realCliPath = path.join(tempDir, "package", "dist", "cli.js");
    const binPath = path.join(tempDir, ".bin", "opencode-codebase-index-mcp");
    mkdirSync(path.dirname(realCliPath), { recursive: true });
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(realCliPath, "#!/usr/bin/env node\n", "utf-8");
    symlinkSync(realCliPath, binPath);

    expect(isCliEntrypoint(pathToFileURL(realCliPath).href, binPath)).toBe(true);
  });
});
