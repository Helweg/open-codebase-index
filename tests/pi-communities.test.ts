import { describe, expect, it, vi } from "vitest";

import { TOOL_NAME } from "../src/tools/tool-names.js";

const getCodeCommunities = vi.hoisted(() => vi.fn().mockResolvedValue({
  communities: [
    {
      id: 0,
      label: "Core",
      symbolCount: 1,
      members: [
        {
          symbolId: "sym_core",
          symbolName: "CoreService",
          filePath: "src/core.ts",
        },
      ],
    },
  ],
  hubNodes: [
    {
      symbolId: "sym_core",
      symbolName: "CoreService",
      filePath: "src/core.ts",
      callerCount: 3,
      calleeCount: 2,
      totalConnections: 5,
      crossCommunityConnections: 2,
    },
  ],
  couplings: [
    {
      communityA: 0,
      communityB: 1,
      communityAName: "Core",
      communityBName: "Adapters",
      distinctConnections: 3,
      representativeRelationships: [
        {
          fromSymbolId: "sym_core",
          fromSymbolName: "CoreService",
          fromFilePath: "src/core.ts",
          toSymbolId: "sym_adapter",
          toSymbolName: "AdapterService",
          toFilePath: "src/adapter.ts",
        },
      ],
    },
  ],
  totalSymbols: 2,
  totalCommunities: 1,
}));

vi.mock("../src/tools/operations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/tools/operations.js")>(),
  getCodeCommunities,
}));

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: {
      branch?: string;
      minSize?: number;
      limit?: number;
      hubThreshold?: number;
      minCoupling?: number;
      couplingLimit?: number;
    },
    signal: AbortSignal,
    onUpdate: () => void,
    context: { cwd?: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

describe("Pi code_communities contract", () => {
  it("executes through the shared community operation and returns structured details", async () => {
    const { default: codebaseIndexPiExtension } = await import("../src/pi-extension.js");
    const tools: RegisteredTool[] = [];

    codebaseIndexPiExtension({
      registerTool(tool) {
        tools.push(tool as unknown as RegisteredTool);
      },
      on() {},
    } as Parameters<typeof codebaseIndexPiExtension>[0]);

    const tool = tools.find((candidate) => candidate.name === TOOL_NAME.CODE_COMMUNITIES);
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      "call-1",
      { branch: "main", minSize: 2, limit: 5, hubThreshold: 1, minCoupling: 2, couplingLimit: 4 },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp/project" },
    );

    expect(getCodeCommunities).toHaveBeenCalledWith("/tmp/project", "pi", {
      branch: "main",
      minSize: 2,
      limit: 5,
      hubThreshold: 1,
      minCoupling: 2,
      couplingLimit: 4,
    });
    expect(result.content[0].text).toContain("CoreService");
    expect(result.content[0].text).toContain("2 cross-community");
    expect(result.content[0].text).toContain("Community couplings: 1 shown");
    expect(result.content[0].text).toContain("Core ↔ Adapters: 3 distinct connections");
    expect(result.content[0].text).toContain("CoreService (src/core.ts) -> AdapterService (src/adapter.ts)");
    expect(result.details).toEqual(expect.objectContaining({ totalCommunities: 1 }));
  });
});
