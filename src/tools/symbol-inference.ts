import {
  extractIntentIdentifierHints,
  isExplicitIdentifierLookup,
  normalizeRankingText,
} from "../indexer/intent-aware-ranking.js";

export function inferExactSymbolFromQuery(query: string): string | undefined {
  // Context routing and the indexer's identifier lanes must agree on whether the
  // whole query asks for one symbol, rather than describing behavior involving it.
  if (!isExplicitIdentifierLookup(query)) {
    return undefined;
  }

  const [hint] = extractIntentIdentifierHints(query);
  if (!hint) {
    return undefined;
  }

  // Keep the caller's spelling for case-sensitive symbol lookup.
  const tokens = query.normalize("NFKC")
    .match(/[\p{L}_$][\p{L}\p{N}_$-]*(?:(?:\.|::)[\p{L}_$][\p{L}\p{N}_$]*)*/gu) ?? [];
  return tokens.find((token) => normalizeRankingText(token) === hint);
}
