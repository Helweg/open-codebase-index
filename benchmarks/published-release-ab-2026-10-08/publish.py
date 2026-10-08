#!/usr/bin/env python3
"""Publish complete normalized replay, without changing frozen historical files."""
import csv, gzip, hashlib, io, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
worktree = pathlib.Path(sys.argv[2])
out = worktree / 'benchmarks/results/published-release-ab-2026-10-08'
out.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()
normalize = lambda text: text.replace(str(root),'${PRIVATE_WORK}').replace(str(worktree),'${COMPARISON_WORKTREE}').replace('/Users/kenneth','${USER_HOME}')
def member(p):
    raw = p.read_bytes()
    content = normalize(raw.decode())
    return {'path':str(p.relative_to(root)),'originalSha256':sha(raw),'sha256':sha(content.encode()),'content':content}
completed = json.loads((root/'run/completed.json').read_text())
assert completed['cells']==36 and completed['primaryRows']==400 and completed['queryPassRecords']==1200
paths = [root / rel for rel in ['protocol.json','explicit-gold.json','analysis.json','scored-primary.json','package-evidence.json','runtime.json','historical-before.json','run/rows.json','run/cells.json','run/completed.json','run/start.json']]
paths += list((root/'inputs/datasets').glob('*.json'))
paths += list((root/'programs').glob('*'))
for name in ['requests.json','stderr.log','cell.json','config.json']:
    paths += list((root/'run').glob('*/*/'+name))
files = [member(p) for p in sorted(set(paths)) if p.is_file()]
package = {'schemaVersion':1,'kind':'development-exposed-published-release-regression-comparison','independentlyReviewed':False,'normalization':'Private paths replaced with placeholders; original and normalized hashes separately reported. Source archives and verified registry/native/dependency bytes retained privately or represented by frozen public identities, not redistributed. Replay is analysis replay, not a portable timing or model/index runtime image.','files':files}
evidence = gzip.compress(json.dumps(package,indent=2).encode(),mtime=0)
(out/'results-evidence.json.gz').write_bytes(evidence)
(out/'report.json').write_text(normalize((root/'analysis.json').read_text()))
primary = json.loads((root/'scored-primary.json').read_text())
metric_names = ['hitAt1','hitAt5','mrrAt10','ndcgAt10','declarationRangeAt5','completeDeclarationBodyAt5','targetIdentityAt5','originalEvidenceOverlapAt5','exactCitedBodyAt5']
stream=io.StringIO()
writer=csv.DictWriter(stream,fieldnames=['repository','version','mode','queryId','track','status','queryMs','firstRealQuery','setupFailure']+metric_names)
writer.writeheader()
for row in primary:
    writer.writerow({k:row[k] for k in writer.fieldnames if k in row} | {k:row['metrics'].get(k,'N/A') for k in metric_names})
(out/'per-task-outcomes.csv').write_text(stream.getvalue())
originals=json.loads((root/'historical-before.json').read_text())
preservation={'schemaVersion':1,'historicalFilesUnchanged':True,'files':[]}
for rel,expected in originals.items():
    actual=sha((worktree/rel).read_bytes())
    assert actual==expected, 'Historical artifact changed: '+rel
    preservation['files'].append({'path':rel,'beforeSha256':expected,'afterSha256':actual,'unchanged':True})
(out/'historical-preservation.json').write_text(json.dumps(preservation,indent=2)+'\n')
print(json.dumps({'resultsEvidenceSha256':sha(evidence),'memberCount':len(files),'historicalPreservedFiles':len(originals),'reportSha256':sha((out/'report.json').read_bytes())},indent=2))
