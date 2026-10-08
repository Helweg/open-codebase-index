#!/usr/bin/env node
// Real registry-package participants; no imports from repository source builds.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
const exec = promisify(execFile);
const root = await fs.realpath(process.argv[2]);
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const sha = b => createHash('sha256').update(b).digest('hex');
const save = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(v, null, 2) + '\n'); };
const protocol = await json(path.join(root, 'protocol.json'));
if (!await fs.stat(path.join(root, 'BUILD_GATE_COMPLETE')).catch(() => false)) throw new Error('Parent build gate missing');
for (const item of protocol.bindings) if (sha(await fs.readFile(path.join(root, item.path))) !== item.sha256) throw new Error(`Frozen binding changed: ${item.path}`);
const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json();
if (!tags.models.some(m => m.name === protocol.model.name && m.digest === protocol.model.digest)) throw new Error('Frozen local model changed');
const { Client } = await import(pathToFileURL(path.join(root, 'packages/0.36.1/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(root, 'packages/0.36.1/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const output = path.join(root, 'run');
await fs.mkdir(output); // Refuse overwriting or repeating an executed study.
await save(path.join(output, 'start.json'), { startedAt: new Date().toISOString(), protocolSha256: sha(await fs.readFile(path.join(root, 'protocol.json'))), command: [process.execPath, ...process.argv.slice(1)], gate: await fs.readFile(path.join(root, 'BUILD_GATE_COMPLETE'), 'utf8') });
async function bounded(operation, ms) { let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline ${ms}ms exceeded`)), ms); })]); } finally { clearTimeout(timer); } }
function text(raw) { if (raw?.isError) throw new Error('MCP isError=true'); if (!Array.isArray(raw?.content)) throw new Error('Missing MCP content'); const value = raw.content.map(c => { if (c.type !== 'text' || typeof c.text !== 'string') throw new Error('Non-text MCP content'); return c.text; }).join('\n'); if (Buffer.byteLength(value) > protocol.budgets.maxOutputBytes) throw new Error('Output budget exceeded'); return value; }
async function citations(raw, source) {
  const value = text(raw); const hits = []; let fenced = false;
  for (const line of value.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^\[(\d+)\]\s+.+?\s+(?:at|in)\s+(.+?):(\d+)(?:-(\d+))?(?:\s|$)/.exec(line);
    if (!m) continue;
    const abs = await fs.realpath(path.resolve(source, m[2])); const rel = path.relative(source, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Outside source: ${m[2]}`);
    const bytes = await fs.readFile(abs); const lines = bytes.toString('utf8').split(/\r?\n/);
    const startLine = Number(m[3]), endLine = Number(m[4] ?? m[3]);
    hits.push({ rank: Number(m[1]), path: rel.split(path.sep).join('/'), startLine, endLine, rangeValid: startLine > 0 && endLine >= startLine && endLine <= lines.length, sourceSha256: sha(bytes), citedSourceBody: lines.slice(startLine - 1, endLine).join('\n') });
  }
  if (!hits.length && !/^No (?:matching code|definition found)/.test(value.trim())) throw new Error('Nonempty result lacks numbered citations');
  return { paths: [...new Set(hits.map(h => h.path))].slice(0, 10), hits, text: value };
}
const rows = [], cells = [];
for (const spec of protocol.schedule) {
  const dir = path.join(output, spec.repository, `${spec.version}-${spec.mode}`), source = path.join(dir, 'source');
  await fs.mkdir(source, { recursive: true });
  const repo = protocol.repositories.find(r => r.name === spec.repository);
  await exec('/usr/bin/tar', ['-xf', path.join(root, 'archives', `${repo.name}-${repo.revision}.tar`), '-C', source], { timeout: 30000 });
  const configPath = path.join(dir, 'config.json');
  await save(configPath, { ...protocol.configuration, indexing: { ...protocol.configuration.indexing, mode: spec.mode } });
  const home = path.join(dir, 'home'), tmp = path.join(dir, 'tmp');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(tmp);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmp, XDG_CACHE_HOME: path.join(home, '.cache'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  const args = [path.join(root, `packages/${spec.version}/node_modules/open-codebase-index/dist/cli.js`), '--project', source, '--host', 'opencode', '--config', configPath];
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: source, env, stderr: 'pipe' });
  const client = new Client({ name: 'published-release-paired-comparison', version: '1' });
  let stderr = '', connected = false, setupError = null, connectionMs = null, indexMs = null;
  let indexRaw = null;
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const setupStart = performance.now();
  const records = [];
  async function call(name, arguments_, timeout) {
    const request = { name, arguments: arguments_ }, started = performance.now();
    const record = { request, startedAt: new Date().toISOString() }; records.push(record);
    try { record.raw = await client.callTool(request, undefined, { timeout }); record.durationMs = performance.now() - started; text(record.raw); return record.raw; }
    catch (error) { record.durationMs = performance.now() - started; record.error = String(error); throw error; }
  }
  try {
    await bounded((async () => {
      const start = performance.now(); await client.connect(transport); connected = true; connectionMs = performance.now() - start;
      const indexStart = performance.now(); indexRaw = await call('index_codebase', { force: true }, protocol.budgets.indexTimeoutMs); indexMs = performance.now() - indexStart;
    })(), protocol.budgets.indexTimeoutMs);
  } catch (error) { setupError = String(error); await transport.close().catch(() => {}); connected = false; }
  const cell = { ...spec, command: [process.execPath, ...args], environment: env, setupMs: performance.now() - setupStart, connectionMs, indexMs, setupError, embeddingWork: null, embeddingWorkReason: 'Provider request/text/token counts not independently instrumented; no proxy or configuration change', sourceArchiveSha256: repo.archiveSha256, coldIndex: true, initialization: 'Fresh MCP process and index; same pre-existing resident Ollama model; no excluded query warmup' };
  const indexText = !setupError && indexRaw ? text(indexRaw) : '';
  const numberFrom = regex => { const match = regex.exec(indexText); return match ? Number(match[1].replaceAll(',', '')) : null; };
  cell.apiReportedIndexWork = {
    source: 'Successful public index_codebase tool response; product-reported counters, not independently measured backend requests/tokens/computation/retries',
    processedFiles: numberFrom(/([\d,]+) files processed/),
    embeddedChunks: spec.mode === 'hybrid' ? numberFrom(/([\d,]+) new chunks embedded/) : null,
    tokenCount: spec.mode === 'hybrid' ? numberFrom(/Tokens:\s*([\d,]+)/) : null,
    structuralChunks: spec.mode === 'structural' ? numberFrom(/([\d,]+) structural chunks indexed/) : null,
    productDurationSeconds: numberFrom(/Duration:\s*([\d.]+)s/),
    failedEmbeddingChunks: numberFrom(/INDEXING WARNING:\s*([\d,]+) chunks failed to embed/),
    unavailableReason: setupError ? 'Setup failed or timed out; absent counters are N/A' : 'Absent/unparseable or structural non-embedding counters are N/A, not zero',
  };
  if (connected) try { cell.statusBefore = await call('index_status', {}, protocol.budgets.queryTimeoutMs); } catch (error) { cell.statusError = String(error); }
  const dataset = await json(path.join(root, 'inputs/datasets', repo.dataset)); const queryMap = new Map(dataset.queries.map(q => [q.id, q]));
  for (let pass = 1; pass <= 3; pass++) for (const queryId of spec.queryOrder) {
    const q = queryMap.get(queryId); const symbol = q.args?.symbol;
    const request = { name: symbol ? 'implementation_lookup' : 'codebase_peek', arguments: { query: symbol ?? q.query, limit: 50 } };
    const row = { repository: repo.name, version: spec.version, mode: spec.mode, queryId, track: symbol ? 'explicit' : 'natural', pass, request, status: 'error', paths: [], hits: [], queryMs: null, firstRealQuery: pass === 1 && queryId === spec.queryOrder[0], setupFailure: !!setupError };
    if (!setupError) {
      const start = performance.now();
      try { row.raw = await call(request.name, request.arguments, protocol.budgets.queryTimeoutMs); row.queryMs = performance.now() - start; Object.assign(row, await citations(row.raw, source)); row.status = 'success'; }
      catch (error) { row.queryMs = performance.now() - start; row.error = String(error); row.raw = records.at(-1)?.raw ?? null; }
    } else row.error = `Cell setup failed; not issued, supported failure penalty: ${setupError}`;
    rows.push(row); await save(path.join(dir, `query-${pass}-${queryId}.json`), row);
  }
  if (connected) try { cell.statusAfter = await call('index_status', {}, protocol.budgets.queryTimeoutMs); } catch (error) { cell.statusAfterError = String(error); }
  await client.close().catch(() => {}); await transport.close().catch(() => {});
  await fs.writeFile(path.join(dir, 'stderr.log'), stderr); await save(path.join(dir, 'requests.json'), records); await save(path.join(dir, 'cell.json'), cell);
  cells.push(cell); console.log(JSON.stringify({ finished: cells.length, repository: repo.name, version: spec.version, mode: spec.mode, setupError, setupMs: cell.setupMs }));
}
if (cells.length !== 36 || rows.length !== 1200 || rows.filter(r => r.pass === 1).length !== 400) throw new Error('Incomplete expected records');
await save(path.join(output, 'cells.json'), cells); await save(path.join(output, 'rows.json'), rows);
await save(path.join(output, 'completed.json'), { completedAt: new Date().toISOString(), cells: cells.length, primaryRows: 400, queryPassRecords: rows.length });
