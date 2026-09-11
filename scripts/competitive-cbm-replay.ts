import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCodebaseMemoryPaths } from "./competitive-adapters.js";
import { scoreQuery } from "./competitive-scoring.js";
import type { CompetitiveQueryScore } from "./competitive-scoring.js";
import type { GoldenQuery } from "../src/eval/types.js";

export const CBM_CORRECTION_VERSION = "cbm-container-groups-v1";

interface RawCommandArtifact {
  file: string;
  bytes: Buffer;
  relatedFile?: string;
  relatedBytes?: Buffer;
  value: {
    command?: unknown;
    raw?: unknown;
  };
}

function remapOriginalRoot(raw: unknown, originalRoot: string | undefined): unknown {
  if (!originalRoot || typeof raw !== "object" || raw === null) return raw;
  const envelope = structuredClone(raw) as { structuredContent?: { groups?: Array<{ file?: unknown }> } };
  for (const group of envelope.structuredContent?.groups ?? []) {
    if (typeof group.file !== "string" || !path.isAbsolute(group.file)) continue;
    if (group.file === originalRoot) group.file = ".";
    else if (group.file.startsWith(`${originalRoot}${path.sep}`)) {
      group.file = path.relative(originalRoot, group.file);
    }
  }
  return envelope;
}

