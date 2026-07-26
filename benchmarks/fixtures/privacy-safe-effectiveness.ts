import type {
  EffectivenessFixture,
  EffectivenessFixtureResult,
} from "../../src/eval/effectiveness-report.js";
import { effectivenessEvidenceMarker } from "../../src/eval/effectiveness-report.js";

export const EFFECTIVENESS_FIXTURE_SCHEMA_VERSION = 2 as const;

function sourceBlock(name: string, evidenceId: string, topic: string, lines: number): string {
  const body = [
    `  const evidence = ${JSON.stringify(effectivenessEvidenceMarker(evidenceId))};`,
    ...Array.from({ length: lines - 1 }, (_, index) =>
      `  const step${index + 1} = ${JSON.stringify(`${topic}-${index + 1}`)};`
    ),
  ].join("\n");
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
    content: sourceBlock(name, evidenceId, marker, 16),
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
  const semanticResults = [primary, secondary, distractor];

  return {
    id: `fixture-${index}`,
    tokenBudget: index % 2 === 0 ? 256 : 384,
    maxResults,
    expectedEvidenceIds: [primaryEvidence, secondaryEvidence],
    semanticResults,
  };
}

export const EFFECTIVENESS_FIXTURES: EffectivenessFixture[] = [
  fixture(1, "authentication", "validateSession", "loadSessionPolicy"),
  fixture(2, "configuration", "parseRuntimeConfig", "mergeProjectConfig"),
  fixture(3, "cache", "readQueryCache", "evictExpiredEntries", 1),
  fixture(4, "call-graph", "resolveCallTarget", "buildCallPath"),
  fixture(5, "parser", "parseSourceFile", "chunkSyntaxTree"),
];
