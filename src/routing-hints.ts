import type { StatusResult } from "./indexer/index.js";
import {
  containsQuotedIdentifier,
  countWords,
  hasConceptualDiscoveryHint,
  hasBroadLocalTaskHint,
  hasDefinitionHint,
  hasExactMatchHint,
  hasIdentifierShape,
  hasNonDiscoveryHint,
  isExternalLookup,
  looksLikeDirectPath,
  normalizeText,
} from "./routing-hints-patterns.js";

export type RoutingIntent =
  | "local_conceptual"
  | "local_broad_task"
  | "definition_lookup"
  | "exact_identifier"
  | "external"
  | "direct_path"
  | "other";

export interface RoutingAssessment {
  intent: RoutingIntent;
  text: string;
  reason: string;
}

export interface RoutingSessionState {
  assessment: RoutingAssessment;
  pendingHint: boolean;
  updatedAt: number;
}

interface TextPartLike {
  type?: string;
  text?: string;
}

export function extractUserText(parts: TextPartLike[]): string {
  return normalizeText(
    parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join(" "),
  );
}

export function assessRoutingIntent(text: string): RoutingAssessment {
  const normalizedText = normalizeText(text);
  const lowered = normalizedText.toLowerCase();

  if (!lowered) {
    return {
      intent: "other",
      text: normalizedText,
      reason: "empty_text",
    };
  }

  if (isExternalLookup(lowered)) {
    return {
      intent: "external",
      text: normalizedText,
      reason: "external_lookup",
    };
  }

  const matchedConceptualHint = hasConceptualDiscoveryHint(lowered);
  const matchedDefinitionHint = hasDefinitionHint(lowered);
  const matchedExactMatchHint = hasExactMatchHint(lowered);
  const matchedNonDiscoveryHint = hasNonDiscoveryHint(lowered);
  const matchedBroadLocalTask = hasBroadLocalTaskHint(lowered);
  const hasIdentifier = hasIdentifierShape(normalizedText);
  const hasQuotedIdentifier = containsQuotedIdentifier(normalizedText);
  const shortQuery = countWords(lowered) <= 10;

  if (matchedNonDiscoveryHint && !matchedConceptualHint && !matchedBroadLocalTask) {
    return {
      intent: "other",
      text: normalizedText,
      reason: "non_discovery_task",
    };
  }

  if (looksLikeDirectPath(normalizedText)) {
    return {
      intent: "direct_path",
      text: normalizedText,
      reason: "direct_path_reference",
    };
  }

  if ((matchedDefinitionHint || lowered.includes("where is") || lowered.includes("where are")) && (lowered.includes("defined") || lowered.includes("definition"))) {
    return {
      intent: "definition_lookup",
      text: normalizedText,
      reason: "definition_lookup_request",
    };
  }

  if (matchedBroadLocalTask) {
    return {
      intent: "local_broad_task",
      text: normalizedText,
      reason: "broad_local_code_task",
    };
  }

  if ((matchedExactMatchHint || hasQuotedIdentifier || hasIdentifier) && !matchedConceptualHint && shortQuery) {
    return {
      intent: "exact_identifier",
      text: normalizedText,
      reason: matchedExactMatchHint || hasQuotedIdentifier ? "exact_match_request" : "identifier_shaped_query",
    };
  }

  if (matchedConceptualHint) {
    return {
      intent: "local_conceptual",
      text: normalizedText,
      reason: "conceptual_local_discovery",
    };
  }

  return {
    intent: "other",
    text: normalizedText,
    reason: "no_local_discovery_signal",
  };
}

