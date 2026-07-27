import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackgroundIndexingPolicy,
  parseMacOsPowerSource,
  readMacOsPowerSource,
} from "../src/utils/power-source.js";

describe("macOS power source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses AC and battery power from pmset output", () => {
    expect(parseMacOsPowerSource("Now drawing from 'AC Power'\n")).toBe("ac");
    expect(parseMacOsPowerSource("Now drawing from 'Battery Power'\n")).toBe("battery");
    expect(parseMacOsPowerSource("No power source available\n")).toBe("unknown");
  });

  it("runs pmset with a five-second timeout", async () => {
    const runCommand = vi.fn().mockResolvedValue("Now drawing from 'Battery Power'\n");

    await expect(readMacOsPowerSource(runCommand)).resolves.toBe("battery");
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/pmset",
      ["-g", "batt"],
      { timeoutMs: 5_000 },
    );
  });

  it("does not create a policy when disabled or outside macOS", () => {
    const readPowerSource = vi.fn().mockResolvedValue("battery");

    expect(createBackgroundIndexingPolicy(false, {
      platform: "darwin",
      readPowerSource,
    })).toBeNull();
    expect(createBackgroundIndexingPolicy(true, {
      platform: "linux",
      readPowerSource,
    })).toBeNull();
    expect(readPowerSource).not.toHaveBeenCalled();
  });

  it("pauses on battery and resumes on AC power", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readPowerSource = vi.fn()
      .mockResolvedValueOnce("battery")
      .mockResolvedValueOnce("ac");
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "darwin",
      readPowerSource,
      recheckDelayMs: 10,
    });

    await expect(policy?.isPaused()).resolves.toBe(true);
    await expect(policy?.isPaused()).resolves.toBe(false);

    expect(consoleWarn).toHaveBeenNthCalledWith(
      1,
      "[codebase-index] Background indexing paused while macOS is using battery power.",
    );
    expect(consoleWarn).toHaveBeenNthCalledWith(
      2,
      "[codebase-index] AC power detected; resuming pending background indexing.",
    );
  });

  it("logs once and allows indexing when power detection fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const readPowerSource = vi.fn().mockRejectedValue(new Error("pmset timed out"));
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "darwin",
      readPowerSource,
    });

    await expect(policy?.isPaused()).resolves.toBe(false);
    await expect(policy?.isPaused()).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[codebase-index] Failed to determine the macOS power source; background indexing will continue: pmset timed out",
    );
  });

  it("fails open for unrecognized pmset output", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "darwin",
      readPowerSource: vi.fn().mockResolvedValue("unknown"),
    });

    await expect(policy?.isPaused()).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("background indexing will continue"),
    );
  });
});
