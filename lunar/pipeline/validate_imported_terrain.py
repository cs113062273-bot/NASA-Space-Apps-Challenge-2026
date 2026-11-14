"""Independently read actual JS imports/exports using GDAL and SciPy."""
from datetime import datetime,timezone
from pathlib import Path
import json
import numpy as np
import rasterio
from scipy.signal import convolve2d
from scipy import ndimage
import fetch_site_terrain as source

def main():
    root=source.ROOT;output=root/'app/test-results';fixtures=root/'app/tests/fixtures/terrain-import'
    record=json.loads((output/'terrain-import-export-reference.json').read_text(encoding='utf-8'));report=record['report'];meta=report['patch'];n,w=meta['rows'],meta['cols'];s=meta['stepM'];window=meta['sourceWindow']
    if report['imported']['files']['height']['sha256']!=source.digest(fixtures/'height-area.tif'):raise ValueError('Imported source fingerprint differs from independent fixture')
    with rasterio.open(fixtures/'height-area.tif') as ds:
        z=ds.read(1).astype(float);z[z==ds.nodata]=np.nan
        if ds.res!=(s,s):raise ValueError('Imported source resolution changed')
        expected_transform=ds.transform*rasterio.Affine.translation(window['col'],window['row'])
    kernel=np.array([[-1,0,1],[-2,0,2],[-1,0,1]])/(8*s)
    dx=convolve2d(z,kernel,mode='same',boundary='fill',fillvalue=np.nan);dy=convolve2d(z,kernel.T,mode='same',boundary='fill',fillvalue=np.nan)
    slopes=np.rad2deg(np.arctan(np.hypot(dx,dy)))
    def crop(a):
        out=np.full((n,w),np.nan)
        for r in range(n):
            for c in range(w):
                rr,cc=r+window['row'],c+window['col']
                if 0<=rr<a.shape[0] and 0<=cc<a.shape[1]:out[r,c]=a[rr,cc]
        return out
    height,slope=crop(z),crop(slopes)
    X,Y=np.meshgrid(meta['x0']+np.arange(w)*s,meta['y0']-np.arange(n)*s)
    la,lo=np.deg2rad([report['point']['lat'],report['point']['lon']]);rho=2*1737400*np.tan((np.pi/2+la)/2);tx,ty=rho*np.sin(lo),rho*np.cos(lo)
    known=(np.hypot(abs(X-tx)+s/2,abs(Y-ty)+s/2)<=500)&np.isfinite(height)&np.isfinite(slope)
    mask=known&(slope<=report['maxSlopeDeg'])
    forbidden=np.zeros((2*n+1,2*w+1),bool);forbidden[1::2,1::2]=~mask;forbidden=ndimage.maximum_filter(forbidden,size=3,mode='constant',cval=0);forbidden[[0,-1],:]=True;forbidden[:,[0,-1]]=True
    radii=ndimage.distance_transform_edt(~forbidden)[1::2,1::2]*(s/2);radii[~mask]=0;radii[~known]=np.nan
    labels,count=ndimage.label(mask,structure=np.array([[0,1,0],[1,1,1],[0,1,0]]));sizes=np.bincount(labels.ravel());sizes[0]=0
    expected_summary={'known':int(known.sum()),'eligible':int(mask.sum()),'mapAreaM2':int(mask.sum())*s*s,
        'largestConnectedM2':int(sizes.max())*s*s,'components':int(count),'fittingCentres':int(np.sum(mask&(radii*2+1e-8>=report['settings']['diameterM'])))}
    for name,v in expected_summary.items():
        if report['summary'][name]!=v:raise ValueError(f'Imported terrain summary differs: {name}')
    missing=np.full((n,w),np.nan);expected={'height':height,'slope':slope,'slopeRms':missing,'heightRms':missing,'returns':missing,'eligible':np.where(known,mask.astype(float),np.nan),'footprintRadius':radii}
    checks=[]
    for artifact in record['artifacts']:
        path=output/artifact['file']
        if source.digest(path)!=artifact['sha256']:raise ValueError('JS export bytes changed')
        with rasterio.open(path) as ds:
            if ds.shape!=(n,w) or ds.dtypes!=('float32',) or ds.transform!=expected_transform or not np.isnan(ds.nodata):raise ValueError('Imported export changed grid/type/nodata')
            crs=ds.crs.to_dict()
            if ds.crs.to_epsg() is not None or any(crs.get(k)!=v for k,v in source.POLAR.items()):raise ValueError('Lunar CRS changed')
            actual=ds.read(1);target=expected[artifact['band']];np.testing.assert_array_equal(np.isnan(actual),np.isnan(target));finite=np.isfinite(target)
            difference=float(np.max(abs(actual[finite]-target[finite]))) if finite.any() else 0.
            tolerance=2e-5 if artifact['band']=='footprintRadius' else 2e-6 if artifact['band']=='slope' else 0.
            if difference>tolerance:raise ValueError(f'Import/export differs from independent reference: {artifact["band"]} {difference}')
            checks.append({**artifact,'finitePixels':int(finite.sum()),'maximumDifference':difference,'tolerance':tolerance})
    result={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'importId':report['imported']['id'],'patchSha256':meta['sha256'],'summary':expected_summary,'checks':checks,
        'method':'GDAL reads independently written source and actual JS export; SciPy Horn convolution and half-cell square EDT; float32 export rounding permitted',
        'codeSha256':{str(p.relative_to(root)):source.digest(p) for p in [Path(__file__),root/'pipeline/build_terrain_import_reference.py',root/'app/scripts/export-terrain-reference.mjs',root/'app/src/lib/terrain-import.ts',root/'app/src/lib/terrain-geotiff.ts',root/'app/src/lib/landing-area.ts']},
        'limits':['Synthetic source, not lunar measurement or frame accuracy','User-declared ME421 frame; map-plane slope/length/area','No imported horizon propagation, vehicle, flight hazard or competitor accuracy validation']}
    (root/'data/validation/terrain-import-check.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(f'GDAL/SciPy validated {len(checks)} actual imported-DEM exports, including unknown quality as NaN')

if __name__=='__main__':main()