export function buildRoutingHint(
  assessment: RoutingAssessment,
  status: Pick<StatusResult, "indexed" | "compatibility"> | null,
  includeGraphHandoff: boolean = false,
): string | null {
  const hasSymbolCue = hasIdentifierShape(assessment.text) || containsQuotedIdentifier(assessment.text);

  if (assessment.intent === "definition_lookup") {
    if (!status || !status.indexed || status.compatibility?.compatible === false) {
      return "For this turn, if you need a symbol definition, check `index_status` first and run `index_codebase` if the index is missing or incompatible. Then use `implementation_lookup` for the definition site. Use `grep` for exhaustive literal matches.";
    }

    return "For this turn, prefer `implementation_lookup` to find the authoritative definition site. Use `codebase_search` only if no definition is found, and use `grep` for exhaustive literal matches.";
  }

  if (assessment.intent !== "local_conceptual" && assessment.intent !== "local_broad_task") {
    return null;
  }

  const preEditHint = assessment.intent === "local_broad_task" && hasSymbolCue
    ? " If a likely target symbol is already known or strongly suspected, consider optional `codebase_edit_context` as a compact pre-edit next step for bounded source plus direct callers and callees."
    : "";

  if (!status || !status.indexed || status.compatibility?.compatible === false) {
    const graphHandoff = includeGraphHandoff ? " Use graph tools after semantic discovery identifies relevant symbols." : "";
    return `For this turn, if local code discovery by behavior is needed, check \`index_status\` first and run \`index_codebase\` if the index is missing or incompatible.${graphHandoff} Then use \`codebase_context\` as the first local repository lookup. Use \`grep\` for exact identifiers or exhaustive matches.${preEditHint}`;
  }

  const graphHandoff = includeGraphHandoff
    ? " before graph tools such as `call_graph`, `call_graph_path`, `pr_impact`, or OMO CodeGraph"
    : "";
  return `For this turn, prefer \`codebase_context\` for local code discovery, then use \`codebase_peek\` for metadata and \`codebase_search\` when you need implementation content${graphHandoff}. Use \`grep\` for exact identifiers or exhaustive matches.${preEditHint}`;
}

export class RoutingHintController {
  private readonly sessionState = new Map<string, RoutingSessionState>();

  constructor(
    private readonly getStatus: () => Promise<Pick<StatusResult, "indexed" | "compatibility">>,
    private readonly maxSessions: number = 200,
    private readonly includeGraphHandoff: boolean = false,
  ) {}

  observeUserMessage(sessionID: string, parts: TextPartLike[]): RoutingAssessment {
    const assessment = assessRoutingIntent(extractUserText(parts));

    this.compactSessions();
    this.sessionState.set(sessionID, {
      assessment,
      pendingHint:
        assessment.intent === "local_conceptual"
        || assessment.intent === "local_broad_task"
        || assessment.intent === "definition_lookup",
      updatedAt: Date.now(),
    });

    return assessment;
  }

  async getSystemHints(sessionID?: string): Promise<string[]> {
    if (!sessionID) {
      return [];
    }

    const state = this.sessionState.get(sessionID);
    if (!state || !state.pendingHint) {
      return [];
    }

    const status = await this.safeGetStatus();
    const hint = buildRoutingHint(state.assessment, status, this.includeGraphHandoff);

    state.pendingHint = false;
    state.updatedAt = Date.now();
    this.sessionState.set(sessionID, state);

    return hint ? [hint] : [];
  }

  markToolUsed(sessionID: string, toolName: string): void {
    const state = this.sessionState.get(sessionID);
    if (!state || !state.pendingHint) {
      return;
    }

    if (
      toolName === "codebase_context"
      || toolName === "codebase_edit_context"
      || toolName === "codebase_peek"
      || toolName === "codebase_search"
      || toolName === "implementation_lookup"
      || toolName === "index_status"
      || toolName === "index_codebase"
    ) {
      state.pendingHint = false;
      state.updatedAt = Date.now();
      this.sessionState.set(sessionID, state);
    }
  }

  getSessionState(sessionID: string): RoutingSessionState | undefined {
    return this.sessionState.get(sessionID);
  }

  private async safeGetStatus(): Promise<Pick<StatusResult, "indexed" | "compatibility"> | null> {
    try {
      return await this.getStatus();
    } catch {
      return null;
    }
  }

  private compactSessions(): void {
    if (this.sessionState.size < this.maxSessions) {
      return;
    }

    const oldestSession = [...this.sessionState.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .at(0);

    if (oldestSession) {
      this.sessionState.delete(oldestSession[0]);
    }
  }
}
