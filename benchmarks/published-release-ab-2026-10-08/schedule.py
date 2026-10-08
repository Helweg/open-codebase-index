#!/usr/bin/env python3
import json, pathlib, random, sys
root = pathlib.Path(sys.argv[1])
lock = json.loads((root / 'inputs/source-lock.json').read_text())
rng = random.Random(20261008)
orders = {}
for mode, old_first in [('hybrid',4), ('structural',5)]:
    orders[mode] = [['0.35.3','0.36.1']] * old_first + [['0.36.1','0.35.3']] * (9-old_first)
    rng.shuffle(orders[mode])
schedule = []
for i, repo in enumerate(lock['repositories']):
    modes = ['hybrid','structural']
    rng.shuffle(modes)
    queries = json.loads((root / 'inputs/datasets' / repo['dataset']).read_text())['queries']
    query_order = [q['id'] for q in queries]
    rng.shuffle(query_order)
    for mode in modes:
        for version in orders[mode][i]:
            schedule.append({'repository':repo['name'],'mode':mode,'version':version,'queryOrder':query_order})
(root / 'schedule.json').write_text(json.dumps(schedule,indent=2)+'\n')
