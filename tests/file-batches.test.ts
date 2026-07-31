import { describe, expect, it } from "vitest";

import { INDEX_FILE_BATCH_LIMITS, iterateOrderedFileBatches } from "../src/indexer/file-batches.js";

describe("iterateOrderedFileBatches", () => {
  it("preserves discovery order while enforcing file and byte limits", () => {
    const files = [
      { path: "a", bytes: 3 },
      { path: "b", bytes: 4 },
      { path: "c", bytes: 5 },
      { path: "d", bytes: 1 },
    ];

    const batches = Array.from(iterateOrderedFileBatches(files, (file) => file.bytes, {
      maxFiles: 2,
      maxBytes: 7,
    }));

    expect(batches.map((batch) => batch.map((file) => file.path))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("places a single oversized file in its own batch", () => {
    const batches = Array.from(iterateOrderedFileBatches(
      [{ path: "large", bytes: 12 }, { path: "small", bytes: 1 }],
      (file) => file.bytes,
      { maxFiles: 4, maxBytes: 8 },
    ));

    expect(batches.map((batch) => batch.map((file) => file.path))).toEqual([
      ["large"],
      ["small"],
    ]);
  });

  it("normalizes invalid limits to one", () => {
    const batches = Array.from(iterateOrderedFileBatches([1, 2, 3], () => 0, {
      maxFiles: 0,
      maxBytes: 0,
    }));

    expect(batches).toEqual([[1], [2], [3]]);
  });

  it("uses fixed internal production limits", () => {
    expect(INDEX_FILE_BATCH_LIMITS).toEqual({
      maxFiles: 64,
      maxBytes: 8 * 1024 * 1024,
    });
  });
});
