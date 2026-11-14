"""Independent source/geometry/power validation of actual desktop moving exports.

SciPy interpolation, NumPy three-dimensional rays, source-cell and GEOS graph
certificates are independent of the browser simulator. These checks share the
source products; they do not validate physical terrain or vehicle performance.
"""
from pathlib import Path
from datetime import datetime,timezone
import csv,hashlib,json,math
import numpy as np
from scipy.ndimage import map_coordinates
from scipy.interpolate import BarycentricInterpolator
from build_local_sky_reference import real_background

ROOT=Path(__file__).resolve().parents[1];R=1737400.;AU=149597870.7
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))

def sampler(raw):
    a=np.asarray(raw['data'],dtype=float).reshape(raw['rows'],raw['cols']).copy()*raw.get('factor',1.)
    if 'nodata' in raw:a[np.asarray(raw['data']).reshape(a.shape)==raw['nodata']]=np.nan
    filled=np.nan_to_num(a)
    def sample(x,y):
        c=(x-raw['x0'])/raw['scale'];r=(raw['y0']-y)/raw['scale'];inside=(c>=0)&(r>=0)&(c<=a.shape[1]-1)&(r<=a.shape[0]-1)
        cc=np.clip(np.floor(c).astype(int),0,a.shape[1]-2);rr=np.clip(np.floor(r).astype(int),0,a.shape[0]-2)
        support=inside&np.isfinite(a[rr,cc])&np.isfinite(a[rr,cc+1])&np.isfinite(a[rr+1,cc])&np.isfinite(a[rr+1,cc+1])
        out=map_coordinates(filled,np.array([r,c]),order=1,mode='constant',cval=0.,prefilter=False)
        return np.where(support,out,np.nan)
    return sample

def frame(lat,lon,ground,observer):
    la,lo=np.radians([lat,lon]);up=np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
    east=np.array([-np.sin(lo),np.cos(lo),0.]);north=np.cross(up,east)
    return up,east,north,up*(R+ground+observer)/1000

def angles(vectors,up,east,north,pos):
    v=vectors-pos;el=np.degrees(np.arctan2(v@up,np.hypot(v@east,v@north)));az=np.arctan2(v@east,v@north)
    return az,el

def destination_xy(lat,lon):
    rho=2*R*math.tan(math.radians(90+lat)/2);return rho*math.sin(math.radians(lon)),rho*math.cos(math.radians(lon))

def horizons(lat,lon,ground,observer,az,local,fine,near,far,refined):
    x0,y0=destination_xy(lat,lon);xs=[local['x0'],local['x0']+(local['cols']-1)*local['scale']];ys=[local['y0'],local['y0']-(local['rows']-1)*local['scale']]
    extent=max(math.hypot(x-x0,y-y0) for x in xs for y in ys)
    parts=[(20,2000,20),(2000,10000,40),(10000,25000,80),(25000,60000,240),(60000,300000,480)]
    base=np.concatenate([np.arange(a,b,s,dtype=float) for a,b,s in parts]);radial=max(.5,local['scale']/2)*(0.5 if refined else 1)
    distances=list(base)+list(np.arange(radial,extent+local['scale']+1e-8,radial))
    if refined:distances.extend((base[:-1]+base[1:])/2)
    distances=sorted(distances);d=np.array([v for i,v in enumerate(distances) if not i or v-distances[i-1]>1e-7])
    up,east,north,_=frame(lat,lon,ground,observer);tangent=np.cos(az)[:,None]*north+np.sin(az)[:,None]*east
    direction=up[None,None,:]*np.cos(d/R)[None,:,None]+tangent[:,None,:]*np.sin(d/R)[None,:,None]
    # Independent Cartesian-to-spherical projection instead of the JS rational XY expression.
    la=np.arctan2(direction[:,:,2],np.hypot(direction[:,:,0],direction[:,:,1]));lo=np.arctan2(direction[:,:,1],direction[:,:,0])
    rho=2*R*np.tan((np.pi/2+la)/2);x=rho*np.sin(lo);y=rho*np.cos(lo)
    z=fine(x,y);z=np.where(d[None,:]<=extent+local['scale'],z,np.nan)
    n=np.where(d[None,:]<25000,near(x,y),np.nan);f=far(x,y)
    z=np.where(np.isfinite(z),z,np.where(np.isfinite(n),n,f))
    if not np.isfinite(z).all():raise ValueError('Independent oracle has unknown ray terrain')
    target=direction*(R+z)[:,:,None]-up[None,None,:]*(R+ground+observer)
    vertical=np.einsum('ijk,k->ij',target,up);horizontal=np.einsum('ijk,ik->ij',target,tangent)
    return np.max(np.degrees(np.arctan2(vertical,horizontal)),axis=1)

