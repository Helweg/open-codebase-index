import type { OperationControl } from "../utils/operation-control.js";
import type { HistoryEntity, HistorySnapshot } from "./types.js";
import { HISTORY_LEXICAL_VERSION, normalizeHistoryLexicalText } from "./lexical.js";
import { checkpointHistoryWork } from "./work.js";

export function historyMetadataId(number: number): string { return `entity:${number}`; }
export function historyDocumentId(number: number, id: string): string { return `document:${number}:${id}`; }

async function contentMap(repository: string, entities: HistoryEntity[], control?: OperationControl): Promise<Map<string, string>> {
  const content = new Map<string, string>();
  let count = 0;
  for (const entity of entities) {
    content.set(historyMetadataId(entity.number), `${repository} #${entity.number} ${entity.url}\n${entity.title}`);
    for (const doc of entity.documents) {
      const references = doc.documentKind === "body" && (entity.files.length || entity.commits.length) ? `\n${entity.files.join("\n")}\n${entity.commits.join(" ")}` : "";
      content.set(historyDocumentId(entity.number, doc.id), references ? `${doc.body}${references}` : doc.body);
      if (++count % 32 === 0) await checkpointHistoryWork(control);
    }
  }
  await checkpointHistoryWork(control);
  return content;
}

/** Reuse the serialized index without loading native when its content/version is unchanged. */
export async function updateHistoryLexical(snapshot: HistorySnapshot | undefined, repository: string, entities: HistoryEntity[], directory: string, control?: OperationControl): Promise<string> {
  const compatible = snapshot?.lexicalVersion === HISTORY_LEXICAL_VERSION && Boolean(snapshot.lexical);
  const next = await contentMap(repository, entities, control);
  const previous = compatible ? await contentMap(repository, snapshot.entities, control) : new Map<string, string>();
  const removed: string[] = [];
  for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
  const changed: [string, string][] = [];
  for (const entry of next) if (previous.get(entry[0]) !== entry[1]) changed.push(entry);
  if (compatible && removed.length === 0 && changed.length === 0) return snapshot.lexical;
  const { InvertedIndex } = await import("../native/inverted-index.js");
  const lexical = new InvertedIndex(directory);
  if (compatible) lexical.deserialize(snapshot.lexical);
  let count = 0;
  for (const id of removed) {
    lexical.removeChunk(id);
    if (++count % 32 === 0) await checkpointHistoryWork(control);
  }
  for (const [id, content] of changed) {
    if (previous.has(id)) lexical.removeChunk(id);
    lexical.addChunk(id, normalizeHistoryLexicalText(content));
    if (++count % 32 === 0) await checkpointHistoryWork(control);
  }
  await checkpointHistoryWork(control);
  const serialized = lexical.serialize();
  await checkpointHistoryWork(control);
  return serialized;
}
