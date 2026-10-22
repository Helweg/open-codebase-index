export function redactSensitiveText(text: string): string {
  return text.replace(
    /((?:api[-_]?key|token|password|secret|authorization)\s*[=:]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
}
