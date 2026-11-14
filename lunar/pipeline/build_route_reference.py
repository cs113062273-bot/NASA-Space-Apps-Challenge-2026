"""Independent GEOS swept-clearance graphs and SciPy Dijkstra references.

Uses committed source patches, not the JavaScript planner or raw TIFF cache.
"""
from pathlib import Path
import json,hashlib,math
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import Point,LineString,box
from shapely.strtree import STRtree

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'app/tests/fixtures/terrain-route.json'
DIR=[(r,c) for r in [-1,0,1] for c in [-1,0,1] if r or c]
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def graph_reference(mask,z,error,step,p,start,goal,x0=0.,y0=0.):
    rows,cols=mask.shape;n=rows*cols;bad=[]
    for r,c in np.argwhere(~mask):
        x,y=x0+c*step,y0-r*step;bad.append(box(x-step/2,y-step/2,x+step/2,y+step/2))
    tree=STRtree(bad);boundary=box(x0-step/2,y0-(rows-.5)*step,x0+(cols-.5)*step,y0+step/2).boundary
    radius=p['widthM']/2;allowed=np.zeros((rows,cols),bool)
    for r,c in np.argwhere(mask):
        point=Point(x0+c*step,y0-r*step);distance=point.distance(boundary)
        if bad:distance=min(distance,point.distance(bad[tree.nearest(point)]))
        allowed[r,c]=distance+1e-9>=radius and np.isfinite(z[r,c]) and (not p['heightRmsMultiplier'] or np.isfinite(error[r,c]) and error[r,c]>=0)
    bits=np.zeros(n,np.uint8);edges=[];targets=[];costs=[]
    for r,c in np.argwhere(allowed):
        u=int(r*cols+c)
        for direction,(dr,dc) in enumerate(DIR):
            rr,cc=r+dr,c+dc
            if not (0<=rr<rows and 0<=cc<cols and allowed[rr,cc]):continue
            if dr and dc and not(mask[r,cc] and mask[rr,c]):continue
            distance=step*math.hypot(dr,dc);dh=z[rr,cc]-z[r,c];stress=p['heightRmsMultiplier']*(error[r,c]+error[rr,cc]) if p['heightRmsMultiplier'] else 0
            if math.degrees(math.atan2(abs(dh)+stress,distance))>p['maxGradeDeg']+1e-10:continue
            line=LineString([(x0+c*step,y0-r*step),(x0+cc*step,y0-rr*step)])
            query=box(*[line.bounds[0]-radius-1e-8,line.bounds[1]-radius-1e-8,line.bounds[2]+radius+1e-8,line.bounds[3]+radius+1e-8])
            if any(line.distance(bad[k])+1e-9<radius for k in tree.query(query)):continue
            bits[u]|=1<<direction;edges.append(u);targets.append(int(rr*cols+cc));costs.append(distance+p['ascentCost']*max(0,dh))
    matrix=csr_matrix((costs,(edges,targets)),shape=(n,n))
    best=float(dijkstra(matrix,directed=True,indices=start)[goal]) if allowed.flat[start] and allowed.flat[goal] else math.inf
    return {'status':'found' if math.isfinite(best) else 'blocked','cost':best if math.isfinite(best) else None,'allowedDirections':bits.tolist(),'edgeCount':len(edges)}

def native_case(index,meta,settings,start,goal):
    fields=np.fromfile(ROOT/'app/public/data/landing-terrain'/meta['file'],dtype='<f4').reshape(5,meta['rows'],meta['cols'])
    slope,rms,returns,height,height_rms=fields.astype(float);s=meta['stepM'];xx,yy=np.meshgrid(meta['x0']+np.arange(meta['cols'])*s,meta['y0']-np.arange(meta['rows'])*s)
    lat,lon=np.deg2rad([meta['site']['lat'],meta['site']['lon']]);rho=2*1737400*np.tan((np.pi/2+lat)/2);x,y=rho*np.sin(lon),rho*np.cos(lon)
    known=np.isfinite(fields).all(axis=0)&(slope>=0)&(slope<=90)&(rms>=0)&(returns>=0)&(height_rms>=0)
    mask=known&(slope+rms<=10)&(np.hypot(abs(xx-x)+s/2,abs(yy-y)+s/2)<=500)
    result=graph_reference(mask,height,height_rms,s,settings,start,goal,meta['x0'],meta['y0'])
    print(f'{meta["id"]} width {settings["widthM"]}: {result["status"]}, {result["edgeCount"]} independent edges',flush=True)
    return {'id':meta['id'],'patchSha256':meta['sha256'],'start':int(start),'goal':int(goal),'settings':settings,'reference':result}

