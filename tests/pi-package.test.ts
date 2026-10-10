import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import codebaseIndexPiExtension from "../src/pi-extension.js";
import { CODEBASE_INDEX_GUIDANCE } from "../src/adapters/shared/extension-core.js";
import {
  PORTABLE_TOOL_NAMES,
  PI_TOOL_NAMES,
  TOOL_NAME,
} from "../src/tools/tool-names.js";

type PiExtensionApi = Parameters<typeof codebaseIndexPiExtension>[0];

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
    expect(pkg.dependencies?.typebox).toBeUndefined();
    expect(pkg.peerDependencies?.typebox).toBe("*");
    expect(pkg.peerDependenciesMeta?.typebox?.optional).not.toBe(true);
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(pkg.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional).toBe(true);
  });

  it("includes the Pi extension source in the TypeScript build entries", () => {
    expect(fs.readFileSync("tsup.config.ts", "utf-8")).toContain("src/pi-extension.ts");
  });

  describe("prompt composition", () => {
    type PromptEvent = {
      systemPrompt: string;
      systemPromptOptions?: {
        sections?: Record<string, string | null>;
        forceSystemPrompt?: string;
      };
    };
    type BeforeAgentStart = (
      event: PromptEvent,
      ctx: { cwd: string },
    ) => Promise<{ systemPrompt: string } | void>;
    let root: string;
    let beforeAgentStart: BeforeAgentStart;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-composition-"));
      fs.mkdirSync(path.join(root, ".codebase-index"));
      fs.writeFileSync(path.join(root, ".codebase-index", "config.json"), JSON.stringify({
        indexing: { autoIndex: false, watchFiles: false, requireProjectMarker: true },
      }));
      const api: Partial<PiExtensionApi> = {
        registerTool() {},
        on(event: string, handler: unknown) {
          if (event === "before_agent_start") beforeAgentStart = handler as BeforeAgentStart;
          return () => {};
        },
      };
      codebaseIndexPiExtension(api as PiExtensionApi);
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("contributes a native section instead of forcing a whole-prompt snapshot", async () => {
      const sections: Record<string, string | null> = { sibling: "Existing guidance" };
      const event = { systemPrompt: "Base policy", systemPromptOptions: { sections } };
      const result = await beforeAgentStart(event, { cwd: root });

      expect(result).toBeUndefined();
      expect(sections.codebase_index_guidance).toBe(CODEBASE_INDEX_GUIDANCE);
      expect(sections.sibling).toBe("Existing guidance");
      expect(event.systemPrompt).toBe("Base policy");
      expect(event.systemPromptOptions).not.toHaveProperty("forceSystemPrompt");
      sections.later = "Later extension guidance";
      expect(event.systemPromptOptions.sections.later).toBe("Later extension guidance");
    });

    it("does not clear an intentional forced prompt from another extension", async () => {
      const options = {
        sections: {} as Record<string, string | null>,
        forceSystemPrompt: "Intentional override",
      };
      const result = await beforeAgentStart({
        systemPrompt: "Intentional override", systemPromptOptions: options,
      }, { cwd: root });

      expect(result).toBeUndefined();
      expect(options.forceSystemPrompt).toBe("Intentional override");
      expect(options.sections.codebase_index_guidance).toBe(CODEBASE_INDEX_GUIDANCE);
    });

    for (const systemPromptOptions of [undefined, {}]) {
      it(`keeps the legacy string-return contract with ${systemPromptOptions ? "inspection-only" : "no"} options`, async () => {
        const event = { systemPrompt: "Base policy", systemPromptOptions };
        expect(await beforeAgentStart(event, { cwd: root })).toEqual({
          systemPrompt: `Base policy\n\n${CODEBASE_INDEX_GUIDANCE}`,
        });
        expect(event.systemPrompt).toBe("Base policy");
      });
    }
  });

  it("registers first-class Pi tools", () => {
    const tools: Array<{ name: string; parameters?: unknown }> = [];

    const api: Partial<PiExtensionApi> = {
      registerTool(tool) {
        tools.push({ name: tool.name, parameters: tool.parameters });
      },
      on() { return () => {}; },
    };
    codebaseIndexPiExtension(api as PiExtensionApi);

    const toolNames = tools.map((tool) => tool.name);
    const toolNameSet = new Set(toolNames);
    const coreToolNameSet = new Set<string>(PORTABLE_TOOL_NAMES);

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
    for (const params of [searchParams, peekParams, similarParams]) {
      expect(params).toContain("element");
    }
  });
});
