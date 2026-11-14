"""Independent NumPy/SciPy mixed-DEM spherical sightlines, including real browser data.

No TypeScript imports or browser output is used to form the expected horizons.
Grid interpolation uses scipy.ndimage.map_coordinates with explicit four-cell support.
"""
from pathlib import Path
import gzip, hashlib, json, math
import numpy as np
from scipy.ndimage import map_coordinates
import rasterio

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'app/public/data'
R=1737400.
SOURCES={}

def sha(path):
    path=Path(path)
    value=hashlib.sha256(path.read_bytes()).hexdigest()
    SOURCES[path.relative_to(ROOT).as_posix()]=value
    return value

def xy(lat,lon):
    rho=2*R*math.tan(math.radians(90+lat)/2)
    return rho*math.sin(math.radians(lon)),rho*math.cos(math.radians(lon))

def unpack(path,width):
    sha(path)
    delta=np.frombuffer(gzip.decompress(path.read_bytes()),dtype='<i2').reshape(-1,width)
    return np.cumsum(delta,axis=1,dtype=np.int64).astype(np.int16)

def sample(g,x,y,field='data'):
    a=np.asarray(g[field],dtype=float).reshape(g['rows'],g['cols']).copy()
    if 'nodata' in g:a[a==g['nodata']]=np.nan
    c=(x-g['x0'])/g['scale'];r=(g['y0']-y)/g['scale']
    inside=(c>=0)&(r>=0)&(c<=g['cols']-1)&(r<=g['rows']-1)
    cc=np.clip(np.floor(c).astype(int),0,g['cols']-2);rr=np.clip(np.floor(r).astype(int),0,g['rows']-2)
    support=inside&np.isfinite(a[rr,cc])&np.isfinite(a[rr,cc+1])&np.isfinite(a[rr+1,cc])&np.isfinite(a[rr+1,cc+1])
    out=map_coordinates(np.nan_to_num(a),np.array([r,c]),order=1,mode='constant',cval=0.,prefilter=False)*g.get('factor',1.)
    return np.where(support,out,np.nan)

