import type { CallSiteData, SymbolData } from "../native/types.js";

import * as path from "node:path";

const GO_SOURCE_EXTENSION = ".go";

function normalizeGoFilePath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll("\\", "/"));
}

export function isGoFilePath(filePath: string): boolean {
  return path.posix.extname(normalizeGoFilePath(filePath)).toLowerCase() === GO_SOURCE_EXTENSION;
}

// The native Go query intentionally exposes both `Target()` and `pkg.Target()`
// as Call sites. This lexer preserves that public contract while using the
// reported UTF-8 byte coordinates to admit only syntactically direct calls.
// It also recognizes local bindings conservatively so lexical shadowing never
// turns into a guessed package edge.
interface GoToken {
  kind: "identifier" | "symbol";
  value: string;
  line: number;
  column: number;
}

const GO_CALLABLE_SYMBOL_KINDS = new Set(["function_declaration", "method_declaration"]);
const GO_KEYWORDS = new Set([
  "break",
  "default",
  "func",
  "interface",
  "select",
  "case",
  "defer",
  "go",
  "map",
  "struct",
  "chan",
  "else",
  "goto",
  "package",
  "switch",
  "const",
  "fallthrough",
  "if",
  "range",
  "type",
  "continue",
  "for",
  "import",
  "return",
  "var",
]);
const GO_BUILD_OPERATING_SYSTEMS = new Set([
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "illumos",
  "ios",
  "js",
  "linux",
  "netbsd",
  "openbsd",
  "plan9",
  "solaris",
  "wasip1",
  "windows",
]);
const GO_BUILD_ARCHITECTURES = new Set([
  "386",
  "amd64",
  "arm",
  "arm64",
  "loong64",
  "mips",
  "mips64",
  "mips64le",
  "mipsle",
  "ppc64",
  "ppc64le",
  "riscv64",
  "s390x",
  "wasm",
]);

function isGoIdentifierStart(character: string): boolean {
  return character === "_" || /\p{L}/u.test(character);
}

function isGoIdentifierContinue(character: string): boolean {
  return isGoIdentifierStart(character) || /\p{Nd}/u.test(character);
}

function tokenizeGoSource(content: string): GoToken[] {
  const tokens: GoToken[] = [];
  let cursor = 0;
  let line = 1;
  let column = 0;

  const currentCharacter = (): string => {
    const codePoint = content.codePointAt(cursor);
    return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
  };
  const advance = (): string => {
    const character = currentCharacter();
    cursor += character.length;
    if (character === "\n") {
      tokens.push({ kind: "symbol", value: "\n", line, column });
      line += 1;
      column = 0;
    } else {
      column += Buffer.byteLength(character, "utf8");
    }
    return character;
  };

  while (cursor < content.length) {
    const character = currentCharacter();
    const next = content[cursor + character.length] ?? "";

    if (/\s/u.test(character)) {
      advance();
      continue;
    }
    if (character === "/" && next === "/") {
      advance();
      advance();
      while (cursor < content.length && currentCharacter() !== "\n") advance();
      continue;
    }
    if (character === "/" && next === "*") {
      advance();
      advance();
      while (cursor < content.length) {
        const commentCharacter = currentCharacter();
        const commentNext = content[cursor + commentCharacter.length] ?? "";
        advance();
        if (commentCharacter === "*" && commentNext === "/") {
          advance();
          break;
        }
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const delimiter = character;
      advance();
      let escaped = false;
      while (cursor < content.length) {
        const stringCharacter = currentCharacter();
        advance();
        if (delimiter !== "`" && escaped) {
          escaped = false;
          continue;
        }
        if (delimiter !== "`" && stringCharacter === "\\") {
          escaped = true;
          continue;
        }
        if (stringCharacter === delimiter) break;
      }
      continue;
    }
    if (isGoIdentifierStart(character)) {
      const startLine = line;
      const startColumn = column;
      let value = "";
      while (cursor < content.length && isGoIdentifierContinue(currentCharacter())) {
        value += advance();
      }
      tokens.push({ kind: "identifier", value, line: startLine, column: startColumn });
      continue;
    }

    const startLine = line;
    const startColumn = column;
    if (character === ":" && next === "=") {
      advance();
      advance();
      tokens.push({ kind: "symbol", value: ":=", line: startLine, column: startColumn });
      continue;
    }
    advance();
    tokens.push({ kind: "symbol", value: character, line: startLine, column: startColumn });
  }

  return tokens;
}

function previousGoToken(tokens: readonly GoToken[], start: number): number {
  let cursor = start;
  while (cursor >= 0 && tokens[cursor].value === "\n") cursor -= 1;
  return cursor;
}

function nextGoToken(tokens: readonly GoToken[], start: number): number {
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor].value === "\n") cursor += 1;
  return cursor;
}

