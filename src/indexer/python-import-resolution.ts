import type { CallSiteData, SymbolData } from "../native/types.js";
import type { LocalModuleData } from "./local-module-resolution.js";

import * as path from "node:path";

interface PythonToken {
  value: string;
  line: number;
  column: number;
}

export function isPythonFilePath(filePath: string): boolean {
  return path.posix.extname(filePath.replaceAll("\\", "/")) === ".py";
}

// This is deliberately a bounded static resolver, not Python's runtime importer.
// Keep byte coordinates aligned with native call sites and ignore quoted/commented
// imports. Only simple f-string fields are admitted. Parsing arbitrary Python
// expressions or reused quote delimiters here could hide a rebinding operation.
function tokensForPython(content: string): PythonToken[] | undefined {
  const tokens: PythonToken[] = [];
  let cursor = 0;
  let line = 1;
  let column = 0;
  const advance = (): string => {
    const character = String.fromCodePoint(content.codePointAt(cursor)!);
    cursor += character.length;
    if (character === "\n") { line += 1; column = 0; }
    else column += Buffer.byteLength(character);
    return character;
  };
  while (cursor < content.length) {
    const character = content[cursor];
    if (/\s/u.test(character)) { advance(); continue; }
    if (character === "#") {
      while (cursor < content.length && content[cursor] !== "\n") advance();
      continue;
    }
    if (character === "'" || character === '"') {
      const prefix = tokens.at(-1);
      const interpolated = prefix?.line === line
        && prefix.column + Buffer.byteLength(prefix.value) === column
        && /^(?:f|fr|rf|t|tr|rt)$/iu.test(prefix.value);
      const stringStart = cursor;
      const delimiter = content.startsWith(character.repeat(3), cursor) ? character.repeat(3) : character;
      for (let index = 0; index < delimiter.length; index += 1) advance();
      let closed = false;
      while (cursor < content.length) {
        if (content.startsWith(delimiter, cursor)) {
          for (let index = 0; index < delimiter.length; index += 1) advance();
          closed = true;
          break;
        }
        if (advance() === "\\" && cursor < content.length) advance();
      }
      if (!closed) return undefined;
      if (interpolated) {
        const literal = content.slice(stringStart + delimiter.length, cursor - delimiter.length);
        const remainder = literal.replaceAll("{{", "").replaceAll("}}", "")
          .replace(/\{[A-Za-z_]\w*(?:(?:\.[A-Za-z_]\w*)|(?:\[(?:'[A-Za-z_]\w*'|"[A-Za-z_]\w*"|\d+)\]))*\}/gu, "");
        if (/[{}]/u.test(remainder)) return undefined;
      }
      continue;
    }
    const startLine = line;
    const startColumn = column;
    const identifier = content.slice(cursor).match(/^[\p{ID_Start}_][\p{ID_Continue}]*/u)?.[0];
    if (identifier) {
      const end = cursor + identifier.length;
      while (cursor < end) advance();
      tokens.push({ value: identifier.normalize("NFKC"), line: startLine, column: startColumn });
    } else {
      tokens.push({ value: advance(), line: startLine, column: startColumn });
    }
  }
  return tokens;
}

function isDirectUse(tokens: readonly PythonToken[], index: number): boolean {
  return tokens[index + 1]?.value === "("
    && ![".", "def", "class"].includes(tokens[index - 1]?.value ?? "");
}

function hasDynamicBindings(tokens: readonly PythonToken[]): boolean {
  return tokens.some((token, index) =>
    ["exec", "eval", "globals", "locals", "vars", "setattr", "__import__"].includes(token.value)
    || (token.value === "import" && tokens[index + 1]?.value === "*")
  );
}

interface RelativeBinding {
  source: string;
  importedName: string;
  line: number;
}

