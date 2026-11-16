import { describe, expect, it } from "vitest";

import type { RankedCandidate } from "../src/indexer/intent-aware-ranking.js";
import { isTestPath, rankIntentAwareCandidates } from "../src/indexer/intent-aware-ranking.js";

function candidate(
  id: string,
  score: number,
  filePath: string,
  chunkType: string,
): RankedCandidate {
  return {
    id,
    score,
    metadata: {
      filePath,
      startLine: 1,
      endLine: 5,
      chunkType,
      language: "typescript",
      hash: id,
    },
  };
}

describe("test path classification", () => {
  it.each([
    ["test", true],
    ["src/tests/helper.ts", true],
    ["src/__tests__/helper.ts", true],
    ["spec/helper.rb", true],
    ["src/specs/helper.rb", true],
    ["src/helper.test.ts", true],
    ["src/helper.spec.d.ts", true],
    ["src/helper_test.go", true],
    ["src/helper_spec.rb", true],
    [".test.ts", true],
    ["src/helper.test..", true],
    ["src/helper.test.\n", true],
    ["src/test_helper.py", true],
    ["src/spec_helper.rb", true],
    ["src/test_.helper.py", true],
    ["src/test_..x", true],
    ["src/test_...", true],
    ["src/test_a..", true],
    ["src/test.js", true],
    ["src/spec.tsx", true],
    ["src/test.cts", true],
    ["src/spec.mjs", true],
    ["C:\\repo\\src\\helper.spec.ts", true],
    ["ｓｒｃ／ＨＥＬＰＥＲ．ＴＥＳＴ．ＴＳ", true],
    ["", false],
    ["src/helper.ts", false],
    ["testing/helper.ts", false],
    ["src/__tests__backup/helper.ts", false],
    ["src/helper.test.ts/source.ts", false],
    ["src/test_helper.py/source.ts", false],
    ["src/helper.spec.ts/", false],
    ["src/helper.test.", false],
    ["src/helper_test.", false],
    ["src/test_.py", false],
    ["src/test_..", false],
    ["src/test_a.", false],
    ["src/test.py", false],
    ["src/spec.rb", false],
    ["C:\\repo\\testing\\helper.ts", false],
  ])("classifies %j as a test path: %s", (filePath, expected) => {
    expect(isTestPath(filePath)).toBe(expected);
  });

  it("does not classify repeated filename markers in parent components as test files", () => {
    const suffixParent = `.test.${".spec.".repeat(2048)}`;
    const prefixParent = `test_${"..".repeat(2048)}`;
    expect(isTestPath(`${suffixParent}/`)).toBe(false);
    expect(isTestPath(`${prefixParent}/`)).toBe(false);
    expect(isTestPath(`${suffixParent}/source.ts`)).toBe(false);
    expect(isTestPath(`${prefixParent}/source.ts`)).toBe(false);
    expect(isTestPath(`${suffixParent}/test_helper.py`)).toBe(true);
    expect(isTestPath(`${prefixParent}/helper.spec.ts`)).toBe(true);
  });
});

describe("intent-aware source path preference", () => {
  it("only promotes implementation evidence for an explicit source preference", () => {
    const candidates = [
      candidate("test", 0.82, "tests/search-ranking.test.ts", "function"),
      candidate("source", 0.55, "src/indexer/search-ranking.ts", "function"),
    ];
    const query = "explain how semantic and keyword rankings are combined";

    expect(rankIntentAwareCandidates(query, candidates, candidates.length).map(({ id }) => id))
      .toEqual(["test", "source"]);
    expect(rankIntentAwareCandidates(query, candidates, candidates.length, { prioritizeSourcePaths: true }).map(({ id }) => id))
      .toEqual(["source", "test"]);
  });

  it.each([
    ["find code that batches outbound notifications", "source"],
    ["find tests for code that batches outbound notifications", "test"],
    ["documentation for code that batches outbound notifications", "documentation"],
    ["configuration for code that batches outbound notifications", "configuration"],
  ])("preserves the requested artifact preference for %s", (query, expected) => {
    const candidates = [
      candidate("test", 0.82, "tests/notifications.test.ts", "function"),
      candidate("source", 0.55, "src/notifications/batch.ts", "function"),
      candidate("documentation", 0.62, "docs/notifications.md", "section"),
      candidate("configuration", 0.60, "config/notifications.json", "object"),
    ];

    expect(rankIntentAwareCandidates(query, candidates, candidates.length)[0]?.id)
      .toBe(expected);
  });
});
