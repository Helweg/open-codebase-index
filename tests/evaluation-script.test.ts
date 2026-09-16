import * as fs from "fs";

import { describe, expect, it } from "vitest";

describe("evaluation package scripts", () => {
  it("runs the Ollama CI gate with its absolute budget and no baseline comparison", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["eval:ci:ollama"]).toBe(
      "npx tsx src/cli.ts eval run --config .github/eval-ollama-config.json --reindex --ci --budget benchmarks/budgets/ollama.json",
    );
  });
});
