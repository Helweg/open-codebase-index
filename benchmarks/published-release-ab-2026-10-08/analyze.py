#!/usr/bin/env python3
"""Deterministic pass-one scoring; failures are zero, never best-of-repeat."""
import collections, hashlib, json, math, pathlib, random, re, statistics, sys
root = pathlib.Path(sys.argv[1])
load = lambda p: json.loads((root / p).read_text())
protocol = load('protocol.json')
rows = load('run/rows.json')
cells = load('run/cells.json')
gold = {g['queryId']: g for g in load('explicit-gold.json')}
queries = {q['id']: q for repo in protocol['repositories'] for q in load('inputs/datasets/' + repo['dataset'])['queries']}
assert len(rows) == 1200 and len(cells) == 36
metric_names = ['hitAt1', 'hitAt5', 'mrrAt10', 'ndcgAt10']
header = re.compile(r'^\[(\d+)\]\s+.+?\s+(?:at|in)\s+(.+?):(\d+)(?:-(\d+))?(?:\s|$)', re.M)
scored = []
for row in rows:
    if row['pass'] != 1:
        continue
    q = queries[row['queryId']]
    paths = row['paths'] if row['status'] == 'success' else []
    relevant = {q['expected']['filePath'], *q['expected'].get('acceptableFiles', [])}
    ranks = [i + 1 for i, p in enumerate(paths) if p in relevant]
    rank = min(ranks) if ranks else 0
    ideal = sum(1 / math.log2(i + 2) for i in range(len(relevant)))
    metrics = {'hitAt1': int(rank == 1), 'hitAt5': int(0 < rank <= 5), 'mrrAt10': 1 / rank if rank else 0, 'ndcgAt10': sum(1 / math.log2(r + 1) for r in ranks) / ideal}
    evidence = []
    g = gold.get(row['queryId'])
    if g:
        matches = list(header.finditer(row.get('text', '')))
        for i, hit in enumerate(row['hits']):
            segment = row.get('text', '')[matches[i].end():matches[i+1].start() if i+1 < len(matches) else None] if i < len(matches) else ''
            fenced = re.search(r'```[^\n]*\n(.*?)\n```', segment, re.S)
            consumer = fenced.group(1) if fenced else None
            citation_header = matches[i].group(0) if i < len(matches) else ''
            target_identity = bool(re.search(r'"' + re.escape(g['symbol']) + r'"', citation_header))
            qa_overlap = hit['path'] == g['filePath'] and any(hit['startLine'] <= end and hit['endLine'] >= start for start, end in g['originalEvidenceRanges'])
            qa_coverage = hit['path'] == g['filePath'] and all(hit['startLine'] <= start and hit['endLine'] >= end for start, end in g['originalEvidenceRanges'])
            range_correct = hit['path'] == g['filePath'] and hit['rangeValid'] and hit['startLine'] <= g['startLine'] and hit['endLine'] >= g['endLine']
            # Returned body, not source readback, is the scored evidence. No reconstruction of omitted text.
            complete = bool(range_correct and consumer is not None and g['body'] in consumer)
            evidence.append({**hit, 'targetIdentity': target_identity, 'originalEvidenceOverlap': qa_overlap, 'allOriginalEvidenceCovered': qa_coverage, 'consumerBody': consumer, 'consumerBodySha256': hashlib.sha256(consumer.encode()).hexdigest() if consumer is not None else None, 'bodyExactlyMatchesCitedSource': consumer == hit['citedSourceBody'], 'visibleBodySourceContained': bool(consumer and consumer in hit['citedSourceBody']), 'goldDeclarationRangeCovered': range_correct, 'completeGoldDeclarationBodyReturned': complete})
        metrics['declarationRangeAt5'] = int(any(e['rank'] <= 5 and e['goldDeclarationRangeCovered'] for e in evidence))
        metrics['completeDeclarationBodyAt5'] = int(any(e['rank'] <= 5 and e['completeGoldDeclarationBodyReturned'] for e in evidence))
        metrics['targetIdentityAt5'] = int(any(e['rank'] <= 5 and e['path'] == g['filePath'] and e['targetIdentity'] for e in evidence))
        metrics['originalEvidenceOverlapAt5'] = int(any(e['rank'] <= 5 and e['originalEvidenceOverlap'] for e in evidence))
        metrics['exactCitedBodyAt5'] = int(any(e['rank'] <= 5 and e['path'] == g['filePath'] and e['bodyExactlyMatchesCitedSource'] for e in evidence))
    scored.append({k: row[k] for k in ['repository','version','mode','queryId','track','status','queryMs','firstRealQuery','setupFailure']} | {'metrics': metrics, 'fullDeclarationGradeable': g is not None, 'concreteImplementationClosureGradeable': False, 'bodyEvidence': evidence})