def trace(lat,lon,local,near,far,bins,globe=None):
    x0,y0=xy(lat,lon)
    local={**local,'scale':local['stepM'],'data':local['height'],'factor':1}
    ground=float(sample(local,np.array([x0]),np.array([y0]))[0])
    if not math.isfinite(ground):raise ValueError('Missing local observer support')
    local_rms=float(sample({**local,'data':local['heightRms']},np.array([x0]),np.array([y0]))[0])
    def background(x,y,d):
        n=sample(near,x,y);f=sample(far,x,y)
        n=np.where(d<25000,n,np.nan)
        return np.where(np.isfinite(n),n,np.where(np.isfinite(f),f,globe if globe is not None else np.nan)),np.where(np.isfinite(n),0,np.where(np.isfinite(f),1,2))
    bg=float(background(np.array([x0]),np.array([y0]),np.array([0]))[0][0])
    xs=[local['x0'],local['x0']+(local['cols']-1)*local['scale']];ys=[local['y0'],local['y0']-(local['rows']-1)*local['scale']]
    extent=max(math.hypot(x-x0,y-y0) for x in xs for y in ys)
    segments=[(20,2000,20),(2000,10000,40),(10000,25000,80),(25000,60000,240),(60000,300000,480)]
    distances=sorted([float(d) for a,b,s in segments for d in range(a,b,s)]+list(np.arange(max(.5,local['scale']/2),extent+local['scale']+1e-8,max(.5,local['scale']/2))))
    d=np.array([v for i,v in enumerate(distances) if not i or v-distances[i-1]>1e-7])
    # Use 3D target vectors and dot products with observer up/azimuth direction.
    # This is independent of the TS target-longitude expression for elevation.
    lat0=math.radians(lat);lon0=math.radians(lon)
    up=np.array([math.cos(lat0)*math.cos(lon0),math.cos(lat0)*math.sin(lon0),math.sin(lat0)])
    north=np.array([-math.sin(lat0)*math.cos(lon0),-math.sin(lat0)*math.sin(lon0),math.cos(lat0)])
    east=np.array([-math.sin(lon0),math.cos(lon0),0.])
    counts=dict(localSamples=0,nearSamples=0,farSamples=0,globeSamples=0,missingSamples=0,localGapFallbacks=0)
    delta_min=math.inf;delta_max=-math.inf;answers={2:[],10:[]}
    for start in range(0,bins,48):
        az=(np.arange(start,min(bins,start+48))+.5)*2*np.pi/bins
        tangent=np.cos(az)[:,None]*north+np.sin(az)[:,None]*east
        direction=up[None,None,:]*np.cos(d/R)[None,:,None]+tangent[:,None,:]*np.sin(d/R)[None,:,None]
        latitude=np.arcsin(np.clip(direction[:,:,2],-1,1));longitude=np.arctan2(direction[:,:,1],direction[:,:,0])
        rho=2*R*np.tan((np.pi/2+latitude)/2);x=rho*np.sin(longitude);y=rho*np.cos(longitude)
        h=sample(local,x,y);h=np.where(d[None,:]<=extent+local['scale'],h,np.nan);use_local=np.isfinite(h)
        coarse,kind=background(x,y,d[None,:]);fallback=~use_local;valid=np.isfinite(coarse)
        counts['localSamples']+=int(np.count_nonzero(use_local))
        counts['missingSamples']+=int(np.count_nonzero(fallback&~valid))
        for k,label in enumerate(['nearSamples','farSamples','globeSamples']):counts[label]+=int(np.count_nonzero(fallback&valid&(kind==k)))
        counts['localGapFallbacks']+=int(np.count_nonzero(fallback&valid&(x>=xs[0])&(x<=xs[1])&(y<=ys[0])&(y>=ys[1])))
        delta=(h-coarse)[use_local&valid]
        if delta.size:delta_min=min(delta_min,float(delta.min()));delta_max=max(delta_max,float(delta.max()))
        height=np.where(use_local,h,coarse)
        for observer in [2,10]:
            target=direction*(R+height)[:,:,None]-up[None,None,:]*(R+ground+observer)
            vertical=np.einsum('ijk,k->ij',target,up);horizontal=np.einsum('ijk,ik->ij',target,tangent)
            angle=np.arctan2(vertical,horizontal);angle=np.where(np.isfinite(height),angle,-np.pi/2)
            # JavaScript rounds ties toward +infinity, not Python's even tie.
            answers[observer].extend(np.floor(np.max(angle,axis=1)*180/np.pi*100+.5).astype(int).tolist())
    return {'horizons':{str(k):v for k,v in answers.items()},'groundM':ground,'baselineGroundM':bg if math.isfinite(bg) else None,'heightRmsM':local_rms if math.isfinite(local_rms) else None,
            'bins':bins,**counts,'localDeltaMinM':delta_min if math.isfinite(delta_min) else None,'localDeltaMaxM':delta_max if math.isfinite(delta_max) else None}

def real_background(lat,lon):
    path=DATA/'terrain/terrain.json';sha(path);m=json.loads(path.read_text());n=m['near'];x,y=xy(lat,lon);span=n['scale']*n['tile']
    c1=math.floor((x-26000-n['x0'])/span);c2=math.floor((x+26000-n['x0'])/span)
    r1=math.floor((n['y0']-y-26000)/span);r2=math.floor((n['y0']-y+26000)/span)
    a=np.full(((r2-r1+1)*n['tile'],(c2-c1+1)*n['tile']),-32768,dtype=np.int16)
    for r in range(r1,r2+1):
        for c in range(c1,c2+1):
            path=DATA/f'terrain/near/{r}_{c}.i16z'
            if path.exists():a[(r-r1)*n['tile']:(r-r1+1)*n['tile'],(c-c1)*n['tile']:(c-c1+1)*n['tile']]=unpack(path,n['tile'])
    near={'data':a,'rows':a.shape[0],'cols':a.shape[1],'x0':n['x0']+c1*span,'y0':n['y0']-r1*span,'scale':n['scale'],'factor':m['factor'],'nodata':-32768}
    f=m['far'];far={'data':unpack(DATA/'terrain/far.i16z',f['n']),'rows':f['n'],'cols':f['n'],**f,'factor':m['factor']}
    return near,far

def clean(v):
    if isinstance(v,np.ndarray):return clean(v.tolist())
    if isinstance(v,list):return [clean(x) for x in v]
    if isinstance(v,dict):return {k:clean(x) for k,x in v.items()}
    if isinstance(v,float) and not math.isfinite(v):return None
    return v

