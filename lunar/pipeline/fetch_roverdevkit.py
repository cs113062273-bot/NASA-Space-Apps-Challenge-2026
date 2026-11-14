"""Retain an immutable, hash-checked analytical comparator subset; no execution."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import httpx

ROOT = Path(__file__).resolve().parents[1]
REPO = 'Complex-Systems-Design-Lab/roverdevkit'
MANIFEST = ROOT / 'data/validation/competitor-roverdevkit-source.json'


def digest(body):
    return hashlib.sha256(body).hexdigest()


def main():
    prior = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else None
    with httpx.Client(timeout=25, follow_redirects=True) as client:
        if prior:
            for item in prior['files']:
                body = (ROOT / item['cache']).read_bytes()
                if digest(body) != item['sha256']:
                    raise ValueError('Retained comparator source changed: ' + item['path'])
            print('Verified existing pinned source:', prior['commit'], len(prior['files']), 'files')
        if prior:
            commit = prior['commit']
        else:
            response = client.get(f'https://api.github.com/repos/{REPO}/commits/main')
            response.raise_for_status()
            commit = response.json()['sha']
        response = client.get(f'https://api.github.com/repos/{REPO}/git/trees/{commit}', params={'recursive': '1'})
        response.raise_for_status()
        tree = response.json()
        if tree.get('truncated'):
            raise ValueError('Incomplete source inventory')
        prefixes = ('roverdevkit/mission/', 'roverdevkit/power/', 'roverdevkit/drivetrain/', 'roverdevkit/terramechanics/', 'roverdevkit/mass/')
        named = {'LICENSE', 'README.md', 'pyproject.toml', 'data/soil_simulants.csv', 'roverdevkit/__init__.py', 'roverdevkit/schema.py', 'roverdevkit/architecture.py'}
        selected = [f for f in tree['tree'] if f['type'] == 'blob' and (f['path'] in named or f['path'].startswith(prefixes) and f['path'].endswith('.py'))]
        if prior and {f['path'] for f in selected} == {f['path'] for f in prior['files']}:
            retained = {f['path']: f for f in prior['files']}
            for item in selected:
                if retained[item['path']]['gitBlobSha1'] != item['sha'] or retained[item['path']]['bytes'] != item['size']:
                    raise ValueError('Pinned comparator tree changed: ' + item['path'])
            # A verification-only invocation must not change the manifest hash
            # consumed by retained numerical references and their checks.
            print('Pinned manifest unchanged after verification')
            return
        cache = ROOT / 'data/raw/research/roverdevkit' / commit

        def retain(item):
            name = item['path']
            existing = next((f for f in prior['files'] if f['path'] == name), None) if prior else None
            if existing:
                if existing['gitBlobSha1'] != item['sha'] or existing['bytes'] != item['size']:
                    raise ValueError('Pinned comparator tree changed: ' + name)
                return existing
            if '..' in Path(name).parts or Path(name).is_absolute():
                raise ValueError('Invalid source path')
            url = f'https://raw.githubusercontent.com/{REPO}/{commit}/{name}'
            result = client.get(url)
            result.raise_for_status()
            body = result.content
            git_blob = hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest()
            if len(body) != item['size'] or len(body) > 1024 * 1024 or git_blob != item['sha']:
                raise ValueError('Source blob differs from pinned tree: ' + name)
            path = cache / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            return {'path': name, 'url': url, 'cache': path.relative_to(ROOT).as_posix(), 'bytes': len(body), 'gitBlobSha1': git_blob, 'sha256': digest(body)}

        with ThreadPoolExecutor(max_workers=4) as pool:
            files = list(pool.map(retain, selected))
    manifest = {'schema': 1, 'repository': f'https://github.com/{REPO}', 'commit': commit, 'tree': tree['sha'], 'retainedUTC': datetime.now(timezone.utc).isoformat(),
                'files': files, 'scope': 'Pinned analytical mission/mobility/power source subset and publisher documentation. No remote code executed, no UI, performance or model comparison result yet.'}
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('Pinned comparator source:', commit, len(files), 'files,', sum(f['bytes'] for f in files), 'bytes')


if __name__ == '__main__':
    main()