function relativeBinding(tokens: readonly PythonToken[], name: string): RelativeBinding | undefined {
  const bindings: RelativeBinding[] = [];
  const allowed = new Set<number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value !== "from" || token.column !== 0) continue;
    const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.line !== token.line);
    const stop = end === -1 ? tokens.length : end;
    const statement = tokens.slice(index, stop).map((part) => part.value).join(" ");
    const match = statement.match(/^from ((?:\. )+)([A-Za-z_]\w*(?: \. [A-Za-z_]\w*)*)?\s*import (.+)$/u);
    if (!match) continue;
    const source = match[1].replaceAll(" ", "") + (match[2] ?? "").replaceAll(" ", "");
    const entries = match[3].split(" , ");
    if (entries.some((entry) => !/^[A-Za-z_]\w*(?: as [A-Za-z_]\w*)?$/u.test(entry))) continue;
    for (const entry of entries) {
      const [importedName, alias] = entry.split(" as ");
      if ((alias ?? importedName) !== name) continue;
      bindings.push({ source, importedName, line: token.line });
      for (let position = index; position < stop; position += 1) allowed.add(position);
    }
  }
  if (bindings.length !== 1 || hasDynamicBindings(tokens)) return undefined;
  // Any other occurrence that is not a direct call may shadow/rebind the name.
  // This intentionally abstains even for harmless references rather than guessing.
  if (tokens.some((token, index) => token.value === name && !allowed.has(index) && !isDirectUse(tokens, index))) return undefined;
  return bindings[0];
}

export async function resolvePythonRelativeCall(
  importer: string,
  content: string,
  site: CallSiteData,
  filePaths: ReadonlySet<string>,
  loadModule: (filePath: string) => Promise<LocalModuleData | undefined>,
): Promise<SymbolData | undefined> {
  if (site.callType !== "Call" || path.posix.isAbsolute(importer) || importer.startsWith("../")) return undefined;
  const tokens = tokensForPython(content);
  if (!tokens) return undefined;
  const callIndex = tokens.findIndex((token) => token.line === site.line && token.column === site.column && token.value === site.calleeName);
  if (callIndex === -1 || !isDirectUse(tokens, callIndex)) return undefined;
  const binding = relativeBinding(tokens, site.calleeName);
  if (!binding || binding.line >= site.line) return undefined;
  const dots = binding.source.match(/^\.+/u)![0].length;
  let directory = path.posix.dirname(importer);
  // Relative imports need a package, and may never climb out of that package
  // chain or cross the known source boundary. Namespace/absolute imports abstain.
  for (let level = 0; level < dots; level += 1) {
    if (!filePaths.has(path.posix.join(directory, "__init__.py"))) return undefined;
    if (level < dots - 1) {
      if (directory === ".") return undefined;
      directory = path.posix.dirname(directory);
    }
  }
  const moduleName = binding.source.slice(dots).replaceAll(".", "/");
  let packageDirectory = directory;
  for (const component of moduleName.split("/").slice(0, -1)) {
    packageDirectory = path.posix.join(packageDirectory, component);
    if (!filePaths.has(`${packageDirectory}/__init__.py`) || filePaths.has(`${packageDirectory}.py`)) return undefined;
  }
  const base = path.posix.join(directory, moduleName);
  const candidates = (moduleName ? [`${base}.py`, `${base}/__init__.py`] : [`${base}/__init__.py`])
    .filter((candidate) => filePaths.has(candidate));
  if (candidates.length !== 1) return undefined;
  const target = await loadModule(candidates[0]);
  if (!target) return undefined;
  const targetTokens = tokensForPython(target.content);
  if (!targetTokens || hasDynamicBindings(targetTokens) || targetTokens.some((token) => token.value === "@")) return undefined;
  const definitions = target.symbols.filter((symbol) => symbol.name === binding.importedName && symbol.kind === "function_definition"
    && targetTokens.some((token, index) => token.value === "def" && token.column === 0
      && token.line === symbol.startLine && targetTokens[index + 1]?.value === symbol.name));
  if (definitions.length !== 1) return undefined;
  const definition = definitions[0];
  if (targetTokens.some((token, index) => token.value === definition.name
    && !(token.line === definition.startLine && targetTokens[index - 1]?.value === "def")
    && !isDirectUse(targetTokens, index))) return undefined;
  return definition;
}
