import { describe, expect, it } from "vitest";
import type { SearchResult } from "../src/indexer/index.js";
import { buildContextPack, countContextTokens } from "../src/tools/context-pack.js";

const roots = [
  { root: "/repo", label: "project: repo" },
  { root: "/repo/docs", label: "knowledge base: docs" },
  { root: "/external/axios", label: "knowledge base: /external/axios" },
  { root: "/other/axios", label: "knowledge base: /other/axios" },
];

function hit(filePath: string, score: number, line = 1): SearchResult {
  return { filePath, score, startLine: line, endLine: line + 2, chunkType: "function", content: "x" };
}

describe("conceptual origin evidence packing", () => {
  const results = [
    hit("/repo/src/a.ts", 0.99),
    hit("/repo/src/b.ts", 0.98),
    hit("/repo/src/c.ts", 0.97),
    hit("/repo/docs/guide.ts", 0.96),
    hit("/external/axios/index.ts", 0.95),
    hit("/other/axios/index.ts", 0.94),
    hit("/repoish/stray.ts", 0.93),
  ];

  it("promotes the first ranked hit per configured origin, including nested roots", () => {
    const options = { origins: roots, tokenBudget: 2000, maxResults: 4 };
    const pack = buildContextPack(results, options);
    expect(pack.results.map((result) => result.filePath)).toEqual([
      "/repo/src/a.ts", "/repo/docs/guide.ts", "/external/axios/index.ts", "/other/axios/index.ts",
    ]);
    expect(pack.text).toContain("/repo/docs/guide.ts:1-3 [origin: knowledge base: docs]");
    expect(pack.text).toContain("[origin: knowledge base: /external/axios]");
    expect(pack.text).toContain("[origin: knowledge base: /other/axios]");
    expect(pack.text).not.toContain("/repoish/stray.ts [origin:");
    expect(pack.limitOmittedCount).toBe(3);
    expect(buildContextPack(results, options).text).toBe(pack.text);
    expect(pack.tokenEstimate).toBe(countContextTokens(pack.text));
    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.tokenBudget);
  });

  it("respects tight limits and budgets without selecting outside retrieved candidates", () => {
    const pack = buildContextPack(results, { origins: roots, maxResults: 2, tokenBudget: 128 });
    expect(pack.results.length).toBeLessThanOrEqual(2);
    expect(pack.results.every((result) => results.includes(result))).toBe(true);
    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.tokenBudget);
  });

  it("does not restart file round robin after promoting another origin", () => {
    const candidates = [
      hit("/repo/src/memory.ts", 0.99, 1),
      hit("/repo/src/memory.ts", 0.98, 10),
      hit("/repo/src/other.ts", 0.97),
      hit("/external/axios/index.ts", 0.96),
    ];
    const pack = buildContextPack(candidates, { origins: roots, tokenBudget: 2000, maxResults: 3 });
    expect(pack.results).toEqual([candidates[0], candidates[3], candidates[2]]);
  });

  it("labels KB-only evidence without inventing a project hit or changing file ordering", () => {
    const candidates = [
      hit("/external/axios/a.ts", 0.99, 1),
      hit("/external/axios/a.ts", 0.98, 10),
      hit("/external/axios/b.ts", 0.97),
    ];
    const pack = buildContextPack(candidates, { origins: roots, tokenBudget: 2000 });
    expect(pack.results).toEqual([candidates[0], candidates[2], candidates[1]]);
    expect(pack.text).toContain("[origin: knowledge base: /external/axios]");
    expect(pack.text).not.toContain("[origin: project:");
  });

  it("promotes an equally relevant sibling but not a near-zero-scored origin", () => {
    const project = hit("/repo/src/a.ts", 1);
    const local = hit("/repo/src/b.ts", 0.9);
    const strongKb = hit("/external/axios/index.ts", 0.9);
    const weakKb = hit("/external/axios/index.ts", 0.01);
    const options = { origins: roots, tokenBudget: 2000, maxResults: 2 };
    expect(buildContextPack([project, local, strongKb], options).results).toEqual([project, strongKb]);
    const weak = buildContextPack([project, local, weakKb], options);
    expect(weak.results).toEqual([project, local]);
    expect(weak.text).not.toContain("/external/axios/index.ts");
  });

  it("does not promote unconfigured paths or change single-origin and definition ordering", () => {
    const unconfigured = hit("/unknown/first.ts", 1);
    const candidates = [unconfigured, ...results];
    const multi = buildContextPack(candidates, { origins: roots, maxResults: 2, tokenBudget: 2000 });
    expect(multi.results.map((result) => result.filePath)).toEqual(["/unknown/first.ts", "/repo/src/a.ts"]);
    const single = buildContextPack(results, { origins: roots.slice(0, 1), tokenBudget: 2000 });
    const baseline = buildContextPack(results, { tokenBudget: 2000 });
    expect(single.text).toBe(baseline.text);
    const definition = buildContextPack(results, { origins: roots, preserveInputOrder: true, maxResults: 2 });
    expect(definition.results).toEqual(results.slice(0, 2));
  });
});