interface QueryArtifact {
  queryId?: string;
  input?: { symbol?: string; limit?: number };
  repeat?: number;
  condition?: string;
  score?: CompetitiveQueryScore;
  [key: string]: unknown;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactSequence(file: string): number {
  const match = /-(\d{6})\.json$/u.exec(file);
  if (!match) throw new Error(`Malformed CBM raw artifact name: ${file}`);
  return Number(match[1]);
}

function anchoredSymbol(artifact: RawCommandArtifact): string {
  const command = artifact.value.command;
  if (!Array.isArray(command) || command.length < 2 || command.at(-2) !== "search_graph") {
    throw new Error(`CBM raw artifact is not a search_graph command: ${artifact.file}`);
  }
  const encoded = command.at(-1);
  if (typeof encoded !== "string") throw new Error(`CBM raw artifact omitted JSON arguments: ${artifact.file}`);
  const args = JSON.parse(encoded) as { name_pattern?: unknown };
  if (typeof args.name_pattern !== "string") throw new Error(`CBM raw artifact omitted name_pattern: ${artifact.file}`);
  const pattern = args.name_pattern;
  if (pattern.length < 2 || pattern[0] !== "^" || pattern.at(-1) !== "$") {
    throw new Error(`CBM raw artifact name_pattern is not anchored: ${artifact.file}`);
  }
  // The legacy grammar allowed every non-$ character independently, including
  // backslashes. Thus an interior $ only needs an immediately preceding slash,
  // regardless of slash-run parity. Scan once instead of backtracking over runs.
  for (let index = 1; index < pattern.length - 1; index += 1) {
    if (pattern[index] === "$" && pattern[index - 1] !== "\\") {
      throw new Error(`CBM raw artifact name_pattern is not anchored: ${artifact.file}`);
    }
  }
  return pattern.slice(1, -1).replace(/\\([.*+?^${}()|[\]\\])/gu, "$1");
}

async function rawArtifacts(conditionDirectory: string): Promise<RawCommandArtifact[]> {
  const names = (await fs.readdir(conditionDirectory))
    .filter((file) => /^codebase-memory-query(?:-failure|-malformed)?-\d{6}\.json$/u.test(file))
    .sort((left, right) => artifactSequence(left) - artifactSequence(right));
  const loaded = await Promise.all(names.map(async (file) => {
    const bytes = await fs.readFile(path.join(conditionDirectory, file));
    return { file, bytes, value: JSON.parse(bytes.toString("utf8")) as RawCommandArtifact["value"] };
  }));
  const collapsed: RawCommandArtifact[] = [];
  for (let index = 0; index < loaded.length; index += 1) {
    const artifact = loaded[index];
    const next = loaded[index + 1];
    if (artifact.file.includes("-malformed-") && next?.file.includes("-failure-")) {
      const sameInvocation = JSON.stringify(artifact.value.command) === JSON.stringify(next.value.command)
        && (artifact.value as { stdout?: unknown }).stdout === (next.value as { stdout?: unknown }).stdout
        && (artifact.value as { stderr?: unknown }).stderr === (next.value as { stderr?: unknown }).stderr;
      if (!sameInvocation) throw new Error(`Ambiguous adjacent CBM malformed/failure artifacts: ${artifact.file}, ${next.file}`);
      collapsed.push({ ...artifact, relatedFile: next.file, relatedBytes: next.bytes });
      index += 1;
    } else {
      collapsed.push(artifact);
    }
  }
  return collapsed;
}

async function queryFileNames(repeatDirectory: string, order: readonly string[]): Promise<string[]> {
  const files = (await fs.readdir(repeatDirectory)).filter((file) => file.endsWith(".json"));
  const byId = new Map<string, string>();
  for (const file of files) {
    const value = JSON.parse(await fs.readFile(path.join(repeatDirectory, file), "utf8")) as QueryArtifact;
    if (!value.queryId || byId.has(value.queryId)) throw new Error(`Duplicate or malformed query artifact in ${repeatDirectory}`);
    byId.set(value.queryId, file);
  }
  if (byId.size !== order.length || order.some((queryId) => !byId.has(queryId))) {
    throw new Error(`Query artifacts do not match frozen order in ${repeatDirectory}`);
  }
  return order.map((queryId) => byId.get(queryId)!);
}

export async function replayCodebaseMemoryRun(
  sourceRoot: string,
  correctedRoot: string,
  correctionVersion = CBM_CORRECTION_VERSION,
): Promise<void> {
  if (!correctionVersion) throw new Error("Correction version must be non-empty");
  const resolvedSource = await fs.realpath(sourceRoot);
  const correctedParent = await fs.realpath(path.dirname(path.resolve(correctedRoot)));
  const resolvedCorrected = path.join(correctedParent, path.basename(path.resolve(correctedRoot)));
  if (
    resolvedSource === resolvedCorrected
    || resolvedCorrected.startsWith(`${resolvedSource}${path.sep}`)
    || resolvedSource.startsWith(`${resolvedCorrected}${path.sep}`)
  ) {
    throw new Error("Source and corrected run trees must be separate, non-overlapping directories");
  }
  await fs.cp(sourceRoot, correctedRoot, { recursive: true, force: false, errorOnExist: true });
  const runBytes = await fs.readFile(path.join(sourceRoot, "run.json"));
  const run = JSON.parse(runBytes.toString("utf8")) as {
    options?: { repeats?: number; repositories?: string[]; outputRoot?: string };
    sourceLock?: { repositories?: Array<{ name: string }> };
  };
  const repositories = run.options?.repositories ?? run.sourceLock?.repositories?.map((repository) => repository.name);
  const repeats = run.options?.repeats;
  if (!repositories || repositories.length === 0 || !Number.isInteger(repeats) || !repeats || repeats < 1) {
    throw new Error("Malformed source run manifest");
  }

  const correctedRows: Array<{
    repository: string;
    queryId: string;
    repeat: number;
    originalStatus: string;
    correctedStatus: string;
    statusChanged: boolean;
    rawSha256?: string;
    correctedParsingError?: string;
  }> = [];
  const staleArtifacts: string[] = [];

  for (const repository of repositories) {
    const input = JSON.parse(await fs.readFile(path.join(sourceRoot, repository, "inputs.json"), "utf8")) as {
      queryOrder?: string[];
      dataset?: { queries?: GoldenQuery[] };
    };
    if (!input.queryOrder || !input.dataset?.queries) throw new Error(`Malformed frozen inputs for ${repository}`);
    const queries = new Map(input.dataset.queries.map((query) => [query.id, query]));
    const conditionDirectory = path.join(sourceRoot, repository, "codebase-memory");
    const correctedConditionDirectory = path.join(correctedRoot, repository, "codebase-memory");
    const sourceDirectory = path.join(sourceRoot, repository, "codebase-memory", "source-and-index");
    const originalSourceDirectory = run.options?.outputRoot
      ? path.join(run.options.outputRoot, "active-source")
      : undefined;
    const commands = await rawArtifacts(conditionDirectory);
    let commandIndex = 0;

    const firstQueryPath = path.join(sourceRoot, repository, "codebase-memory", "first-query.json");
    try {
      const first = JSON.parse(await fs.readFile(firstQueryPath, "utf8")) as { queryId?: string };
      const firstQueryId = first.queryId ?? input.queryOrder.find((queryId) => queries.get(queryId)?.args?.symbol);
      const query = firstQueryId ? queries.get(firstQueryId) : undefined;
      if (!query?.args?.symbol) throw new Error(`Invalid first CBM query for ${repository}`);
      const command = commands[commandIndex];
      if (command) {
        commandIndex += 1;
        if (anchoredSymbol(command) !== query.args.symbol) throw new Error(`First CBM raw command does not match ${repository}/${firstQueryId}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const sourceRepeat = path.join(conditionDirectory, `repeat-${repeat}`);
      const correctedRepeat = path.join(correctedConditionDirectory, `repeat-${repeat}`);
      const files = await queryFileNames(sourceRepeat, input.queryOrder);
      for (const file of files) {
        const sourceFile = path.join(sourceRepeat, file);
        const originalBytes = await fs.readFile(sourceFile);
        const artifact = JSON.parse(originalBytes.toString("utf8")) as QueryArtifact;
        const query = artifact.queryId ? queries.get(artifact.queryId) : undefined;
        if (!query || artifact.repeat !== repeat || artifact.condition !== "codebase-memory" || !artifact.score) {
          throw new Error(`Malformed CBM query artifact: ${repository}/repeat-${repeat}/${file}`);
        }
        let correctedScore = artifact.score;
        let raw: RawCommandArtifact | undefined;
        let correctedParsingError: string | undefined;
        if (query.args?.symbol) {
          raw = commands[commandIndex];
          if (raw) {
            commandIndex += 1;
            if (anchoredSymbol(raw) !== query.args.symbol) {
              throw new Error(`CBM raw command order mismatch: ${repository}/repeat-${repeat}/${query.id}`);
            }
          }
          if (raw?.value.raw !== undefined) {
            try {
              const replayRaw = remapOriginalRoot(raw.value.raw, originalSourceDirectory);
              const paths = parseCodebaseMemoryPaths(replayRaw, sourceDirectory, artifact.input?.limit ?? 50);
              correctedScore = scoreQuery(query, paths, "success");
            } catch (error) {
              correctedParsingError = error instanceof Error ? error.message : String(error);
              correctedScore = scoreQuery(query, [], "error");
            }
          }
        }
        const corrected = {
          ...artifact,
          score: correctedScore,
          correction: {
            version: correctionVersion,
            sourceArtifactSha256: sha256(originalBytes),
            ...(raw ? {
              rawArtifact: raw.file,
              rawSha256: sha256(raw.bytes),
              ...(raw.relatedFile && raw.relatedBytes ? {
                relatedRawArtifact: raw.relatedFile,
                relatedRawSha256: sha256(raw.relatedBytes),
              } : {}),
            } : {}),
            originalStatus: artifact.score.status,
            correctedStatus: correctedScore.status,
            statusChanged: artifact.score.status !== correctedScore.status,
            ...(correctedParsingError ? { correctedParsingError } : {}),
          },
        };
        await fs.writeFile(path.join(correctedRepeat, file), `${JSON.stringify(corrected, null, 2)}\n`);
        correctedRows.push({
          repository,
          queryId: query.id,
          repeat,
          originalStatus: artifact.score.status,
          correctedStatus: correctedScore.status,
          statusChanged: artifact.score.status !== correctedScore.status,
          ...(raw ? { rawSha256: sha256(raw.bytes) } : {}),
          ...(correctedParsingError ? { correctedParsingError } : {}),
        });
      }
    }
    if (commandIndex !== commands.length) throw new Error(`Unmatched CBM raw command artifacts for ${repository}: ${commands.length - commandIndex}`);
    staleArtifacts.push(
      `${repository}/codebase-memory/first-query.json`,
      `${repository}/codebase-memory/summary.json`,
    );
  }

  await fs.writeFile(path.join(correctedRoot, "cbm-correction.json"), `${JSON.stringify({
    correctionVersion,
    sourceRunSha256: sha256(runBytes),
    sourceRoot: path.resolve(sourceRoot),
    staleCopiedArtifacts: staleArtifacts,
    correctedRows,
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [sourceRoot, correctedRoot, correctionVersion] = process.argv.slice(2);
  if (!sourceRoot || !correctedRoot) {
    throw new Error("Usage: competitive-cbm-replay.ts SOURCE_RUN CORRECTED_RUN [CORRECTION_VERSION]");
  }
  await replayCodebaseMemoryRun(
    path.resolve(sourceRoot),
    path.resolve(correctedRoot),
    correctionVersion ?? CBM_CORRECTION_VERSION,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
