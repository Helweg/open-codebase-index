#!/usr/bin/env python3
"""Run before any participant query, on the original pinned archives and QA."""
import hashlib, importlib, json, pathlib, sys, tarfile
from tree_sitter import Language, Parser
root = pathlib.Path(sys.argv[1])
load = lambda p: json.loads((root / p).read_text())
lock = load('inputs/source-lock.json')
langs = {'fastify':('javascript','language'),'hono':('typescript','language_typescript'),'typer':('python','language'),'gin':('go','language'),'clap':('rust','language'),'moshi':('kotlin','language'),'csvhelper':('c_sharp','language'),'monolog':('php','language_php'),'rack':('ruby','language')}
allowed = {'function_declaration','variable_declarator','class_declaration','function_definition','class_definition','method_declaration','function_item','struct_item','trait_item','class'}
def nodes(node):
    yield node
    for child in node.named_children:
        yield from nodes(child)
gold = []
for repo in lock['repositories']:
    name = repo['name']
    archive = root / 'archives' / f"{name}-{repo['revision']}.tar"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == repo['archiveSha256']
    src = root / 'gold-sources' / name
    src.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(src, filter='data')
    mod, fn = langs[name]
    parser = Parser(Language(getattr(importlib.import_module('tree_sitter_' + mod), fn)()))
    cur = {t['id']: t for t in load(f'inputs/curation/{name}.json')['tasks']}
    for q in load(f'inputs/datasets/{name}.json')['queries']:
        sym = q.get('args', {}).get('symbol')
        if not sym:
            continue
        t = cur[q['id']]
        fp = q['expected']['filePath']
        b = (src / fp).read_bytes()
        original_hash = t.get('gold', {}).get('sha256', t.get('goldFileSha256'))
        assert hashlib.sha256(b).hexdigest() == original_hash
        tree = parser.parse(b)
        matches = [n for n in nodes(tree.root_node) if n.type in allowed and n.child_by_field_name('name') and n.child_by_field_name('name').text.decode() == sym]
        assert len(matches) == 1, (q['id'], len(matches))
        n = matches[0]
        assert not n.has_error
        start, end = n.start_point.row + 1, n.end_point.row + 1
        body = '\n'.join(b.decode().splitlines()[start-1:end])
        raw = t.get('gold', {}).get('lineRanges', []) or [t.get('gold', {}).get('lineRange', t.get('lineRange'))]
        raw = list(raw) + t.get('supportingLineRanges', [])
        ranges = [r if isinstance(r, list) else [r.get('startLine',r.get('start')),r.get('endLine',r.get('end'))] for r in raw if r]
        gold.append({'repository':name,'queryId':q['id'],'symbol':sym,'filePath':fp,'sourceSha256':hashlib.sha256(b).hexdigest(),'nodeType':n.type,'startLine':start,'endLine':end,'body':body,'bodySha256':hashlib.sha256(body.encode()).hexdigest(),'originalQA':t,'originalEvidenceRanges':ranges,'fullDeclarationDerivation':'Unique named declaration node selected by independent Python Tree-sitter parser; node has no parse errors; whole inclusive source lines retained, including all declaration body lines. Original QA supporting ranges are distinct evidence, not exact declaration gold.'})
assert len(gold) == 54
(root / 'explicit-gold.json').write_text(json.dumps(gold, indent=2) + '\n')
