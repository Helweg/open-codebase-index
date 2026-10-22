/** Native BM25 drops tokens shorter than three bytes; encode numeric identifiers consistently on both sides. */
export function normalizeHistoryLexicalText(text: string): string {
  return text.replace(/(^|[^\p{L}\p{N}_])#?([0-9]+)(?=$|[^\p{L}\p{N}_])/gu,
    (_match, prefix: string, number: string) => `${prefix}githubnumber${number}`);
}