assert len(scored) == 400
mean = lambda values: statistics.mean(values) if values else None
summary = []
paired = []
repo_order = [r['name'] for r in protocol['repositories']]
for mode in ['hybrid','structural']:
    for track in ['explicit','natural']:
        metrics = metric_names + (['declarationRangeAt5','completeDeclarationBodyAt5','targetIdentityAt5','originalEvidenceOverlapAt5','exactCitedBodyAt5'] if track == 'explicit' else [])
        for version in ['0.35.3','0.36.1']:
            subset = [r for r in scored if r['mode'] == mode and r['track'] == track and r['version'] == version]
            summary.append({'mode':mode,'track':track,'version':version,'count':len(subset),'success':sum(r['status']=='success' for r in subset),'errors':sum(r['status']=='error' for r in subset),'unsupported':0,'means':{m:mean([r['metrics'][m] for r in subset]) for m in metrics},'equalRepositoryMeans':{m:mean([mean([r['metrics'][m] for r in subset if r['repository']==repo]) for repo in repo_order]) for m in metrics}})
        lookup = {(r['queryId'],r['version']):r for r in scored if r['mode']==mode and r['track']==track}
        pairs = [{'queryId':q,'repository':lookup[q,'0.35.3']['repository'],'differences':{m:lookup[q,'0.36.1']['metrics'][m]-lookup[q,'0.35.3']['metrics'][m] for m in metrics}} for q in sorted({key[0] for key in lookup})]
        per_repo = [{'repository':repo,'count':sum(p['repository']==repo for p in pairs),'differences':{m:mean([p['differences'][m] for p in pairs if p['repository']==repo]) for m in metrics}} for repo in repo_order]
        uncertainty={}
        for m in metrics:
            diffs=[r['differences'][m] for r in per_repo]
            rng=random.Random(20261008)
            draws=sorted(mean(rng.choices(diffs,k=9)) for _ in range(10000))
            uncertainty[m]={'descriptiveRepositoryBootstrap95':[draws[249],draws[9749]],'leaveOneRepositoryOut':[mean(diffs[:i]+diffs[i+1:]) for i in range(9)]}
        paired.append({'mode':mode,'track':track,'newMinusOld':{m:mean([p['differences'][m] for p in pairs]) for m in metrics},'winsLossesTies':{m:{'wins':sum(p['differences'][m]>0 for p in pairs),'losses':sum(p['differences'][m]<0 for p in pairs),'ties':sum(p['differences'][m]==0 for p in pairs)} for m in metrics},'perRepository':per_repo,'perTask':pairs,'uncertainty':uncertainty})
latency=[]
for mode in ['hybrid','structural']:
    for version in ['0.35.3','0.36.1']:
        subset=[r for r in rows if r['mode']==mode and r['version']==version]
        setups=[c for c in cells if c['mode']==mode and c['version']==version]
        groups={'firstRealQuery':[r for r in subset if r['firstRealQuery']], 'laterPassOne':[r for r in subset if r['pass']==1 and not r['firstRealQuery']], 'passesTwoAndThree':[r for r in subset if r['pass']>1]}
        detail={}
        for label,group in groups.items():
            values=sorted(r['queryMs'] for r in group if r['queryMs'] is not None)
            detail[label]={'records':len(group),'measured':len(values),'successes':sum(r['status']=='success' for r in group),'medianMs':statistics.median(values) if values else None,'meanMs':mean(values),'minMs':min(values) if values else None,'maxMs':max(values) if values else None}
        latency.append({'version':version,'mode':mode,'coldSetupCount':len(setups),'failedSetups':sum(bool(c['setupError']) for c in setups),'medianSetupMs':statistics.median(c['setupMs'] for c in setups),'queries':detail})
report={'schemaVersion':1,'kind':'development-exposed-published-release-regression-comparison','counts':{'cells':36,'primaryRows':400,'queryPassRecords':1200,'explicitPerCondition':54,'naturalPerCondition':46},'summary':summary,'paired':paired,'latency':latency,'bodyMetricLimits':'Exact pinned-source declaration range and returned complete declaration text, not semantic equivalence, concrete method closure, inherited/library behavior or coding productivity. Struct/trait declarations do not prove concrete implementation; natural-language tasks have file-only gold and body/range correctness is ungradeable. Consumer omission/truncation is not reconstructed. Explicit AST annotations were frozen before participant feedback using separate upstream Python Tree-sitter grammars and original source QA.','uncertaintyLimits':'Descriptive only: nine convenience clusters, development-exposed tasks, not unseen-project inference or confirmatory superiority.','repeatStability': [{'mode':mode,'version':version,'identicalPathListsAcrossThreePasses':sum(len({tuple(r['paths']) for r in rows if r['mode']==mode and r['version']==version and r['queryId']==q})==1 for q in queries),'taskCount':100} for mode in ['hybrid','structural'] for version in ['0.35.3','0.36.1']]}
report['apiReportedIndexWork'] = {
    'limits': 'Public successful setup response counters only; not independently measured backend calls, actual prompt/token computation, retries or model work. Absent/unparseable/failed setup values are N/A. Structural mode does not embed.',
    'perCell': [{k: c[k] for k in ['repository','version','mode','setupError','apiReportedIndexWork']} for c in cells],
    'byCondition': [],
}
for mode in ['hybrid','structural']:
    for version in ['0.35.3','0.36.1']:
        condition = {'mode': mode, 'version': version, 'cells': 9, 'counters': {}}
        for counter in ['processedFiles','embeddedChunks','tokenCount','structuralChunks','productDurationSeconds','failedEmbeddingChunks']:
            values = [c['apiReportedIndexWork'][counter] for c in cells if c['mode']==mode and c['version']==version and c['apiReportedIndexWork'][counter] is not None]
            condition['counters'][counter] = {'availableCells':len(values),'unavailableCells':9-len(values),'sumAvailable':sum(values) if values else None}
        report['apiReportedIndexWork']['byCondition'].append(condition)
(root/'analysis.json').write_text(json.dumps(report,indent=2)+'\n')
(root/'scored-primary.json').write_text(json.dumps(scored,indent=2)+'\n')
print(json.dumps({'summary':summary,'latency':latency},indent=2))
