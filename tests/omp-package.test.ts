import * as fs from "fs";

import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import codebaseIndexOmpExtension from "../src/omp-extension.js";
import {
  PI_TOOL_NAMES,
  PORTABLE_TOOL_NAMES,
  TOOL_NAME,
} from "../src/tools/tool-names.js";

interface RegisteredTool {
  name: string;
  parameters?: unknown;
}

type OmpExtensionApi = Parameters<typeof codebaseIndexOmpExtension>[0];

function collectTools(api: Partial<Pick<OmpExtensionApi, "typebox">> = {}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  codebaseIndexOmpExtension({
    registerTool(tool: RegisteredTool) {
      tools.push({ name: tool.name, parameters: tool.parameters });
    },
    on() {},
    ...api,
  } as OmpExtensionApi);

  return tools;
}

describe("omp package integration", () => {
  it("declares an omp package manifest with extension and skill resources", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
      pi?: { extensions?: string[]; skills?: string[] };
      omp?: { extensions?: string[]; skills?: string[] };
      files?: string[];
    };

    expect(pkg.omp?.extensions).toContain("./dist/omp-extension.js");
    expect(pkg.omp?.skills).toContain("./skills");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("skills");
    // The Pi manifest stays declared: omp prefers `omp` and falls back to `pi`,
    // while the Pi host keeps loading `pi` on its own.
    expect(pkg.pi?.extensions).toContain("./dist/pi-extension.js");
  });

  it("includes the omp extension source in the TypeScript build entries", () => {
    expect(fs.readFileSync("tsup.config.ts", "utf-8")).toContain("src/omp-extension.ts");
  });

  it("registers the shared host tool surface", () => {
    const toolNames = collectTools().map((tool) => tool.name);

    expect(toolNames).toEqual([...PI_TOOL_NAMES]);
    expect(toolNames).toContain(TOOL_NAME.PI_KNOWLEDGE_BASE_ADD);
    expect(toolNames).toContain(TOOL_NAME.PI_KNOWLEDGE_BASE_LIST);
    expect(toolNames).toContain(TOOL_NAME.PI_KNOWLEDGE_BASE_REMOVE);
    expect(toolNames).not.toContain(TOOL_NAME.ADD_KNOWLEDGE_BASE);
    expect(toolNames).not.toContain(TOOL_NAME.INDEX_VISUALIZE);
    expect(toolNames).toEqual(expect.arrayContaining([...PORTABLE_TOOL_NAMES]));
  });

  it("builds fallback parameter schemas from the package builder", () => {
    const tools = collectTools();
    const searchParams = JSON.stringify(tools.find((tool) => tool.name === TOOL_NAME.CODEBASE_SEARCH)?.parameters);
    const peekParams = JSON.stringify(tools.find((tool) => tool.name === TOOL_NAME.CODEBASE_PEEK)?.parameters);

    for (const params of [searchParams, peekParams]) {
      expect(params).toContain("blameAuthor");
      expect(params).toContain("blameSha");
      expect(params).toContain("element");
    }
  });

  it("prefers the host schema builder when the host provides one", () => {
    const reads: string[] = [];
    const hostSchema = new Proxy(Type, {
      get(target, property, receiver) {
        if (typeof property === "string") reads.push(property);
        return Reflect.get(target, property, receiver);
      },
    });

    const tools = collectTools({ typebox: { Type: hostSchema } });

    expect(reads).toContain("Object");
    expect(reads).toContain("String");
    expect(tools.map((tool) => tool.name)).toEqual([...PI_TOOL_NAMES]);
  });
});
