const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const QUOTED_BACKTICK_RE = /`([^`]+)`/g;
const QUOTED_SINGLE_RE = /'([^'\\]+)'/g;
const QUOTED_DOUBLE_RE = /"([^"]+)"/g;

const SYMBOL_LIKE_RE = /^(?:[A-Za-z_$][A-Za-z0-9_$]*)$/;
const CAMEL_CASE_RE = /^[a-z_][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/;
const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9_$]*$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*_[a-z0-9_]+$/;

const DEFINITION_INTENT_RE = /\b(where|defined|definition|define|declaration|symbol|function|method|class|interface|type)\b/i;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "for",
  "find",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "that",
  "the",
  "definition",
  "show",
  "to",
  "where",
  "which",
  "what",
  "you",
  "your",
  "with",
]);

function stripCallSuffix(token: string): string {
  return token.replace(/\(\s*\)$/, "");
}

function isLikelySymbolName(token: string): boolean {
  if (!SYMBOL_LIKE_RE.test(token)) {
    return false;
  }

  if (STOP_WORDS.has(token.toLowerCase())) {
    return false;
  }

  return CAMEL_CASE_RE.test(token) || PASCAL_CASE_RE.test(token) || SNAKE_CASE_RE.test(token);
}

function extractQuotedIdentifiers(query: string): string[] {
  const identifiers = new Set<string>();

  for (const match of query.matchAll(QUOTED_BACKTICK_RE)) {
    const candidate = stripCallSuffix(match[1]!.trim());
    if (candidate && isLikelySymbolName(candidate)) {
      identifiers.add(candidate);
    }
  }

  for (const match of query.matchAll(QUOTED_SINGLE_RE)) {
    const candidate = stripCallSuffix(match[1]!.trim());
    if (candidate && isLikelySymbolName(candidate)) {
      identifiers.add(candidate);
    }
  }

  for (const match of query.matchAll(QUOTED_DOUBLE_RE)) {
    const candidate = stripCallSuffix(match[1]!.trim());
    if (candidate && isLikelySymbolName(candidate)) {
      identifiers.add(candidate);
    }
  }

  return [...identifiers];
}

function extractBareIdentifiers(query: string): string[] {
  const unquoted = query
    .replace(QUOTED_BACKTICK_RE, " ")
    .replace(QUOTED_SINGLE_RE, " ")
    .replace(QUOTED_DOUBLE_RE, " ");

  const identifiers = new Set<string>();
  for (const match of unquoted.matchAll(IDENTIFIER_RE)) {
    const candidate = stripCallSuffix(match[0]);
    if (isLikelySymbolName(candidate)) {
      identifiers.add(candidate);
    }
  }

  return [...identifiers];
}

function isSingleMeaningfulToken(query: string, symbol: string): boolean {
  const tokens = query
    .replace(/[`'"()]/g, " ")
    .split(/[^A-Za-z0-9_$]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .filter((token) => !STOP_WORDS.has(token));

  return tokens.length === 1 && tokens[0] === symbol.toLowerCase();
}

export function inferExactSymbolFromQuery(query: string): string | undefined {
  const quoted = extractQuotedIdentifiers(query);
  if (quoted.length === 1) {
    return quoted[0];
  }
  if (quoted.length > 1) {
    return undefined;
  }

  const candidates = extractBareIdentifiers(query);
  if (candidates.length !== 1) {
    return undefined;
  }

  const candidate = candidates[0];
  if (DEFINITION_INTENT_RE.test(query)) {
    return candidate;
  }

  if (isSingleMeaningfulToken(query, candidate)) {
    return candidate;
  }

  return undefined;
}
