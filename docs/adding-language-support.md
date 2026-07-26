# Adding Language Support

This guide is meant to be usable by both humans and coding agents.

## Agent-ready brief

If you want an agent to implement a new language, give it this guide plus a request like:

> Add semantic parsing support for `<language>`.
> If the grammar makes call extraction practical, add `call_graph` support too.
> Update tests and docs, then run `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run test:run`.

The agent should treat this as a staged task:

1. confirm file discovery
2. register the language
3. add parser support
4. add parser tests
5. verify
6. optionally add call-graph support
7. update docs
8. re-run verification

## The only caveat

This guide removes **repo-specific** guesswork. It does **not** replace knowledge of the target language’s tree-sitter grammar.

The implementer still needs to know or look up:

- the grammar crate
- the parser constant
- the node kinds for declarations, comments, and calls
- the grammar license, release history, and compatibility with the repository's tree-sitter runtime

So this guide is a **repo wiring guide**, not a replacement for the target language's tree-sitter grammar docs.

## Pick the support level first

There are three support levels in this repo:

1. **File discovery only** — files are indexed, but may fall back to line-based chunking
2. **Semantic parsing** — tree-sitter extracts better chunks for search
3. **Call graph support** — `call_graph` can extract callers/callees too

If you are unsure, aim for **semantic parsing first**. It is much easier to land than full call-graph support.

## Definition of done

### Semantic parsing support is done when:

- the language is registered in `native/src/types.rs`
- files in that language are discovered by the indexer
- `native/src/parser.rs` uses the correct tree-sitter grammar
- semantic chunks are produced for the main declaration types
- `tests/native.test.ts` covers the language
- the grammar license is verified and its notice is included in the published package when required
- every new grammar dependency has a locked entry and verified runtime compatibility
- docs are updated if user-facing support claims changed
- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run test:run` all pass

### Call-graph support is done when:

- a `native/queries/<language>-calls.scm` file exists
- `native/src/call_extractor.rs` routes the language correctly
- `src/indexer/index.ts` includes the language in `CALL_GRAPH_LANGUAGES`
- `src/indexer/index.ts` includes the relevant declaration chunk types in `CALL_GRAPH_SYMBOL_CHUNK_TYPES`
- `tests/call-graph.test.ts` covers the supported call/query forms
- full verification passes again

## Files to change

### Always relevant

- `src/config/constants.ts` — file extensions included in indexing
- `native/src/types.rs` — language enum and string/extension mapping
- `native/src/parser.rs` — tree-sitter parser wiring, semantic node kinds, comment kinds
- `tests/native.test.ts` — parser coverage

### Only for call-graph support

- `native/src/call_extractor.rs` — call extraction routing
- `native/queries/<language>-calls.scm` — tree-sitter query file
- `src/indexer/index.ts` — call-graph language + symbol chunk-type allowlists
- `tests/call-graph.test.ts` — call-graph coverage

### Only when adding a grammar dependency

- `native/Cargo.toml` — grammar crate declaration
- `native/Cargo.lock` — reproducibly resolved version
- the repository license or third-party notices file — attribution required by the dependency license
- `package.json` — inclusion of a new notices file in the published package, when applicable

### Usually update too

- `README.md` — supported-language claims

## Recommended order

1. **Confirm file discovery** in `src/config/constants.ts`
2. **Register the language** in `native/src/types.rs`
3. **Add parser support** in `native/src/parser.rs`
4. **Add one parser test** in `tests/native.test.ts`
5. Run `npm run build` and `npm run test:run`
6. Only then add **call-graph support**
7. Update docs

That order keeps failures easy to localize.

## Fast implementation checklist

Use this exact sequence:

- [ ] Check whether the extensions are already present in `src/config/constants.ts`
- [ ] Add the language to `Language`, `from_extension()`, `as_str()`, and `from_string()` in `native/src/types.rs`
- [ ] Add the grammar crate in `native/Cargo.toml` if needed
- [ ] Check the license text, release history, registry publication, and tree-sitter ABI compatibility of the grammar
- [ ] Update `native/Cargo.lock` and distribute required third-party attribution when a grammar crate is added
- [ ] Add parser selection, comment node kinds, and semantic node kinds in `native/src/parser.rs`
- [ ] Add one parser test in `tests/native.test.ts`
- [ ] Run `npm run build` and `npm run test:run`
- [ ] If call graph is needed, add `native/queries/<language>-calls.scm`
- [ ] Wire the language into `native/src/call_extractor.rs`
- [ ] Add the language and chunk types to `src/indexer/index.ts`
- [ ] Add call-graph tests in `tests/call-graph.test.ts`
- [ ] Update `README.md` if supported-language claims changed
- [ ] Verify the third-party notice with `npm pack --dry-run --ignore-scripts`
- [ ] Run full verification: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test:run`

## What each file needs

