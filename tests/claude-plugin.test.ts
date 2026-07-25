import * as fs from "fs";

import { describe, expect, it } from "vitest";

describe("Claude Code plugin", () => {
  it("exposes Claude plugin manifest with inline MCP command on the claude host", () => {
    const pluginManifest = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf-8")) as {
      name: string;
      version: string;
      hooks?: string;
      skills?: string;
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };

    expect(pluginManifest.name).toBe("codebase-index");
    expect(pluginManifest.version).toBe("0.17.1");
    expect(pluginManifest.hooks).toBeUndefined();
    expect(pluginManifest.skills).toBe("./skills/");

    const codebaseMcp = pluginManifest.mcpServers?.["codebase-index"];
    // Runs the published npm package, not the uncommitted dist/, so a git
    // marketplace install can start the server without a local build.
    expect(codebaseMcp?.command).toBe("npx");
    expect(codebaseMcp?.args).toEqual([
      "-y",
      "--package",
      "opencode-codebase-index",
      "opencode-codebase-index-mcp",
      "--host",
      "claude",
    ]);
  });

  it("exposes a Claude marketplace manifest using owner metadata", () => {
    const marketplace = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf-8")) as {
      name: string;
      owner: { name: string };
      plugins: Array<{ name: string; source: string; version: string }>;
    };

    expect(marketplace.name).toBe("helweg-plugins");
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({
      name: "codebase-index",
      version: "0.17.1",
    }));
  });
});
