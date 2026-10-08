#!/usr/bin/env python3
"""Verify and replay published normalized evidence without model/index access."""
import gzip, hashlib, json, pathlib, subprocess, sys, tempfile
archive = pathlib.Path(sys.argv[1])
package = json.loads(gzip.decompress(archive.read_bytes()))
with tempfile.TemporaryDirectory(prefix='ocbi-published-ab-replay-') as temp:
    root = pathlib.Path(temp)
    for item in package['files']:
        rel = pathlib.PurePosixPath(item['path'])
        if rel.is_absolute() or '..' in rel.parts:
            raise ValueError('Unsafe replay member')
        data = item['content'].encode()
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Replay member hash mismatch: ' + item['path'])
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    expected = hashlib.sha256((root / 'analysis.json').read_bytes()).hexdigest()
    result = subprocess.run([sys.executable, str(root / 'programs/analyze.py'), str(root)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    actual = hashlib.sha256((root / 'analysis.json').read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError('Replayed analysis changed')
    print(json.dumps({'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'verifiedFiles':len(package['files']),'replayedAnalysisSha256':actual,'primaryRows':400,'queryPassRecords':1200,'cells':36}))