function findMatchingGoDelimiter(
  tokens: readonly GoToken[],
  start: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function goPositionContains(symbol: SymbolData, site: CallSiteData): boolean {
  const startsBefore = symbol.startLine < site.line
    || (symbol.startLine === site.line && symbol.startCol <= site.column);
  const endsAfter = symbol.endLine > site.line
    || (symbol.endLine === site.line && symbol.endCol >= site.column);
  return startsBefore && endsAfter;
}

function findEnclosingGoCallableSymbol(
  symbols: readonly SymbolData[],
  site: CallSiteData,
): SymbolData | undefined {
  return symbols
    .filter((symbol) => GO_CALLABLE_SYMBOL_KINDS.has(symbol.kind) && goPositionContains(symbol, site))
    .sort((left, right) =>
      (left.endLine - left.startLine) - (right.endLine - right.startLine)
      || left.startLine - right.startLine
      || left.startCol - right.startCol
      || left.id.localeCompare(right.id)
    )[0];
}

function goTokenIsWithinSymbol(token: GoToken, symbol: SymbolData): boolean {
  return token.line > symbol.startLine
    || (token.line === symbol.startLine && token.column >= symbol.startCol);
}

function goDeclarationContainsName(
  tokens: readonly GoToken[],
  declarationIndex: number,
  callIndex: number,
  name: string,
): boolean {
  const declarationKind = tokens[declarationIndex].value;
  let cursor = nextGoToken(tokens, declarationIndex + 1);
  if (cursor >= callIndex) return false;

  if (tokens[cursor].value !== "(") {
    if (tokens[cursor].kind === "identifier" && tokens[cursor].value === name) return true;
    if (declarationKind === "type") return false;
    while (cursor < callIndex) {
      const comma = nextGoToken(tokens, cursor + 1);
      if (tokens[comma]?.value !== ",") return false;
      cursor = nextGoToken(tokens, comma + 1);
      if (tokens[cursor]?.kind !== "identifier") return false;
      if (tokens[cursor].value === name) return true;
    }
    return false;
  }

  const end = findMatchingGoDelimiter(tokens, cursor, "(", ")");
  if (end === undefined) return false;
  let atSpecStart = true;
  let depth = 1;
  for (let index = cursor + 1; index < Math.min(end, callIndex); index += 1) {
    const token = tokens[index];
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth -= 1;
    if (depth !== 1) continue;
    if (token.value === "\n" || token.value === ";") {
      atSpecStart = true;
      continue;
    }
    if (!atSpecStart) continue;
    if (token.kind === "identifier") {
      if (token.value === name) return true;
      let next = nextGoToken(tokens, index + 1);
      while (tokens[next]?.value === ",") {
        next = nextGoToken(tokens, next + 1);
        if (tokens[next]?.kind !== "identifier") break;
        if (tokens[next].value === name) return true;
        next = nextGoToken(tokens, next + 1);
      }
      atSpecStart = false;
    }
  }
  return false;
}

function goFunctionHeaderContainsName(
  tokens: readonly GoToken[],
  functionIndex: number,
  callIndex: number,
  name: string,
): boolean {
  let declarationNameIndex: number | undefined;
  const cursor = nextGoToken(tokens, functionIndex + 1);
  if (tokens[cursor]?.value === "(") {
    const receiverEnd = findMatchingGoDelimiter(tokens, cursor, "(", ")");
    if (receiverEnd !== undefined) {
      const possibleName = nextGoToken(tokens, receiverEnd + 1);
      const possibleParameters = nextGoToken(tokens, possibleName + 1);
      if (tokens[possibleName]?.kind === "identifier" && tokens[possibleParameters]?.value === "(") {
        declarationNameIndex = possibleName;
      }
    }
  } else if (tokens[cursor]?.kind === "identifier") {
    declarationNameIndex = cursor;
  }

  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let anonymousTypeBraceDepth = 0;
  for (let index = functionIndex + 1; index < callIndex; index += 1) {
    const token = tokens[index];
    if (token.value === "(") parenthesisDepth += 1;
    if (token.value === ")") parenthesisDepth -= 1;
    if (token.value === "[") bracketDepth += 1;
    if (token.value === "]") bracketDepth -= 1;
    if (token.value === "{") {
      if (parenthesisDepth === 0 && bracketDepth === 0 && anonymousTypeBraceDepth === 0) {
        const previous = previousGoToken(tokens, index - 1);
        if (tokens[previous]?.value === "interface" || tokens[previous]?.value === "struct") {
          anonymousTypeBraceDepth = 1;
          continue;
        }
        break;
      }
      if (anonymousTypeBraceDepth > 0) anonymousTypeBraceDepth += 1;
    }
    if (token.value === "}" && anonymousTypeBraceDepth > 0) anonymousTypeBraceDepth -= 1;
    if (index !== declarationNameIndex && token.kind === "identifier" && token.value === name) {
      return true;
    }
  }
  return false;
}

function hasGoLocalBindingBeforeCall(
  tokens: readonly GoToken[],
  scopeStart: number,
  callIndex: number,
  name: string,
): boolean {
  for (let index = scopeStart; index < callIndex; index += 1) {
    const token = tokens[index];
    if (token.value === "func" && goFunctionHeaderContainsName(tokens, index, callIndex, name)) {
      return true;
    }
    if (
      (token.value === "var" || token.value === "const" || token.value === "type")
      && goDeclarationContainsName(tokens, index, callIndex, name)
    ) {
      return true;
    }
    if (token.value === ":=") {
      let binding = previousGoToken(tokens, index - 1);
      while (binding >= scopeStart && tokens[binding]?.kind === "identifier") {
        if (tokens[binding].value === name) return true;
        const comma = previousGoToken(tokens, binding - 1);
        if (tokens[comma]?.value !== ",") break;
        binding = previousGoToken(tokens, comma - 1);
      }
    }
  }
  return false;
}

function isDirectGoFunctionCallSite(
  tokens: readonly GoToken[],
  callIndex: number | undefined,
  site: CallSiteData,
  symbols: readonly SymbolData[],
): boolean {
  if (site.callType !== "Call" || site.calleeName === "init" || callIndex === undefined) return false;

  const previous = previousGoToken(tokens, callIndex - 1);
  const next = nextGoToken(tokens, callIndex + 1);
  if (tokens[previous]?.value === "." || tokens[next]?.value !== "(") return false;

  const enclosingSymbol = findEnclosingGoCallableSymbol(symbols, site);
  if (!enclosingSymbol) return false;
  const scopeStart = tokens.findIndex((token) => goTokenIsWithinSymbol(token, enclosingSymbol));
  if (scopeStart === -1 || scopeStart >= callIndex) return false;
  return !hasGoLocalBindingBeforeCall(tokens, scopeStart, callIndex, site.calleeName);
}

export function createGoDirectCallClassifier(
  content: string,
  symbols: readonly SymbolData[],
): (site: CallSiteData) => boolean {
  const tokens = tokenizeGoSource(content);
  const tokenIndexes = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "identifier") {
      tokenIndexes.set(`${token.value}\0${token.line}\0${token.column}`, index);
    }
  }
  return (site) => isDirectGoFunctionCallSite(
    tokens,
    tokenIndexes.get(`${site.calleeName}\0${site.line}\0${site.column}`),
    site,
    symbols,
  );
}

