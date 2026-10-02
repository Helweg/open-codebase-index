import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createCodebaseIndexExtension, type ExtensionSchemaBuilder } from "../shared/extension-core.js";

/**
 * omp (oh-my-pi) implements the pi extension contract, so this wrapper registers
 * the shared core and pi-compatible `.codebase-index/` storage. omp exposes its
 * TypeBox-style builder as the namespace `pi.typebox` (`{ Type, default }`);
 * prefer `pi.typebox.Type` so parameter schemas come from the host, falling back
 * to this package's builder when the host exposes none.
 */
export type OmpExtensionAPI = ExtensionAPI & { typebox?: { Type?: ExtensionSchemaBuilder } };

export default function codebaseIndexOmpExtension(pi: OmpExtensionAPI): void {
  createCodebaseIndexExtension({ schema: pi.typebox?.Type ?? Type })(pi);
}
