import { readFileSync } from "fs";

export function getPackageVersion(): string {
  const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as unknown;
  if (raw && typeof raw === "object" && "version" in raw && typeof raw.version === "string") {
    return raw.version;
  }

  return "0.0.0";
}