### `src/config/constants.ts`

Add extensions **only if they are not already included**.

Important: discovery here does **not** mean semantic parsing is supported.

### `native/src/types.rs`

Add the language to:

- `Language`
- `from_extension()`
- `as_str()`
- `from_string()`

This is the canonical registry.

### `native/src/parser.rs`

Add the language in three places:

- parser selection in `parse_file_internal()`
- `is_comment_node()`
- `is_semantic_node()`

Start with narrow, declaration-like nodes:

- functions
- methods
- classes / structs
- interfaces / traits
- enums
- modules / namespaces

Avoid broad container nodes unless the grammar gives you no better option.

If a wrapper such as a template or namespace contains declarations, check whether marking it semantic prevents traversal from reaching the functions or types being sought.

### `tests/native.test.ts`

Add a small test proving the main declaration type becomes a chunk.

## Call-graph support checklist

If the language should support `call_graph`, do all of this:

### `native/queries/<language>-calls.scm`

Create a query file modeled after the existing ones.

Use the same capture names already expected by `native/src/call_extractor.rs`:

- `@callee.name`
- `@call`
- `@constructor`
- `@import.name`
- `@import.default`
- `@import.namespace`

For C-family languages, the extractor also supports conservative exclusion captures:

- `@excluded.name` for macros and inline function-pointer declarators that must not become direct-call edges
- `@indirect.type`, `@indirect.variable_type`, and `@indirect.variable` for connecting an indirect function-type alias to variables declared with that alias

Start small:

- direct calls
- method/member calls
- imports/includes if applicable

### `native/src/call_extractor.rs`

Add the language to:

- parser selection
- query-source selection
- `method_parent_kinds` if needed

### `src/indexer/index.ts`

Add the language to `CALL_GRAPH_LANGUAGES` and add relevant declaration chunk types to `CALL_GRAPH_SYMBOL_CHUNK_TYPES`.

Those chunk-type strings must match the tree-sitter node kinds that actually become chunks in `native/src/parser.rs`.

### `tests/call-graph.test.ts`

Add focused tests for the constructs your query file supports.

When the grammar is ambiguous, add negative fixtures as well. In particular, verify that declarations, local macros, explicit template calls, and function-pointer invocations do not become ordinary direct calls in the graph.

## Common failure modes

### Files are indexed, but results are poor

The extension is included, but the language is not wired in `types.rs` and `parser.rs`, so indexing falls back to line-based chunks.

### Build fails after adding a grammar crate

Usually the crate name, parser constant, or grammar version is wrong.

### Parsing works, but chunks are noisy or missing

`is_semantic_node()` is using the wrong node kinds.

### Comments do not attach to chunks

`is_comment_node()` is using the wrong comment node kinds.

### `extract_calls()` returns nothing

The query file, query registration, or query node names do not match the grammar.

Also check that the query capture names match what `native/src/call_extractor.rs` expects.

### Call extraction works, but `call_graph` is still empty

The language is missing from `CALL_GRAPH_LANGUAGES` or its symbol chunk types are missing from `CALL_GRAPH_SYMBOL_CHUNK_TYPES` in `src/indexer/index.ts`.

## Verification

Run:

```bash
npm run build
npm run typecheck
npm run lint
npm run test:run
```

For partial progress while implementing, the minimum useful checkpoint is:

```bash
npm run build
npm run test:run
```

## Practical note for PHP

PHP is already integrated at all three levels: file discovery, semantic parsing, and call graph extraction. Changes must therefore preserve `native/src/types.rs`, `native/src/parser.rs`, `native/queries/php-calls.scm`, `src/indexer/index.ts`, and their tests together.

A `parseFile()` content assertion alone does not prove syntax compatibility because Tree-sitter can return chunks while the tree still contains `ERROR` nodes. PHP grammar tests must also assert `!tree.root_node().has_error()` in Rust, then verify the chunk names and types exposed through NAPI.

Call graph tests must distinguish an invocation from a first-class callable reference. For example, `foo(...)` is not a call unless it is used as an operand of the PHP 8.5 pipe operator `|>`.

The tested matrix and remaining `tree-sitter-php` 0.24.2 limitations are documented in the README's "Verified PHP 8.x compatibility" section.

## Metal implementation note

Metal uses a dedicated `Language::Metal` label while reusing the existing C++ grammar. This avoids a fragile new dependency, but still requires Metal-specific semantic nodes, declaration-name extraction, and a call query. Tests must cover short types, nested methods, exact function names under templates, and shader-stage qualifiers; a successfully built tree is not enough because tree-sitter recovery nodes can remain around Metal-specific syntax. Macro-only regions should be checked separately too: in a mixed file, regions not covered by a semantic declaration may remain outside chunks.

## One-line summary

If you know how to inspect a tree-sitter grammar, this guide should be enough to add a language in this repo without guessing where the plumbing lives.
