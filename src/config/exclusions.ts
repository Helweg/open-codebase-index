import { DEFAULT_EXCLUDE } from "./constants.js";

const derivedDefaultExcludePatterns = new WeakSet<readonly string[]>();

export function createDefaultExcludePatterns(): string[] {
  const patterns = [...DEFAULT_EXCLUDE];
  derivedDefaultExcludePatterns.add(patterns);
  return patterns;
}

export function isDefaultExcludePatterns(patterns: readonly string[]): boolean {
  return derivedDefaultExcludePatterns.has(patterns)
    && patterns.length === DEFAULT_EXCLUDE.length
    && patterns.every((pattern, index) => pattern === DEFAULT_EXCLUDE[index]);
}
