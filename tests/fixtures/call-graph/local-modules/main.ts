import { directTarget, directTarget as localAlias } from "./direct.js";
import { publicTarget as localReexport } from "./barrel.js";
import { duplicateTarget } from "./duplicate-a.js";
import { ambiguousTarget } from "./ambiguous-barrel.js";
import { missingTarget } from "./missing.js";

export function localTarget(): number {
  return 3;
}

export function runDirect(): number {
  return directTarget();
}

export function runAlias(): number {
  return localAlias();
}

export function runReexport(): number {
  return localReexport();
}

export function runDuplicate(): string {
  return duplicateTarget();
}

export function runAmbiguous(): string {
  return ambiguousTarget();
}

export function runMissing(): unknown {
  return missingTarget();
}

export function runLocal(): number {
  return localTarget();
}