def main():
    rng=np.random.default_rng(2601105);cases=[]
    for i in range(24):
        rows,cols=8,9;s=[1.,5.,20.][i%3];mask=rng.random((rows,cols))>.16
        mask[1,1]=mask[-2,-2]=True
        height=(rng.random((rows,cols))*.15*s).astype('float32').astype(float);error=np.full_like(height,float(np.float32(.01*s)))
        settings={'widthM':[0,.8*s,2*s][i%3],'maxGradeDeg':[10,25,80][(i//3)%3],'heightRmsMultiplier':i%3,'ascentCost':[0,2,10][(i//4)%3]}
        result=graph_reference(mask,height,error,s,settings,cols+1,(rows-2)*cols+cols-2)
        cases.append({'rows':rows,'cols':cols,'stepM':s,'mask':mask.astype(int).ravel().tolist(),'height':height.ravel().tolist(),'heightRms':error.ravel().tolist(),'start':cols+1,'goal':(rows-2)*cols+cols-2,'settings':settings,'reference':result})
    for penalty in [0,5]:
        mask=np.ones((7,9),bool);height=np.zeros((7,9));height[2:5,4]=10;error=np.zeros_like(height);settings={'widthM':0,'maxGradeDeg':90,'heightRmsMultiplier':0,'ascentCost':penalty}
        cases.append({'rows':7,'cols':9,'stepM':1,'mask':mask.astype(int).ravel().tolist(),'height':height.ravel().tolist(),'heightRms':error.ravel().tolist(),'start':28,'goal':34,'settings':settings,'reference':graph_reference(mask,height,error,1,settings,28,34)})
    directory=ROOT/'app/public/data/landing-terrain';index=json.loads((directory/'index.json').read_text(encoding='utf-8'));native=[]
    for site in ['c1','shackleton']:
        meta=next(m for m in index['patches'] if m['id']==site)
        existing=json.loads((ROOT/'data/validation/landing-area-reference.json').read_text(encoding='utf-8'));ref=next(c for c in existing['cases'] if c['id']==site and c['maxSlope']==10 and c['settings']['rmsMultiplier']==1 and not c['settings']['requireReturns'])
        # Fixed scientific endpoints: the actual mission cell and the independent
        # best-disc cell. This is fixture selection, not runtime endpoint repair.
        x,y=ref['targetX'],ref['targetY'];s=meta['stepM'];col=int((x-meta['x0']+s/2)//s);row=int((meta['y0']+s/2-y)//s)
        for width in [4,30]:native.append(native_case(index,meta,{'widthM':width,'maxGradeDeg':15,'heightRmsMultiplier':1,'ascentCost':2},row*meta['cols']+col,ref['result']['best']['index']))
    distances=[]
    for _ in range(120):
        a,b=rng.uniform(-20,20,(2,2));left,bottom=rng.uniform(-15,10,2);right=left+rng.uniform(.1,10);top=bottom+rng.uniform(.1,10)
        distances.append({'a':a.tolist(),'b':b.tolist(),'bounds':[left,bottom,right,top],'distance':LineString([a,b]).distance(box(left,bottom,right,top))})
    result={'schema':1,'method':'GEOS point/segment to closed pixel polygons and boundary; SciPy directed sparse Dijkstra, independent of JS A* and clearance shortcuts','directions':DIR,'cases':cases,'native':native,'distances':distances,
        'nativeIndexSha256':digest(directory/'index.json'),'codeSha256':digest(__file__),'limits':['Same source products, independent numerical geometry/optimizer; no physical terrain, rover or time-dependent mission validation']}
    OUT.write_text(json.dumps(result,separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8',newline='\n')
    print(f'Wrote {len(cases)} synthetic graph cases, {len(native)} real-source graphs and {len(distances)} GEOS distance cases; {OUT.stat().st_size:,} bytes',flush=True)

if __name__=='__main__':main()
