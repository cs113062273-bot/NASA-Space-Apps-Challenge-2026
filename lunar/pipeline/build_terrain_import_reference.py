"""Small GDAL-written import fixtures and independent SciPy Horn references.

Synthetic numerical cases, not measured terrain or source accuracy evidence.
"""
from pathlib import Path
import hashlib
import json
import numpy as np
import rasterio
from rasterio.transform import from_origin,Affine
from scipy.signal import convolve2d

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'app/tests/fixtures/terrain-import'
CRS='+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m +no_defs'

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    sites=json.loads((ROOT/'app/public/data/sites.json').read_text(encoding='utf-8'))['sites'];site=next(s for s in sites if s['id']=='c1')
    rho=2*1737400*np.tan(np.deg2rad((90+site['lat'])/2));lon=np.deg2rad(site['lon']);x,y=float(rho*np.sin(lon)),float(rho*np.cos(lon))
    rows=cols=64;step=20.;transform=from_origin(x-650,y+650,step,step);rr,cc=np.mgrid[:rows,:cols]
    z=(100+.4*(cc-32)+.6*(rr-32)+5*np.sin(cc*.3)*np.cos(rr*.17)).astype('float32');z[20:23,40:43]=-9999
    def write(name,array,crs=CRS,tr=transform,point=False):
        with rasterio.open(OUT/name,'w',driver='GTiff',width=cols,height=rows,count=1,dtype='float32',crs=crs,transform=tr,nodata=-9999,compress='deflate',predictor=3,tiled=True,blockxsize=16,blockysize=16) as ds:
            ds.write(array,1)
            if point:ds.update_tags(AREA_OR_POINT='Point')
    write('height-area.tif',z);write('height-point.tif',z,point=True)
    write('earth.tif',z,crs='EPSG:32633')
    write('rotated.tif',z,tr=Affine(20,1,transform.c,0,-20,transform.f))
    write('misaligned-rms.tif',np.ones_like(z),tr=Affine(20,0,transform.c+.25,0,-20,transform.f))
    for name,value in [('slope',2),('slope-rms',.5),('returns',1),('height-rms',.2)]:write(name+'.tif',np.full_like(z,value))
    kernel=np.array([[-1,0,1],[-2,0,2],[-1,0,1]])/(8*step)
    clean=z.astype(float);clean[z==-9999]=np.nan
    dx=convolve2d(clean,kernel,mode='same',boundary='fill',fillvalue=np.nan);dy=convolve2d(clean,kernel.T,mode='same',boundary='fill',fillvalue=np.nan)
    slope=np.rad2deg(np.arctan(np.hypot(dx,dy)))
    valid=np.flatnonzero(np.isfinite(slope))
    picks=valid[np.linspace(0,len(valid)-1,30,dtype=int)]
    report={'schema':1,'method':'GDAL/rasterio independently writes deflate tiled PixelIsArea/Point TIFFs; SciPy convolve2d Horn kernels with NaN border and no-data support',
        'site':{'lat':site['lat'],'lon':site['lon']},'rows':rows,'cols':cols,'stepM':step,'x0':transform.c+step/2,'y0':transform.f-step/2,
        'samples':[{'row':int(k//cols),'col':int(k%cols),'height':float(z.ravel()[k]),'slope':float(slope.ravel()[k])} for k in picks],
        'unknownSlopeCells':int(np.isnan(slope).sum()),'unknownSlopeCoordinates':np.argwhere(np.isnan(slope)).tolist(),'sourceSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.glob('*.tif'))},
        'generatorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Synthetic numerical/encoding checks, not measured lunar terrain, frame registration or flight safety']}
    (OUT/'reference.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(f'Wrote {len(report["sourceSha256"])} independent GeoTIFF fixtures; {len(picks)} SciPy slope samples; {report["unknownSlopeCells"]} unknown slope cells')

if __name__=='__main__':main()
