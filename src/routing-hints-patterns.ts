const EXTERNAL_HINTS = [
  "official docs",
  "official documentation",
  "web search",
  "website",
  "context7",
  "stackoverflow",
];

const NON_DISCOVERY_HINTS = [
  "commit",
  "rebase",
  "push",
  "pull request",
  "lint",
  "typecheck",
  "build",
  "test",
  "release",
  "deploy",
  "screenshot",
  "browser",
  "open the website",
];

const CONCEPTUAL_DISCOVERY_HINTS = [
  "where is",
  "where are",
  "which file",
  "what file",
  "how does",
  "how do we",
  "how is",
  "find the code",
  "find code",
  "find where",
  "find logic",
  "implementation",
  "implements",
  "handler",
  "flow",
  "logic",
  "middleware",
  "parser",
  "validation",
  "rate limiting",
  "error handling",
  "auth flow",
  "responsible for",
  "similar code",
  "pattern",
  "code that",
];

const BROAD_LOCAL_TASK_HINTS = [
  "fix the bug",
  "fix this",
  "fix issue",
  "implement ",
  "add support",
  "investigate ",
  "debug ",
  "refactor ",
  "review this",
  "review codebase",
  "review the codebase",
  "audit this",
  "audit the codebase",
];

const DEFINITION_HINTS = [
  "defined",
  "definition",
  "jump to",
  "definition site",
  "authoritative definition",
];

const EXACT_MATCH_HINTS = [
  "exact",
  "all references",
  "all occurrences",
  "literal",
  "regex",
  "grep",
  "identifier",
  "symbol",
  "named",
  "definition of",
];

const FILE_PATH_PATTERN = /(?:^|\s)(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+/;
const URL_PATTERN = /https?:\/\//;
const CAMEL_OR_PASCAL_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
const SNAKE_PATTERN = /\b[a-z0-9]+_[a-z0-9_]+\b/g;
const KEBAB_PATTERN = /\b[a-z0-9]+-[a-z0-9-]+\b/g;
const BACKTICK_IDENTIFIER_PATTERN = /`([^`]+)`/g;
const BACKTICK_IDENTIFIER_PRESENCE_PATTERN = /`([^`]+)`/;
const DOUBLE_QUOTED_PATTERN = /"[^"]+"/;
const SINGLE_QUOTED_PATTERN = /'[^']+'/;

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function includesHint(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

export function countWords(text: string): number {
  if (!text) {
    return 0;
  }

  return text.split(/\s+/).filter(Boolean).length;
}

export function isExternalLookup(text: string): boolean {
  return URL_PATTERN.test(text) || includesHint(text, EXTERNAL_HINTS)
    || /\b(?:search|look up|browse|check|consult|fetch|read|find)\b.{0,80}\b(?:online docs|npm registry|pypi|crates\.io|github (?:repo|repository|examples?))\b/.test(text);
}

export function hasConceptualDiscoveryHint(text: string): boolean {
  return includesHint(text, CONCEPTUAL_DISCOVERY_HINTS)
    || /\btrace (?:the |how )?.{0,80}\b(?:authorization|execution|request|call|data|dependency|control)\b/.test(text)
    || (/\b(?:source|code|repository|repo|checkout)\b/.test(text)
      && /\b(?:explain|trace|compare|analy[sz]e|identify|cite|describe)\b/.test(text));
}

export function hasBroadLocalTaskHint(text: string): boolean {
  return includesHint(text, BROAD_LOCAL_TASK_HINTS);
}

export function hasDefinitionHint(text: string): boolean {
  return includesHint(text, DEFINITION_HINTS);
}

export function hasExactMatchHint(text: string): boolean {
  return includesHint(text, EXACT_MATCH_HINTS);
}

export function hasExplicitWorkflowTaskHint(text: string): boolean {
  return /\b(?:code coverage|coverage report|build code size|(?:build|test|release) workflow)\b/.test(text);
}

export function hasNonDiscoveryHint(text: string): boolean {
  return /\bpr\b/.test(text) || includesHint(text, NON_DISCOVERY_HINTS);
}

export function hasIdentifierShape(text: string): boolean {
  const matches = [
    ...(text.match(CAMEL_OR_PASCAL_PATTERN) ?? []),
    ...(text.match(SNAKE_PATTERN) ?? []),
    ...(text.match(KEBAB_PATTERN) ?? []),
    ...Array.from(text.matchAll(BACKTICK_IDENTIFIER_PATTERN), (match) => match[1]),
  ];

  return matches.some((match) => {
    if (match.length < 3) {
      return false;
    }

    return /[A-Z]/.test(match) || match.includes("_") || match.includes("-") || /`/.test(match);
  });
}

export function containsQuotedIdentifier(text: string): boolean {
  return BACKTICK_IDENTIFIER_PRESENCE_PATTERN.test(text) || DOUBLE_QUOTED_PATTERN.test(text) || SINGLE_QUOTED_PATTERN.test(text);
}

export function looksLikeDirectPath(text: string): boolean {
  return FILE_PATH_PATTERN.test(text) || /\b[a-z0-9_-]+\.(ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml)\b/i.test(text);
}
