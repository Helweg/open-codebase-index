import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/config/schema.js";
import { collectFiles } from "../src/utils/files.js";

const JAVA_FILES = [
  "gson/src/main/java/com/google/gson/Gson.java",
  "gson/src/main/java/com/google/gson/internal/bind/ReflectiveTypeAdapterFactory.java",
];

describe("default deep source discovery", () => {
  let tempDir: string;
  let project: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-discovery-"));
    project = path.join(tempDir, "project");
    fs.mkdirSync(project);
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function write(relative: string): void {
    const file = path.join(project, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "class Example {}\n");
  }

  it.each(["fallback", "configured"] as const)("includes nested Java packages with %s defaults", async (mode) => {
    JAVA_FILES.forEach(write);
    const config = parseConfig(undefined);
    const result = await collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize,
      undefined, mode === "configured" ? config.indexing : undefined);
    expect(result.files.map(file => path.relative(project, file.path).split(path.sep).join("/")).sort())
      .toEqual([...JAVA_FILES].sort());
  });

  it.each([0, 5])("keeps an explicit depth limit of %s", async (maxDepth) => {
    write("Root.java");
    JAVA_FILES.forEach(write);
    const config = parseConfig({ indexing: { maxDepth } });
    const result = await collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize,
      undefined, config.indexing);
    expect(result.files.map(file => path.relative(project, file.path))).toEqual(["Root.java"]);
  });

  it("preserves ignored, hidden, build and explicitly excluded paths at deep levels", async () => {
    write(JAVA_FILES[0]);
    const parent = "a/b/c/d/e/f/g";
    for (const directory of [".hidden", "node_modules", "build", "ignored", "private"]) {
      write(`${parent}/${directory}/Secret.java`);
    }
    fs.writeFileSync(path.join(project, ".gitignore"), "**/ignored/\n");
    const config = parseConfig({ exclude: ["**/private/**"] });
    const result = await collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize);
    expect(result.files.map(file => path.relative(project, file.path).split(path.sep).join("/")))
      .toEqual([JAVA_FILES[0]]);
  });

  it.skipIf(process.platform === "win32")("does not follow deep directory or file symlinks", async () => {
    write(JAVA_FILES[0]);
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "Secret.java"), "class Secret {}\n");
    const parent = path.dirname(path.join(project, JAVA_FILES[0]));
    fs.symlinkSync(outside, path.join(parent, "linked"), "dir");
    fs.symlinkSync(path.join(outside, "Secret.java"), path.join(parent, "Link.java"), "file");
    const config = parseConfig(undefined);
    const result = await collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize);
    expect(result.files.map(file => file.path)).toEqual([path.join(project, JAVA_FILES[0])]);
  });

  it("retains the default per-directory file cap at deep levels", async () => {
    for (let index = 0; index < 105; index += 1) write(`a/b/c/d/e/f/g/File${index}.java`);
    const config = parseConfig(undefined);
    const result = await collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize);
    expect(result.files).toHaveLength(100);
    expect(result.skipped.filter(file => file.reason === "excluded")).toHaveLength(5);
  });

  it("applies unlimited default discovery to an explicit additional root", async () => {
    const knowledgeRoot = path.join(tempDir, "knowledge");
    const file = path.join(knowledgeRoot, JAVA_FILES[1]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "class Example {}\n");
    const config = parseConfig(undefined);
    const result = await collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize,
      [knowledgeRoot]);
    expect(result.files.map(entry => entry.path)).toEqual([file]);
  });

  it("still stops discovery when cancelled", async () => {
    JAVA_FILES.forEach(write);
    const config = parseConfig(undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(collectFiles(project, config.include, config.exclude, config.indexing.maxFileSize,
      undefined, { ...config.indexing, signal: controller.signal })).rejects.toThrow();
  });
});
