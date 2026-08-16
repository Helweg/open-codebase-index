---
name: codebase-search
description: Semantic code and documentation search by meaning. Use codebase_peek to find WHERE code is (saves tokens), codebase_search to see actual code. For exact identifiers, use grep instead. Search local codebase before using websearch for code/library/API/example questions.
---

# Codebase Search Skill

## Important: Indexed Content

The indexed codebase contains **two types of content**:

1. **Project Source Code** — all code files in the current workspace
2. **Knowledge Base Documentation** — external documentation, usage guides, API references, and example programs added via `add_knowledge_base`

## When to Use What

| Scenario | Tool | Why |
|----------|------|-----|
| Code/library/API question | `codebase_search` | Search local knowledge first |
| Just need file locations | `codebase_peek` | Metadata only, saves ~90% tokens |
| Need to see actual code | `codebase_search` | Returns full code content |
| Find duplicates/patterns | `find_similar` | Given code snippet → similar code |
| Understand code flow | `call_graph` | Find callers/callees of any function |
| Trace dependency paths | `call_graph_path` | Find a shortest known path between two symbols |
| Analyze PR blast radius | `pr_impact` | Find affected symbols, communities, hub nodes, and risk |
| Don't know function/class names | `codebase_peek` or `codebase_search` | Natural language → code |
| Know exact identifier names | `grep` | Faster, more precise |
| Need ALL occurrences | `grep` | Semantic returns top N only |
| Access specific URL | `webfetch` | Direct URL access, no codebase search needed |
| Local search fails | `websearch` | Fallback when codebase has no results |
| Local and web search fails | suggest adding knowledge base | Notify user to add related folder |

## Search Rule

**Search local codebase first, then web search if needed.**

```
Question received
    ↓
Is this about code/library/API/framework?
    ↓ YES
codebase_search(query)
    ↓
Found relevant results? → YES → Return answer
    ↓ NO
websearch(query)
    ↓
Found relevant results? → YES → Return answer
    ↓ NO
Suggest: "知识库中未找到相关信息，是否添加相关文档文件夹？"
```

1. Use `codebase_search` for code/library/API questions
2. If no relevant results → use `websearch`
3. If web search also fails → suggest adding a knowledge base folder

## Recommended Workflow

1. **Locate by meaning first**: `codebase_peek("authentication flow")` → get likely locations before grep or graph tools
2. **Search with content**: `codebase_search("ADC channels ESP32")` → inspect implementation or knowledge-base matches
3. **Read what matters**: `Read` the specific files you need
4. **Trace structure after discovery**: `call_graph`, `call_graph_path`, `pr_impact`, or OMO CodeGraph once you know the relevant symbol
5. **Drill down with grep**: `grep "validateToken"` for exact matches

## Tools

### `codebase_peek`
Find WHERE code is. Returns metadata only (file, line, name, type).

```
codebase_peek(query="validation logic", chunkType="function", directory="src/utils")
codebase_peek(query="authentication flow", blameAuthor="jane@example.com")
```

### `codebase_search`
Find code with full content. Use when you need to see implementation.

```
codebase_search(query="error handling middleware", fileType="ts", contextLines=2)
codebase_search(query="rate limiter", blameSince="2025-01-01", blameUntil="2025-01-31")
```

### `find_similar`
Find code similar to a given snippet. Use for duplicate detection, pattern discovery, refactoring.

```
find_similar(code="function validate(input) { return input.length > 0; }", excludeFile="src/current.ts", blameSince="2025-01-01")
```

### `call_graph`
Query callers or callees of a function/method.

```
call_graph(name="validateToken", direction="callers")
```

### `index_codebase`
Manually trigger indexing. Required before first search.

### `index_status`
Check if indexed and ready.

### `add_knowledge_base`
Add a folder as a knowledge base. The folder will be indexed alongside project code.

```
add_knowledge_base(path="/path/to/docs")
```

### `list_knowledge_bases`
List all configured knowledge base folders.

### `remove_knowledge_base`
Remove a knowledge base folder from the index.

```
remove_knowledge_base(path="/path/to/docs")
```

## Query Tips

**Describe behavior, not syntax:**
- Good: `"function that hashes passwords securely"`
- Bad: `"hashPassword"` (use grep for exact names)

**Search across documentation:**
- Good: `"how to configure WiFi in ESP-IDF"`
- Good: `"GPIO initialization example"`

## Filters

| Filter | Example |
|--------|---------|
| `chunkType` | `function`, `class`, `interface`, `type`, `method` |
| `directory` | `"src/api"`, `"tests"` |
| `fileType` | `"ts"`, `"py"`, `"rs"` |
| `blameAuthor` | `"jane@example.com"` or `"Jane Doe"` |
| `blameSha` | `"abc1234"` |
| `blameSince` | `"2025-01-01"` |
| `blameUntil` | `"2025-01-31"` |
