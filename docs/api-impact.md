# API impact evidence in pre-edit context

Pass `includeApiImpact: true` to `codebase_edit_context` to request a bounded API evidence section in addition to the existing implementation, callers and callees. The option is available through MCP, OpenCode and Pi and is off by default.

```json
{
  "query": "change the create-user response",
  "symbol": "createUser",
  "filePath": "src/server.ts",
  "includeApiImpact": true,
  "tokenBudget": 1200
}
```

## What the evidence means

- `syntactic_route_registration`: a supported local Express registration associates a literal method/path with the resolved handler.
- `exact_relative_fetch_match`: an indexed JS/TS file contains a supported literal relative `fetch` request with the same method/path.
- `candidate_test_file`: the matching file is classified as a test. This is not proof that the test runs, passes, or covers the handler at runtime.

These associations are not persisted as resolved call-graph edges. Existing unresolved calls remain unresolved unless the ordinary graph resolver independently resolves them. Source file and line citations let an agent verify each association before editing.

## Deliberate limits

The first implementation supports a restricted Express/relative-fetch workflow, not general framework discovery. Imported handlers, routers and mount prefixes, dynamic paths or methods, wrapper clients, base URLs and cross-file handler association are unsupported. Ambiguous duplicate route signatures are labeled rather than silently treated as unique.

The scan considers active-branch indexed JS/TS file paths, including files without named graph symbols. It reads at most 200 candidate files, with a 256 KiB per-file limit, and displays at most 20 consumer matches. Paths escaping the project root are rejected. The complete response still obeys the existing token budget, so a small budget may omit evidence. Absence of a match is not proof that no consumer exists, particularly when a cap or unsupported syntax applies.

An unindexed or missing branch must be indexed normally before its evidence can be retrieved. The scan reads eligible files from the current tree, so it is not a historical contract snapshot or a guarantee that the index matches every current source byte.

## Validation scope

A small running Express application returned HTTP 201 and the built public OpenCode tool identified its local handler, a symbol-free top-level consumer and a conventional test callback. Conservative syntax and host-contract cases are covered separately by regression tests. This does not establish broad framework coverage or completed coding-task success. See [implementation validation](reliable-change-context-validation.md) for current observations and remaining gates.
