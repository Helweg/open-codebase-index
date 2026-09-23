import { describe, expect, it } from "vitest";
import { auditAgentTaskArms, type AgentTaskArmDescriptor } from "../src/eval/agent-task-arm-audit.js";

function arms(): { control: AgentTaskArmDescriptor; treatment: AgentTaskArmDescriptor } {
  const sharedAgent = { argv: ["agent-cli", "--profile", "eval", "--model", "model-x"], model: "model-x" };
  const sharedServer = { name: "other-tool", argv: ["other-mcp", "--stdio"] };
  return {
    control: { agent: sharedAgent, mcpServers: [sharedServer] },
    treatment: {
      agent: sharedAgent,
      mcpServers: [sharedServer, { name: "codebase-index", argv: ["ocbi-mcp", "--host", "jcode"] }],
    },
  };
}

describe("auditAgentTaskArms", () => {
  it("accepts same agent and common MCP settings with exactly one treatment OCBI entry", () => {
    const { control, treatment } = arms();
    const result = auditAgentTaskArms(control, treatment);
    expect(result.equivalentExceptOcbi).toBe(true);
    expect(result.mismatchCategories).toEqual([]);
    expect(result.structuralDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns stable structural digest when MCP input order differs", () => {
    const { control, treatment } = arms();
    const changedOrder = { ...treatment, mcpServers: [...treatment.mcpServers].reverse() };
    expect(auditAgentTaskArms(control, treatment).structuralDigest)
      .toBe(auditAgentTaskArms(control, changedOrder).structuralDigest);
  });

  it("does not fingerprint caller-provided strings in the structural digest", () => {
    const { control, treatment } = arms();
    const alteredAgent = { argv: ["different-agent", "--profile", "other", "--model", "other-model"], model: "other-model" };
    const alteredControl = { ...control, agent: alteredAgent };
    const alteredTreatment = { ...treatment, agent: alteredAgent };
    expect(auditAgentTaskArms(control, treatment).structuralDigest)
      .toBe(auditAgentTaskArms(alteredControl, alteredTreatment).structuralDigest);
  });

  it("reports agent, common-server, and OCBI-placement mismatches", () => {
    const { control, treatment } = arms();
    const invalidPlacement = {
      ...treatment,
      agent: { ...treatment.agent, model: "model-y" },
      mcpServers: [{ name: "other-tool", argv: ["different-mcp"] }],
    };
    const result = auditAgentTaskArms(control, invalidPlacement);
    expect(result.equivalentExceptOcbi).toBe(false);
    expect(result.mismatchCategories).toEqual([
      "agent_settings_mismatch",
      "mcp_settings_mismatch",
      "ocbi_entry_misplaced",
    ]);
  });

  it("reports an OCBI entry in control and duplicate treatment entries", () => {
    const { control, treatment } = arms();
    const result = auditAgentTaskArms(
      { ...control, mcpServers: [...control.mcpServers, { name: "codebase-index", argv: ["ocbi-mcp"] }] },
      { ...treatment, mcpServers: [...treatment.mcpServers, { name: "codebase-index", argv: ["ocbi-mcp"] }] },
    );
    expect(result.mismatchCategories).toContain("ocbi_entry_misplaced");
    expect(result.mismatchCategories).toContain("ocbi_entry_ambiguous");
  });

  it("fails closed on unknown fields and suspicious secret-like arguments without digesting them", () => {
    const { control, treatment } = arms();
    const unknown = { ...control, env: { API_KEY: "must-not-be-read" } };
    const invalid = auditAgentTaskArms(unknown, treatment);
    expect(invalid.mismatchCategories).toContain("invalid_descriptor");
    expect(invalid.structuralDigest).toBeUndefined();

    const unsafe = auditAgentTaskArms(
      { ...control, agent: { ...control.agent, argv: [...control.agent.argv, "--api-key=do-not-log"] } },
      treatment,
    );
    expect(unsafe.mismatchCategories).toContain("unsafe_value");
    expect(unsafe.mismatchCategories).toContain("invalid_descriptor");
    expect(unsafe.structuralDigest).toBeUndefined();
    expect(JSON.stringify(unsafe)).not.toContain("do-not-log");
  });

  it("rejects malformed descriptors and unsafe OCBI names", () => {
    const { control, treatment } = arms();
    expect(auditAgentTaskArms({ agent: {}, mcpServers: [] }, treatment).mismatchCategories)
      .toContain("invalid_descriptor");
    expect(auditAgentTaskArms(control, treatment, "codebase-index\nsecret").mismatchCategories)
      .toContain("unsafe_value");
  });
});
