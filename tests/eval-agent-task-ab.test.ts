import { describe, expect, it, vi } from "vitest";

import {
  compareAgentTaskTrials,
  createBalancedAssignments,
  fingerprintAgentTaskDataset,
  parseAgentTaskDataset,
  runAgentTaskEvaluation,
  type AgentTaskDataset,
  type AgentTaskTrialResult,
} from "../src/eval/agent-task-ab.js";

function dataset(taskCount = 4): AgentTaskDataset {
  return parseAgentTaskDataset({
    version: "1.0.0",
    name: "fresh-cross-repo-agent-tasks",
    preregistration: {
      id: "prereg-001",
      createdAt: "2026-09-23T15:00:00Z",
      primaryMetric: "task-success",
      analysis: "paired-exact-sign-test",
    },
    repositories: [
      { id: "client", url: "https://example.test/client.git", revision: "a".repeat(40) },
      { id: "server", url: "https://example.test/server.git", revision: "b".repeat(40) },
    ],
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index + 1}`,
      repositoryIds: ["client", "server"],
      prompt: `Implement cross-repository change ${index + 1}`,
      verifier: { command: "verify", args: [`task-${index + 1}`] },
    })),
  });
}

function trial(base: AgentTaskDataset, taskId: string, variantId: "no-ocbi" | "ocbi", success: boolean): AgentTaskTrialResult {
  return {
    datasetFingerprint: fingerprintAgentTaskDataset(base),
    taskId,
    repositoryIds: ["client", "server"],
    variantId,
    order: variantId === "no-ocbi" ? 0 : 1,
    trialId: `${taskId}:${variantId}`,
    controls: {
      agent: "same-agent",
      model: "same-model",
      maxTokens: 1000,
      maxToolCalls: 20,
      maxDurationMs: 60_000,
      maxTranscriptBytes: 16_384,
    },
    repositoryDirectories: {},
    patches: {},
    agent: { exitCode: success ? 0 : 1, durationMs: 10 },
    ...(success ? { verifier: { exitCode: 0, durationMs: 2 } } : {}),
    success,
  };
}

describe("multi-repository agent-task A/B evaluation", () => {
  it("requires pinned joint repositories and rejects outcome labels", () => {
    expect(dataset().tasks[0]?.repositoryIds).toEqual(["client", "server"]);
    expect(() => parseAgentTaskDataset({
      ...dataset(),
      tasks: [{
        id: "bad",
        repositoryIds: ["client"],
        prompt: "single repo",
        verifier: { command: "verify" },
      }],
    })).toThrow(/at least two repositories/);
    expect(() => parseAgentTaskDataset({
      ...dataset(),
      tasks: [{
        id: "bad",
        repositoryIds: ["client", "server"],
        prompt: "leaky label",
        verifier: { command: "verify" },
        expectedOutcome: "pass",
      }],
    })).toThrow(/unknown field.*expectedOutcome/);
  });

  it("creates reproducible, balanced variant order", () => {
    const first = createBalancedAssignments(dataset(), "public-seed");
    const second = createBalancedAssignments(dataset(), "public-seed");
    expect(second).toEqual(first);
    expect(first.filter((entry) => entry.order[0] === "ocbi")).toHaveLength(2);
    expect(first.filter((entry) => entry.order[0] === "no-ocbi")).toHaveLength(2);
  });

  it("runs both variants in separate prepared workspaces and preserves bounded evidence metadata", async () => {
    const prepared: string[] = [];
    const cleaned: string[] = [];
    const execute = vi.fn(async (request: { command: string; cwd: string; env: Record<string, string>; maxTranscriptBytes: number }) => ({
      exitCode: 0,
      durationMs: 5,
      stdout: `${request.command}:${request.cwd}`,
      usage: { inputTokens: 10, outputTokens: 4, toolCalls: 2 },
    }));
    const result = await runAgentTaskEvaluation({
      dataset: dataset(1),
      seed: "seed",
      controls: {
        agent: "jcode",
        model: "fixed-model",
        maxTokens: 1000,
        maxToolCalls: 25,
        maxDurationMs: 30_000,
        maxTranscriptBytes: 8192,
      },
      variants: [
        { id: "no-ocbi", command: "agent", env: { OCBI_ENABLED: "0" } },
        { id: "ocbi", command: "agent", env: { OCBI_ENABLED: "1" } },
      ],
      preparation: {
        async prepare(input) {
          const cwd = `/isolated/${input.trialId}`;
          prepared.push(cwd);
          return {
            cwd,
            repositoryDirectories: { client: `${cwd}/client`, server: `${cwd}/server` },
            async collectArtifacts() { return { client: "diff --git a/x b/x" }; },
            async cleanup() { cleaned.push(cwd); },
          };
        },
      },
      execution: { execute },
    });

    expect(result).toHaveLength(2);
    expect(new Set(prepared).size).toBe(2);
    expect(cleaned).toEqual(prepared);
    expect(result.every((entry) => entry.repositoryIds.length === 2)).toBe(true);
    expect(result.every((entry) => entry.agent.usage?.toolCalls === 2)).toBe(true);
    expect(result.every((entry) => entry.patches.client?.startsWith("diff --git"))).toBe(true);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("compares complete paired trials and rejects missing or duplicate arms", () => {
    const base = dataset(4);
    const trials = [
      trial(base, "task-1", "no-ocbi", true), trial(base, "task-1", "ocbi", true),
      trial(base, "task-2", "no-ocbi", false), trial(base, "task-2", "ocbi", false),
      trial(base, "task-3", "no-ocbi", true), trial(base, "task-3", "ocbi", false),
      trial(base, "task-4", "no-ocbi", false), trial(base, "task-4", "ocbi", true),
    ];
    expect(compareAgentTaskTrials(base, trials)).toMatchObject({
      exploratory: true,
      successes: { "no-ocbi": 2, ocbi: 2 },
      bothSucceeded: 1,
      bothFailed: 1,
      noOcbiOnly: 1,
      ocbiOnly: 1,
      discordantPairs: 2,
      successRateDifference: 0,
      exactTwoSidedSignTestPValue: 1,
    });
    expect(() => compareAgentTaskTrials(base, trials.slice(1))).toThrow(/exactly one no-ocbi trial/);
    expect(() => compareAgentTaskTrials(base, [...trials, trials[0]!])).toThrow(/Duplicate no-ocbi trial/);

    const mismatchedControls = structuredClone(trials);
    mismatchedControls[1]!.controls.maxTokens += 1;
    expect(() => compareAgentTaskTrials(base, mismatchedControls)).toThrow(/mismatched run controls/);

    const malformedSuccess = structuredClone(trials);
    malformedSuccess[0]!.success = false;
    expect(() => compareAgentTaskTrials(base, malformedSuccess)).toThrow(/inconsistent success flag/);

    const wrongRepositories = structuredClone(trials);
    wrongRepositories[0]!.repositoryIds = ["client"];
    expect(() => compareAgentTaskTrials(base, wrongRepositories)).toThrow(/mismatched repository IDs/);
  });
});
