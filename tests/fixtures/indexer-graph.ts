import type { Indexer } from "../../src/indexer/index.js";

import * as path from "node:path";

interface DeclarationLocation {
  file: string;
  name: string;
  kind: string;
  language: string;
  span: [number, number, number, number];
}

interface IndexerGraphSnapshot {
  declarations: DeclarationLocation[];
  edges: {
    caller: string;
    source: DeclarationLocation;
    name: string;
    target: DeclarationLocation | "off-branch" | null;
    resolved: boolean;
    type: string;
    confidence: string;
    line: number;
    column: number;
  }[];
}

function sortedByValue<T>(items: Iterable<T>): T[] {
  return Array.from(items, (item) => ({ item, key: JSON.stringify(item) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ item }) => item);
}

export async function readIndexerGraph(indexer: Indexer, root: string): Promise<IndexerGraphSnapshot> {
  const symbols = await indexer.getSymbolsForBranch();
  const locations = new Map<string, DeclarationLocation>(symbols.map((symbol) => [symbol.id, {
    file: path.relative(root, symbol.filePath).split(path.sep).join("/"),
    name: symbol.name, kind: symbol.kind, language: symbol.language,
    span: [symbol.startLine, symbol.startCol, symbol.endLine, symbol.endCol],
  }]));
  const outgoing = await Promise.all(Array.from(locations, async ([id, source]): Promise<IndexerGraphSnapshot["edges"]> =>
    (await indexer.getCallees(id)).map((edge) => ({
      caller: source.name, source, name: edge.targetName,
      target: edge.toSymbolId ? locations.get(edge.toSymbolId) ?? "off-branch" : null,
      resolved: edge.isResolved, type: edge.callType, confidence: edge.confidence,
      line: edge.line, column: edge.col,
    })),
  ));
  return { declarations: sortedByValue(locations.values()), edges: sortedByValue(outgoing.flat()) };
}
