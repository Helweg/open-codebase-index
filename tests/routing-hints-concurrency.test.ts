import { describe, expect, it } from "vitest";

import { RoutingHintController } from "../src/routing-hints.js";

describe("RoutingHintController concurrency", () => {
  it("claims pending hints atomically across concurrent getSystemHints calls", async () => {
    const controller = new RoutingHintController(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              indexed: true,
              compatibility: { compatible: true },
            });
          }, 10);
        }),
      200,
      true,
    );

    controller.observeUserMessage("s1", [
      { type: "text", text: "Where is the auth flow implemented?" },
    ]);

    const [first, second] = await Promise.all([
      controller.getSystemHints("s1"),
      controller.getSystemHints("s1"),
    ]);

    const totalHints = first.length + second.length;
    expect(totalHints).toBe(1);

    const nonEmpties = [first, second].filter((hints) => hints.length > 0);
    expect(nonEmpties).toHaveLength(1);
    expect(nonEmpties[0][0]).toContain("prefer `codebase_context`");

    const third = await controller.getSystemHints("s1");
    expect(third).toEqual([]);
  });
});
