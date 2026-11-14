"""Package native 5 m PGDA companion products around every covered curated point.

No resampling/averaging: each binary field retains its source float32 values.
Source coverage is explicit; the browser may reuse a patch for nearby custom points.
"""
from datetime import datetime,timezone
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

import fetch_site_terrain as source

OUT=source.ROOT/'app/public/data/landing-terrain'
FIELD_ORDER=['slp','slperr','ldec','surf','toterr']
N=256
R=1737400.


def xy(lat,lon):
    radius=2*R*np.tan(np.deg2rad((90+lat)/2))
    return float(radius*np.sin(np.deg2rad(lon))),float(radius*np.cos(np.deg2rad(lon)))


def main():
    manifest=source.verify();OUT.mkdir(parents=True,exist_ok=True)
    catalogue=source.ROOT/'app/public/data/sites.json';sites=json.loads(catalogue.read_text(encoding='utf-8'))['sites']
    datasets={region:{field:rasterio.open(source.CACHE/source.filename(region,field)) for field in FIELD_ORDER} for region in manifest['regions']}
    for fields in datasets.values():
        crs=fields['surf'].crs.to_dict()
        if any(crs.get(k)!=v for k,v in {'proj':'stere','lat_0':-90,'lat_ts':-90,'lon_0':0,'x_0':0,'y_0':0,'R':R,'units':'m'}.items()):
            raise ValueError('PGDA projection differs from the explicit south-polar map model')
    patches=[];uncovered=[]
    try:
        for site in sites:
            x,y=xy(site['lat'],site['lon'])
            candidates=[region for region,fields in datasets.items() if fields['surf'].bounds.left<=x<fields['surf'].bounds.right and fields['surf'].bounds.bottom<y<=fields['surf'].bounds.top]
            if not candidates:uncovered.append(site['id']);continue
            # Source selection is by available margin around the requested point,
            # never by whichever source reports a more favorable slope.
            def margin(region):
                b=datasets[region]['surf'].bounds
                return min(x-b.left,b.right-x,y-b.bottom,b.top-y)
            region=sorted(candidates,key=lambda r:(-margin(r),r))[0];reference=datasets[region]['surf']
            row,col=reference.index(x,y);row-=N//2;col-=N//2
            window=Window(col,row,N,N);transform=reference.window_transform(window)
            arrays=[]
            for field in FIELD_ORDER:
                a=datasets[region][field].read(1,window=window,boundless=True,fill_value=np.nan,out_dtype='float32')
                a=np.asarray(a,dtype='<f4');a[~np.isfinite(a)]=np.nan;arrays.append(a)
            path=OUT/f'{site["id"]}.f32';np.stack(arrays).astype('<f4').tofile(path)
            entry={'id':site['id'],'site':{'lat':site['lat'],'lon':site['lon']},'region':region,
                'rows':N,'cols':N,'stepM':5,'x0':float(transform.c+2.5),'y0':float(transform.f-2.5),
                'file':path.name,'bytes':path.stat().st_size,'sha256':source.digest(path),
                'sourceWindow':{'row':int(row),'col':int(col),'rows':N,'cols':N},
                'sourceFiles':{field:{k:v for k,v in manifest['regions'][region][field].items() if k in ['url','sha256','bytes']} for field in FIELD_ORDER},
                'finiteByField':{field:int(np.isfinite(a).sum()) for field,a in zip(FIELD_ORDER,arrays)}}
            patches.append(entry);print(f'{site["id"]}: {region}, {path.stat().st_size:,} bytes',flush=True)
    finally:
        for fields in datasets.values():
            for ds in fields.values():ds.close()
    index={'schema':1,'createdUTC':datetime.now(timezone.utc).isoformat(),'frame':'MOON_ME_DE421',
        'projection':'Spherical south polar stereographic, pole -90 deg, central meridian 0, radius 1737400 m; pixel centres',
        'fieldOrder':FIELD_ORDER,'encoding':'field-major float32 little-endian; NaN means unavailable',
        'productURL':manifest['product_page'],'readmeURL':manifest['readme']['url'],
        'sourceManifestSha256':source.digest(source.MANIFEST),'catalogueSha256':source.digest(catalogue),
        'codeSha256':{n:source.digest(Path(__file__).parent/n) for n in ['build_landing_terrain.py','fetch_site_terrain.py']},
        'patches':patches,'uncoveredSites':uncovered,
        'limits':manifest['limits']+['Map area and footprint lengths use the stated stereographic plane, not 3D surface area',
            'No mission-date sunlight, power, communications, blast, rock or vehicle-clearance certification',
            'Nominal geographic registration; no metre-level flight frame/terrain registration is established']}
    (OUT/'index.json').write_text(json.dumps(index,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(f'Packaged {len(patches)} points, {len(uncovered)} outside retained source regions',flush=True)


if __name__=='__main__':main()