function hasGoBuildDirective(content: string): boolean {
  const packageOffset = content.search(/^[ \t]*package\s+[\p{L}_]/mu);
  const header = packageOffset === -1 ? content : content.slice(0, packageOffset);
  return /^[ \t]*\/\/(?:go:build\b|[ \t]*\+build\b)/mu.test(header);
}

function hasGoFileNameBuildConstraint(filePath: string): boolean {
  let stem = path.posix.basename(normalizeGoFilePath(filePath), GO_SOURCE_EXTENSION).toLowerCase();
  if (stem.endsWith("_test")) stem = stem.slice(0, -"_test".length);
  const segments = stem.split("_");
  const last = segments.at(-1);
  const secondLast = segments.at(-2);
  return (last !== undefined && (GO_BUILD_OPERATING_SYSTEMS.has(last) || GO_BUILD_ARCHITECTURES.has(last)))
    || (secondLast !== undefined && GO_BUILD_OPERATING_SYSTEMS.has(secondLast)
      && last !== undefined && GO_BUILD_ARCHITECTURES.has(last));
}

function hasGoCgoImport(content: string): boolean {
  return /\bimport(?:\s+(?:[._]|[\p{L}_][\p{L}\p{Nd}_]*))?\s+(?:"C"|`C`)/u.test(content)
    || /\bimport\s*\([\s\S]*?(?:"C"|`C`)[\s\S]*?\)/u.test(content);
}

// Cross-file resolution abstains whenever file membership depends on build
// context that the index does not model. This is intentionally narrower than
// the set of files the parser can index.
export function isGoPackageResolutionEligible(filePath: string, content: string): boolean {
  const normalized = normalizeGoFilePath(filePath);
  const baseName = path.posix.basename(normalized);
  return path.posix.extname(normalized) === GO_SOURCE_EXTENSION
    && !baseName.startsWith(".")
    && !baseName.startsWith("_")
    && !hasGoBuildDirective(content)
    && !hasGoFileNameBuildConstraint(normalized)
    && !hasGoCgoImport(content);
}

export function isGoTestFilePath(filePath: string): boolean {
  return normalizeGoFilePath(filePath).toLowerCase().endsWith("_test.go");
}

export function parseGoPackageName(content: string): string | undefined {
  let cursor = content.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (cursor < content.length) {
    if (/\s/u.test(content[cursor])) {
      cursor += 1;
      continue;
    }
    if (content.startsWith("//", cursor)) {
      const lineEnd = content.indexOf("\n", cursor + 2);
      cursor = lineEnd === -1 ? content.length : lineEnd + 1;
      continue;
    }
    if (content.startsWith("/*", cursor)) {
      const commentEnd = content.indexOf("*/", cursor + 2);
      if (commentEnd === -1) return undefined;
      cursor = commentEnd + 2;
      continue;
    }
    break;
  }

  const packageName = content.slice(cursor).match(
    /^package\s+([\p{L}_][\p{L}\p{Nd}_]*)(?=\s|;|$)/u,
  )?.[1];
  return packageName && packageName !== "_" && !GO_KEYWORDS.has(packageName)
    ? packageName
    : undefined;
}
