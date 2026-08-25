import { describe, expect, it } from "vitest";

import { extractIntentIdentifierHints } from "../src/indexer/intent-aware-ranking.js";

describe("intent identifier hints", () => {
  it("does not treat unquoted PascalCase product branding as an identifier in conceptual prose", () => {
    expect(extractIntentIdentifierHints(
      "How does AgentLens authenticate and refresh Microsoft Graph tokens?",
    )).not.toContain("agentlens");
  });

  it("preserves explicit and code-shaped identifier cues", () => {
    expect(extractIntentIdentifierHints("How does updateAgentLensToken work?"))
      .toContain("updateagentlenstoken");
    expect(extractIntentIdentifierHints("Where is PaymentValidator implemented?"))
      .toContain("paymentvalidator");
    expect(extractIntentIdentifierHints("Explain `AgentLens`"))
      .toContain("agentlens");
  });
});
