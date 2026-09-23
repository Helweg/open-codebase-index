import { createHash } from "node:crypto";

/** Explicit, caller-reviewed description of the agent and MCP registrations for one arm. */
export interface AgentTaskArmDescriptor {
  agent: {
    argv: string[];
    model: string;
  };
  mcpServers: Array<{
    name: string;
    argv: string[];
  }>;
}

export type AgentTaskArmMismatchCategory =
  | "invalid_descriptor"
  | "unsafe_value"
  | "agent_settings_mismatch"
  | "mcp_settings_mismatch"
  | "ocbi_entry_misplaced"
  | "ocbi_entry_ambiguous";

export interface AgentTaskArmAuditResult {
  /** Static descriptor check only. This does not establish runtime equivalence. */
  equivalentExceptOcbi: boolean;
  mismatchCategories: AgentTaskArmMismatchCategory[];
  /** Shape/outcome digest only. It contains no argv, model, or server-name values. */
  structuralDigest?: string;
}

const SECRET_OPTION = /(?:^|[-_])(api[-_]?key|token|auth(?:orization)?|password|passwd|secret|credential|private[-_]?key)(?:$|[-_])/i;
const SECRET_ASSIGNMENT = /(?:^|\s)(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*|(?:api[-_]?key|access[-_]?token|password|secret))\s*=/i;
const TOKEN_SHAPES = /(?:\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bBearer\s+\S+)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function safeString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !hasControlCharacters(value)
    && !SECRET_ASSIGNMENT.test(value)
    && !TOKEN_SHAPES.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(value);
}

function validateDescriptor(value: unknown): { valid: boolean; unsafe: boolean; normalized?: AgentTaskArmDescriptor } {
  if (!isRecord(value) || !hasExactKeys(value, ["agent", "mcpServers"])) return { valid: false, unsafe: false };
  const agent = value.agent;
  const servers = value.mcpServers;
  if (!isRecord(agent) || !hasExactKeys(agent, ["argv", "model"]) || !Array.isArray(servers)) {
    return { valid: false, unsafe: false };
  }
  const argv = agent.argv;
  const model = agent.model;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((entry) => typeof entry === "string")) {
    return { valid: false, unsafe: false };
  }
  if (!safeString(model)) return { valid: false, unsafe: typeof model === "string" };
  let unsafe = false;
  for (const item of argv) {
    if (!safeString(item)) unsafe = true;
    if (item.startsWith("-") && SECRET_OPTION.test(item.split("=", 1)[0]!)) unsafe = true;
  }
  const normalizedServers: Array<{ name: string; argv: string[] }> = [];
  for (const server of servers) {
    if (!isRecord(server) || !hasExactKeys(server, ["name", "argv"]) || !Array.isArray(server.argv)
      || server.argv.length === 0 || !server.argv.every((entry) => typeof entry === "string")) {
      return { valid: false, unsafe };
    }
    if (!safeString(server.name)) {
      unsafe ||= typeof server.name === "string";
      continue;
    }
    for (const item of server.argv) {
      if (!safeString(item)) unsafe = true;
      if (item.startsWith("-") && SECRET_OPTION.test(item.split("=", 1)[0]!)) unsafe = true;
    }
    normalizedServers.push({ name: server.name, argv: [...server.argv] as string[] });
  }
  if (unsafe) return { valid: false, unsafe: true };
  normalizedServers.sort((left, right) => left.name.localeCompare(right.name));
  return {
    valid: true,
    unsafe: false,
    normalized: { agent: { argv: [...argv] as string[], model }, mcpServers: normalizedServers },
  };
}

/**
 * Checks explicitly supplied, non-secret descriptors for static arm parity.
 * Exactly one server whose name matches `ocbiServerName` must exist in treatment
 * and none in control. This does not parse config files or prove runtime behavior.
 */
export function auditAgentTaskArms(
  control: unknown,
  treatment: unknown,
  ocbiServerName = "codebase-index",
): AgentTaskArmAuditResult {
  const mismatches = new Set<AgentTaskArmMismatchCategory>();
  const controlResult = validateDescriptor(control);
  const treatmentResult = validateDescriptor(treatment);
  if (controlResult.unsafe || treatmentResult.unsafe) mismatches.add("unsafe_value");
  if (!controlResult.valid || !treatmentResult.valid) mismatches.add("invalid_descriptor");
  if (!safeString(ocbiServerName)) {
    mismatches.add("unsafe_value");
    mismatches.add("invalid_descriptor");
  }
  const validControl = controlResult.normalized;
  const validTreatment = treatmentResult.normalized;
  if (!validControl || !validTreatment || !safeString(ocbiServerName)) {
    return { equivalentExceptOcbi: false, mismatchCategories: [...mismatches].sort() };
  }

  const controlOcbi = validControl.mcpServers.filter((server) => server.name === ocbiServerName);
  const treatmentOcbi = validTreatment.mcpServers.filter((server) => server.name === ocbiServerName);
  if (controlOcbi.length > 0 || treatmentOcbi.length !== 1) mismatches.add("ocbi_entry_misplaced");
  if (controlOcbi.length > 1 || treatmentOcbi.length > 1) mismatches.add("ocbi_entry_ambiguous");

  if (JSON.stringify(validControl.agent) !== JSON.stringify(validTreatment.agent)) {
    mismatches.add("agent_settings_mismatch");
  }
  const controlNonOcbi = validControl.mcpServers.filter((server) => server.name !== ocbiServerName);
  const treatmentNonOcbi = validTreatment.mcpServers.filter((server) => server.name !== ocbiServerName);
  if (JSON.stringify(controlNonOcbi) !== JSON.stringify(treatmentNonOcbi)) {
    mismatches.add("mcp_settings_mismatch");
  }

  const structure = {
    controlAgentArgCount: validControl.agent.argv.length,
    treatmentAgentArgCount: validTreatment.agent.argv.length,
    agentSettingsMatch: JSON.stringify(validControl.agent) === JSON.stringify(validTreatment.agent),
    controlMcpServerCount: validControl.mcpServers.length,
    treatmentMcpServerCount: validTreatment.mcpServers.length,
    controlOcbiCount: controlOcbi.length,
    treatmentOcbiCount: treatmentOcbi.length,
    commonMcpSettingsMatch: JSON.stringify(controlNonOcbi) === JSON.stringify(treatmentNonOcbi),
  };
  const structuralDigest = createHash("sha256").update(JSON.stringify(structure)).digest("hex");
  const mismatchCategories = [...mismatches].sort();
  return {
    equivalentExceptOcbi: mismatchCategories.length === 0,
    mismatchCategories,
    structuralDigest,
  };
}
