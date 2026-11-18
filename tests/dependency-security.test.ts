import type * as Cookies from "effect/unstable/http/Cookies";
import type * as Toml from "toml";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Runtime resolution prevents a static import from hiding a vulnerable nested SDK copy.
const pluginRequire = createRequire(import.meta.resolve("@opencode-ai/plugin"));
const effectRequire = createRequire(pluginRequire.resolve("effect/package.json"));
const cookies: typeof Cookies = await import(
  pathToFileURL(pluginRequire.resolve("effect/unstable/http/Cookies")).href
);
const toml = effectRequire("toml") as typeof Toml;

describe("OpenCode build dependency security", () => {
  it.each([
    { name: "session; SameSite=None", options: undefined },
    { name: "session", options: { domain: "legit.com; Domain=.parent.tld" } },
    { name: "session", options: { path: "/; SameSite=None" } },
  ])("rejects cookie attribute injection in $name with $options", ({ name, options }) => {
    expect(cookies.makeCookie(name, "token", options)._tag).toBe("Failure");
    expect(() => cookies.makeCookieUnsafe(name, "token", options)).toThrow();
  });

  it("encodes cookie values and revalidates attributes during serialization", () => {
    const cookie = cookies.makeCookieUnsafe("session", "token; SameSite=None", {
      domain: "example.com",
      path: "/",
    });
    expect(cookies.serializeCookie(cookie)).toBe(
      "session=token%3B%20SameSite%3DNone; Domain=example.com; Path=/",
    );
    expect(() => cookies.serializeCookie({
      ...cookie,
      options: { domain: "legit.com; Domain=.parent.tld" },
    })).toThrow();
  });

  it("preserves TOML config values across the patched parser's major upgrade", () => {
    const config = toml.parse('title = "example"\n[server]\nport = 3000\nsecure = true\n');
    expect(config.title).toBe("example");
    expect(config.server.port).toBe(3000);
    expect(config.server.secure).toBe(true);
    expect(() => toml.parse("id = 771752188537605140")).toThrow();
    expect(toml.parse("id = 771752188537605140", { bigint: true }).id).toBe(771752188537605140n);
  });

  it("rejects TOML quote-path collisions without polluting Object.prototype", () => {
    const marker = "ocbiSecurityPollution";
    const payload = [
      '"b.c" = 1979-05-27T07:32:00Z',
      '[[\'"b\']]',
      '["b.c"]',
      `__proto__.__proto__.${marker} = "yes"`,
    ].join("\n");
    expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
    try {
      expect(() => toml.parse(payload)).toThrow();
      expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, marker);
    }
  });
});
