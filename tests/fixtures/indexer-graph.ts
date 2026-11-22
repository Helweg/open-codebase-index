import type { Indexer } from "../../src/indexer/index.js";

import * as path from "node:path";

function sortedByValue<T>(items: Iterable<T>): T[] {
  return Array.from(items, (item) => ({ item, key: JSON.stringify(item) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ item }) => item);
}

export async function readIndexerGraph(indexer: Indexer, root: string) {
  const symbols = await indexer.getSymbolsForBranch();
  const locations = new Map(symbols.map((symbol) => [symbol.id, {
    file: path.relative(root, symbol.filePath).split(path.sep).join("/"),
    name: symbol.name, kind: symbol.kind, language: symbol.language,
    span: [symbol.startLine, symbol.startCol, symbol.endLine, symbol.endCol],
  }]));
  const outgoing = await Promise.all(symbols.map(async (symbol) =>
    (await indexer.getCallees(symbol.id)).map((edge) => ({
      caller: symbol.name, source: locations.get(symbol.id), name: edge.targetName,
      target: edge.toSymbolId ? locations.get(edge.toSymbolId) ?? "off-branch" : null,
      resolved: edge.isResolved, type: edge.callType, confidence: edge.confidence,
      line: edge.line, column: edge.col,
    })),
  ));
  return { declarations: sortedByValue(locations.values()), edges: sortedByValue(outgoing.flat()) };
}
