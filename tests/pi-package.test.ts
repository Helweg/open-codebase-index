import * as fs from "fs";

import { describe, expect, it } from "vitest";

import codebaseIndexPiExtension from "../src/pi-extension.js";

describe("Pi package integration", () => {
  it("declares a Pi package manifest with extension and skill resources", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
      pi?: { extensions?: string[]; skills?: string[] };
      files?: string[];
      keywords?: string[];
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi?.extensions).toContain("./dist/pi-extension.js");
    expect(pkg.pi?.skills).toContain("./skills");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("skills");
    expect(pkg.dependencies?.typebox).toBeDefined();
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(pkg.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional).toBe(true);
  });

  it("includes the Pi extension source in the TypeScript build entries", () => {
    expect(fs.readFileSync("tsup.config.ts", "utf-8")).toContain("src/pi-extension.ts");
  });

  it("registers first-class Pi tools", () => {
    const tools: Array<{ name: string; parameters?: unknown }> = [];

    codebaseIndexPiExtension({
      registerTool(tool) {
        tools.push({ name: tool.name, parameters: tool.parameters });
      },
      on() {},
    } as Parameters<typeof codebaseIndexPiExtension>[0]);

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "codebase_context",
      "codebase_search",
      "codebase_peek",
      "find_similar",
      "implementation_lookup",
      "index_codebase",
      "index_status",
      "index_health_check",
      "index_metrics",
      "index_logs",
      "call_graph",
      "call_graph_path",
      "pr_impact",
      "knowledge_base_list",
      "knowledge_base_add",
      "knowledge_base_remove",
    ]));

    const searchParams = JSON.stringify(tools.find((tool) => tool.name === "codebase_search")?.parameters);
    const peekParams = JSON.stringify(tools.find((tool) => tool.name === "codebase_peek")?.parameters);
    const callGraphParams = JSON.stringify(tools.find((tool) => tool.name === "call_graph")?.parameters);
    const callGraphPathParams = JSON.stringify(tools.find((tool) => tool.name === "call_graph_path")?.parameters);
    const contextParams = JSON.stringify(tools.find((tool) => tool.name === "codebase_context")?.parameters);
    for (const params of [searchParams, peekParams]) {
      expect(params).toContain("blameAuthor");
      expect(params).toContain("blameSha");
      expect(params).toContain("blameSince");
    }
    expect(callGraphParams).toContain("file");
    expect(callGraphParams).toContain("directory");
    expect(callGraphParams).not.toContain("symbolId");
    for (const params of [callGraphPathParams, contextParams]) {
      expect(params).toContain("fromFile");
      expect(params).toContain("fromDirectory");
      expect(params).toContain("toFile");
      expect(params).toContain("toDirectory");
    }
  });
});
