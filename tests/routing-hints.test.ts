import { describe, expect, it } from "vitest";

import {
  RoutingHintController,
  assessRoutingIntent,
  buildRoutingHint,
  extractUserText,
} from "../src/routing-hints.js";

describe("routing hints", () => {
  describe("extractUserText", () => {
    it("combines text parts and ignores non-text parts", () => {
      const text = extractUserText([
        { type: "text", text: "where is the auth flow" },
        { type: "tool", text: "ignored" },
        { type: "text", text: "implemented" },
      ]);

      expect(text).toBe("where is the auth flow implemented");
    });
  });

  describe("assessRoutingIntent", () => {
    it.each([
      "Where is authentication implemented?",
      "How does the retry queue work?",
      "Fix the bug where expired sessions remain active",
      "Add support for cancelling in-flight indexing",
      "Refactor the cache invalidation to avoid duplicate work",
      "Investigate why startup hangs on Windows",
      "Review this codebase for security issues",
      "Implement issue 158.",
    ])("emits a local-code routing hint for %s", (query) => {
      const assessment = assessRoutingIntent(query);

      expect(buildRoutingHint(assessment, { indexed: true, compatibility: { compatible: true } }, true)).toContain("codebase_context");
    });

    it.each([
      ["Fix the bug where expired sessions remain active", "local_broad_task"],
      ["Add support for cancelling in-flight indexing", "local_broad_task"],
      ["Implement issue 158.", "local_broad_task"],
      ["Fix the bug and add tests", "local_broad_task"],
    ])("classifies %s as %s", (query, intent) => {
      const assessment = assessRoutingIntent(query);

      expect(assessment.intent).toBe(intent);
    });

    it.each([
      ["Find all references to `validateToken`", "exact_identifier"],
      ["Run the tests and fix the failing build", "other"],
      ["Update CHANGELOG.md for the release", "other"],
      ["Read src/index.ts", "direct_path"],
    ])("classifies %s as %s", (query, intent) => {
      expect(assessRoutingIntent(query).intent).toBe(intent);
    });

    it("does not alternate exact-identifier detection for repeated backticked queries", () => {
      const first = assessRoutingIntent("Find all references to `validateToken`");
      const second = assessRoutingIntent("Find all references to `otherSymbol`");
      const third = assessRoutingIntent("Find all references to `validateToken`");

      expect(first.intent).toBe("exact_identifier");
      expect(second.intent).toBe("exact_identifier");
      expect(third.intent).toBe("exact_identifier");
    });

    it("detects definition lookups separately from conceptual discovery", () => {
      const assessment = assessRoutingIntent("Where is the payment handler defined?");

      expect(assessment.intent).toBe("definition_lookup");
      expect(assessment.reason).toBe("definition_lookup_request");
    });

    it("detects external lookups", () => {
      const assessment = assessRoutingIntent("Check the official docs for Next.js app router");

      expect(assessment.intent).toBe("external");
    });
  });

  describe("buildRoutingHint", () => {
    it("returns a semantic routing hint when the index is ready", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Where is the webhook validation logic?"),
        { indexed: true, compatibility: { compatible: true } },
        true,
      );

      expect(hint).toContain("prefer `codebase_context`");
      expect(hint).toContain("`codebase_peek`");
      expect(hint).toContain("`codebase_search`");
      expect(hint).toContain("`grep`");
      expect(hint).toContain("before graph tools such as `call_graph`, `call_graph_path`, `pr_impact`, or OMO CodeGraph");
    });

    it("returns a semantic routing hint for broad local task prompts", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Fix the bug where expired sessions remain active"),
        { indexed: true, compatibility: { compatible: true } },
        true,
      );

      expect(hint).toContain("prefer `codebase_context`");
      expect(hint).toContain("`codebase_search`");
      expect(hint).toContain("`grep`");
    });

    it("returns an index bootstrap hint when the index is missing", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Which file handles retry backoff logic?"),
        { indexed: false, compatibility: null },
        true,
      );

      expect(hint).toContain("check `index_status` first");
      expect(hint).toContain("run `index_codebase`");
      expect(hint).toContain("Use graph tools after semantic discovery identifies relevant symbols");
    });

    it("adds optional codebase_edit_context guidance for broad change requests with suspected symbols", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Implement validateToken to reject invalid tokens with clearer errors"),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toContain("consider optional `codebase_edit_context`");
      expect(hint).toContain("bounded source");
      expect(hint).toContain("callers and callees");
      expect(hint).toContain("prefer `codebase_context`");
    });

    it("does not add codebase_edit_context guidance for conceptual discovery even with identifier cues", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("How is validateToken validated in this flow?"),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toContain("prefer `codebase_context`");
      expect(hint).not.toContain("consider optional `codebase_edit_context`");
    });

    it("returns null for non-conceptual intents", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Find all references to validateToken"),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toBeNull();
    });

    it.each([
      "Run the tests and fix the failing build",
      "Update CHANGELOG.md for the release",
      "Find all references to `validateToken`",
      "Read src/index.ts",
    ])("returns no hint for %s", (query) => {
      const hint = buildRoutingHint(
        assessRoutingIntent(query),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toBeNull();
    });

    it("omits graph handoff wording by default", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Where is the webhook validation logic?"),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toContain("prefer `codebase_context`");
      expect(hint).not.toContain("OMO CodeGraph");
      expect(hint).not.toContain("Use graph tools after semantic discovery");
    });

    it("returns a definition-specific hint when the index is ready", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Where is the payment handler defined?"),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toContain("prefer `implementation_lookup`");
      expect(hint).toContain("`codebase_search`");
    });

    it("returns an index bootstrap hint for definition lookups when the index is missing", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Where is the payment handler defined?"),
        { indexed: false, compatibility: null },
      );

      expect(hint).toContain("check `index_status` first");
      expect(hint).toContain("`implementation_lookup`");
    });
  });

  describe("RoutingHintController", () => {
    it("stores conceptual discovery state and emits one hint", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }), 200, true);

      controller.observeUserMessage("session-1", [{ type: "text", text: "Where is the auth flow implemented?" }]);

      const state = controller.getSessionState("session-1");
      expect(state?.assessment.intent).toBe("local_conceptual");
      expect(state?.pendingHint).toBe(true);

      const hints = await controller.getSystemHints("session-1");
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("prefer `codebase_context`");
      expect(hints[0]).toContain("OMO CodeGraph");
    });

    it("stores broad local task state and emits codebase_context-first hint", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }), 200, true);

      controller.observeUserMessage("session-1b", [{ type: "text", text: "Fix the bug where expired sessions remain active" }]);

      const hints = await controller.getSystemHints("session-1b");
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("prefer `codebase_context`");
      expect(hints[0]).toContain("`codebase_search`");
    });

    it("emits at most one hint for each user message", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }));

      controller.observeUserMessage("session-once", [{ type: "text", text: "Investigate why startup hangs" }]);

      expect(await controller.getSystemHints("session-once")).toHaveLength(1);
      expect(await controller.getSystemHints("session-once")).toEqual([]);

      controller.observeUserMessage("session-once", [{ type: "text", text: "Fix the bug in startup recovery" }]);
      expect(await controller.getSystemHints("session-once")).toHaveLength(1);
    });

    it("stops nudging after a codebase tool is used", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }));

      controller.observeUserMessage("session-2", [{ type: "text", text: "Find the code that validates webhook signatures" }]);
      controller.markToolUsed("session-2", "codebase_peek");

      const state = controller.getSessionState("session-2");
      expect(state?.pendingHint).toBe(false);

      const hints = await controller.getSystemHints("session-2");
      expect(hints).toEqual([]);
    });

    it("does not create hints for exact identifier lookups", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }));

      controller.observeUserMessage("session-3", [{ type: "text", text: "Find all references to `validateToken`" }]);

      const hints = await controller.getSystemHints("session-3");
      expect(hints).toEqual([]);
    });

    it("stops nudging after codebase_context is used", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }), 200, true);

      controller.observeUserMessage("session-3b", [{ type: "text", text: "Review this codebase for security issues" }]);
      controller.markToolUsed("session-3b", "codebase_context");

      const hints = await controller.getSystemHints("session-3b");
      expect(hints).toEqual([]);
    });

    it("stops nudging after implementation_lookup is used for definition requests", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }));

      controller.observeUserMessage("session-4", [{ type: "text", text: "Where is the payment handler defined?" }]);
      controller.markToolUsed("session-4", "implementation_lookup");

      const state = controller.getSessionState("session-4");
      expect(state?.pendingHint).toBe(false);

      const hints = await controller.getSystemHints("session-4");
      expect(hints).toEqual([]);
    });

    it("falls back safely when index status lookup fails", async () => {
      const controller = new RoutingHintController(async () => {
        throw new Error("status unavailable");
      });

      controller.observeUserMessage("session-5", [{ type: "text", text: "Where is the retry policy logic?" }]);

      const hints = await controller.getSystemHints("session-5");
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("check `index_status` first");
    });
  });
});
