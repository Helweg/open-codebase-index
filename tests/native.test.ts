import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseFile,
  parseFiles,
  hashContent,
  hashFile,
  VectorStore,
  createEmbeddingTexts,
  createEmbeddingText,
  createDynamicBatches,
  generateChunkId,
  estimateTokens,
  type CodeChunk,
} from "../src/native/index.js";

describe("native module", () => {
  describe("parseFile", () => {
    it("should parse TypeScript functions", () => {
      const content = `
export function validateEmail(email: string): boolean {
  return email.includes("@");
}

export async function fetchUser(id: number): Promise<User> {
  return await db.query(id);
}
`;
      const chunks = parseFile("test.ts", content);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.content.includes("validateEmail"))).toBe(true);
      expect(chunks.some((c) => c.content.includes("fetchUser"))).toBe(true);
    });

    it("should parse TypeScript classes", () => {
      const content = `
export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: number): Promise<User> {
    return this.db.find(id);
  }
}
`;
      const chunks = parseFile("service.ts", content);

      expect(chunks.some((c) => c.content.includes("class UserService"))).toBe(true);
    });

    it.each(["module.mts", "module.cts"])(
      "should classify and semantically parse %s as TypeScript",
      (filePath) => {
        const content = `
function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
`;
        const chunks = parseFile(filePath, content);

        expect(chunks.some((c) => c.chunkType === "function_declaration")).toBe(true);
        expect(chunks.every((c) => c.language === "typescript")).toBe(true);
      }
    );

    it.each(["widget.cxx", "widget.hxx"])(
      "should classify and semantically parse %s as C++",
      (filePath) => {
        const content = `
#include <string>

std::string normalize_name(const std::string& value) {
  return value;
}
`;
        const chunks = parseFile(filePath, content);

        expect(chunks.some((c) => c.chunkType === "function_definition")).toBe(true);
        expect(chunks.every((c) => c.language === "cpp")).toBe(true);
      }
    );

    it("should classify and semantically parse .cs files as C#", () => {
      const content = `
public class UserService
{
    public string NormalizeName(string value)
    {
        return value.Trim().ToLowerInvariant();
    }
}
`;
      const chunks = parseFile("UserService.cs", content);

      expect(chunks.some((c) => c.chunkType === "class_declaration")).toBe(true);
      expect(chunks.every((c) => c.language === "csharp")).toBe(true);
    });

    it("should parse JavaScript files", () => {
      const content = `
function greet(name) {
  console.log("Hello, " + name);
}

const add = (a, b) => a + b;
`;
      const chunks = parseFile("util.js", content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("should chunk plain text files", () => {
      const chunks = parseFile("data.txt", "just plain text");

      expect(chunks).toBeInstanceOf(Array);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]?.content).toContain("just plain text");
      expect(chunks[0]?.chunkType).toBe("block");
    });

    it("should chunk markdown files", () => {
      const content = "# Project KB\n\nProject knowledge base delta.";
      const chunks = parseFile("README.md", content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]?.content).toContain("Project knowledge base delta");
      expect(chunks[0]?.chunkType).toBe("block");
    });

    it("should parse PHP files", () => {
      const content = `
<?php

function greet($name) {
    return "Hello, " . $name;
}

class User {
    private $name;

    public function __construct($name) {
        $this->name = $name;
    }

    public function getName() {
        return $this->name;
    }
}

interface Logger {
    public function log($message);
}
`;
      const chunks = parseFile("test.php", content);

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks.some((c) => c.content.includes("function greet"))).toBe(true);
      expect(chunks.some((c) => c.content.includes("class User"))).toBe(true);
      expect(chunks.some((c) => c.content.includes("interface Logger"))).toBe(true);
    });

    it("should parse PHP .inc files", () => {
      const content = `
<?php

function helper($value) {
    return $value * 2;
}

trait Timestampable {
    private $createdAt;

    public function setCreatedAt($time) {
        $this->createdAt = $time;
    }
}
`;
      const chunks = parseFile("config.inc", content);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.content.includes("function helper"))).toBe(true);
      expect(chunks.some((c) => c.content.includes("trait Timestampable"))).toBe(true);
    });

    it("should parse Apex classes (.cls) with methods and constructors", () => {
      const content = `
public with sharing class AccountService {
    private static final String DEFAULT_NAME = 'Untitled';

    public AccountService() {}

    public static Account createAccount(String name) {
        Account a = new Account(Name = name);
        insert a;
        return a;
    }

    public Integer countActiveAccounts() {
        return [SELECT COUNT() FROM Account WHERE Active__c = TRUE];
    }
}
`;
      const chunks = parseFile("AccountService.cls", content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.some((c) => c.chunkType === "class_declaration")).toBe(true);
      expect(chunks.some((c) => c.content.includes("createAccount"))).toBe(true);
      expect(chunks.some((c) => c.content.includes("countActiveAccounts"))).toBe(true);
    });

    it("should parse Apex triggers (.trigger)", () => {
      const content = `
trigger AccountTrigger on Account (before insert, before update, after delete) {
    for (Account a : Trigger.new) {
        a.Description = 'Updated by trigger';
    }
}
`;
      const chunks = parseFile("AccountTrigger.trigger", content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.some((c) => c.chunkType === "trigger_declaration")).toBe(true);
      expect(chunks.some((c) => c.name === "AccountTrigger")).toBe(true);
      expect(chunks.some((c) => c.content.includes("before insert"))).toBe(true);
    });

    it("should attach Apex JavaDoc block comments to declarations", () => {
      const content = `
/**
 * Service for managing Account records.
 * Used by Aura controllers and batch jobs.
 */
public class AccountService {
    /**
     * Creates a new Account with the given name.
     */
    public static Account createAccount(String name) {
        return new Account(Name = name);
    }
}
`;
      const chunks = parseFile("AccountService.cls", content);

      const classChunk = chunks.find((c) => c.chunkType === "class_declaration");
      expect(classChunk).toBeDefined();
      expect(classChunk?.content).toContain("Service for managing Account");
    });

    it("should parse a realistic 200+ line Apex fixture without errors", () => {
      const fixturePath = path.join(
        __dirname,
        "fixtures",
        "apex",
        "AccountServiceFixture.cls",
      );
      const content = fs.readFileSync(fixturePath, "utf-8");
      const chunks = parseFile("AccountServiceFixture.cls", content);

      expect(chunks.length).toBeGreaterThan(0);

      // The outer class is very large (>2KB) and will be split into multiple
      // chunks by split_large_chunk; the chunks inherit chunk_type from the
      // parent semantic node, so we expect class_declaration chunks.
      expect(chunks.some((c) => c.chunkType === "class_declaration")).toBe(true);

      // Recognizable identifiers should appear somewhere in the output.
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("AccountServiceFixture");
      expect(allContent).toContain("createAccount");
      expect(allContent).toContain("AccountServiceException");
      expect(allContent).toContain("ProcessingStatus");

      // Language label is consistent.
      expect(chunks.every((c) => c.language === "apex")).toBe(true);
    });

    it("should parse GDScript files", () => {
      const content = `
extends Node

class_name Player

signal health_changed(new_health)

const MAX_HEALTH := 100

# Initialises the player when the scene is ready.
func _ready() -> void:
    print("ready")

func take_damage(amount: int) -> void:
    health -= amount
    health_changed.emit(health)
`;
      const chunks = parseFile("player.gd", content);

      expect(chunks.length).toBeGreaterThanOrEqual(2);

      const chunkTypes = chunks.map((c) => c.chunkType);
      expect(chunkTypes).toContain("function_definition");

      // Leading # comment should attach to the _ready chunk.
      const ready = chunks.find(
        (c) => c.chunkType === "function_definition" && c.content.includes("_ready"),
      );
      expect(ready).toBeDefined();
      expect(ready!.content).toContain("Initialises the player");

      // Language label is consistent.
      expect(chunks.every((c) => c.language === "gdscript")).toBe(true);
    });

    it("should parse Zig files", () => {
      const content = `
const std = @import("std");

/// Adds two integers.
pub fn add(a: i32, b: i32) i32 {
    return a + b;
}

const Point = struct {
    x: f32,
    y: f32,
};

test "add works" {
    try std.testing.expect(add(1, 2) == 3);
}
`;
      const chunks = parseFile("main.zig", content);

      // Should produce semantic chunks for each declaration
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      const chunkTypes = chunks.map((c) => c.chunkType);
      expect(chunkTypes).toContain("function_declaration");
      expect(chunkTypes).toContain("test_declaration");

      // Doc comment must be attached to the fn add chunk
      const addChunk = chunks.find(
        (c) => c.chunkType === "function_declaration" && c.content.includes("fn add"),
      );
      expect(addChunk).toBeDefined();
      expect(addChunk!.content).toContain("Adds two integers");
    });

    it("should parse MATLAB functions", () => {
      const content = `
% Estimate a normalized signal score.
function score = calculateSignal(prices)
    returns = diff(log(prices));
    score = mean(returns) / std(returns);
end
`;
      const chunks = parseFile("calculateSignal.m", content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.some((c) => c.chunkType === "function_definition")).toBe(true);
      expect(chunks.some((c) => c.name === "calculateSignal")).toBe(true);
      expect(chunks.every((c) => c.language === "matlab")).toBe(true);

      const functionChunk = chunks.find((c) => c.chunkType === "function_definition");
      expect(functionChunk?.content).toContain("Estimate a normalized signal score");
    });

    it("should parse MATLAB classes", () => {
      const content = `
% Trading signal model.
classdef SignalModel
    properties
        Window
    end

    methods
        function obj = SignalModel(window)
            obj.Window = window;
        end

        function value = score(obj, prices)
            value = mean(prices(end - obj.Window + 1:end));
        end
    end
end
`;
      const chunks = parseFile("SignalModel.m", content);

      const classChunk = chunks.find((c) => c.chunkType === "class_definition");
      expect(classChunk).toBeDefined();
      expect(classChunk?.name).toBe("SignalModel");
      expect(classChunk?.content).toContain("Trading signal model");
      expect(classChunk?.content).toContain("function value = score");
      expect(classChunk?.language).toBe("matlab");
    });
  });

  describe("parseFiles", () => {
    it("should parse multiple files in batch", () => {
      const files = [
        { path: "a.ts", content: "export function foo() {}" },
        { path: "b.ts", content: "export function bar() {}" },
      ];

      const results = parseFiles(files);

      expect(results.length).toBe(2);
      expect(results[0].path).toBe("a.ts");
      expect(results[1].path).toBe("b.ts");
    });
  });

  describe("hashContent", () => {
    it("should return consistent hash for same content", () => {
      const hash1 = hashContent("test content");
      const hash2 = hashContent("test content");

      expect(hash1).toBe(hash2);
    });

    it("should return different hash for different content", () => {
      const hash1 = hashContent("content A");
      const hash2 = hashContent("content B");

      expect(hash1).not.toBe(hash2);
    });

    it("should return non-empty string", () => {
      const hash = hashContent("test");

      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe("hashFile", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should hash file content", () => {
      const filePath = path.join(tempDir, "test.txt");
      fs.writeFileSync(filePath, "file content");

      const hash = hashFile(filePath);

      expect(hash.length).toBeGreaterThan(0);
    });

    it("should return same hash for identical files", () => {
      const file1 = path.join(tempDir, "a.txt");
      const file2 = path.join(tempDir, "b.txt");
      fs.writeFileSync(file1, "same content");
      fs.writeFileSync(file2, "same content");

      expect(hashFile(file1)).toBe(hashFile(file2));
    });
  });

  describe("VectorStore", () => {
    let tempDir: string;
    let store: VectorStore;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vector-test-"));
      store = new VectorStore(path.join(tempDir, "vectors"), 3);
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should add and retrieve vectors", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      expect(store.count()).toBe(1);
    });

    it("should search for similar vectors", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.add("chunk2", [0, 1, 0], {
        filePath: "test2.ts",
        startLine: 10,
        endLine: 15,
        chunkType: "function",
        language: "typescript",
        hash: "def456",
      });

      const results = store.search([1, 0.1, 0], 2);

      expect(results.length).toBe(2);
      expect(results[0].id).toBe("chunk1");
    });

    it("should remove vectors", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      store.remove("chunk1");

      expect(store.count()).toBe(0);
    });

    it("should persist and load", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.save();

      const newStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      newStore.load();

      expect(newStore.count()).toBe(1);
    });

    it("should fingerprint persisted vectors and require the fingerprint for strict loads", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.save();

      const metadataPath = path.join(tempDir, "vectors.meta.json");
      const persisted = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
        vector_fingerprint?: string;
      };
      expect(persisted.vector_fingerprint).toBeTypeOf("string");
      expect(store.hasFingerprint()).toBe(true);

      const strictStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      strictStore.loadStrict();
      expect(strictStore.count()).toBe(1);
    });

    it("should reject valid vector and metadata artifacts from different publications", () => {
      const firstPath = path.join(tempDir, "vectors-first");
      const secondPath = path.join(tempDir, "vectors-second");
      const first = new VectorStore(firstPath, 3);
      const second = new VectorStore(secondPath, 3);
      first.add("first", [1, 0, 0], {
        filePath: "first.ts",
        startLine: 1,
        endLine: 2,
        chunkType: "function",
        language: "typescript",
        hash: "first-hash",
      });
      second.add("second", [0, 1, 0], {
        filePath: "second.ts",
        startLine: 1,
        endLine: 2,
        chunkType: "function",
        language: "typescript",
        hash: "second-hash",
      });
      first.save();
      second.save();
      fs.copyFileSync(`${secondPath}.meta.json`, `${firstPath}.meta.json`);

      const mixed = new VectorStore(firstPath, 3);
      expect(() => mixed.loadStrict()).toThrow(/fingerprint.*mismatch/i);
      expect(mixed.count()).toBe(0);
      expect(() => mixed.load()).toThrow(/fingerprint.*mismatch/i);
      expect(mixed.count()).toBe(0);
    });

    it("should reject foreign metadata when vector artifacts are identical", () => {
      const firstPath = path.join(tempDir, "vectors-identical-first");
      const secondPath = path.join(tempDir, "vectors-identical-second");
      const first = new VectorStore(firstPath, 3);
      const second = new VectorStore(secondPath, 3);
      first.add("first", [1, 0, 0], {
        filePath: "first.ts",
        startLine: 1,
        endLine: 2,
        chunkType: "function",
        language: "typescript",
        hash: "first-hash",
      });
      second.add("second", [1, 0, 0], {
        filePath: "second.ts",
        startLine: 1,
        endLine: 2,
        chunkType: "function",
        language: "typescript",
        hash: "second-hash",
      });
      first.save();
      second.save();
      fs.copyFileSync(`${secondPath}.meta.json`, `${firstPath}.meta.json`);

      const mixed = new VectorStore(firstPath, 3);
      expect(() => mixed.loadStrict()).toThrow(/fingerprint.*mismatch/i);
      expect(mixed.count()).toBe(0);
    });

    it("should allow structurally valid legacy loads only in writer mode", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.save();

      const metadataPath = path.join(tempDir, "vectors.meta.json");
      const legacyMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
      delete legacyMetadata.vector_fingerprint;
      fs.writeFileSync(metadataPath, JSON.stringify(legacyMetadata));

      const writerStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      writerStore.load();
      expect(writerStore.count()).toBe(1);
      expect(writerStore.hasFingerprint()).toBe(false);

      const readerStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      expect(() => readerStore.loadStrict()).toThrow(/missing.*fingerprint/i);
    });

    it("should reject structurally inconsistent vector metadata", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.save();

      const metadataPath = path.join(tempDir, "vectors.meta.json");
      const inconsistent = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
        key_to_id: Record<string, number>;
        vector_fingerprint?: string;
      };
      inconsistent.key_to_id.ghost = 99;
      delete inconsistent.vector_fingerprint;
      fs.writeFileSync(metadataPath, JSON.stringify(inconsistent));

      const reloaded = new VectorStore(path.join(tempDir, "vectors"), 3);
      expect(() => reloaded.load()).toThrow(/structure/i);
    });

    it("should reject incomplete legacy vector publications in writer mode", () => {
      const missingMetadataPath = path.join(tempDir, "missing-metadata");
      const missingMetadata = new VectorStore(missingMetadataPath, 3);
      missingMetadata.save();
      fs.rmSync(`${missingMetadataPath}.meta.json`);
      expect(() => new VectorStore(missingMetadataPath, 3).load()).toThrow(/incomplete vector publication/i);

      const missingVectorsPath = path.join(tempDir, "missing-vectors");
      const missingVectors = new VectorStore(missingVectorsPath, 3);
      missingVectors.save();
      fs.rmSync(missingVectorsPath);
      expect(() => new VectorStore(missingVectorsPath, 3).load()).toThrow(/incomplete vector publication/i);
    });

    it("should clear the in-memory fingerprint when metadata publication fails", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.save();
      expect(store.hasFingerprint()).toBe(true);

      const metadataPath = path.join(tempDir, "vectors.meta.json");
      fs.rmSync(metadataPath);
      fs.mkdirSync(metadataPath);

      expect(() => store.save()).toThrow();
      expect(store.hasFingerprint()).toBe(false);
    });

    it("should add vectors in batch and keep metadata searchable", () => {
      store.addBatch([
        {
          id: "chunk1",
          vector: [1, 0, 0],
          metadata: {
            filePath: "a.ts",
            startLine: 1,
            endLine: 5,
            chunkType: "function",
            language: "typescript",
            hash: "abc123",
          },
        },
        {
          id: "chunk2",
          vector: [0, 1, 0],
          metadata: {
            filePath: "b.ts",
            startLine: 10,
            endLine: 15,
            chunkType: "class",
            language: "typescript",
            hash: "def456",
          },
        },
        {
          id: "chunk3",
          vector: [0, 0, 1],
          metadata: {
            filePath: "c.ts",
            startLine: 20,
            endLine: 25,
            chunkType: "method",
            language: "typescript",
            hash: "ghi789",
          },
        },
      ]);

      expect(store.count()).toBe(3);

      const results = store.search([1, 0.1, 0], 2);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe("chunk1");

      const metadataMap = store.getMetadataBatch(["chunk1", "chunk3"]);
      expect(metadataMap.size).toBe(2);
      expect(metadataMap.get("chunk1")?.filePath).toBe("a.ts");
      expect(metadataMap.get("chunk3")?.chunkType).toBe("method");
    });

    it("should replace existing keys when updating via batch", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "original.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "old-hash",
      });

      store.addBatch([
        {
          id: "chunk1",
          vector: [0, 1, 0],
          metadata: {
            filePath: "updated.ts",
            startLine: 6,
            endLine: 12,
            chunkType: "class",
            language: "typescript",
            hash: "new-hash",
          },
        },
        {
          id: "chunk2",
          vector: [0, 0, 1],
          metadata: {
            filePath: "second.ts",
            startLine: 20,
            endLine: 25,
            chunkType: "method",
            language: "typescript",
            hash: "second-hash",
          },
        },
      ]);

      expect(store.count()).toBe(2);

      const updated = store.getMetadata("chunk1");
      expect(updated?.filePath).toBe("updated.ts");
      expect(updated?.hash).toBe("new-hash");
      expect(updated?.chunkType).toBe("class");

      const results = store.search([0, 1, 0], 2);
      expect(results[0]?.id).toBe("chunk1");
      expect(results[0]?.metadata.filePath).toBe("updated.ts");
    });

    it("should handle high-volume batch inserts without losing search or metadata", () => {
      const batchSize = 1000;
      const items = Array.from({ length: batchSize }, (_unused, index) => ({
        id: `chunk${index}`,
        vector: [Math.cos(index / 25), Math.sin(index / 25), index === 777 ? 1 : 0],
        metadata: {
          filePath: `file-${index}.ts`,
          startLine: index + 1,
          endLine: index + 2,
          chunkType: index % 2 === 0 ? "function" : "class",
          language: "typescript",
          hash: `hash-${index}`,
        },
      }));

      store.addBatch(items);

      expect(store.count()).toBe(batchSize);

      const metadataMap = store.getMetadataBatch(["chunk0", "chunk777", "chunk999"]);
      expect(metadataMap.size).toBe(3);
      expect(metadataMap.get("chunk0")?.hash).toBe("hash-0");
      expect(metadataMap.get("chunk777")?.filePath).toBe("file-777.ts");
      expect(metadataMap.get("chunk999")?.endLine).toBe(1001);

      store.save();

      const reloadedStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      reloadedStore.load();

      expect(reloadedStore.count()).toBe(batchSize);
      expect(reloadedStore.getMetadata("chunk777")?.filePath).toBe("file-777.ts");
      expect(reloadedStore.getMetadata("chunk999")?.hash).toBe("hash-999");

      const reloadedResults = reloadedStore.search(items[777].vector, 10);
      expect(reloadedResults[0]?.id).toBe("chunk777");
    });

    it("should clear all data", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      store.clear();

      expect(store.count()).toBe(0);
    });

    it("should get all metadata", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.add("chunk2", [0, 1, 0], {
        filePath: "test2.ts",
        startLine: 10,
        endLine: 15,
        chunkType: "class",
        language: "typescript",
        hash: "def456",
      });

      const metadata = store.getAllMetadata();

      expect(metadata.length).toBe(2);
      expect(metadata.some((m) => m.key === "chunk1")).toBe(true);
      expect(metadata.some((m) => m.key === "chunk2")).toBe(true);
    });

    it("should get metadata for single chunk", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      const metadata = store.getMetadata("chunk1");
      expect(metadata).toBeDefined();
      expect(metadata?.filePath).toBe("test.ts");
      expect(metadata?.chunkType).toBe("function");

      const missing = store.getMetadata("nonexistent");
      expect(missing).toBeUndefined();
    });

    it("should get metadata batch for multiple chunks", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "a.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      store.add("chunk2", [0, 1, 0], {
        filePath: "b.ts",
        startLine: 10,
        endLine: 15,
        chunkType: "class",
        language: "typescript",
        hash: "def456",
      });

      store.add("chunk3", [0, 0, 1], {
        filePath: "c.ts",
        startLine: 20,
        endLine: 25,
        chunkType: "method",
        language: "typescript",
        hash: "ghi789",
      });

      const metadataMap = store.getMetadataBatch(["chunk1", "chunk3", "nonexistent"]);

      expect(metadataMap.size).toBe(2);
      expect(metadataMap.get("chunk1")?.filePath).toBe("a.ts");
      expect(metadataMap.get("chunk3")?.filePath).toBe("c.ts");
      expect(metadataMap.has("chunk2")).toBe(false);
      expect(metadataMap.has("nonexistent")).toBe(false);
    });
  });

  describe("createEmbeddingText", () => {
    it("should create embedding text with metadata", () => {
      const chunk: CodeChunk = {
        content: "function test() { return 1; }",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        name: "test",
        language: "typescript",
      };

      const text = createEmbeddingText(chunk, "/src/utils/helper.ts");

      expect(text).toContain("TypeScript");
      expect(text).toContain("test");
      expect(text).toContain("function test()");
    });

    it("should extract semantic hints", () => {
      const chunk: CodeChunk = {
        content: "async function validateToken(token: string) { return jwt.verify(token); }",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        name: "validateToken",
        language: "typescript",
      };

      const text = createEmbeddingText(chunk, "/src/auth.ts");

      expect(text.toLowerCase()).toContain("token");
    });
  });

  describe("createDynamicBatches", () => {
    it("should batch chunks by token count", () => {
      const chunks = [
        { text: "a".repeat(1000), id: "1" },
        { text: "b".repeat(1000), id: "2" },
        { text: "c".repeat(1000), id: "3" },
      ];

      const batches = createDynamicBatches(chunks);

      expect(batches.length).toBeGreaterThanOrEqual(1);
      expect(batches.flat().length).toBe(3);
    });

    it("should handle empty input", () => {
      const batches = createDynamicBatches([]);

      expect(batches.length).toBe(0);
    });

    it("should split large chunks into separate batches", () => {
      const chunks = [
        { text: "a".repeat(30000), id: "1" },
        { text: "b".repeat(30000), id: "2" },
      ];

      const batches = createDynamicBatches(chunks);

      expect(batches.length).toBe(2);
    });

    it("should respect maxBatchItems option", () => {
      const chunks = [
        { text: "a".repeat(100), id: "1" },
        { text: "b".repeat(100), id: "2" },
        { text: "c".repeat(100), id: "3" },
      ];

      const batches = createDynamicBatches(chunks, { maxBatchItems: 1 });

      expect(batches).toHaveLength(3);
      expect(batches.every((batch) => batch.length === 1)).toBe(true);
    });

    it("should respect maxBatchTokens override", () => {
      const chunks = [
        { text: "a".repeat(1000), id: "1" },
        { text: "b".repeat(1000), id: "2" },
      ];

      const batches = createDynamicBatches(chunks, { maxBatchTokens: 300 });

      expect(batches).toHaveLength(2);
    });
  });

  describe("createEmbeddingText", () => {
    it("should respect a lower max token override", () => {
      const chunk: CodeChunk = {
        content: "x".repeat(10000),
        startLine: 1,
        endLine: 50,
        chunkType: "function",
        name: "hugeChunk",
        language: "typescript",
      };

      const text = createEmbeddingText(chunk, "/src/huge.ts", 256);

      expect(text.length).toBeLessThan(256 * 4 + 64);
      expect(text).toContain("... [truncated]");
    });
  });

  describe("createEmbeddingTexts", () => {
    it("splits oversized chunks into multiple embedding texts with part markers", () => {
      const chunk: CodeChunk = {
        content: "x".repeat(8000),
        startLine: 1,
        endLine: 200,
        chunkType: "function",
        name: "hugeChunk",
        language: "typescript",
      };

      const texts = createEmbeddingTexts(chunk, "/src/huge.ts", 256);

      expect(texts.length).toBeGreaterThan(1);
      expect(texts[0]).toContain("Part 1/");
      expect(texts[1]).toContain("Part 2/");
      expect(texts.every((text) => text.length <= 256 * 4 + 128)).toBe(true);
    });

    it("returns a single text when the chunk fits the token budget", () => {
      const chunk: CodeChunk = {
        content: "function small() { return 1; }",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        name: "small",
        language: "typescript",
      };

      const texts = createEmbeddingTexts(chunk, "/src/small.ts", 512);

      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toContain("Part 1/");
    });
  });

  describe("generateChunkId", () => {
    it("should generate consistent IDs", () => {
      const chunk: CodeChunk = {
        content: "function test() {}",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        language: "typescript",
      };

      const id1 = generateChunkId("/path/to/file.ts", chunk);
      const id2 = generateChunkId("/path/to/file.ts", chunk);

      expect(id1).toBe(id2);
    });

    it("should generate different IDs for different chunks", () => {
      const chunk1: CodeChunk = {
        content: "function a() {}",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        language: "typescript",
      };
      const chunk2: CodeChunk = {
        content: "function b() {}",
        startLine: 5,
        endLine: 7,
        chunkType: "function",
        language: "typescript",
      };

      const id1 = generateChunkId("/path/to/file.ts", chunk1);
      const id2 = generateChunkId("/path/to/file.ts", chunk2);

      expect(id1).not.toBe(id2);
    });

    it("should start with chunk_ prefix", () => {
      const chunk: CodeChunk = {
        content: "const x = 1;",
        startLine: 1,
        endLine: 1,
        chunkType: "other",
        language: "typescript",
      };

      const id = generateChunkId("/file.ts", chunk);

      expect(id.startsWith("chunk_")).toBe(true);
    });
  });

  describe("estimateTokens", () => {
    it("should estimate ~4 chars per token", () => {
      const text = "a".repeat(400);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(100);
    });
  });
});
