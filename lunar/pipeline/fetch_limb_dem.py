"""Acquire and pin the official LOLA LDEM_64 raster and its unmodified PDS3 label.

First acquisition needs --bootstrap; subsequent use verifies the retained byte hashes.
The 531 MB raster stays in the ignored raw cache, not the web application.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

import httpx
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/raw/dem'
MANIFEST = ROOT / 'data/validation/limb-dem-source.json'
BASE = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img'
FILES = {'ldem_64.lbl': BASE + '/ldem_64.lbl', 'ldem_64.img': BASE + '/ldem_64.img'}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def label_metadata(label: str) -> dict:
    def value(key):
        found = re.findall(r'^\s*' + re.escape(key) + r'\s*=\s*([^\r\n]+)', label, re.M)
        if len(found) != 1:
            raise ValueError(f'Expected one PDS field: {key}')
        return found[0].strip().strip('"')
    expected = {'PRODUCT_ID': 'LDEM_64', 'PRODUCT_VERSION_ID': 'V3.1', 'LINES': '11520',
        'LINE_SAMPLES': '23040', 'SAMPLE_TYPE': 'LSB_INTEGER', 'SAMPLE_BITS': '16',
        'SCALING_FACTOR': '0.5', 'OFFSET': '1737400.', 'MAP_RESOLUTION': '64 <pix/deg>',
        'COORDINATE_SYSTEM_NAME': 'MEAN EARTH/POLAR AXIS OF DE421',
        'MAXIMUM': '21546', 'MINIMUM': '-18251', 'POSITIVE_LONGITUDE_DIRECTION': 'EAST'}
    for key, target in expected.items():
        if value(key) != target:
            raise ValueError(f'Unsupported DEM label {key}: {value(key)}')
    return {'product': value('PRODUCT_ID'), 'version': value('PRODUCT_VERSION_ID'),
        'created': value('PRODUCT_CREATION_TIME'), 'rows': 11520, 'cols': 23040,
        'pixels_per_degree': 64, 'height_factor_m': .5, 'reference_radius_m': 1737400.,
        'minimum_dn': -18251, 'maximum_dn': 21546, 'frame': 'MOON_ME_DE421',
        'pixel_registration': 'lat=90-(row+0.5)/64; east lon=(col+0.5)/64',
        'label_limitations': '45-degree band edge artifacts; interpolated incomplete coverage; no per-pixel error bound'}


def verify() -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if set(manifest['files']) != set(FILES):
        raise ValueError('DEM source set changed')
    for name, url in FILES.items():
        entry = manifest['files'][name]; path = CACHE / name
        if entry['url'] != url or path.stat().st_size != entry['bytes'] or digest(path) != entry['sha256']:
            raise ValueError(f'DEM source bytes changed: {name}')
    metadata = label_metadata((CACHE / 'ldem_64.lbl').read_text(encoding='ascii'))
    if metadata != manifest['metadata']:
        raise ValueError('DEM metadata differs from pinned PDS label')
    if (CACHE / 'ldem_64.img').stat().st_size != 11520 * 23040 * 2:
        raise ValueError('DEM raster dimensions mismatch')
    return manifest


def bootstrap():
    if MANIFEST.exists():
        raise ValueError('Source is already pinned; use --verify')
    CACHE.mkdir(parents=True, exist_ok=True)
    records = {}
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for name, url in FILES.items():
            path = CACHE / name
            if not path.exists():
                temporary = path.with_suffix(path.suffix + '.part')
                count = 0
                with client.stream('GET', url) as response:
                    response.raise_for_status()
                    with temporary.open('wb') as f:
                        for block in response.iter_bytes(4 * 1024 * 1024):
                            f.write(block); count += len(block)
                            if count // 50_000_000 != (count - len(block)) // 50_000_000:
                                print(f'{name}: {count:,} bytes', flush=True)
                temporary.replace(path)
            records[name] = {'url': url, 'bytes': path.stat().st_size, 'sha256': digest(path)}
    metadata = label_metadata((CACHE / 'ldem_64.lbl').read_text(encoding='ascii'))
    raster = np.memmap(CACHE / 'ldem_64.img', mode='r', dtype='<i2', shape=(11520, 23040))
    if int(raster.min()) < metadata['minimum_dn'] or int(raster.max()) > metadata['maximum_dn']:
        raise ValueError('Raster exceeds official label bounds; missing or corrupt data')
    # The published pixel-registered raster does not attain the label extrema.
    # Retain that discrepancy and independently re-read the two actual extrema.
    checks=[]
    with httpx.Client(timeout=60) as client:
        for index in [int(np.argmin(raster)),int(np.argmax(raster))]:
            offset=index*2
            response=client.get(FILES['ldem_64.img'],headers={'Range':f'bytes={offset}-{offset+1}'})
            if response.status_code!=206 or response.headers.get('content-range')!=f'bytes {offset}-{offset+1}/{raster.nbytes}' or len(response.content)!=2:
                raise ValueError('Official DEM extrema byte-range check failed')
            dn=int(np.frombuffer(response.content,dtype='<i2')[0])
            if dn!=int(raster.ravel()[index]):raise ValueError('DEM remote/local extrema differ')
            checks.append({'byte_offset':offset,'dn':dn,'content_range':response.headers['content-range']})
    manifest = {'schema': 1, 'acquired_utc': datetime.now(timezone.utc).isoformat(),
        'files': records, 'metadata': metadata, 'observed_extrema_dn': [int(raster.min()), int(raster.max())],
        'extrema_remote_checks':checks,'extrema_note':'Observed raster extrema differ from, but lie within, the label extrema; source discrepancy retained, not fitted away'}
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    verify()
    print('Pinned and verified official LDEM_64 raster and PDS label', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bootstrap', action='store_true')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.bootstrap:
        bootstrap()
    elif args.verify:
        print(json.dumps(verify()['metadata'], indent=2))
    else:
        parser.error('Choose --bootstrap or --verify')
