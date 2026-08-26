import { deterministicTarget } from "@core/deterministic";
import { ambiguousTarget } from "@ambiguous/target";
import { externalTarget } from "external-package";

export function runDeterministic(): number {
  return deterministicTarget(1);
}

export function runAmbiguous(): number {
  return ambiguousTarget(1);
}

export function runExternal(): number {
  return externalTarget();
}
