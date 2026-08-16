import * as fs from "fs";

import { describe, expect, it } from "vitest";

import codebaseIndexPiExtension from "../src/pi-extension.js";
import {
  PORTABLE_TOOL_NAMES,
  PI_TOOL_NAMES,
  TOOL_NAME,
} from "../src/tools/tool-names.js";

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

    const toolNames = tools.map((tool) => tool.name);
    const toolNameSet = new Set(toolNames);
    const coreToolNameSet = new Set(PORTABLE_TOOL_NAMES);

    expect(toolNames).toHaveLength(PI_TOOL_NAMES.length);
    expect(toolNames).toEqual([...PI_TOOL_NAMES]);
    expect(toolNameSet).toEqual(new Set(PI_TOOL_NAMES));
    expect(new Set(toolNames.filter((toolName) => coreToolNameSet.has(toolName))).size).toBe(PORTABLE_TOOL_NAMES.length);
    expect(toolNames).toContain(TOOL_NAME.PI_KNOWLEDGE_BASE_ADD);
    expect(toolNames).toContain(TOOL_NAME.PI_KNOWLEDGE_BASE_LIST);
    expect(toolNames).toContain(TOOL_NAME.PI_KNOWLEDGE_BASE_REMOVE);
    expect(toolNames).not.toContain(TOOL_NAME.ADD_KNOWLEDGE_BASE);
    expect(toolNames).not.toContain(TOOL_NAME.INDEX_VISUALIZE);

    const searchParams = JSON.stringify(tools.find((tool) => tool.name === TOOL_NAME.CODEBASE_SEARCH)?.parameters);
    const peekParams = JSON.stringify(tools.find((tool) => tool.name === TOOL_NAME.CODEBASE_PEEK)?.parameters);
    const similarParams = JSON.stringify(tools.find((tool) => tool.name === TOOL_NAME.FIND_SIMILAR)?.parameters);
    for (const params of [searchParams, peekParams]) {
      expect(params).toContain("blameAuthor");
      expect(params).toContain("blameSha");
      expect(params).toContain("blameSince");
      expect(params).toContain("blameUntil");
    }
    expect(similarParams).toContain("blameSince");
    expect(similarParams).toContain("blameUntil");
  });
});