def cubic(source,meta,unix):
    x=(unix-meta['start_unix'])/meta['step_s'];first=max(0,min(meta['count']-4,math.floor(x)-1))
    result=BarycentricInterpolator(np.arange(first,first+4),source[first:first+4],axis=0,rng=0)(x)
    return result

def close(actual,expected,tolerance,label):
    if not math.isfinite(actual) or abs(actual-expected)>tolerance:raise ValueError(f'{label}: {actual} vs {expected}; tolerance {tolerance}')

def main():
    out=ROOT/'app/test-results';data=ROOT/'app/public/data';em=read(data/'ephemeris.json');sm=read(data/'stations.json')
    body=np.fromfile(data/'ephemeris.f32',dtype='<f4').reshape(-1,6);station=np.fromfile(data/'stations.f32',dtype='<f4').reshape(-1,27)
    graph=next(v for v in read(ROOT/'app/tests/fixtures/terrain-route.json')['native'] if v['id']=='c1' and v['settings']['widthM']==4)
    reports=[];maximum={'groundM':0.,'directionalClearanceDeg':0.,'sunFraction':0.,'arrayW':0.,'storageWh':0.,'positionM':0.};rows_checked=0;rays_checked=0;csv_checked=0
    for suffix in ['failed','passed','delayed']:
        path=out/f'moving-route-{suffix}.json';p=read(path);source=p['route']['source']['patch'];raw=data/'landing-terrain'/source['file']
        if sha(raw)!=source['sha256'] or source['sha256']!=graph['patchSha256']:raise ValueError('Moving source patch mismatch')
        if p['ephemeris']['bodySha256']!=sha(data/'ephemeris.f32') or p['ephemeris']['stationsSha256']!=sha(data/'stations.f32'):raise ValueError('Moving ephemeris source mismatch')
        g=np.fromfile(raw,dtype='<f4').reshape(5,source['rows'],source['cols']);local={**source,'data':g[3],'scale':source['stepM']};fine=sampler(local)
        near_grid,far_grid=real_background(p['route']['mission']['lat'],p['route']['mission']['lon']);near=sampler(near_grid);far=sampler(far_grid)
        nodes=p['route']['result']['nodes'];length=0.
        for i,n in enumerate(nodes):
            k=n['index'];r,c=divmod(k,source['cols']);x=source['x0']+c*source['stepM'];y=source['y0']-r*source['stepM']
            close(n['x'],x,1e-9,'source vertex X');close(n['y'],y,1e-9,'source vertex Y');close(n['heightM'],float(g[3,r,c]),1e-9,'source height')
            if i:
                before=nodes[i-1];dr=r-before['index']//source['cols'];dc=c-before['index']%source['cols'];direction=read(ROOT/'app/tests/fixtures/terrain-route.json')['directions'].index([dr,dc])
                if not graph['reference']['allowedDirections'][before['index']]&(1<<direction):raise ValueError('Moving route edge lacks its independent GEOS certificate')
                length+=math.hypot(n['x']-before['x'],n['y']-before['y'])
            close(n['distanceM'],length,1e-9,'source path distance')
        inp=p['input'];settings=inp['settings'];power=inp['power'];radio=inp['radio'];storage=power.get('storage',{});capacity=power['batteryWh']*storage.get('maxDod',1)
        ideal={'maxDod':1,'initialSoc':1,'chargeEfficiency':1,'dischargeEfficiency':1,'maxChargeW':None,'maxDischargeW':None,'darkHeaterW':0,'arrayFactor':1}
        if radio.get('relay') or radio.get('operations',{}).get('traffic') or power.get('thermal') or any(value!=ideal[key] for key,value in storage.items()):raise ValueError('This actual-export oracle is scoped to the retained direct/ideal-storage/no-thermal/no-traffic cases; other physics has separate analytic regressions')
        csv_path=out/f'moving-route-{suffix}.csv';csv_rows=list(csv.DictReader(line for line in csv_path.read_text(encoding='utf-8').splitlines() if line and not line.startswith('#')))
        run_names={'nominal':'nominal','raised':'raised','refinedNominal':'refined_nominal','refinedRaised':'refined_raised'};run_summaries=[]
        for name,csv_name in run_names.items():
            run=p['evaluation'][name]
            if run is None:raise ValueError('Single-run export must retain all four runs')
            serialized=[row for row in csv_rows if row['scenario']==csv_name]
            if len(serialized)!=len(run['samples']):raise ValueError('Moving CSV sample count differs')
            charge=power['batteryWh']*(storage.get('initialSoc',1)-(1-storage.get('maxDod',1)));solar_wh=0.;load_wh=0.;returned=0.;first_power=None;expected_distance=0.;halted=False
            initial=charge;elapsed=0.
            for s,cs in zip(run['samples'],serialized):
                rows_checked+=1;csv_checked+=1;lat=s['lat'];lon=s['lon'];x,y=destination_xy(lat,lon)
                # Source polyline position, independent of the exported geographic coordinate.
                d=s['mapDistanceM'];i=next((i for i,n in enumerate(nodes) if n['distanceM']>=d and i>0),len(nodes)-1);a=nodes[max(0,i-1)];b=nodes[i];f=(d-a['distanceM'])/(b['distanceM']-a['distanceM']) if b['distanceM']>a['distanceM'] else 0
                px=a['x']+f*(b['x']-a['x']);py=a['y']+f*(b['y']-a['y']);position_error=math.hypot(x-px,y-py);maximum['positionM']=max(maximum['positionM'],position_error)
                close(position_error,0,2e-7,'geographic/source pose');close(d,expected_distance,2e-5,'causal drive progress')
                ground=float(fine(np.array([x]),np.array([y]))[0]);maximum['groundM']=max(maximum['groundM'],abs(ground-s['groundM']));close(s['groundM'],ground,2e-7,'moving local observer')
                up,east,north,pos=frame(lat,lon,ground,inp['observerM']);bv=cubic(body,em,s['unix']).astype(np.float32).astype(float);sv=cubic(station,em,s['unix'])
                for j in range(3):sv[j*9+6:j*9+9]/=np.linalg.norm(sv[j*9+6:j*9+9])
                sv=sv.astype(np.float32).astype(float).reshape(3,9);vectors=np.vstack([bv.reshape(2,3),sv[:,:3]])
                az,el=angles(vectors,up,east,north,pos);sky=horizons(lat,lon,ground,inp['observerM'],az,local,fine,near,far,run['refined'])+run['shiftDeg'];rays_checked+=5
                for key,value in [('sunClearDeg',el[0]-sky[0]),('earthClearDeg',el[1]-sky[1])]:maximum['directionalClearanceDeg']=max(maximum['directionalClearanceDeg'],abs(s[key]-value));close(s[key],value,3e-5,key)
                sun_dist=np.linalg.norm(bv[:3]-pos);earth_dist=np.linalg.norm(bv[3:]-pos);sun_radius=math.asin(696000/sun_dist);earth_radius=math.asin(6371/earth_dist)
                separation=math.acos(np.clip(np.dot(bv[:3]-pos,bv[3:]-pos)/sun_dist/earth_dist,-1,1))
                if separation<=sun_radius+earth_radius:raise ValueError('Retained direct-export oracle requires a non-eclipse sample')
                z=np.clip(math.radians(el[0]-sky[0])/sun_radius,-1,1);fraction=(math.asin(z)+z*math.sqrt(max(0,1-z*z))+math.pi/2)/math.pi
                maximum['sunFraction']=max(maximum['sunFraction'],abs(s['sunFraction']-fraction));close(s['sunFraction'],fraction,3e-6,'finite Sun fraction')
                elevation=math.radians(el[0]);incidence=math.cos(elevation) if power['mode']=='tracking' else max(0,math.sin(elevation)) if power['mode']=='horizontal' else max(0,math.cos(elevation)*math.cos(az[0]-math.radians(power['facingAz']+(s['headingDeg'] if settings['panelFrame']=='travel' else 0))))
                array=1361*(AU/np.linalg.norm(bv[:3]))**2*fraction*incidence*power['areaM2']*power['efficiency']*storage.get('arrayFactor',1)
                maximum['arrayW']=max(maximum['arrayW'],abs(array-s['arrayW']));close(s['arrayW'],array,.005,'array watts')
                recent=s['unix']<sm['earth_orientation']['recent_kernel_until_unix'];o=sm['earth_orientation'];aim_stress=(o['recent_aim_stress_deg'] if recent else o['long_term_aim_stress_deg'])+.0005 if run['shiftDeg'] else 0
                ground_stress=(o['recent_ground_stress_deg'] if recent else o['long_term_ground_stress_deg'])+.01 if run['shiftDeg'] else 0
                mask=0;rates=[]
                for j in range(3):
                    receiver=math.degrees(math.asin(np.clip(np.dot(sv[j,3:6]+pos,sv[j,6:9])/np.linalg.norm(sv[j,3:6]+pos),-1,1)))
                    allowed=el[j+2]-sky[j+2]-aim_stress>=inp['earthMinClear'] and receiver-ground_stress>=10
                    if allowed:mask|=1<<j
                    band=radio['band'];mhz=8425 if band=='X' else 2295;ground_gain=68.3 if band=='X' else 56.74;temperature=211 if band=='X' else 166;wavelength=299792458/(mhz*1e6);distance=np.linalg.norm(sv[j,:3]-pos)
                    gain=10*math.log10(.55*(math.pi*radio['dishM']/wavelength)**2) if radio.get('dishM') else radio['gainDbi']
                    cn=10*math.log10(max(radio['txW'],1e-6))+gain-20*math.log10(4*math.pi*distance*1000/wavelength)-2+ground_gain-10*math.log10(temperature)+228.6
                    rate=10**((cn-2.5-3)/10);rates.append(float(np.float32(min(rate,radio['maxKbps']*1000) if radio.get('maxKbps') else rate)))
                if radio.get('operations'):raise ValueError('Retained actual-export oracle uses the default allocation; synthetic tests cover custom plans')
                if s['receivingMask']!=mask:raise ValueError('Independent antenna terrain/reception mask differs')
                best=max((j for j in range(3) if mask&(1<<j)),key=lambda j:rates[j],default=None);rate=0 if best is None else rates[best]
                if s['chosenStation']!=(0 if best is None else 1<<best):raise ValueError('Independent best reference antenna differs')
                criterion=bool(mask) if inp['requireDsn'] else el[1]-sky[1]>=inp['earthMinClear']
                if s['earthVisible']!=criterion:raise ValueError('Independent Earth criterion differs')
                close(s['linkRateBps'],rate,max(.5,rate*2e-7),'reference link rate')
                dt=s['seconds']/3600;expected_bus=power['loadW']+s['driveW']+(radio['txW']/0.3 if mask else 0)
                close(s['busW'],expected_bus,.001,'bus load')
                net=array-expected_bus
                if net>=0:charge=min(capacity,charge+min(net,storage.get('maxChargeW') or math.inf)*storage.get('chargeEfficiency',1)*dt);powered=1.
                else:
                    need=-net;limit=storage.get('maxDischargeW');limit=math.inf if limit is None else limit;delivered=min(min(need,limit)*dt,charge*storage.get('dischargeEfficiency',1));powered=0. if limit<need-1e-9 else min(1,delivered/(need*dt));charge-=delivered/storage.get('dischargeEfficiency',1)
                if first_power is None and powered<1-1e-7:first_power=elapsed/3600+powered*dt
                maximum['storageWh']=max(maximum['storageWh'],abs(charge-s['storedWh']));close(s['storedWh'],charge,.004,'causal storage energy');close(s['poweredFraction'],powered,5e-5,'powered fraction')
                if s['phase']=='drive':
                    moved=settings['speedMps']*s['seconds']*(powered if not halted else 0);expected_distance=min(length,expected_distance+moved)
                if powered<1-1e-7:halted=True
                if halted and s['phase']=='halted' and s['driveW']!=0:raise ValueError('Halted drive still reserves future motor demand')
                # The independently checked powered fraction is a Float32
                # channel in the common bus engine. Check RF/bit accounting
                # separately from the small accumulated storage-rounding error.
                delivered=rate*s['seconds']*s['poweredFraction'];close(s['returnedBits'],delivered,max(10,abs(delivered)*3e-6),'powered return')
                solar_wh+=array*dt;load_wh+=expected_bus*dt;returned+=delivered;elapsed+=s['seconds']
                for key,expected in [('map_distance_m',d),('ground_m',s['groundM']),('stored_wh',s['storedWh']),('interval_seconds',s['seconds']),('returned_bits',s['returnedBits'])]:close(float(cs[key]),expected,max(1e-8,abs(expected)*1e-12),'CSV '+key)
            close(run['endStoredWh'],charge,.004,'final energy');close(run['solarWh'],solar_wh,.004,'total solar energy');close(run['loadWh'],load_wh,.004,'total demand');close(run['returnedBits'],returned,max(100,returned*3e-6),'total return');close(run['finalDistanceM'],expected_distance,2e-5,'final progress')
            close(elapsed,run['endUnix']-inp['startUnix'],2e-5,'full scenario duration')
            if first_power is None:
                if run['firstPowerH'] is not None:raise ValueError('Unexpected reported bus failure')
            else:close(run['firstPowerH'],first_power,1e-5,'first bus failure')
            run_summaries.append({'name':name,'samples':len(run['samples']),'pass':run['pass'],'arrived':run['arrived'],'finalDistanceM':run['finalDistanceM'],'endStoredWh':run['endStoredWh'],'returnedBits':run['returnedBits']})
        if suffix=='failed' and (p['evaluation']['pass'] or p['evaluation']['nominal']['arrived']):raise ValueError('Failed drive received destination credit')
        if suffix in ['passed','delayed'] and (not p['evaluation']['pass'] or p['evaluation']['nominal']['solarWh']<=0 or p['evaluation']['nominal']['returnedBits']<=0):raise ValueError('Retained passing run must exercise positive solar generation and direct return')
        reports.append({'case':suffix,'jsonSha256':sha(path),'csvSha256':sha(csv_path),'resultSha256':p['resultSha256'],'runs':run_summaries})
    replay=read(out/'moving-route-restored.json');passed=read(out/'moving-route-passed.json')
    if replay['evaluation']!=passed['evaluation'] or replay['resultSha256']!=passed['resultSha256']:raise ValueError('Fresh-context restoration changed the moving result')
    replay=read(out/'moving-route-delayed-restored.json');delayed=read(out/'moving-route-delayed.json')
    if replay['evaluation']!=delayed['evaluation'] or replay['resultSha256']!=delayed['resultSha256'] or delayed['input']['settings']['departureDelayH']!=1:raise ValueError('Chosen nonzero wait changed across restoration')
    artifact={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'method':__doc__,'cases':reports,'rowsChecked':rows_checked,'startPoseDirectionalRaysChecked':rays_checked,'csvRowsChecked':csv_checked,'maximumAbsoluteDifference':maximum,
      'sourceSha256':{'body':sha(data/'ephemeris.f32'),'stations':sha(data/'stations.f32'),'nativeGraph':sha(ROOT/'app/tests/fixtures/terrain-route.json')},
      'codeSha256':{name:sha(ROOT/name) for name in ['pipeline/validate_moving_exports.py','app/src/lib/traverse.ts','app/src/lib/traverse-evaluation.ts','app/src/lib/traverse.worker.ts','app/src/lib/moving-sky.ts','app/src/lib/moving-ephemeris.ts','app/src/lib/power.ts','app/src/lib/link.ts','app/src/components/TerrainTraversePanel.tsx']},
      'limits':['Actual export cases are direct service, default allocation, ideal storage and disabled equipment thermal; analytic regressions cover additional selected mechanisms.','Independent arithmetic on the same source grids, not terrain truth, vehicle/soil qualification, a continuous-path proof or a running-competitor outcome.']}
    (ROOT/'data/validation/moving-route-check.json').write_text(json.dumps(artifact,indent=2)+'\n',encoding='utf-8',newline='\n');print(json.dumps({'rows':rows_checked,'rays':rays_checked,'maximum':maximum}))

if __name__=='__main__':main()
