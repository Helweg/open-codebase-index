import { describe, expect, it } from "vitest";

import { RoutingHintController } from "../src/routing-hints.js";

describe("RoutingHintController concurrency", () => {
  it("returns the same pending hint across concurrent title and main transforms", async () => {
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

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]).toContain("prefer `codebase_context`");

    const third = await controller.getSystemHints("s1");
    expect(third).toEqual(first);
  });
});
