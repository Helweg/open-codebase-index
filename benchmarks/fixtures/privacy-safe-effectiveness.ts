import type {
  EffectivenessFixture,
  EffectivenessFixtureResult,
} from "../../src/eval/effectiveness-report.js";

export const EFFECTIVENESS_FIXTURE_SCHEMA_VERSION = 1 as const;

function sourceBlock(name: string, marker: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, index) =>
    `  const step${index + 1} = ${JSON.stringify(`${marker}-${index + 1}`)};`
  ).join("\n");
  return `export function ${name}() {\n${body}\n  return true;\n}`;
}

function result(
  filePath: string,
  name: string,
  startLine: number,
  score: number,
  evidenceId: string,
  marker: string,
): EffectivenessFixtureResult {
  return {
    filePath,
    startLine,
    endLine: startLine + 18,
    content: sourceBlock(name, marker, 16),
    score,
    chunkType: "function",
    name,
    evidenceIds: [evidenceId],
  };
}

function fixture(
  index: number,
  topic: string,
  primaryName: string,
  secondaryName: string,
  maxResults = 2,
): EffectivenessFixture {
  const primaryEvidence = `evidence-${index}-primary`;
  const secondaryEvidence = `evidence-${index}-secondary`;
  const distractorEvidence = `evidence-${index}-distractor`;
  const primary = result(
    `fixture-${index}/primary.ts`,
    primaryName,
    10,
    0.98,
    primaryEvidence,
    `${topic}-primary`,
  );
  const secondary = result(
    `fixture-${index}/secondary.ts`,
    secondaryName,
    40,
    0.91,
    secondaryEvidence,
    `${topic}-secondary`,
  );
  const distractor = result(
    `fixture-${index}/notes.ts`,
    `${primaryName}Example`,
    75,
    0.55,
    distractorEvidence,
    `${topic}-example`,
  );

  return {
    id: `fixture-${index}`,
    tokenBudget: index % 2 === 0 ? 256 : 384,
    maxResults,
    expectedEvidenceIds: [primaryEvidence, secondaryEvidence],
    semanticResults: [primary, secondary, distractor],
    baseline: {
      grepOutput: [
        `${primary.filePath}:${primary.startLine}:${primary.name}`,
        `${secondary.filePath}:${secondary.startLine}:${secondary.name}`,
      ].join("\n"),
      exactReadOutput: [
        `FILE ${primary.filePath}\n${sourceBlock(primaryName, `${topic}-primary-read`, 34)}`,
        `FILE ${secondary.filePath}\n${sourceBlock(secondaryName, `${topic}-secondary-read`, 30)}`,
      ].join("\n\n"),
      evidenceIds: [primaryEvidence, secondaryEvidence],
    },
  };
}

export const EFFECTIVENESS_FIXTURES: EffectivenessFixture[] = [
  fixture(1, "authentication", "validateSession", "loadSessionPolicy"),
  fixture(2, "configuration", "parseRuntimeConfig", "mergeProjectConfig"),
  fixture(3, "cache", "readQueryCache", "evictExpiredEntries", 1),
  fixture(4, "call-graph", "resolveCallTarget", "buildCallPath"),
  fixture(5, "parser", "parseSourceFile", "chunkSyntaxTree"),
];