def main():
    lat,lon=-89.4398,222.83;x,y=xy(lat,lon)
    local={'rows':13,'cols':13,'stepM':10.,'x0':x-60,'y0':y+60,'height':np.zeros((13,13),np.float32),'heightRms':np.full((13,13),.3,np.float32)}
    near={'rows':40,'cols':40,'scale':80.,'x0':x-1560,'y0':y+1560,'factor':1.,'data':np.zeros((40,40),np.int16)}
    far={'rows':161,'cols':161,'scale':6000.,'x0':-480000.,'y0':480000.,'factor':1.,'data':np.zeros((161,161),np.int16)}
    cases=[]
    for name in ['flat-sphere','local-ridge','lower-local-ground','local-hole','near-nodata','globe-fallback','unknown-background']:
        l={**local,'height':local['height'].copy()};n={**near,'data':near['data'].copy()};f={**far,'data':far['data'].copy()};globe=None
        if name=='local-ridge':l['height'][1:4,:]=80
        if name=='lower-local-ground':l['height'].fill(-50)
        if name=='local-hole':l['height'][1:4,3:7]=np.nan
        if name=='near-nodata':n['data'][5:10,10:25]=-32768;n['nodata']=-32768;f['data'].fill(20)
        if name in ['globe-fallback','unknown-background']:f['data'].fill(-32768);f['nodata']=-32768;globe=40. if name=='globe-fallback' else None
        cases.append({'name':name,'lat':lat,'lon':lon,'local':l,'near':n,'far':f,'globe':globe,'reference':trace(lat,lon,l,n,f,36,globe)})
    l={**local,'height':local['height'].copy(),'x0':-60.,'y0':60.};l['height'][1:4,:]=80
    n={**near,'x0':-1560.,'y0':1560.}
    poles=[{'name':str(lo),'lat':-90.,'lon':lo,'local':l,'near':n,'far':far,'reference':trace(-90.,lo,l,n,far,36)} for lo in [0.,90.,222.83]]
    sites_path=DATA/'sites.json';sha(sites_path);site=next(s for s in json.loads(sites_path.read_text())['sites'] if s['id']=='c1')
    lat,lon=site['lat'],site['lon'];n,f=real_background(lat,lon)
    index_path=DATA/'landing-terrain/index.json';sha(index_path);index=json.loads(index_path.read_text());p=next(p for p in index['patches'] if p['id']=='c1');path=DATA/'landing-terrain'/p['file'];sha(path)
    fields=np.fromfile(path,dtype='<f4').reshape(5,p['rows'],p['cols']);local={**p,'height':fields[3],'heightRms':fields[4]}
    actual=[{'name':'native-c1','lat':lat,'lon':lon,'patchSha256':p['sha256'],'reference':trace(lat,lon,local,n,f,2880)}]
    imports=ROOT/'app/tests/fixtures/terrain-import';source=imports/'height-area.tif';sha(source)
    with rasterio.open(source) as ds:
        # The product uses a bounded 1100 m / max-512-cell analysis window,
        # not the entire imported raster. Reconstruct that window in GDAL.
        s=ds.transform.a;x,y=xy(lat,lon);size=min(512,max(32,math.ceil(1100/s)))
        col=math.floor((x-ds.transform.c)/s)-size//2;row=math.floor((ds.transform.f-y)/s)-size//2
        h=ds.read(1,window=rasterio.windows.Window(col,row,size,size),boundless=True,fill_value=ds.nodata).astype(np.float32);h[h==ds.nodata]=np.nan
        local={'rows':size,'cols':size,'stepM':s,'x0':ds.transform.c+(col+.5)*s,'y0':ds.transform.f-(row+.5)*s,'height':h,'heightRms':np.full_like(h,np.nan)}
    actual.append({'name':'imported-height-c1','lat':lat,'lon':lon,'sourceWindow':{'row':row,'col':col,'rows':size,'cols':size},'reference':trace(lat,lon,local,n,f,2880)})
    fixture={'schema':1,'method':'SciPy bilinear interpolation with strict four-cell support; NumPy 3D great-circle vectors and observer-frame dot products. Background/native source bytes retained and SHA-256 checked; no TypeScript output forms the oracle.','synthetic':cases,'poles':poles,'actual':actual,'sources':SOURCES,'generatorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    path=ROOT/'app/tests/fixtures/local-sky.json';path.write_text(json.dumps(clean(fixture),separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps({'synthetic':len(cases),'actual':len(actual),'sourceFiles':len(SOURCES),'bytes':path.stat().st_size,'missing':[v['reference']['missingSamples'] for v in actual]}))

if __name__=='__main__':main()
