"""Pin primary source bytes for LCRNS reference-orbit work; never execute downloaded files.

The app's direct-route DE440 manifest is independent. These DE421 files must not silently
replace its kernels. --bootstrap records a first acquisition; --verify checks cache only.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/raw/research/relay'
MANIFEST = ROOT / 'data/validation/relay-sources.json'
NAIF = 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/'
PDS = 'https://pds-geosciences.wustl.edu/grail/grail-l-lgrs-5-rdr-v1/grail_1001/shadr/'
SOURCES = {
    'de421.bsp': NAIF+'spk/planets/a_old_versions/de421.bsp',
    'moon_pa_de421_1900-2050.bpc': NAIF+'pck/moon_pa_de421_1900-2050.bpc',
    'moon_080317.tf': NAIF+'fk/satellites/moon_080317.tf',
    'header.421': 'https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de421/header.421',
    'gggrx_0900c_sha.tab': PDS+'gggrx_0900c_sha.tab',
    'gggrx_0900c_sha.lbl': PDS+'gggrx_0900c_sha.lbl',
    'lcrns-reference-3.1.pdf': 'https://www.nasa.gov/wp-content/uploads/2025/08/nasa-lunar-communications-relay-and-navigation-systems-lcrns-reference-constellation-3-1.pdf?emrc=68cc484867c73',
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def fetch(name: str, expected: dict | None, verify: bool) -> dict:
    p = CACHE/name
    if p.parent.resolve() != CACHE.resolve():
        raise ValueError('Source target escapes relay cache')
    if p.is_file() and expected and digest(p) == expected['sha256']:
        print(f'Verified {name}', flush=True)
        return expected
    if verify:
        raise ValueError(f'Missing/mismatched relay source: {name}')
    tmp = p.with_suffix(p.suffix+'.part')
    with urlopen(Request(SOURCES[name], headers={'User-Agent':'LASTLIGHT-research/0.1'}), timeout=60) as response, tmp.open('wb') as out:
        advertised = response.headers.get('Content-Length')
        etag, modified = response.headers.get('ETag'), response.headers.get('Last-Modified')
        for block in iter(lambda: response.read(1024*1024), b''):
            out.write(block)
    size, sha = tmp.stat().st_size, digest(tmp)
    if not size or (advertised and size != int(advertised)):
        raise ValueError(f'Truncated source: {name}')
    if expected and sha != expected['sha256']:
        raise ValueError(f'Source changed: {name}; review bytes before intentionally replacing the manifest')
    tmp.replace(p)
    print(f'Fetched {name}: {size:,} bytes', flush=True)
    return {'url':SOURCES[name], 'bytes':size, 'sha256':sha, 'etag':etag, 'last_modified':modified,
        'acquired_utc':datetime.now(timezone.utc).isoformat()}


def verify_sources() -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if set(manifest['sources']) != set(SOURCES):
        raise ValueError('Relay source manifest does not match the required named inputs')
    for name, entry in manifest['sources'].items():
        if entry['url'] != SOURCES[name] or digest(CACHE/name) != entry['sha256'] or (CACHE/name).stat().st_size != entry['bytes']:
            raise ValueError(f'Relay source provenance mismatch: {name}')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bootstrap', action='store_true')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if not MANIFEST.exists() and not args.bootstrap:
        parser.error('First acquisition requires --bootstrap')
    old = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else {'sources':{}}
    CACHE.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {name:pool.submit(fetch,name,old['sources'].get(name),args.verify) for name in SOURCES}
        entries = {name:job.result() for name,job in jobs.items()}
    MANIFEST.write_text(json.dumps({'schema':1,'checked_utc':datetime.now(timezone.utc).isoformat(),
        'purpose':'Research reference orbits, not operational provider ephemerides', 'sources':entries},indent=2)+'\n',encoding='utf-8',newline='\n')
    verify_sources()


if __name__ == '__main__':
    main()
