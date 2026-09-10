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

    it("honors linesPerChunk for line-based (.jsonl) files", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `{"i":${i}}`);
      const content = lines.join("\n");

      const defaultChunks = parseFile("session.jsonl", content, 30);
      const smallChunks = parseFile("session.jsonl", content, 5);

      // Default window covers all 20 lines in one chunk.
      expect(defaultChunks.length).toBe(1);
      expect(defaultChunks[0].endLine - defaultChunks[0].startLine + 1).toBe(20);

      // Window of 5 with overlap 1 (min(3, 5/4)) -> step 4 -> chunks at starts 1, 5, 9, 13, 17.
      expect(smallChunks.length).toBe(5);
      for (const chunk of smallChunks) {
        expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(5);
      }
      expect(smallChunks[1].startLine - smallChunks[0].startLine).toBe(4);
    });

    it("extracts generic XML structure, text, and bounded attributes", () => {
      const content = `<?xml version="1.0"?>
<catalog xmlns="urn:catalog" source="internal">
  <book id="bk-1" available="true">
    <title>XML &amp; SVG</title>
    <summary>Useful <![CDATA[structured text]]>.</summary>
    <empty-marker enabled="yes" />
  </book>
</catalog>`;

      const chunks = parseFile("catalog.xml", content);
      const combined = chunks.map((chunk) => chunk.content).join("\n");

      expect(chunks.every((chunk) => chunk.language === "xml")).toBe(true);
      expect(chunks.every((chunk) => chunk.chunkType === "element")).toBe(true);
      expect(combined).toContain('catalog [source="internal"]');
      expect(combined).toContain('catalog/book [id="bk-1" available="true"]');
      expect(combined).toContain("catalog/book/title: XML & SVG");
      expect(combined).toContain("catalog/book/summary: Useful structured text.");
      expect(combined).toContain('catalog/book/empty-marker [enabled="yes"]');
      expect(combined).not.toContain("xmlns");
    });

    it("keeps accessible SVG text while excluding rendering and layer noise", () => {
      const content = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" aria-label="Accessible sales chart" role="img" viewBox="VIEWBOX_NOISE" data-layer="LAYER_NOISE">
  <title>Quarterly sales</title>
  <desc>Sales increased during 2026.</desc>
  <defs><title>DEFS_TEXT_NOISE</title></defs>
  <g aria-hidden="true"><text>ARIA_HIDDEN_TEXT_NOISE</text></g>
  <text style="display: none">DISPLAY_NONE_TEXT_NOISE</text>
  <text style="display: /* generated ; */ none !important">COMMENTED_DISPLAY_NONE_TEXT_NOISE</text>
  <text style='content:"/*";display:none'>STRING_COMMENT_MARKER_HIDDEN_NOISE</text>
  <text style='content:"display:none"'>Visible CSS string content</text>
  <text style="display:noneish">Visible invalid display value</text>
  <text style="display:no/* generated */ne">Visible interrupted display keyword</text>
  <text style="${"x".repeat(4097)}">OVERSIZED_STYLE_TEXT_NOISE</text>
  <text visibility="hidden">VISIBILITY_TEXT_NOISE</text>
  <style>.STYLE_NOISE { fill: red; }</style>
  <g id="LAYER_NOISE" transform="translate(COORD_NOISE)" fill="FILL_NOISE" stroke="STROKE_NOISE" inkscape:groupmode="layer" inkscape:label="INKSCAPE_LAYER_NOISE">
    <path d="PATH_NOISE" style="STYLE_NOISE" />
    <text x="COORD_NOISE" class="STYLE_NOISE">Visible sales <tspan>2026</tspan></text>
    <circle cx="COORD_NOISE" aria-description="Current quarter marker">ARIA_CHILD_NOISE</circle>
    <foreign:text xmlns:foreign="urn:not-svg" aria-label="FOREIGN_ARIA_NOISE">FOREIGN_TEXT_NOISE</foreign:text>
  </g>
</svg>`;

      const chunks = parseFile("chart.svg", content);
      const combined = chunks.map((chunk) => chunk.content).join("\n");

      expect(chunks.every((chunk) => chunk.language === "svg")).toBe(true);
      expect(combined).toContain("title: Quarterly sales");
      expect(combined).toContain("desc: Sales increased during 2026.");
      expect(combined).toContain("text: Visible sales 2026");
      expect(combined).toContain("text: Visible CSS string content");
      expect(combined).toContain("text: Visible invalid display value");
      expect(combined).toContain("text: Visible interrupted display keyword");
      expect(combined).toContain('svg [aria-label="Accessible sales chart" role="img"]');
      expect(combined).toContain('circle [aria-description="Current quarter marker"]');
      expect(combined).not.toContain("PATH_NOISE");
      expect(combined).not.toContain("COORD_NOISE");
      expect(combined).not.toContain("STYLE_NOISE");
      expect(combined).not.toContain("LAYER_NOISE");
      expect(combined).not.toContain("VIEWBOX_NOISE");
      expect(combined).not.toContain("FILL_NOISE");
      expect(combined).not.toContain("STROKE_NOISE");
      expect(combined).not.toContain("INKSCAPE_LAYER_NOISE");
      expect(combined).not.toContain("ARIA_CHILD_NOISE");
      expect(combined).not.toContain("DEFS_TEXT_NOISE");
      expect(combined).not.toContain("ARIA_HIDDEN_TEXT_NOISE");
      expect(combined).not.toContain("DISPLAY_NONE_TEXT_NOISE");
      expect(combined).not.toContain("COMMENTED_DISPLAY_NONE_TEXT_NOISE");
      expect(combined).not.toContain("STRING_COMMENT_MARKER_HIDDEN_NOISE");
      expect(combined).not.toContain("OVERSIZED_STYLE_TEXT_NOISE");
      expect(combined).not.toContain("VISIBILITY_TEXT_NOISE");
      expect(combined).not.toContain("FOREIGN_ARIA_NOISE");
      expect(combined).not.toContain("FOREIGN_TEXT_NOISE");
    });

    it("keeps SVG descendants that override inherited visibility", () => {
      const chunks = parseFile(
        "visibility-overrides.svg",
        `<svg>
  <g visibility="hidden"><text visibility="visible">Attribute override</text><text>Inherited hidden</text></g>
  <g style="visibility:hidden"><text style="visibility:visible">Style override</text><text>Style inherited hidden</text></g>
  <text visibility="hidden">Hidden direct <tspan visibility="visible">Visible tspan</tspan></text>
  <g display="none"><text visibility="visible">Display remains hidden</text></g>
  <g aria-hidden="true"><text visibility="visible">ARIA remains hidden</text></g>
  <g style="visibility:hidden !important"><text style="visibility:visible">Important parent override</text></g>
  <g style="visibility:hidden !important; visibility:visible"><text>Important remains hidden</text></g>
  <g visibility="hidden" style="visibility:visible"><text>Inline style wins</text></g>
</svg>`,
      );
      const combined = chunks.map((chunk) => chunk.content).join("\n");

      expect(combined).toContain("text: Attribute override");
      expect(combined).toContain("text: Style override");
      expect(combined).toContain("text: Visible tspan");
      expect(combined).toContain("text: Important parent override");
      expect(combined).toContain("text: Inline style wins");
      expect(combined).not.toContain("Inherited hidden");
      expect(combined).not.toContain("Style inherited hidden");
      expect(combined).not.toContain("Hidden direct");
      expect(combined).not.toContain("Display remains hidden");
      expect(combined).not.toContain("ARIA remains hidden");
      expect(combined).not.toContain("Important remains hidden");
    });

    it("ignores invalid SVG visibility declarations without replacing valid suppression", () => {
      for (const style of [
        "display:none;display:garbage",
        "display:none;display:",
        "display:none;display:garbage !important",
        "display:none;display:none block",
        "visibility:hidden;visibility:garbage",
        "visibility:hidden;visibility:",
        "visibility:hidden;visibility:garbage !important",
        "visibility:hidden;visibility:visible hidden",
      ]) {
        expect(parseFile("invalid-style.svg", `<svg><text style="${style}">Hidden label</text></svg>`))
          .toEqual([]);
      }
      expect(parseFile(
        "invalid-inline-style.svg",
        '<svg><text display="none" style="display:garbage">Hidden display</text><text visibility="hidden" style="visibility:garbage">Hidden visibility</text></svg>',
      )).toEqual([]);
    });

    it("preserves valid SVG inline display and visibility overrides", () => {
      for (const display of ["block", "inline", "inline-block", "flex", "inline flex", "flow-root block", "list-item inline flow", "table-row", "contents"]) {
        const chunks = parseFile(
          "valid-style.svg",
          `<svg><text style="display:none;display:${display}">Visible label</text></svg>`,
        );
        expect(chunks.map((chunk) => chunk.content)).toEqual(["text: Visible label"]);
      }
      expect(parseFile(
        "valid-visibility.svg",
        '<svg><text style="visibility:hidden;visibility:visible !important;visibility:hidden">Visible label</text></svg>',
      ).map((chunk) => chunk.content)).toEqual(["text: Visible label"]);
    });

    it("rejects malformed XML instead of indexing raw lines", () => {
      expect(() => parseFile("broken.xml", "<root><item></root>"))
        .toThrow(/Failed to parse markup file/);
      expect(() => parseFile("forbidden-cdata-end.xml", "<root>a]]>b</root>"))
        .toThrow(/forbidden sequence/);
      expect(() => parseFile("literal-angle-attribute.xml", '<root value="<"/>'))
        .toThrow(/literal < character/);
    });

    it("preserves only source whitespace across references, CDATA, and nested SVG text", () => {
      const xmlChunks = parseFile(
        "adjacent.xml",
        "<root><reference>foo&#66;ar</reference><cdata><![CDATA[foo]]>bar</cdata></root>",
      );
      expect(xmlChunks.map((chunk) => chunk.content)).toEqual([
        "root/reference: fooBar",
        "root/cdata: foobar",
      ]);
      expect(parseFile("space.xml", "<root><child/>&#x20;</root>")
        .map((chunk) => chunk.content)).toEqual(["root/child"]);

      const svgChunks = parseFile(
        "adjacent.svg",
        "<svg><text>A<tspan>B</tspan><title>C</title>D</text><title>Top title</title></svg>",
      );
      expect(svgChunks.map((chunk) => chunk.content)).toEqual([
        "text: ABCD",
        "title: Top title",
      ]);
    });

    it("preserves non-breaking spaces and safely renders attribute values", () => {
      const chunks = parseFile(
        "fidelity.xml",
        '<root label="Say &quot;yes&quot; at C:\\tmp"><value>A\u00a0B</value></root>',
      );
      const combined = chunks.map((chunk) => chunk.content).join("\n");

      expect(combined).toContain('label="Say \\"yes\\" at C:\\\\tmp"');
      expect(combined).toContain("root/value: A\u00a0B");
    });

    it("keeps SVG semantic names and accessibility attributes case-sensitive", () => {
      const chunks = parseFile(
        "case-sensitive.svg",
        '<svg xmlns:foreign="urn:not-svg"><TEXT>UPPER_TEXT_NOISE</TEXT><Title>UPPER_TITLE_NOISE</Title><g ARIA-label="UPPER_ARIA_NOISE" foreign:aria-label="NAMESPACED_ARIA_NOISE"/><text>Visible text</text></svg>',
      );
      const combined = chunks.map((chunk) => chunk.content).join("\n");

      expect(combined).toContain("text: Visible text");
      expect(combined).not.toContain("UPPER_TEXT_NOISE");
      expect(combined).not.toContain("UPPER_TITLE_NOISE");
      expect(combined).not.toContain("UPPER_ARIA_NOISE");
      expect(combined).not.toContain("NAMESPACED_ARIA_NOISE");
    });

    it("streams deeply nested SVG text into one semantic record", () => {
      const depth = 256;
      const content = `<svg><text>${"<tspan>".repeat(depth)}Deep label${"</tspan>".repeat(depth)}</text></svg>`;

      expect(parseFile("deep.svg", content).map((chunk) => chunk.content)).toEqual([
        "text: Deep label",
      ]);
    });

    it("requires one document root and an SVG root element", () => {
      expect(parseFile(
        "valid-declaration.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root/>',
      ).map((chunk) => chunk.content)).toEqual(["root"]);
      expect(() => parseFile("multiple.xml", "<first/><second/>"))
        .toThrow(/more than one root element/);
      expect(() => parseFile("outside.xml", "text<root/>"))
        .toThrow(/text outside the root element/);
      expect(() => parseFile("not-svg.svg", "<document><title>Wrong root</title></document>"))
        .toThrow(/must use <svg> as the root element/);
      expect(() => parseFile("late-declaration.xml", "<!--comment--><?xml version=\"1.0\"?><root/>"))
        .toThrow(/declaration must be the first document construct/);
      expect(() => parseFile("spaced-declaration.xml", " \n<?xml version=\"1.0\"?><root/>"))
        .toThrow(/declaration must be the first document construct/);
      expect(() => parseFile("duplicate-declaration.xml", "<?xml version=\"1.0\"?><?xml version=\"1.0\"?><root/>"))
        .toThrow(/declaration must be the first document construct/);
      expect(() => parseFile("missing-version.xml", '<?xml encoding="UTF-8"?><root/>'))
        .toThrow(/must begin with version/);
      expect(() => parseFile("invalid-standalone.xml", '<?xml version="1.0" standalone="maybe"?><root/>'))
        .toThrow(/standalone value must be yes or no/);
      expect(() => parseFile("reserved-pi.xml", '<?XML version="1.0"?><root/>'))
        .toThrow(/processing instruction target XML is reserved/);
      expect(() => parseFile("duplicate-doctype.xml", "<!DOCTYPE root><!DOCTYPE root><root/>"))
        .toThrow(/document type must appear at most once/);
      expect(() => parseFile("mismatched-doctype.xml", "<!DOCTYPE expected><actual/>"))
        .toThrow(/document type root does not match/);
      expect(() => parseFile("invalid-comment.xml", "<root><!-- invalid -- comment --></root>"))
        .toThrow(/Failed to parse markup file/);
      expect(() => parseFile("wrong-namespace.svg", '<svg xmlns="urn:not-svg"><text>Wrong namespace</text></svg>'))
        .toThrow(/SVG root namespace must be/);
    });

    it("resolves prefixed SVG element namespaces", () => {
      const chunks = parseFile(
        "prefixed.svg",
        '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:title>Prefixed title</s:title></s:svg>',
      );

      expect(chunks.map((chunk) => chunk.content)).toEqual(["title: Prefixed title"]);
    });

    it("resolves character references in SVG namespace URIs", () => {
      const chunks = parseFile(
        "encoded-namespace.svg",
        '<svg xmlns="http://www.w3.org/2000/sv&#x67;"><title>Encoded namespace</title></svg>',
      );

      expect(chunks.map((chunk) => chunk.content)).toEqual(["title: Encoded namespace"]);
    });

    it("rejects undeclared namespace prefixes", () => {
      expect(() => parseFile("undeclared-element.xml", "<root><p:item/></root>"))
        .toThrow(/element uses an undeclared namespace prefix/);
      expect(() => parseFile("undeclared-attribute.xml", '<root p:value="x"/>'))
        .toThrow(/attribute uses an undeclared namespace prefix/);
      expect(() => parseFile("undeclared-element.svg", "<svg><p:text>Hidden</p:text></svg>"))
        .toThrow(/element uses an undeclared namespace prefix/);
    });

    it("honors an explicit default namespace undeclaration in implicit SVG mode", () => {
      const chunks = parseFile(
        "namespace-undeclaration.svg",
        '<svg><g xmlns="http://www.w3.org/2000/svg"><g xmlns=""><text>UNDECLARED_NAMESPACE_NOISE</text></g><text>Visible label</text></g></svg>',
      );
      const combined = chunks.map((chunk) => chunk.content).join("\n");

      expect(combined).toContain("text: Visible label");
      expect(combined).not.toContain("UNDECLARED_NAMESPACE_NOISE");
    });

    it("accepts a compact internal DOCTYPE subset", () => {
      expect(parseFile(
        "internal-subset.xml",
        "<!DOCTYPE root[<!ELEMENT root EMPTY>]><root/>",
      ).map((chunk) => chunk.content)).toEqual(["root"]);
    });

    it("rejects invalid XML character references", () => {
      expect(() => parseFile("control.xml", "<root>&#x1;</root>"))
        .toThrow(/invalid in XML 1\.0/);
      expect(() => parseFile("literal-control.xml", "<root>bad\u0001text</root>"))
        .toThrow(/literal character U\+0001/);
      expect(() => parseFile("filtered-attribute.svg", '<svg><path d="M0 &broken"/></svg>'))
        .toThrow(/unterminated entity reference/);
      expect(() => parseFile("long-reference.svg", `<svg><path d="&${"x".repeat(300)};"/></svg>`))
        .toThrow(/entity reference exceeds the supported limit/);
      expect(() => parseFile("invalid-entity-name.xml", "<root>&!;</root>"))
        .toThrow(/entity reference name is invalid/);
      expect(() => parseFile("invalid-attribute-entity.xml", '<root value="&a b;"/>'))
        .toThrow(/entity reference name is invalid/);
    });

    it("rejects invalid XML qualified names", () => {
      expect(() => parseFile("digit-name.xml", "<1root/>"))
        .toThrow(/not a valid XML qualified name/);
      expect(() => parseFile("digit-attribute.xml", '<root 1attr="value"/>'))
        .toThrow(/not a valid XML qualified name/);
      expect(() => parseFile("multi-prefix.xml", "<one:two:root/>"))
        .toThrow(/not a valid XML qualified name/);
    });

    it("keeps unknown attribute entities literal without expanding DTD content", () => {
      const chunks = parseFile(
        "entities.xml",
        '<root kind="A &custom; B" letter="&#x41;">value</root>',
      );

      expect(chunks[0]?.content).toBe('root [kind="A &custom; B" letter="A"]: value');
    });

    it("reports line and column spans through a UTF-8 BOM and lone CR line endings", () => {
      const chunks = parseFile(
        "positions.xml",
        "\uFEFF<root>\r<item>value</item>\r</root>",
      );

      expect(chunks[0]).toMatchObject({
        content: "root/item: value",
        startLine: 2,
        startCol: 0,
        endLine: 2,
      });
    });

    it("bounds markup names before rendering chunks", () => {
      const name = "a".repeat(3000);
      expect(() => parseFile("long-name.xml", `<${name}/>`))
        .toThrow(/name exceeds the supported limit/);
      expect(() => parseFile(
        "long-namespace.xml",
        `<root xmlns="${"a".repeat(4097)}"/>`,
      )).toThrow(/namespace URI exceeds the supported limit/);
      expect(() => parseFile(
        "long-declaration.xml",
        `<?xml version="1.0" encoding="${"a".repeat(513)}"?><root/>`,
      )).toThrow(/declaration attribute value exceeds the supported limit/);
    });

    it("bounds complete markup records and gives split parts unique IDs", () => {
      const name = "n".repeat(250);
      const content = `<${name} first="${"a".repeat(500)}" second="${"b".repeat(500)}">${"visible ".repeat(1000)}</${name}>`;
      const chunks = parseFile("large-record.xml", content);
      const ids = chunks.map((chunk) => generateChunkId("large-record.xml", chunk));

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => Buffer.byteLength(chunk.content) <= 2000)).toBe(true);
      expect(new Set(ids).size).toBe(chunks.length);
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

    it("should preserve PHP 8.x semantic declarations and names", () => {
      const content = fs.readFileSync(
        path.join(__dirname, "fixtures", "call-graph", "php-8-features.php"),
        "utf-8",
      );
      const chunks = parseFile("php-8-features.php", content);

      const job = chunks.find((chunk) => chunk.name === "Job");
      expect(job?.chunkType).toBe("class_declaration");
      expect(job?.content).toContain("public int|string $id");
      expect(job?.content).toContain("match ($label)");

      const status = chunks.find((chunk) => chunk.name === "Status");
      expect(status?.chunkType).toBe("enum_declaration");
      expect(status?.content).toContain("public const string LABEL");

      expect(chunks.find((chunk) => chunk.name === "Cacheable")?.chunkType).toBe(
        "interface_declaration",
      );
      expect(chunks.find((chunk) => chunk.name === "Timestamps")?.chunkType).toBe(
        "trait_declaration",
      );

      const profile = chunks.find((chunk) => chunk.name === "Profile");
      expect(profile?.content).toContain("private(set)");
      expect(profile?.content).toContain("public string $slug");

      const pipeline = chunks.find((chunk) => chunk.name === "pipeline");
      expect(pipeline?.chunkType).toBe("function_definition");
      expect(pipeline?.content).toContain("|> (trim(...))");
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

    it("should parse modern Swift declarations into named semantic chunks", () => {
      const fixturePath = path.join(
        __dirname,
        "fixtures",
        "swift",
        "ModernService.swift",
      );
      const content = fs.readFileSync(fixturePath, "utf-8");
      const chunks = parseFile("ModernService.swift", content);

      expect(chunks.length).toBeGreaterThan(20);
      expect(chunks.every((chunk) => chunk.language === "swift")).toBe(true);
      expect(chunks.some((chunk) => chunk.chunkType === "block")).toBe(false);

      const hasNamedChunk = (chunkType: string, name: string): boolean =>
        chunks.some(
          (chunk) => chunk.chunkType === chunkType && chunk.name === name,
        );

      expect(hasNamedChunk("protocol_declaration", "DataLoading")).toBe(true);
      expect(hasNamedChunk("protocol_function_declaration", "load")).toBe(true);
      expect(hasNamedChunk("actor_declaration", "ResponseCache")).toBe(true);
      expect(hasNamedChunk("struct_declaration", "User")).toBe(true);
      expect(hasNamedChunk("enum_declaration", "LoadState")).toBe(true);
      expect(hasNamedChunk("class_declaration", "UserRepository")).toBe(true);
      expect(hasNamedChunk("extension_declaration", "UserRepository")).toBe(true);
      expect(hasNamedChunk("method_declaration", "loadNames")).toBe(true);
      expect(hasNamedChunk("init_declaration", "init")).toBe(true);
      expect(hasNamedChunk("deinit_declaration", "deinit")).toBe(true);
      expect(hasNamedChunk("subscript_declaration", "subscript")).toBe(true);
      expect(hasNamedChunk("function_declaration", "decode")).toBe(true);
      expect(hasNamedChunk("function_declaration", "collect")).toBe(true);

      const protocolChunk = chunks.find(
        (chunk) =>
          chunk.chunkType === "protocol_declaration" &&
          chunk.name === "DataLoading",
      );
      expect(protocolChunk?.content).toContain("Loads values asynchronously");

      const repositoryChunk = chunks.find(
        (chunk) =>
          chunk.chunkType === "class_declaration" &&
          chunk.name === "UserRepository",
      );
      expect(repositoryChunk?.content).toContain("Repository backed by an actor-isolated cache");
    });

    it("should keep adjacent small Swift functions as separate named chunks", () => {
      const chunks = parseFile(
        "Tiny.swift",
        "func a() { b() }\nfunc b() {}\n",
      );
      const functions = chunks.filter(
        (chunk) => chunk.chunkType === "function_declaration",
      );

      expect(functions.map((chunk) => chunk.name)).toEqual(["a", "b"]);
      expect(functions[0].content).toContain("func a()");
      expect(functions[1].content).toContain("func b()");
    });

    it("should expose small Swift methods nested in a type", () => {
      const chunks = parseFile(
        "TinyType.swift",
        `struct TinyType {
    func a() { b() }
    func b() {}
}
`,
      );
      const methods = chunks.filter(
        (chunk) => chunk.chunkType === "method_declaration",
      );

      expect(chunks.some(
        (chunk) =>
          chunk.chunkType === "struct_declaration" && chunk.name === "TinyType",
      )).toBe(true);
      expect(methods.map((chunk) => chunk.name)).toEqual(["a", "b"]);
    });

    it("should prefer nested Swift chunks when large declaration windows overlap exactly", () => {
      const fixturePath = path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "swift",
        "DuplicateSemanticWindow.swift",
      );
      const content = fs.readFileSync(fixturePath, "utf-8");

      const chunks = parseFile("LargeContainer.swift", content);
      const duplicateKeys = new Set<string>();
      const seenKeys = new Set<string>();
      for (const chunk of chunks) {
        const key = `${chunk.startLine}:${chunk.endLine}:${chunk.content}`;
        if (seenKeys.has(key)) {
          duplicateKeys.add(key);
        }
        seenKeys.add(key);
      }

      expect(duplicateKeys).toEqual(new Set());
      expect(chunks.some(
        (chunk) => chunk.chunkType === "method_declaration" && chunk.name === "nestedMethod",
      )).toBe(true);
      expect(chunks.find(
        (chunk) => chunk.startLine === 19 && chunk.endLine === 30,
      )).toMatchObject({ chunkType: "method_declaration", name: "nestedMethod" });
    });

    it("should attach Swift line and block comments to declarations", () => {
      const chunks = parseFile(
        "Comments.swift",
        `/// Line documentation.
func documented() {}

/** Block documentation. */
struct DocumentedType {}
`,
      );

      const documented = chunks.find((chunk) => chunk.name === "documented");
      const documentedType = chunks.find(
        (chunk) => chunk.name === "DocumentedType",
      );
      expect(documented?.content).toContain("Line documentation");
      expect(documentedType?.content).toContain("Block documentation");
    });

    it("should keep Swift doc comment ranges on their real source lines", () => {
      const chunks = parseFile(
        "CommentRange.swift",
        `helper()
/// Documentation.
func documented() {}
`,
      );
      const documented = chunks.find((chunk) => chunk.name === "documented");

      expect(documented?.startLine).toBe(2);
      expect(documented?.endLine).toBe(3);

      const nestedChunks = parseFile(
        "NestedCommentRange.swift",
        `struct Container {
    /// Documentation.
    func documented() {}
}
`,
      );
      const nestedMethod = nestedChunks.find(
        (chunk) => chunk.name === "documented",
      );

      expect(nestedMethod?.startLine).toBe(2);
      expect(nestedMethod?.endLine).toBe(3);
    });

    it("should keep complete multi-line Swift doc comments", () => {
      const chunks = parseFile(
        "LongDocumentation.swift",
        `/// one
/// two
/// three
/// four
/// five
/// six
func documented() {}
`,
      );
      const documented = chunks.find((chunk) => chunk.name === "documented");

      expect(documented?.content).toContain("/// one");
      expect(documented?.content).toContain("/// six");
      expect(documented?.startLine).toBe(1);
    });

    it("should name Swift operators and qualified extensions", () => {
      const chunks = parseFile(
        "Names.swift",
        `struct Vector {}
func + (lhs: Vector, rhs: Vector) -> Vector { lhs }
extension Module.Container<Int> {
    func inspect() {}
}
`,
      );

      expect(chunks.some(
        (chunk) => chunk.chunkType === "function_declaration" && chunk.name === "+",
      )).toBe(true);
      expect(chunks.some(
        (chunk) =>
          chunk.chunkType === "extension_declaration" &&
          chunk.name === "Container",
      )).toBe(true);
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

    it("should parse Metal functions, structs, stages, and address spaces", () => {
      const fixturePath = path.join(
        __dirname,
        "fixtures",
        "metal",
        "representative.metal",
      );
      const content = fs.readFileSync(fixturePath, "utf-8");
      const chunks = parseFile("representative.metal", content);

      const functionNames = chunks
        .filter((chunk) => chunk.chunkType === "function_definition")
        .map((chunk) => chunk.name);
      expect(functionNames).toEqual(
        expect.arrayContaining([
          "scaled_value",
          "shade",
          "adjust",
          "vertex_main",
          "fragment_main",
          "reduce_kernel",
        ]),
      );

      const templateFunction = chunks.find(
        (chunk) => chunk.name === "scaled_value",
      );
      expect(templateFunction?.content).toContain("template <typename T>");
      expect(templateFunction?.content).toContain("inline T scaled_value");

      const structNames = chunks
        .filter((chunk) => chunk.chunkType === "struct_specifier")
        .map((chunk) => chunk.name);
      expect(structNames).toEqual(
        expect.arrayContaining([
          "VertexIn",
          "VertexOut",
          "Uniforms",
          "Tiny",
          "Ops",
          "BufferPair",
        ]),
      );
      expect(structNames.filter((name) => name === "BufferPair")).toHaveLength(2);

      expect(
        chunks.find((chunk) => chunk.chunkType === "enum_specifier")?.name,
      ).toBe("BlendMode");
      expect(
        chunks.find((chunk) => chunk.chunkType === "union_specifier")?.name,
      ).toBe("ScalarBits");
      expect(
        chunks.find((chunk) => chunk.chunkType === "alias_declaration")?.name,
      ).toBe("Gain");
      expect(
        chunks.find((chunk) => chunk.chunkType === "type_definition")?.name,
      ).toBe("LegacyUniforms");

      const shade = chunks.find((chunk) => chunk.name === "shade");
      expect(shade?.content).toContain("Samples the texture");

      const kernel = chunks.find((chunk) => chunk.name === "reduce_kernel");
      expect(kernel?.content).toContain("kernel void");
      expect(kernel?.content).toContain("device float");
      expect(kernel?.content).toContain("constant uint");
      expect(kernel?.content).toContain("threadgroup float");
      expect(kernel?.content).toContain("thread float");
      expect(kernel?.content).toContain("[[thread_position_in_grid]]");
      expect(chunks.every((chunk) => chunk.language === "metal")).toBe(true);
    });
  });

  describe("parseFiles", () => {
    it("retains malformed markup as an empty batch result", () => {
      const results = parseFiles([
        { path: "broken.xml", content: "<root><item></root>" },
        { path: "broken.svg", content: "<svg><text>Useful</svg>" },
        { path: "duplicate-doctype.xml", content: "<!DOCTYPE root><!DOCTYPE root><root/>" },
        { path: "lexically-invalid.xml", content: "<root>a]]>b</root>" },
        { path: "invalid-declaration.xml", content: '<?xml standalone="maybe"?><root/>' },
        { path: "geometry.svg", content: '<svg><path d="M0 0L1 1"/></svg>' },
        { path: "valid.svg", content: "<svg><title>Useful title</title></svg>" },
      ]);

      expect(results).toHaveLength(7);
      expect(results[0]).toMatchObject({
        path: "broken.xml",
        chunks: [],
        symbols: [],
        parseFailed: true,
      });
      expect(results[1]).toMatchObject({
        path: "broken.svg",
        chunks: [],
        symbols: [],
        parseFailed: true,
      });
      expect(results[2]).toMatchObject({
        path: "duplicate-doctype.xml",
        chunks: [],
        symbols: [],
        parseFailed: true,
      });
      expect(results[3]).toMatchObject({
        path: "lexically-invalid.xml",
        chunks: [],
        symbols: [],
        parseFailed: true,
      });
      expect(results[4]).toMatchObject({
        path: "invalid-declaration.xml",
        chunks: [],
        symbols: [],
        parseFailed: true,
      });
      expect(results[5]).toMatchObject({
        path: "geometry.svg",
        chunks: [],
        symbols: [],
        parseFailed: false,
      });
      expect(results[6]?.chunks).toEqual([
        expect.objectContaining({ content: "title: Useful title", language: "svg" }),
      ]);
    });

    it("caps markup extraction with representative file coverage", () => {
      const items = Array.from(
        { length: 101 },
        (_, index) => `<item>value-${index}</item>`,
      ).join("");
      const [result] = parseFiles(
        [{ path: "large.xml", content: `<root>${items}</root>` }],
        undefined,
        5,
      );

      expect(result.chunks.map((chunk) => chunk.content)).toEqual([
        "root/item: value-0",
        "root/item: value-25",
        "root/item: value-50",
        "root/item: value-75",
        "root/item: value-100",
      ]);
    });

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

    it("extracts nested class methods as symbols without changing semantic chunks", () => {
      const [result] = parseFiles([{
        path: "service.ts",
        content: `export class Service {
  async getStatus(): Promise<string> {
    return "ready";
  }
}`,
      }]);

      expect(result.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Service", kind: "class_declaration" }),
        expect.objectContaining({ name: "getStatus", kind: "method_definition" }),
      ]));
      expect(result.chunks.some((chunk) => chunk.name === "getStatus")).toBe(false);
    });

    it("names TypeScript arrow-function symbols using variable bindings", () => {
      const [result] = parseFiles([
        {
          path: "arrows.ts",
          content: `
const handler = (event: string) => {
  return event.toLowerCase();
};

const normalize = (value: number) => value * 2;
const values = [1, 2].map(item => item * 2);
`,
        },
      ]);

      const arrowSymbols = result.symbols.filter((symbol) => symbol.kind === "arrow_function");
      const names = arrowSymbols.map((symbol) => symbol.name);

      expect(names).toEqual(expect.arrayContaining(["handler", "normalize"]));
      expect(names).not.toContain("event");
      expect(names).not.toContain("value");
      expect(names).not.toContain("item");
    });

    it("includes exported abstract class declarations and their methods", () => {
      const [result] = parseFiles([
        {
          path: "animals.ts",
          content: `export abstract class AbstractAnimal {
  identify(): string {
    return "animal";
  }

  describe(): string {
    return this.identify();
  }
}`,
        },
      ]);

      expect(result.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "class_declaration",
            name: "AbstractAnimal",
          }),
          expect.objectContaining({
            kind: "method_definition",
            name: "identify",
          }),
          expect.objectContaining({
            kind: "method_definition",
            name: "describe",
          }),
        ]),
      );
    });

    it("honors linesPerChunk across a batch of line-based files", () => {
      const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
      const content = lines.join("\n");
      const files = [
        { path: "a.txt", content },
        { path: "b.jsonl", content },
      ];

      const [a, b] = parseFiles(files, 4);

      // Window of 4 with overlap 1 (min(3, 4/4)) -> step 3 -> starts 1, 4, 7, 10.
      expect(a.chunks.length).toBe(4);
      expect(b.chunks.length).toBe(4);
      for (const chunk of a.chunks) {
        expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(4);
      }
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

    it("should search only within allowed vector IDs", () => {
      store.add("closest", [1, 0, 0], {
        filePath: "closest.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "closest",
      });
      store.add("allowed", [0, 1, 0], {
        filePath: "allowed.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "allowed",
      });

      expect(store.search([1, 0, 0], 1)[0]?.id).toBe("closest");
      expect(store.search([1, 0, 0], 1, ["allowed"])).toMatchObject([{ id: "allowed" }]);
      expect(store.search([1, 0, 0], 1, [])).toEqual([]);
      expect(store.search([1, 0, 0], 1, ["missing"])).toEqual([]);
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

    it("should reject duplicate batch keys before mutating the store", () => {
      const duplicateBatch = [
        {
          id: "duplicate",
          vector: [1, 0, 0],
          metadata: {
            filePath: "container.swift",
            startLine: 1,
            endLine: 10,
            chunkType: "enum_declaration",
            language: "swift",
            hash: "same-hash",
          },
        },
        {
          id: "duplicate",
          vector: [0, 1, 0],
          metadata: {
            filePath: "container.swift",
            startLine: 1,
            endLine: 10,
            chunkType: "method_declaration",
            language: "swift",
            hash: "same-hash",
          },
        },
      ];

      store.add("existing", [0, 0, 1], {
        filePath: "existing.swift",
        startLine: 1,
        endLine: 1,
        chunkType: "property_declaration",
        language: "swift",
        hash: "existing-hash",
      });

      expect(() => store.addBatch(duplicateBatch)).toThrow(/duplicate vector store keys/i);
      expect(store.count()).toBe(1);
      expect(store.getMetadata("existing")?.filePath).toBe("existing.swift");

      store.addBatch([duplicateBatch[1]!]);
      store.save();

      const reloadedStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      reloadedStore.load();
      expect(reloadedStore.count()).toBe(2);
      expect(reloadedStore.getMetadata("existing")?.filePath).toBe("existing.swift");
      expect(reloadedStore.getMetadata("duplicate")?.chunkType).toBe("method_declaration");
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

    it("should describe Swift semantic chunk types", () => {
      const chunk: CodeChunk = {
        content: "actor ResponseCache {}",
        startLine: 1,
        endLine: 1,
        chunkType: "actor_declaration",
        name: "ResponseCache",
        language: "swift",
      };

      const text = createEmbeddingText(chunk, "/Sources/ResponseCache.swift");

      expect(text).toContain('Swift actor "ResponseCache"');
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
    it("does not infer code-purpose hints from markup names or accessibility roles", () => {
      const text = createEmbeddingText({
        content: 'path [role="img"]: Visible label',
        startLine: 1,
        endLine: 1,
        chunkType: "element",
        name: "path",
        language: "svg",
      }, "/assets/chart.svg");

      expect(text).toContain('SVG element "path"');
      expect(text).not.toContain("Purpose:");
    });

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

    it("distinguishes identical markup elements on the same line", () => {
      const chunks = parseFile(
        "same-line.svg",
        "<svg><text>same</text><text>same</text></svg>",
      );
      const ids = chunks.map((chunk) => generateChunkId("same-line.svg", chunk));

      expect(chunks).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
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
