"""Sub-hour SPICE targets for independent interpolation residual checks.

Uses the previously pinned local kernels; does not fetch or change source assets.
"""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json
import numpy as np
import spiceypy as sp
from scipy.interpolate import BarycentricInterpolator
import build_station_ephemeris as S
import ephemeris as E

ROOT=Path(__file__).resolve().parents[1]
def sha(p):
    p = Path(p)
    data = p.read_bytes()
    if p.suffix == '.json':
        data = data.replace(b'\r\n', b'\n')
    return hashlib.sha256(data).hexdigest()

def residual_report(samples,fixture):
    maximum={'receiverElevationDeg':0.,'lunarAimDeg':0.,'bodyDirectionDeg':0.}
    def angle(a,b):return float(np.degrees(np.arctan2(np.linalg.norm(np.cross(a,b)),np.dot(a,b))))
    for c in samples:
        a=np.array(c['interpolated']).astype(np.float32).astype(float).reshape(3,9);b=np.array(c['stationVectors']).reshape(3,9)
        for j in range(3):maximum['lunarAimDeg']=max(maximum['lunarAimDeg'],angle(a[j,:3],b[j,:3]))
        for lat,lon in [(-89.4398,222.83),(0,0),(45,90)]:
            la,lo=np.radians([lat,lon]);pos=1737.4*np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
            for j in range(3):
                aa=a[j,3:6]+pos;bb=b[j,3:6]+pos
                ea=np.degrees(np.arcsin(np.clip(aa@a[j,6:9]/np.linalg.norm(aa),-1,1)));eb=np.degrees(np.arcsin(np.clip(bb@b[j,6:9]/np.linalg.norm(bb),-1,1)))
                maximum['receiverElevationDeg']=max(maximum['receiverElevationDeg'],float(abs(ea-eb)))
        for j in range(2):maximum['bodyDirectionDeg']=max(maximum['bodyDirectionDeg'],angle(np.array(c['bodyInterpolated'][3*j:3*j+3]).astype(np.float32).astype(float),np.array(c['bodyVectors'][3*j:3*j+3])))
    if maximum['receiverElevationDeg']>=.01 or maximum['lunarAimDeg']>=.0005:raise ValueError('Sampled interpolation error exceeds the selected engineering guards')
    report={'schema':1,'samples':len(samples),'method':'Complete pinned SPICE sub-hour station/body vectors compared with independently evaluated SciPy cubic interpolation; Float32 channel rounding and receiver zenith normalization retained.',
      'maximumSampledDifference':maximum,'engineeringInterpolationGuardsDeg':{'receiver':.01,'aim':.0005},'referenceSha256':sha(fixture),'generatorSha256':sha(__file__),
      'limits':['Sampled interpolation differences, not independent flight or general source/model accuracy.','Guards are selected engineering sensitivities, not confidence bounds; source Earth orientation and small-origin approximations retain separate limits.']}
    (ROOT/'data/validation/moving-ephemeris-check.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n')

def main():
    S.furnish();data=ROOT/'app/public/data';meta=json.loads((data/'ephemeris.json').read_text());count=meta['count'];start=meta['start_unix'];step=meta['step_s']
    stations=np.fromfile(data/'stations.f32',dtype='<f4').reshape(count,27);bodies=np.fromfile(data/'ephemeris.f32',dtype='<f4').reshape(count,6)
    samples=[]
    # Include both source boundaries, both Earth-PCK eras, solstices and month offsets.
    hours=[0,1,count-3,count-2]+[int((datetime(y,m,15,tzinfo=timezone.utc).timestamp()-start)/step) for y in [2025,2026,2027] for m in [1,4,7,10]]
    hours=sorted(set(h for h in hours if 0<=h<count-1))
    for hour in hours:
        for fraction in [1/12,1/4,1/2,3/4,11/12]:
            unix=start+(hour+fraction)*step;utc=datetime.fromtimestamp(unix,timezone.utc).strftime('%Y-%m-%dT%H:%M:%S');et=sp.str2et(utc)
            truth=S.vectors(np.array([et]))[0].reshape(27).astype(float)
            sun,_=sp.spkpos('SUN',et,'MOON_ME','LT+S','MOON');earth,_=sp.spkpos('EARTH',et,'MOON_ME','LT+S','MOON')
            first=max(0,min(count-4,hour-1));x=(unix-start)/step
            interpolated=BarycentricInterpolator(np.arange(first,first+4),stations[first:first+4],axis=0,rng=0)(x)
            body=BarycentricInterpolator(np.arange(first,first+4),bodies[first:first+4],axis=0,rng=0)(x)
            for j in range(3):interpolated[j*9+6:j*9+9]/=np.linalg.norm(interpolated[j*9+6:j*9+9])
            samples.append({'unix':unix,'utc':utc+'Z','stationVectors':truth.tolist(),'interpolated':interpolated.tolist(),'bodyVectors':np.r_[sun,earth].tolist(),'bodyInterpolated':body.tolist()})
    artifact={'schema':1,'method':'Complete pinned SPICE XCN+S/CN+S station vectors at sub-hour UTC; SciPy barycentric cubic interpolation of four retained hourly samples, receiver zenith normalized. Body vectors use the source pipeline corrections. No browser values form the oracle.','samples':samples,
      'sourceSha256':{name:sha(ROOT/name) for name in ['app/public/data/ephemeris.json','app/public/data/ephemeris.f32','app/public/data/stations.f32','app/public/data/stations.json','data/validation/kernels.json']},
      'generatorSha256':sha(__file__)}
    path=ROOT/'app/tests/fixtures/moving-ephemeris.json';path.write_text(json.dumps(artifact,separators=(',',':'))+'\n',encoding='utf-8',newline='\n')
    residual_report(samples,path)
    print(json.dumps({'samples':len(samples),'bytes':path.stat().st_size}))

if __name__=='__main__':main()
