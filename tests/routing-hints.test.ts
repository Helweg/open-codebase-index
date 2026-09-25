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
      "Trace the authorization path for a recipient of a password-protected share. Do not edit files or run services.",
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
      ["Prepare the PR for release", "other"],
      ["trace the courier shipment", "other"],
      ["Update CHANGELOG.md for the release", "other"],
      ["Read src/index.ts", "direct_path"],
    ])("classifies %s as %s", (query, intent) => {
      expect(assessRoutingIntent(query).intent).toBe(intent);
    });

    it("does not mistake protected code paths for PR chores", () => {
      const assessment = assessRoutingIntent("In the pinned pingvin-share checkout, trace the authorization path for a recipient who knows the password of an existing password-protected, unexpired share and wants to download an individual file. Explain the token endpoint and its checks, how the token reaches later requests, which guards protect share detail and file download endpoints, and how the file guard behaves differently when the cookie is absent versus present. Identify where expiration, maximum views, and the view increment are enforced. Cite relevant source paths and line ranges. Do not edit files, run services, or assume behavior not supported by this revision.");
      expect(assessment.intent).toBe("local_conceptual");
      expect(buildRoutingHint(assessment, { indexed: true, compatibility: { compatible: true } })).toContain("codebase_context");
    });

    it("routes a broad source investigation mentioning paths to discovery", () => {
      const assessment = assessRoutingIntent("Investigate why the search integration fails across src/search.ts and src/provider.ts, then cite the cause.");
      expect(assessment.intent).toBe("local_broad_task");
      expect(assessRoutingIntent("Read src/search.ts").intent).toBe("direct_path");
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

    it.each([
      "Explain how source code in two repositories integrates an npm package and cite relevant files.",
      "Compare the build path in repo-a/src/build.ts with the package implementation in repo-b/src/index.ts and cite source.",
      "Describe the framework hydration flow using source files in the repository, including tests.",
    ])("treats source-grounded explanations as local discovery despite package and path terms: %s", (query) => {
      const assessment = assessRoutingIntent(query);
      expect(assessment.intent).toBe("local_conceptual");
      expect(buildRoutingHint(assessment, { indexed: true, compatibility: { compatible: true } })).toContain("codebase_context");
    });

    it.each([
      "Search the npm registry for the latest package version",
      "Browse the GitHub repository for an external example",
      "Read the official documentation for the web API",
    ])("retains genuinely external lookup routing: %s", (query) => {
      expect(assessRoutingIntent(query).intent).toBe("external");
    });
  });

  describe("buildRoutingHint", () => {
    it("returns a semantic routing hint when the index is ready", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("Where is the webhook validation logic?"),
        { indexed: true, compatibility: { compatible: true } },
        true,
      );

      expect(hint).toContain("one bounded `codebase_context` query before exploratory shell");
      expect(hint).toContain("Verify each cited path and claim with Read");
      expect(hint).toContain("If the exact path or identifier is already known, use Read or `grep` directly instead");
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

      expect(hint).toContain("one bounded `codebase_context` query before exploratory shell");
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
      expect(hint).toContain("one bounded `codebase_context` query before exploratory shell");
    });

    it("does not add codebase_edit_context guidance for conceptual discovery even with identifier cues", () => {
      const hint = buildRoutingHint(
        assessRoutingIntent("How is validateToken validated in this flow?"),
        { indexed: true, compatibility: { compatible: true } },
      );

      expect(hint).toContain("one bounded `codebase_context` query before exploratory shell");
      expect(hint).not.toContain("consider optional `codebase_edit_context`");
      expect(hint).toContain("Verify each cited path and claim with Read");
      expect(hint).toContain("qualify runtime outcomes the source leaves conditional");
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

      expect(hint).toContain("one bounded `codebase_context` query before exploratory shell");
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
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    }

    it("queues a context hint for a protected-share authorization trace", async () => {
      const controller = new RoutingHintController(async () => ({ indexed: true, compatibility: { compatible: true } }));
      controller.observeUserMessage("share-trace", [{ type: "text", text: "Trace the authorization path for a password-protected share. Do not edit files." }]);
      expect((await controller.getSystemHints("share-trace"))[0]).toContain("one bounded `codebase_context` query before exploratory shell");
    });

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
      expect(hints[0]).toContain("one bounded `codebase_context` query before exploratory shell");
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
      expect(hints[0]).toContain("one bounded `codebase_context` query before exploratory shell");
      expect(hints[0]).toContain("`codebase_search`");
    });

    it("retains a hint across title and main transforms until a relevant tool is used", async () => {
      const controller = new RoutingHintController(async () => ({
        indexed: true,
        compatibility: { compatible: true },
      }));

      controller.observeUserMessage("session-once", [{ type: "text", text: "Investigate why startup hangs" }]);

      const titleHints = await controller.getSystemHints("session-once");
      const mainHints = await controller.getSystemHints("session-once");
      expect(titleHints).toHaveLength(1);
      expect(mainHints).toEqual(titleHints);
      expect(controller.getSessionState("session-once")?.pendingHint).toBe(true);

      controller.markToolUsed("session-once", "codebase_context");
      expect(await controller.getSystemHints("session-once")).toEqual([]);

      controller.observeUserMessage("session-once", [{ type: "text", text: "Fix the bug in startup recovery" }]);
      expect(await controller.getSystemHints("session-once")).toHaveLength(1);
    });

    it("replaces a pending hint when the next user message has no discovery intent", async () => {
      const controller = new RoutingHintController(async () => ({ indexed: true, compatibility: { compatible: true } }));
      controller.observeUserMessage("session-next", [{ type: "text", text: "Trace the authorization path for a protected share" }]);
      expect(await controller.getSystemHints("session-next")).toHaveLength(1);

      controller.observeUserMessage("session-next", [{ type: "text", text: "Run the tests" }]);
      expect(await controller.getSystemHints("session-next")).toEqual([]);
    });

    it("does not return a stale hint after the next user message arrives during status lookup", async () => {
      const status = deferred<{ indexed: boolean; compatibility: { compatible: boolean } }>();
      const controller = new RoutingHintController(() => status.promise);
      controller.observeUserMessage("session-next-deferred", [{ type: "text", text: "Trace the authorization path for a protected share" }]);

      const pendingHints = controller.getSystemHints("session-next-deferred");
      controller.observeUserMessage("session-next-deferred", [{ type: "text", text: "Run the tests" }]);
      status.resolve({ indexed: true, compatibility: { compatible: true } });

      expect(await pendingHints).toEqual([]);
    });

    it("does not return a stale hint after a relevant tool call during status lookup", async () => {
      const status = deferred<{ indexed: boolean; compatibility: { compatible: boolean } }>();
      const controller = new RoutingHintController(() => status.promise);
      controller.observeUserMessage("session-tool-deferred", [{ type: "text", text: "Investigate why startup hangs" }]);

      const pendingHints = controller.getSystemHints("session-tool-deferred");
      controller.markToolUsed("session-tool-deferred", "codebase_context");
      status.resolve({ indexed: true, compatibility: { compatible: true } });

      expect(await pendingHints).toEqual([]);
    });

    it("keeps concurrent title and main transforms consistent", async () => {
      const controller = new RoutingHintController(async () => ({ indexed: true, compatibility: { compatible: true } }));
      controller.observeUserMessage("session-concurrent", [{ type: "text", text: "Investigate why startup hangs" }]);

      const hints = await Promise.all([
        controller.getSystemHints("session-concurrent"),
        controller.getSystemHints("session-concurrent"),
      ]);

      expect(hints[0]).toHaveLength(1);
      expect(hints[1]).toEqual(hints[0]);
      expect(controller.getSessionState("session-concurrent")?.pendingHint).toBe(true);
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
