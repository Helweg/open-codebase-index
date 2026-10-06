# Current participant public-interface calibration, 2026-10-06

Status: **development-only calibration, not a competitive result**. This completes current-version initialization/readiness/query checks on an owned synthetic fixture. It does not acquire a participant study cohort, supply an independent approval, establish held-out quality, compare speed, or demonstrate coding productivity. The [dated evidence plan](2026-10-06-competitive-evidence-plan.md) remains the governing protocol.

## Exact inventory and isolation

Official metadata was refreshed on 2026-10-06; the advertised versions remained unchanged from the plan:

| Participant | Advertised version | Actually exercised installation |
|---|---|---|
| OCBI | `0.35.3` ([npm](https://www.npmjs.com/package/opencode-codebase-index), [release](https://github.com/Helweg/open-codebase-index/releases/tag/v0.35.3)) | Pre-existing local built `dist/cli.js`, MCP worker and Darwin ARM64 native module; hybrid and structural modes |
| CodeGraph | `1.6.2` ([npm](https://www.npmjs.com/package/@colbymchenry/codegraph)) | Exact npm wrapper plus `@colbymchenry/codegraph-darwin-arm64@1.6.2`; public platform executable |
| codebase-memory-mcp | `0.11.0` ([npm](https://www.npmjs.com/package/codebase-memory-mcp), [release](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.11.0)) | Exact npm package, followed by its official checksum-verifying `install.js`; public native executable |
| grepai | `0.37.0` ([release](https://github.com/yoanbernabeu/grepai/releases/tag/v0.37.0)) | Official `grepai_0.37.0_darwin_arm64.tar.gz` asset |

The OCBI package version was `0.35.3`; the checkout HEAD was `139608270fbb327e4dd56a0617dfda46cb1ba655`. The plan's accepted release reference is `261f5d0a9ac9b4ebb758326136aed0737b36b372`. **Local built bytes were not proven byte-identical to that release.** Actual CLI SHA-256: `dbe7bf8c435854d0e52a620e7acd926dd56e7368cfcf0918aff6f5d8932b2806`; MCP worker: `1568362917b01f17a29a0a28caf92f7c8f5591ad0951bd83ec233a16fe0b5438`. The artifact also pins the native module, entrypoint, Node binary and both existing adapter scripts.

All participant installations and fixture/index/home/cache/config/tmp directories were under a unique owned workspace outside the repository and preserved September study. No global installation, user index, global configuration or historical study lock was changed. Each condition used separate fresh roots for the graph and file-discovery interfaces. The original scripts were imported without modification; the temporary orchestration only materialized fixtures, invoked their public methods serially, and preserved observations. It did not score responses or implement another evaluator.

Runtime: Darwin `27.0.0` ARM64, Node `v26.9.0`, npm `11.19.1`, existing local Ollama `0.35.1`. Hybrid OCBI and grepai used loopback Ollama with existing `nomic-embed-text:latest`, digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f` (274,302,450 bytes). No model download was needed. Structural OCBI reported no embedding provider. No hosted embedding/source-upload interface was selected. Network traffic was not independently captured.

## Execution contract

One attempt per condition per interface, serial order:

1. OCBI hybrid
2. OCBI structural
3. CodeGraph
4. codebase-memory-mcp
5. grepai

Within each condition, graph calibration preceded file-discovery calibration on a **different fresh fixture copy**. Both interfaces ran their own initialization exactly once; this was not retrying a failed cell. Index calls were bounded at 300 seconds, queries at 60 seconds, and the outer job at 1,200 seconds. The job exited 0 in 66.42 seconds; that is an audit trace, **not comparable participant latency**. Requested hit/graph limit was 50; the existing file adapter retained at most ten distinct returned files. No refresh, mutation, branch-switch or external-writer scenario was run.

The five fixture files were `package.json`, `.gitignore`, `src/leaf.js`, `src/entry.js` and `python_ops.py`. The JavaScript wrapper imports and calls `calibrationLeaf`, which returns `value + 7`; Python supplies a separate leaf/wrapper pair. Exact bytes are published. Participant inputs contained explicit symbols and, for graph requests, the intentionally supplied paths. There were no hidden expected fields, real repository tasks, reference repairs or study sources.

Graph requests: leaf definition, leaf direct callers, entry direct callees, entry-to-leaf shortest path, and an absent definition. File requests: exact leaf symbol, `increment a value by seven through an entry wrapper`, and exact symbol `calibrationDefinitelyAbsent`.

## Observed public readiness and outputs

| Condition | Initialization/readiness | Observed graph/query evidence |
|---|---|---|
| OCBI hybrid | `index_codebase`: 3 files, 4 embedded chunks. Supplemental `index_status`: active branch catalog `ready`, 4 chunks, compatible Ollama/model. | Leaf definition and body; caller/callee edge `calibrationEntry → calibrationLeaf`; two-node path; absent definition returned empty. File symbol returned `src/leaf.js`; natural-language request returned three paths; absent symbol returned empty. |
| OCBI structural | `index_codebase`: 3 files, 4 structural chunks. Supplemental `index_status`: catalog `ready`, 4 chunks, provider `none`, structural compatibility. | Same observed exact-symbol definition and edge/path identities on this tiny fixture. Both structural and hybrid natural-language file responses returned `python_ops.py`, `src/entry.js`, `src/leaf.js` in that order. This is not a quality comparison or pure-BM25 claim. |
| CodeGraph | `init <root> --yes`: 3 files, 8 nodes, 9 edges. Supplemental `status <root> --json`: initialized, no pending changes, extraction version 27, `node-sqlite` backend. | Definition plus indexed body; direct callees and path included the wrapper-to-leaf edge. Direct callers also contained an `entry.js` file-node caller; retained without filtering it away. File symbol query returned `src/leaf.js`, then `src/entry.js`; absent symbol returned empty. |
| codebase-memory-mcp | MCP `index_repository`: `status: indexed`, 25 nodes, 27 edges, zero not-indexed/skipped/partial/unusable counts. CLI adapter separately indexed its fresh root. | `search_graph`, `trace_path` and graph endpoint resolution worked. Default `get_code_snippet` returned tree text and caused the **existing adapter's JSON parsing failure**. Original failure retained. File symbol returned `src/leaf.js`; absent symbol empty; natural-language request returned selected-adapter `unsupported`. |
| grepai | `init --yes --provider ollama --model nomic-embed-text --backend gob`, then foreground `watch --no-ui`. Logs contain initial scan complete, 4 files/4 chunks, 4 extracted symbols, `[RUNNING] ... - steady`, and watching. | Trace returned one leaf definition, the wrapper-to-leaf edge and path; absent trace definition empty. Semantic file search returned four paths for every request, including the fabricated absent symbol. This is a returned semantic-neighbor list, not an exact-symbol absence interface. |

Full response bodies, raw envelopes, requests, tool schemas, normalized graph identities, returned path lists and stderr are in the artifact. Successful orchestration does not mean every adapter response was successful: CBM's definition-body operation errored, and its selected natural-language mapping was unsupported.

### Preserved failures and interface limitations

- **CBM snippet mapping:** the advertised `get_code_snippet` schema defaults `format` to `tree`. The unmodified conformance driver omitted that argument but attempted JSON parsing. Its original error was `SyntaxError: Unexpected token 'a', "name: calib"... is not valid JSON`; the raw response had `isError: false` and contained the correct source as tree text. After retaining that error, a **separate supplemental CLI probe** added the documented `format: "json"` and returned structured identity/source successfully. This diagnoses a request-format mismatch, not an upstream inability to read source. No adapter was fixed, no original result replaced, and no scored retry occurred.
- **CBM natural language:** `unsupported` is the existing adapter's declared lack of a selected documented mapping. It is not evidence that upstream has no other natural-language capability.
- **grepai definitions:** trace exposes one root/signature, not exhaustive duplicate definitions or indexed body content. That limitation remains in provenance. Graph identity worked on the unique-symbol fixture only.
- **CodeGraph caller semantics:** the file-node caller remained in raw and normalized evidence; no cross-system exact-edge quality score was assigned.
- **OCBI version invocation:** a preliminary bare `node dist/cli.js --version` invocation timed out after 60 seconds with no stdout/stderr. It was not used as version proof. The subsequent explicit MCP launch, initialization and queries worked, and npm/package metadata supplied the version inventory. The timeout remains in command evidence.
- **Telemetry:** the CodeGraph conformance driver's isolated environment does not set telemetry/daemon off switches. Its stderr printed the anonymous-usage notice. The file-discovery adapter does set `CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK=1` and `CODEGRAPH_NO_DAEMON=1`. The [pinned upstream telemetry policy](https://github.com/colbymchenry/codegraph/blob/v1.6.2/TELEMETRY.md) states that source, paths, names and queries are not collected. This calibration does not independently certify network behavior.
- Freshness, truncation, duplicate symbols, large-file pagination, broader language coverage, matched context budgets and agent repair outcomes remain uncalibrated here. Small setup evidence cannot substitute for them.

## Published evidence and normalization

[Current participant calibration JSON](../../benchmarks/results/competitive-2026-10-06/current-participant-calibration.json), SHA-256:

```text
db88c314a7feeb8803183ccf26dad896eab079706163a1899e81c9c479ef47ce
```

The JSON embeds 107 evidence files, including both temporary orchestration/probe sources, all observed initialization/query envelopes and command logs, watcher logs, generated configuration, lockfile, complete metadata responses, supplemental probes and per-file original/normalized hashes. Useful evidence is preserved inside this artifact; temporary runnable scaffolds and owned installations were removed afterward.

**Normalization is explicit:** private absolute paths are replaced with `${PROJECT}`, `${WORK}`, `${USER_HOME}`, `${OLLAMA_HOME}` and `${NODE}`. CBM workspace-derived project/qualified-name prefixes use `${CBM_CONFORMANCE_PROJECT}` and `${CBM_FILE_PROJECT}` consistently. Those are presentation placeholders, not literal API inputs. Each embedded file has `originalSha256` for untouched local bytes and `normalizedSha256` for its published UTF-8 `content`. Public text is therefore **not byte-identical raw evidence**; original hashes alone cannot reconstruct private paths. Machine-derived project IDs must be obtained anew from `index_repository` when reproducing.

Release asset pins, each matching both the official advertised digest and downloaded bytes:

| Asset | SHA-256 |
|---|---|
| grepai Darwin ARM64 archive | `7ca7d771f8913265329f11c699137c887d29853d8d04e1610d3d93e0abd73427` |
| grepai checksums | `7c2d25c2512d04fec9cb3c9785aebf5c60e4b28bc58a038531738bc60980065c` |
| CBM Darwin ARM64 archive | `4dee7f38b63740e6751d7a7ed7eb10291c1f2a3ea2415f599dc68370ca0a2d18` |
| CBM checksums | `5e5a3b25c619ecf8f7349acf38d74f1989b4ec65dfae911d8ceb788969f1cf91` |

Exact npm tarball integrity values, URLs and platform package lock entries are in `packageMetadata` and the embedded lockfile. Metadata refreshing does not assert those versions will remain latest after this date.

## Reproduction

Prerequisites: a macOS ARM64 checkout with the **recorded built OCBI artifacts**, Node/npm, installed checkout dependencies including `tsx`, and a local Ollama endpoint already serving the recorded nomic model. Do not substitute a hosted provider or silently download an unbounded model. Different built/runtime bytes constitute a new calibration.

The original pre-fix adapter-script snapshot is commit `139608270fbb327e4dd56a0617dfda46cb1ba655`, with script hashes recorded in the artifact. Use that snapshot when reproducing the original observations; running the corrected current driver is a new calibration and must not overwrite the original evidence.

Create a unique workspace outside checkout/study roots and install exact tools locally:

```bash
export PROJECT=/path/to/opencode-codebase-index
export WORK=$(mktemp -d /private/tmp/ocbi-current-calibration-replay.XXXXXX)
mkdir -p "$WORK/tools/npm" "$WORK/tools/grepai" "$WORK/install-home" "$WORK/install-tmp"
export HOME="$WORK/install-home" TMPDIR="$WORK/install-tmp"
export npm_config_cache="$WORK/npm-cache"
export XDG_CACHE_HOME="$HOME/.cache" XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
npm install --prefix "$WORK/tools/npm" --ignore-scripts --no-audit --no-fund --save-exact \
  @colbymchenry/codegraph@1.6.2 \
  @colbymchenry/codegraph-darwin-arm64@1.6.2 \
  codebase-memory-mcp@0.11.0
node "$WORK/tools/npm/node_modules/codebase-memory-mcp/install.js"
curl -fLsS --max-time 60 \
  https://github.com/yoanbernabeu/grepai/releases/download/v0.37.0/grepai_0.37.0_darwin_arm64.tar.gz \
  -o "$WORK/grepai.tar.gz"
shasum -a 256 "$WORK/grepai.tar.gz" # must match the pinned digest above
# Inspect archive members before extracting only the fixed executable.
tar -tzf "$WORK/grepai.tar.gz"
tar -xzf "$WORK/grepai.tar.gz" -C "$WORK/tools/grepai" grepai
```

Extract the preserved calibration/probe sources, replacing only the workspace/checkout placeholders. The runner creates separate source roots, controlled configs and isolated participant environments itself:

```bash
node --input-type=module -e '
import fs from "node:fs";
const evidence = JSON.parse(fs.readFileSync(process.env.PROJECT + "/benchmarks/results/competitive-2026-10-06/current-participant-calibration.json", "utf8"));
for (const name of ["calibrate.ts", "readiness.mjs"]) {
  const file = evidence.evidenceFiles.find(entry => entry.path === "${WORK}/" + name);
  const source = file.content.replaceAll("${PROJECT}", process.env.PROJECT).replaceAll("${WORK}", process.env.WORK);
  fs.writeFileSync(process.env.WORK + "/" + name, source);
}
fs.writeFileSync(process.env.WORK + "/package.json", JSON.stringify({private:true,type:"module"}));
'
node "$PROJECT/node_modules/tsx/dist/cli.mjs" "$WORK/calibrate.ts"
node "$WORK/readiness.mjs"
```

Public launches retained by the existing contracts are:

- OCBI: `node dist/cli.js --project <source> --host opencode --config <owned-config>`; MCP initialize/tools-list, `index_codebase`, `implementation_lookup`, `call_graph`, `call_graph_path`, and file adapter `codebase_peek`. Supplemental readiness uses `index_status` on the existing index.
- CodeGraph: `init <source> --yes`, `query <symbol> --path <source> --limit 50 --json`, `node <symbol> --file <returned-path> --path <source>`, `callers`/`callees`, and file adapter `context --path <source> --format json --max-nodes 50 --no-code <question>`. Supplemental readiness uses `status <source> --json`.
- CBM: public stdio MCP initialize/tools-list, `index_repository`, `search_graph`, `get_code_snippet`, `trace_path`; file adapter uses `cli --json index_repository/search_graph <JSON>`. The supplemental snippet command is `cli --json get_code_snippet '{"project":"<actual returned project>","qualified_name":"<actual returned qn>","format":"json"}'` with the same isolated `CBM_CACHE_DIR`.
- grepai: `init --yes --provider ollama --model nomic-embed-text --backend gob`, foreground `watch --no-ui`, `trace callers/callees/graph <symbol> --json` (graph depth 10), and `search <query> --limit 50 --json --compact`.

Use the artifact's exact command arguments and isolated environment for supplemental commands; preserve every new failure rather than selecting a successful rerun. Cleanup only the newly owned workspace after retaining its evidence. No tests, builds, linters or formatters were run for this assignment. Runtime calibration is the evidence above; an independently reviewed fresh study and successful controlled broker/evaluator feasibility are still separate prerequisites for later claims.

## Post-calibration adapter correction

The original observations above and their 107-file evidence package are retained unchanged. After diagnosing the snippet-format mismatch, `CbmDriver` was corrected to pass `format: "json"` to `get_code_snippet`, matching its existing JSON parser and the format already requested by its graph/trace calls. Exact qualified-name, file-path and source-content validation is unchanged.

A separate, one-attempt correction smoke installed the same `codebase-memory-mcp@0.11.0` in a new isolated workspace, recreated the exact five-file fixture and repeated all five graph request families on one fresh index. All five returned `success`: leaf definition/body, direct callers, direct callees, shortest path and absent definition. The leaf identity was `src/leaf.js` / `calibrationLeaf`, its returned body matched the actual fixture bytes, the path was `calibrationEntry → calibrationLeaf`, and the absent definition remained empty.

[Correction evidence](../../benchmarks/results/competitive-2026-10-06/cbm-snippet-format-correction.json) preserves the actual requests/responses, 16 command evidence records, package lock, harness and before/after script hashes with disclosed path/project-ID normalization. This is a documented development adapter repair, not a selective rerun or replacement of a scored study cell. The real native API smoke establishes upstream behavior.

An offline stdio-protocol regression fixture models the observed tree-default/JSON-opt-in response encodings and exercises the real SDK transport and driver. Assertions check decoded indexed source and rejection of a mismatched snippet file, not merely forwarded options. Both cases fail with the original JSON-decoding error when the format correction is temporarily removed and pass with it restored. These automated controls are not represented as native upstream runs.

The [broker/evaluator feasibility probe](2026-10-06-broker-evaluator-feasibility.md) separately establishes edit/evaluation mechanics, but its single capped model attempt produced no repair. Fresh study approval and model-produced valid repair evidence remain prerequisites for the corresponding later claims.
