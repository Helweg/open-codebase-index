#!/usr/bin/env python3
"""Post-run byte/provenance verification only; never query or rescore participants."""
import hashlib, json, pathlib, sys, urllib.request
root = pathlib.Path(sys.argv[1])
load = lambda rel: json.loads((root/rel).read_text())
sha = lambda b: hashlib.sha256(b).hexdigest()
protocol = load('protocol.json')
for item in protocol['bindings']:
    assert sha((root/item['path']).read_bytes()) == item['sha256'], item['path']
closure=load('dependency-byte-inventory.json')
for item in closure:
    assert sha((root/item['path']).read_bytes()) == item['sha256'], item['path']
rows=load('run/rows.json')
manifests={repo['name']:{f['path']:f for f in load('inputs/source-manifests/'+repo['name']+'.json')['files']} for repo in protocol['repositories']}
source_cache={}
hit_count=0
for row in rows:
    for hit in row['hits']:
        pin=manifests[row['repository']][hit['path']]
        assert pin['sha256'] == hit['sourceSha256']
        key=(row['repository'],hit['path'])
        if key not in source_cache:
            b=(root/'gold-sources'/key[0]/key[1]).read_bytes()
            assert sha(b) == pin['sha256']
            source_cache[key]=b.decode().splitlines()
        expected='\n'.join(source_cache[key][hit['startLine']-1:hit['endLine']])
        assert hit['rangeValid'] and expected == hit['citedSourceBody']
        hit_count+=1
with urllib.request.urlopen('http://127.0.0.1:11434/api/tags') as response:
    tags=json.load(response)
assert any(m['name']==protocol['model']['name'] and m['digest']==protocol['model']['digest'] for m in tags['models'])
receipt={'schemaVersion':1,'frozenBindingsUnchanged':len(protocol['bindings']),'dependencyFilesByteUnchanged':len(closure),'queryPassRecords':len(rows),'primaryRows':sum(r['pass']==1 for r in rows),'cells':len(load('run/cells.json')),'supportedQueryErrors':sum(r['status']=='error' for r in rows),'setupErrors':sum(bool(c['setupError']) for c in load('run/cells.json')),'pinnedSourceCitationsVerified':hit_count,'distinctPinnedSourceFilesVerified':len(source_cache),'rangesSourceContained':True,'modelTagDigestUnchanged':protocol['model']['digest'],'consumerBodyLimit':'This verifies pinned citation source slices, NOT full consumer-body completeness; separately frozen scorer checks actual returned bodies without reconstructing omitted/truncated text.'}
(root/'evidence-verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
