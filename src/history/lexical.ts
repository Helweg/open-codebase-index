/** Includes the analyzer and the entity-metadata/document chunk layout. */
export const HISTORY_LEXICAL_VERSION = 2;

export function historyTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** Native BM25 drops short tokens; encode all such words, not selected acronyms. */
export function normalizeHistoryLexicalText(text: string): string {
  return historyTokens(text).map((token) => {
    if (/^[0-9]+$/.test(token)) return `githubnumber${token}`;
    return Buffer.byteLength(token, "utf8") < 3 ? `githubshort${token}` : token;
  }).join(" ");
}
