import * as fs from "fs";

import { describe, expect, it } from "vitest";
import { parseHostMode } from "../src/config/host.js";

describe("Codex plugin host mode", () => {
  it("ships MCP CLI runtime dependencies for clean npx installs", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeTruthy();
    expect(packageJson.dependencies?.zod).toBeTruthy();
    expect(packageJson.devDependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(packageJson.devDependencies?.zod).toBeUndefined();
    expect(packageJson.scripts?.["dev:link-mcp"]).toBe("node scripts/link-local-mcp-bin.mjs");
  });

  it("parses known host modes", () => {
    expect(parseHostMode("opencode")).toBe("opencode");
    expect(parseHostMode("codex")).toBe("codex");
    expect(parseHostMode("claude")).toBe("claude");
    expect(parseHostMode("pi")).toBe("pi");
    expect(parseHostMode("jcode")).toBe("jcode");
  });

  it("rejects unknown host mode with a clear error", () => {
    expect(() => parseHostMode("weird"))
      .toThrow("Invalid host mode: weird. Allowed values: opencode, codex, claude, pi, jcode.");
  });

  it("exposes Codex plugin manifest and MCP command", () => {
    const pluginManifest = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf-8")) as {
      mcpServers?: string;
      hooks?: string;
      interface?: { defaultPrompt?: string[] };
      version: string;
      name: string;
    };
    const mcpManifest = JSON.parse(fs.readFileSync(".mcp.json", "utf-8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(pluginManifest.name).toBe("codebase-index");
    const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string };
    expect(pluginManifest.version).toBe(packageManifest.version);
    expect(pluginManifest.mcpServers).toBe("./.mcp.json");
    expect(pluginManifest.hooks).toBe("./hooks/hooks.json");
    expect(fs.existsSync("hooks/hooks.json")).toBe(true);

    const codebaseMcp = mcpManifest.mcpServers["codebase-index"];
    expect(codebaseMcp.command).toBe("npx");
    expect(codebaseMcp.args).toEqual([
      "-y",
      "--package",
      "opencode-codebase-index",
      "opencode-codebase-index-mcp",
      "--host",
      "codex",
    ]);

    const hookManifest = fs.readFileSync("hooks/hooks.json", "utf-8");
    const skill = fs.readFileSync("skills/codebase-search/SKILL.md", "utf-8");
    expect(pluginManifest.interface?.defaultPrompt?.join(" ")).toContain("codebase_context");
    expect(hookManifest).toContain("codebase_context before shell search");
    expect(skill).toContain("codebase_context(query, ...)");
  });
});
