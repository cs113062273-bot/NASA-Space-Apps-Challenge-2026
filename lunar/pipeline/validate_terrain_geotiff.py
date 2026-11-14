"""Read actual JS-exported lunar GeoTIFFs with independent GDAL/Rasterio/SciPy."""
from datetime import datetime,timezone
import json
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

import fetch_site_terrain as source


def main():
    output=source.ROOT/'app/test-results';record=json.loads((output/'terrain-export-reference.json').read_text(encoding='utf-8'))
    report=record['report'];meta=report['patch'];n=meta['rows'];w=meta['cols']
    arrays=np.fromfile(source.ROOT/'app/public/data/landing-terrain'/meta['file'],dtype='<f4').reshape(5,n,w)
    slp,error,returns,height,height_error=arrays.astype(float)
    X,Y=np.meshgrid(meta['x0']+np.arange(w)*5,meta['y0']-np.arange(n)*5)
    lat,lon=np.deg2rad([report['point']['lat'],report['point']['lon']]);rho=2*1737400*np.tan((np.pi/2+lat)/2);tx,ty=rho*np.sin(lon),rho*np.cos(lon)
    circle=np.hypot(abs(X-tx)+2.5,abs(Y-ty)+2.5)<=500
    known=circle&np.isfinite(arrays).all(axis=0)&(slp>=0)&(slp<=90)&(error>=0)&(returns>=0)&(height_error>=0)
    mask=known&(slp+report['settings']['rmsMultiplier']*error<=report['maxSlopeDeg'])
    if report['settings']['requireReturns']:mask&=returns>0
    forbidden=np.zeros((2*n+1,2*w+1),bool);forbidden[1::2,1::2]=~mask
    forbidden=ndimage.maximum_filter(forbidden,size=3,mode='constant',cval=0);forbidden[[0,-1],:]=True;forbidden[:,[0,-1]]=True
    radii=ndimage.distance_transform_edt(~forbidden)[1::2,1::2]*2.5;radii[~mask]=0
    eligible=np.where(known,mask.astype(float),np.nan);radii[~known]=np.nan
    expected=dict(zip(['slope','slopeRms','returns','height','heightRms'],arrays));expected.update(eligible=eligible,footprintRadius=radii)
    checks=[]
    for artifact in record['artifacts']:
        path=output/artifact['file']
        if source.digest(path)!=artifact['sha256']:raise ValueError('JS reference export changed')
        with rasterio.open(path) as ds:
            if ds.shape!=(n,w) or ds.count!=1 or ds.dtypes!=('float32',) or not np.isnan(ds.nodata):raise ValueError('Invalid exported raster type/size/nodata')
            if ds.transform!=rasterio.Affine(5,0,meta['x0']-2.5,0,-5,meta['y0']+2.5):raise ValueError('Export has wrong pixel registration')
            crs=ds.crs.to_dict()
            if any(crs.get(k)!=v for k,v in {'proj':'stere','lat_0':-90,'lat_ts':-90,'lon_0':0,'x_0':0,'y_0':0,'R':1737400,'units':'m'}.items()) or ds.crs.to_epsg() is not None:
                raise ValueError('Export lost its explicit lunar projection or acquired an Earth EPSG')
            actual=ds.read(1);target=expected[artifact['band']]
            np.testing.assert_array_equal(np.isnan(actual),np.isnan(target))
            difference=float(np.max(abs(actual[np.isfinite(target)]-target[np.isfinite(target)])))
            if difference>(1e-5 if artifact['band']=='footprintRadius' else 0):raise ValueError('Export pixel values differ from source/independent geometry')
            checks.append({**artifact,'rows':n,'cols':w,'maximum_value_difference':difference,'crs':crs,'valid_pixels':int(np.isfinite(actual).sum())})
    result={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'patchSha256':meta['sha256'],'checks':checks,
        'codeSha256':{str(p.relative_to(source.ROOT)):source.digest(p) for p in [Path(__file__),source.ROOT/'app/src/lib/terrain-geotiff.ts',source.ROOT/'app/scripts/export-terrain-reference.mjs']},
        'limits':['Independent file reader and distance implementation, same terrain source','Nominal geographic registration; not flight qualification']}
    (source.ROOT/'data/validation/terrain-geotiff-check.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(f'GDAL/SciPy validated {len(checks)} exported float32 lunar GeoTIFF layers',flush=True)


if __name__=='__main__':main()
