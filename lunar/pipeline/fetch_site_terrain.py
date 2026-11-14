"""Pin complete official PGDA 5 m terrain/slope/uncertainty/count source products.

Raw TIFFs remain outside Git. Bootstrap explicitly selects new named regions;
already pinned files are verified rather than silently replaced.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time

import httpx
import rasterio

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'data/raw/site-terrain'
MANIFEST=ROOT/'data/validation/site-terrain-source.json'
BASE='https://pgda.gsfc.nasa.gov/data/LOLA_5mpp'
REGIONS=('Site01','Site04','Site06','Site07','Site11','Site20v2','Site23','Site42','Haworth','Shoemaker','DM2','SL2','SL3')
FIELDS=('surf','slp','slperr','ldec','toterr')
POLAR={'proj':'stere','lat_0':-90,'lat_ts':-90,'lon_0':0,'x_0':0,'y_0':0,'R':1737400,'units':'m'}


def digest(path):
    sha=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''):sha.update(block)
    return sha.hexdigest()


def filename(region,field):return f'{region}_final_adj_5mpp_{field}.tif'


def verify():
    manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
    readme=CACHE/'README'
    if manifest.get('frame')!='MOON_ME_DE421' or manifest.get('product_page')!='https://pgda.gsfc.nasa.gov/products/78' or manifest['readme']['url']!=BASE+'/README' or readme.stat().st_size!=manifest['readme']['bytes'] or digest(readme)!=manifest['readme']['sha256']:
        raise ValueError('PGDA frame/documentation provenance differs from pinned source')
    for region,entries in manifest['regions'].items():
        if region not in REGIONS or set(entries)!=set(FIELDS):raise ValueError('Unsupported PGDA source set')
        for field,entry in entries.items():
            path=CACHE/filename(region,field)
            if entry['url']!=f'{BASE}/{region}/{path.name}' or path.stat().st_size!=entry['bytes'] or digest(path)!=entry['sha256']:
                raise ValueError(f'PGDA source bytes differ: {path.name}')
    return manifest


def bootstrap(regions):
    CACHE.mkdir(parents=True,exist_ok=True)
    prior=verify() if MANIFEST.exists() else {'schema':1,'regions':{}}
    readme=CACHE/'README'
    if not readme.exists():
        response=httpx.get(BASE+'/README',timeout=60);response.raise_for_status();readme.write_bytes(response.content)
    if 'readme' in prior and digest(readme)!=prior['readme']['sha256']:raise ValueError('PGDA README changed')
    prior.update({'readme':{'url':BASE+'/README','sha256':digest(readme),'bytes':readme.stat().st_size},
        'frame':'MOON_ME_DE421','product_page':'https://pgda.gsfc.nasa.gov/products/78',
        'limits':['Grid resolution is 5 m, not independent 5 m measurements; many pixels are interpolated',
            'Slope and height error maps are RMS, not confidence or hard error bounds',
            'No boulder density, sub-grid hazard, vehicle capability or flight landing safety is established']})
    for region in regions:
        if region not in REGIONS:raise ValueError('Select a documented PGDA region')
        if region in prior['regions']:continue
        def download(field):
            name=filename(region,field);path=CACHE/name;url=f'{BASE}/{region}/{name}'
            if not path.exists():
                temporary=path.with_suffix('.tif.part')
                for attempt in range(4):
                    start=temporary.stat().st_size if temporary.exists() else 0
                    try:
                        with httpx.Client(timeout=120,follow_redirects=True) as client,client.stream('GET',url,headers={'Range':f'bytes={start}-'} if start else {}) as r:
                            r.raise_for_status()
                            append=start>0 and r.status_code==206
                            if r.status_code==206 and not r.headers.get('content-range','').startswith(f'bytes {start}-'):
                                raise ValueError('PGDA resume response starts at the wrong byte')
                            with temporary.open('ab' if append else 'wb') as f:
                                for block in r.iter_bytes(1024*1024):f.write(block)
                        break
                    except httpx.HTTPError:
                        if attempt==3:raise
                        print(f'Retrying {name} at retained partial bytes',flush=True);time.sleep(2**attempt)
                temporary.replace(path)
            with rasterio.open(path) as raster:
                if raster.count!=1 or raster.res!=(5.,5.) or raster.transform.b!=0 or raster.transform.d!=0 or raster.transform.e!=-5.:
                    raise ValueError(f'Unexpected raster grid: {name}')
                parameters=raster.crs.to_dict()
                if any(parameters.get(k)!=v for k,v in POLAR.items()):raise ValueError(f'Unexpected lunar projection parameters: {name}')
                grid={'width':raster.width,'height':raster.height,'transform':list(raster.transform)[:6],
                    'crs_wkt':raster.crs.to_wkt(),'nodata':'NaN' if raster.nodata is not None and not math.isfinite(raster.nodata) else raster.nodata,'dtype':raster.dtypes[0]}
            print(f'Pinned {name}: {path.stat().st_size:,} bytes',flush=True)
            return field,{'url':url,'bytes':path.stat().st_size,'sha256':digest(path),'grid':grid}
        with ThreadPoolExecutor(5) as pool:entries=dict(pool.map(download,FIELDS))
        if any((e['grid']['transform'],e['grid']['width'],e['grid']['height'])!=(entries['surf']['grid']['transform'],entries['surf']['grid']['width'],entries['surf']['grid']['height']) for e in entries.values()):
            raise ValueError('PGDA companion products do not share a grid')
        variants=len({e['grid']['crs_wkt'] for e in entries.values()})
        if variants>1:
            prior.setdefault('crs_name_variants',{})[region]={'distinct_original_wkt_strings':variants,'validated_projection_parameters':POLAR,
                'note':'Original names/prime-meridian labels differ; numeric projection, zero meridian, radius, pixel grid and units agree. Same ME421 frame follows the official companion-product documentation; no fitted registration correction applied.'}
        prior['regions'][region]=entries
        # Each complete validated region is durable even if a later transfer fails.
        prior['checked_utc']=datetime.now(timezone.utc).isoformat()
        checkpoint=MANIFEST.with_suffix('.json.part')
        checkpoint.write_text(json.dumps(prior,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n');checkpoint.replace(MANIFEST)
        print(f'Checkpointed {region}; {len(prior["regions"])} complete source regions',flush=True)
    verify()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--bootstrap',nargs='+',choices=REGIONS);parser.add_argument('--verify',action='store_true')
    args=parser.parse_args()
    if args.bootstrap:bootstrap(args.bootstrap)
    elif args.verify:print('Verified '+', '.join(verify()['regions']))
    else:parser.error('Choose --bootstrap REGION ... or --verify')
