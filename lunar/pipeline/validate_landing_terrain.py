"""Independent classic-TIFF pixel reads and SciPy connected-area/disc references."""
from datetime import datetime,timezone
import json
from pathlib import Path
import struct

import numpy as np
from scipy import ndimage

import fetch_site_terrain as source

OUT=source.ROOT/'app/public/data/landing-terrain'


def tiff_window(path,row,col,rows,cols):
    """Strict uncompressed float32 classic-TIFF decoder, independent of GDAL.

    This reader deliberately refuses other encodings, rather than guessing.
    """
    with Path(path).open('rb') as f:
        header=f.read(8)
        if header[:4]!=b'II*\x00':raise ValueError('Reference decoder requires little-endian classic TIFF')
        f.seek(struct.unpack('<I',header[4:])[0]);count=struct.unpack('<H',f.read(2))[0]
        entries=[struct.unpack('<HHI4s',f.read(12)) for _ in range(count)]
        def tag(key):
            typ,n,inline=next((t,n,v) for k,t,n,v in entries if k==key)
            dtype={3:'<u2',4:'<u4',12:'<f8'}.get(typ)
            if dtype is None:raise ValueError(f'Unsupported TIFF tag type {typ}')
            size=np.dtype(dtype).itemsize*n
            if size<=4:data=inline[:size]
            else:f.seek(struct.unpack('<I',inline)[0]);data=f.read(size)
            return np.frombuffer(data,dtype=dtype,count=n)
        width,height=int(tag(256)[0]),int(tag(257)[0])
        if int(tag(259)[0])!=1 or int(tag(258)[0])!=32 or int(tag(339)[0])!=3 or int(tag(277)[0])!=1:raise ValueError('Unsupported TIFF raster encoding')
        offsets=tag(273);per=int(tag(278)[0]);scale=tag(33550);tie=tag(33922)
        result=np.full((rows,cols),np.nan,dtype='<f4')
        left,right=max(col,0),min(col+cols,width)
        for r in range(max(0,row),min(height,row+rows)):
            if left>=right:continue
            f.seek(int(offsets[r//per])+((r%per)*width+left)*4)
            result[r-row,left-col:right-col]=np.frombuffer(f.read((right-left)*4),dtype='<f4')
        return result,{'x0':float(tie[3]+(col+.5-tie[0])*scale[0]),'y0':float(tie[4]-(row+.5-tie[1])*scale[1])}


def reference(arrays,meta,targetX,targetY,slope_limit,rms,diameter,require_returns):
    h,w=meta['rows'],meta['cols'];step=meta['stepM']
    x=meta['x0']+np.arange(w)*step;y=meta['y0']-np.arange(h)*step
    X,Y=np.meshgrid(x,y);circle=np.hypot(abs(X-targetX)+step/2,abs(Y-targetY)+step/2)<=500
    c=np.arange(np.ceil((targetX-500-meta['x0'])/step),np.floor((targetX+500-meta['x0'])/step)+1)
    r=np.arange(np.ceil((meta['y0']-targetY-500)/step),np.floor((meta['y0']-targetY+500)/step)+1)
    C,R=np.meshgrid(c,r)
    total=int(np.sum(np.hypot(abs(meta['x0']+C*step-targetX)+step/2,abs(meta['y0']-R*step-targetY)+step/2)<=500))
    slp,error,returns,height,height_error=arrays.astype(float)
    known=circle&np.isfinite(arrays).all(axis=0)&(slp>=0)&(slp<=90)&(error>=0)&(returns>=0)&(height_error>=0)
    mask=known&(slp+rms*error<=slope_limit)&((returns>0)|(not require_returns))
    labels,count=ndimage.label(mask,structure=np.array([[0,1,0],[1,1,1],[0,1,0]]))
    counts=np.bincount(labels.ravel());counts[0]=0
    forbidden=np.zeros((2*h+1,2*w+1),bool);forbidden[1::2,1::2]=~mask
    forbidden=ndimage.maximum_filter(forbidden,size=3,mode='constant',cval=0)
    forbidden[[0,-1],:]=True;forbidden[:,[0,-1]]=True
    radii=ndimage.distance_transform_edt(~forbidden)[1::2,1::2]*(step/2);radii[~mask]=0
    best=None
    if mask.any():
        maximum=float(radii.max());candidates=np.flatnonzero(mask&(radii==maximum))
        distances=(X.ravel()[candidates]-targetX)**2+(Y.ravel()[candidates]-targetY)**2
        k=int(candidates[np.argmin(distances)])
        best={'index':k,'x':float(X.ravel()[k]),'y':float(Y.ravel()[k]),'radiusM':maximum}
    col=int(np.floor((targetX-(meta['x0']-step/2))/step));row=int(np.floor(((meta['y0']+step/2)-targetY)/step))
    point_eligible=0<=row<h and 0<=col<w and bool(mask[row,col])
    point_radius=0.
    if point_eligible:
        point_radius=min(targetX-(meta['x0']-step/2),meta['x0']+(w-.5)*step-targetX,
            meta['y0']+step/2-targetY,targetY-(meta['y0']-(h-.5)*step))
        if (~mask).any():
            dx=np.maximum(abs(X[~mask]-targetX)-step/2,0);dy=np.maximum(abs(Y[~mask]-targetY)-step/2,0)
            point_radius=min(point_radius,float(np.hypot(dx,dy).min()))
    return {'inCircle':total,'known':int(known.sum()),'nominal':int((known&(slp<=slope_limit)).sum()),
        'eligible':int(mask.sum()),'directReturns':int((known&(returns>0)).sum()),'mapAreaM2':int(mask.sum())*step**2,
        'largestConnectedM2':int(counts.max())*step**2,'components':int(count),
        'fittingCentres':int(np.sum(mask&(radii*2+1e-8>=diameter))),'best':best,
        'point':{'radiusM':float(point_radius),'eligible':bool(point_eligible)}}


def main():
    source.verify();index=json.loads((OUT/'index.json').read_text(encoding='utf-8'));cases=[];checks=[]
    for name,sha in index['codeSha256'].items():
        if source.digest(Path(__file__).parent/name)!=sha:raise ValueError('Terrain generator/source verifier changed after packaging')
    if source.digest(source.MANIFEST)!=index['sourceManifestSha256']:raise ValueError('Terrain source manifest changed after packaging')
    for meta in index['patches']:
        path=OUT/meta['file']
        if source.digest(path)!=meta['sha256']:raise ValueError('Packaged terrain bytes changed')
        arrays=np.fromfile(path,dtype='<f4').reshape(5,meta['rows'],meta['cols'])
        for field,array in zip(index['fieldOrder'],arrays):
            region=meta['region'];window=meta['sourceWindow']
            independent,origin=tiff_window(source.CACHE/source.filename(region,field),window['row'],window['col'],meta['rows'],meta['cols'])
            np.testing.assert_array_equal(array,independent)
            np.testing.assert_array_equal(array.view('<u4'),independent.view('<u4'))
            if origin!={'x0':meta['x0'],'y0':meta['y0']}:raise ValueError('GeoTIFF half-pixel registration differs')
            checks.append({'id':meta['id'],'field':field,'cells':int(array.size),'exact_float32_equal':True,'bitwise_float32_equal':True})
        la,lo=np.deg2rad([meta['site']['lat'],meta['site']['lon']]);rho=2*1737400*np.tan((np.pi/2+la)/2);x,y=rho*np.sin(lo),rho*np.cos(lo)
        for slope,rms,diameter,returns in [(10,0,100,False),(10,1,100,False),(10,2,150,False),(10,1,100,True),(5,1,50,False)]:
            cases.append({'id':meta['id'],'targetX':float(x),'targetY':float(y),'maxSlope':slope,'settings':{'rmsMultiplier':rms,'diameterM':diameter,'requireReturns':returns},'result':reference(arrays,meta,x,y,slope,rms,diameter,returns)})
    report={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'indexSha256':source.digest(OUT/'index.json'),
        'method':'Independent uncompressed TIFF strip parser; SciPy four-neighbour label and half-cell Euclidean distance transform',
        'pixelChecks':checks,'cases':cases,'codeSha256':source.digest(Path(__file__)),
        'limits':['Same source DEM products, not independent terrain truth','Areas/lengths in the stated map plane; nominal frame registration',
            'Slope RMS stress is not a confidence bound; no flight hazard or landing qualification']}
    (source.ROOT/'data/validation/landing-area-reference.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(f'Independent TIFF: {len(checks)} full field windows; SciPy: {len(cases)} terrain screens',flush=True)


if __name__=='__main__':main()
