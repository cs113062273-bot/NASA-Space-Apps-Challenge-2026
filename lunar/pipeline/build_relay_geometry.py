"""Derive sampled single-SV terrain/DSN geometry from a checked reference trajectory.

Exports an importable two-leg CSV with explicitly ASSUMED rates. Geometry is a reference
scenario, not provider coverage, RF closure, booking, or continuous-time visibility proof.
Only hours passing at every sample, including both endpoints, are retained.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
from scipy.interpolate import CubicHermiteSpline
from scipy.integrate import solve_ivp
import spiceypy as sp

import build_station_ephemeris as stations
import fetch_kernels as kernels
import fetch_relay_sources as sources
import lunar_limb
from propagate_relay import ReferenceDynamics
from relay_orbits import INITIAL_STATES

ME_FRAME='MOON_ME_DE440_ME421'
LANDER=-990200
SV=-991001 # local research ID, not an assigned flight-spacecraft ID


def full_hours(passing: np.ndarray, samples_per_hour: int) -> np.ndarray:
    if not isinstance(samples_per_hour,int) or samples_per_hour<1 or passing.ndim!=1 or len(passing)<2 or (len(passing)-1)%samples_per_hour:
        raise ValueError('Whole-hour sample grid mismatch')
    return np.array([np.all(passing[a:a+samples_per_hour+1]) for a in range(0,len(passing)-1,samples_per_hour)])


def contact_runs(good: np.ndarray, start_unix: float, leg: str, kbps: float) -> list[dict]:
    if leg not in ['access','backhaul'] or not np.isfinite(kbps) or not 0<kbps<=1e9:raise ValueError('Invalid contact service assumptions')
    edges=np.diff(np.r_[False,good,False].astype(int))
    return [{'startUnix':float(start_unix+a*3600),'endUnix':float(start_unix+b*3600),'leg':leg,'kbps':kbps}
        for a,b in zip(np.flatnonzero(edges==1),np.flatnonzero(edges==-1))]


def local_frame(lat: float,lon: float):
    la,lo=np.deg2rad([lat,lon])
    return np.array([-np.sin(lo),np.cos(lo),0]),np.array([-np.sin(la)*np.cos(lo),-np.sin(la)*np.sin(lo),np.cos(la)]),np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])


def terrain_clearance(vectors: np.ndarray,lat: float,lon: float,horizon: np.ndarray) -> np.ndarray:
    east,north,up=local_frame(lat,lon)
    e,n,u=vectors@east,vectors@north,vectors@up
    az=np.arctan2(e,n)%(2*np.pi);el=np.rad2deg(np.arctan2(u,np.hypot(e,n)))
    # Published horizon rays are bin centres, matching lunar_geo.py and Horizon.at.
    pos=az/(2*np.pi)*len(horizon)-.5;i=np.floor(pos).astype(int)%len(horizon);f=pos-np.floor(pos)
    return el-((1-f)*horizon[i]+f*horizon[(i+1)%len(horizon)])/100


def verified_trajectory():
    report_path=sources.ROOT/'data/validation/relay-propagation.json'
    checks=json.loads((sources.ROOT/'data/validation/relay-orbit-checks.json').read_text(encoding='utf-8'))
    report=json.loads(report_path.read_text(encoding='utf-8'))
    if hashlib.sha256(report_path.read_bytes()).hexdigest()!=checks['baseline_report_sha256']:
        raise ValueError('Orbit numerical checks do not cover the current propagation report')
    for name,sha in report['code_sha256'].items():
        if hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest()!=sha:raise ValueError('Orbit model changed after numerical validation')
    if max(checks['thirty_day_tighter_dop853']['maximum_position_difference_km_by_sv'])>.02:
        raise ValueError('Reference orbit convergence gate failed')
    if max(checks['three_day_rk45']['maximum_position_difference_km_by_sv'])>.005 or checks['gravity_gradient']['maximum_vector_difference_km_s2']>1e-13 or checks['state_interpolation']['maximum_midpoint_position_difference_km']>.05:
        raise ValueError('Reference force/integrator/interpolation check failed')
    path=sources.ROOT/report['artifact']
    if hashlib.sha256(path.read_bytes()).hexdigest()!=report['artifact_sha256'] or report['artifact_sha256']!=checks['baseline_artifact_sha256']:
        raise ValueError('Orbit artifact differs from its numerical checks')
    return report,checks,np.load(path)


def write_spk(path: Path,cache,sv_index: int,lander_position: np.ndarray):
    epochs=cache['epoch_et']+cache['tdb_elapsed_s'];states=cache['states_icrf_km_kms'][:,sv_index,:]
    handle=sp.spkopn(str(path),'LASTLIGHT NONOPERATIONAL REFERENCE',0)
    try:
        sp.spkw13(handle,SV,301,'J2000',float(epochs[0]),float(epochs[-1]),'LCRNS REFERENCE NOT PROVIDER',3,len(epochs),np.ascontiguousarray(states),epochs)
        fixed=np.tile(np.r_[lander_position,[0.,0.,0.]],(2,1))
        sp.spkw08(handle,LANDER,301,ME_FRAME,float(epochs[0]),float(epochs[-1]),'LASTLIGHT TERRAIN OBSERVER',1,2,fixed,float(epochs[0]),float(epochs[-1]-epochs[0]))
    finally:sp.spkcls(handle)


def build(site_id='c1',sv_index=0,days=7,cadence=30,access_kbps=512,backhaul_kbps=2048,limb_step_m=25):
    report,checks,cache=verified_trajectory()
    if not 0<=sv_index<5 or not 1<=days<report['days'] or not 5<=cadence<=300 or 3600%cadence:
        raise ValueError('Choose SV 1..5, fewer days than trajectory coverage, and an hourly-dividing 5..300 s cadence')
    dem,dem_source=lunar_limb.LimbDEM.load()
    dynamics=ReferenceDynamics();provenance=dynamics.provenance;extra={}
    for group in ['shared_kernels']:
        if {k:v['sha256'] for k,v in provenance[group].items()}!={k:v['sha256'] for k,v in report['provenance'][group].items()}:
            raise ValueError('Propagation and geometry use different shared source kernels')
    if {k:v['sha256'] for k,v in provenance['relay_sources']['sources'].items()}!={k:v['sha256'] for k,v in report['provenance']['relay_sources']['sources'].items()}:
        raise ValueError('Propagation source manifest changed before geometry derivation')
    # Converged reception corrections can query just before the first nominal epoch.
    # Integrate a genuine 600 s prefix; never pad with copied or extrapolated states.
    tolerance=np.tile([1e-11]*3+[1e-14]*3,5)
    prefix=solve_ivp(dynamics,(0.,-600.),INITIAL_STATES.ravel(),method='DOP853',rtol=3e-14,atol=tolerance,max_step=60,t_eval=[-300.,-600.])
    if not prefix.success:raise ValueError('Pre-epoch light-time halo integration failed')
    rollback=solve_ivp(dynamics,(-600.,0.),prefix.y[:,-1],method='RK45',rtol=1e-12,atol=tolerance,max_step=30,t_eval=[0.])
    rollback_error=float(np.max(np.linalg.norm((rollback.y[:,-1]-INITIAL_STATES.ravel()).reshape(5,6)[:,:3],axis=1)))
    if not rollback.success or rollback_error>1e-6:raise ValueError('Pre-epoch integration round-trip check failed')
    spk_cache={'epoch_et':cache['epoch_et'],'tdb_elapsed_s':np.r_[[-600.,-300.],cache['tdb_elapsed_s']],
        'states_icrf_km_kms':np.r_[prefix.y.T[::-1].reshape(2,5,6),cache['states_icrf_km_kms']]}
    for name in ['moon_pa_de440_200625.bpc','moon_de440_250416.tf']+stations.EXTRA_KERNELS:
        metadata=json.loads(kernels.MANIFEST.read_text(encoding='utf-8'))['kernels'][name]
        if kernels.digest(kernels.KDIR/name)!=metadata['sha256']:raise ValueError(f'Geometry kernel changed: {name}')
        sp.furnsh(str(kernels.KDIR/name));extra[name]=metadata
    site_path=sources.ROOT/'app/public/data/sites.json';catalogue=json.loads(site_path.read_text(encoding='utf-8'))
    site=next((s for s in catalogue['sites'] if s['id']==site_id),None)
    if not site or '2' not in site['horizons']:raise ValueError('Choose a curated point with a 2 m horizon')
    ground=site.get('ground_m',site.get('elevation_m'))
    if ground is None or not np.isfinite(ground):raise ValueError('Missing site ground elevation')
    _,_,up=local_frame(site['lat'],site['lon']);position=(1737.4+(ground+2)/1000)*up
    start=datetime.fromisoformat(report['epoch_utc']).replace(tzinfo=timezone.utc).timestamp()
    unix=start+np.arange(0,days*86400+cadence,cadence)
    ets=np.array(sp.str2et([datetime.fromtimestamp(u,timezone.utc).isoformat().replace('+00:00','Z') for u in unix]))
    with tempfile.TemporaryDirectory() as tmp:
        spk=Path(tmp)/'reference.bsp';write_spk(spk,spk_cache,sv_index,position);sp.furnsh(str(spk))
        try:
            # Type-13 degree 3 is the same piecewise cubic Hermite state product whose
            # withheld midpoint error was checked against fine integration.
            base=cache['tdb_elapsed_s'];mid=(base[:-1]+base[1:])*.5
            reference=CubicHermiteSpline(base,cache['states_icrf_km_kms'][:,sv_index,:3],cache['states_icrf_km_kms'][:,sv_index,3:],axis=0)(mid)
            actual=sp.spkpos(str(SV),cache['epoch_et']+mid,'J2000','NONE','MOON')[0]
            spk_error=float(np.max(np.linalg.norm(actual-reference,axis=1)))
            if spk_error>1e-8:raise ValueError('SPICE state product disagrees with its checked Hermite interpolation')
            aim,_=sp.spkpos(str(SV),ets,ME_FRAME,'XCN+S',str(LANDER))
            access_range=np.linalg.norm(aim,axis=1)
            access_clear=terrain_clearance(np.asarray(aim),site['lat'],site['lon'],np.array(site['horizons']['2']))
            east,north,up=local_frame(site['lat'],site['lon'])
            access_checks=[{'azDeg':float(np.rad2deg(np.arctan2(aim[j]@east,aim[j]@north))%360),
                'elDeg':float(np.rad2deg(np.arctan2(aim[j]@up,np.hypot(aim[j]@east,aim[j]@north)))),
                'clearanceDeg':float(access_clear[j])} for j in np.linspace(0,len(ets)-1,12,dtype=int)]
            receiver=np.empty((len(ets),3));limb=np.empty_like(receiver);backhaul_range=np.empty_like(receiver);masks=np.zeros(len(ets),dtype=np.uint8)
            terrain_limb=np.empty_like(receiver);terrain_pass=np.empty(receiver.shape,dtype=bool)
            limb_stats={'sampled_rays':0,'inner_bound_rays':0,'outer_bound_rays':0,'terrain_points':0,'maximum_moving_frame_check_error_m':0.,'sphere_guard_pass_terrain_fail_samples':0}
            limb_examples=[]
            moon,_=sp.spkpos('MOON',ets,'J2000','XCN',str(SV));moon=np.array(moon)
            moon_distance=np.linalg.norm(moon,axis=1);moon_angle=np.arcsin(max(sp.bodvrd('MOON','RADII',3)[1])/moon_distance)
            occultation_checks=[]
            for k,(body,complex_name,antenna) in enumerate(stations.STATIONS):
                target,lt=sp.spkpos(body,ets,'J2000','XCN',str(SV));target=np.array(target)
                backhaul_range[:,k]=np.linalg.norm(target,axis=1)
                angle=np.arctan2(np.linalg.norm(np.cross(target,moon),axis=1),np.sum(target*moon,axis=1))
                limb[:,k]=np.rad2deg(angle-moon_angle)
                receive=ets+lt
                incoming=np.asarray(sp.spkpos(str(SV),receive,'ITRF93','CN+S',body)[0])
                station=np.asarray(sp.spkpos(body,receive,'ITRF93','NONE','EARTH')[0])
                zenith=[]
                for v in station:
                    lon,lat,_=sp.recgeo(v,6378.137,1/298.257223563)
                    zenith.append([np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)])
                receiver[:,k]=np.rad2deg(np.arcsin(np.clip(np.sum(incoming*np.array(zenith),axis=1)/np.linalg.norm(incoming,axis=1),-1,1)))
                for j,et in enumerate(ets):
                    ray=lunar_limb.photon_ray(float(et),str(SV),target[j],dem,step_m=limb_step_m)
                    terrain_limb[j,k]=ray['clearance_m'];terrain_pass[j,k]=ray['pass']
                    limb_stats[ray['kind']+'_rays']+=1;limb_stats['terrain_points']+=ray['samples']
                    limb_stats['maximum_moving_frame_check_error_m']=max(limb_stats['maximum_moving_frame_check_error_m'],ray['linearization_max_error_m'])
                    if ray['kind']=='sampled':limb_examples.append({'sample':j,'antenna':antenna,'sphere_clearance_deg':float(limb[j,k]),**ray})
                sphere_good=(receiver[:,k]>=10.35)&(limb[:,k]>=.1)
                limb_stats['sphere_guard_pass_terrain_fail_samples']+=int(np.sum(sphere_good&~terrain_pass[:,k]))
                masks|=(sphere_good&terrain_pass[:,k]).astype(np.uint8)*(1<<k)
                # Cross-check analytic spherical clearance against SPICE occultation,
                # including nearest-limb samples on each side and evenly spaced epochs.
                selected=np.unique(np.r_[np.argsort(abs(limb[:,k]))[:20],np.linspace(0,len(ets)-1,24,dtype=int)])
                for j in selected:
                    code=int(sp.occult('MOON','ELLIPSOID',ME_FRAME,body,'POINT',' ','XCN',str(SV),float(ets[j])))
                    if (code>0)!=(limb[j,k]<0):raise ValueError('Lunar occultation cross-check failed')
                    occultation_checks.append({'sample':int(j),'antenna':antenna,'clearance_deg':float(limb[j,k]),'spice_code':code})
                print(f'Geometry {site_id} SV-{sv_index+1}: {antenna} complete',flush=True)
        finally:sp.unload(str(spk))
    access_hours=full_hours(access_clear>=.1,3600//cadence);backhaul_hours=full_hours(masks!=0,3600//cadence)
    passes=contact_runs(access_hours,start,'access',access_kbps)+contact_runs(backhaul_hours,start,'backhaul',backhaul_kbps)
    passes.sort(key=lambda p:(p['startUnix'],p['leg']))
    if len(passes)>64:raise ValueError('More than 64 contacts; shorten the requested interval for the current app importer')
    name=f'relay-geometry-{site_id}-sv{sv_index+1}'
    csv_path=sources.ROOT/'data/validation'/(name+'.csv');sample_path=sources.CACHE/(name+'.npz')
    fmt=lambda u:datetime.fromtimestamp(u,timezone.utc).isoformat().replace('+00:00','Z')
    csv_path.write_text('# LASTLIGHT reference geometry; assumed rates; no RF/booking/provider validation\nstart_utc,end_utc,leg,rate_kbps\n'+''.join(f'{fmt(p["startUnix"])},{fmt(p["endUnix"])},{p["leg"]},{p["kbps"]}\n' for p in passes),encoding='utf-8',newline='\n')
    np.savez_compressed(sample_path,utc_unix=unix,access_clearance_deg=access_clear,access_range_km=access_range,receiver_elevation_deg=receiver,lunar_limb_clearance_deg=limb,terrain_limb_clearance_m=terrain_limb,terrain_limb_pass=terrain_pass,backhaul_range_km=backhaul_range,eligible_station_mask=masks)
    bins=[slice(a,a+3600//cadence+1) for a in range(0,len(unix)-1,3600//cadence)]
    best_range=np.min(np.where((masks[:,None]&(1<<np.arange(3)))!=0,backhaul_range,np.inf),axis=1)
    hourly=[{'access_clearance_min_deg':float(np.min(access_clear[b])), 'access_range_max_km':float(np.max(access_range[b])),
        'backhaul_range_max_km':float(np.max(best_range[b])) if np.isfinite(best_range[b]).all() else None,
        'access':bool(access_hours[j]),'backhaul':bool(backhaul_hours[j])} for j,b in enumerate(bins)]
    result={'schema':1,'created_utc':datetime.now(timezone.utc).isoformat(),'site':{'id':site_id,'lat':site['lat'],'lon':site['lon'],'ground_m':ground,'observer_m':2},
        'spacecraft':f'SV-{sv_index+1}','start_utc':fmt(start),'days':days,'cadence_utc_s':cadence,
        'access_rule':'XCN+S from fixed terrain observer; clearance >=0.1 deg above interpolated 2 m curated horizon',
        'backhaul_rule':'Moving-Moon photon path >=100 m above sampled LDEM_64 terrain AND XCN spherical-limb clearance >=0.1 deg; CN+S station reception >=10.35 deg at arrival; any one named reference antenna',
        'hour_rule':'Every sample including both endpoints must pass; this is sampled visibility, not continuous-time certification',
        'access_kbps_assumed':access_kbps,'backhaul_kbps_assumed':backhaul_kbps,'passes':passes,
        'access_hours':int(access_hours.sum()),'backhaul_hours':int(backhaul_hours.sum()),
        'terrain_frame':ME_FRAME,'force_frame':'MOON_PA_DE421; explicit ICRF transform, DE421 planetary translation retained',
        'catalogue_sha256':hashlib.sha256(site_path.read_bytes()).hexdigest(),'orbit_checks_sha256':hashlib.sha256((sources.ROOT/'data/validation/relay-orbit-checks.json').read_bytes()).hexdigest(),
        'horizon_centideg':site['horizons']['2'],'horizon_convention':'samples at (index+0.5)*360/720 degrees; cyclic linear interpolation','hourly':hourly,
        'access_check_samples':access_checks,
        'builder_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'limb_terrain':{'source':dem_source,'frame':lunar_limb.FRAME,'step_m':limb_step_m,'radial_guard_m':100.,
            'method':'Finite straight inertial photon segment; Moon translation and ME421 rotation linearized at closest photon approach; exact SPICE shell-end/minimum checks <=1 m',
            'bounds':'Actual DEM minimum/maximum spheres only accelerate definite interior/exterior rays; sampled radial clearance near limb',
            'statistics':limb_stats,'near_limb_examples':sorted(limb_examples,key=lambda r:abs(r['clearance_m']))[:24],
            'code_sha256':{n:hashlib.sha256((Path(__file__).parent/n).read_bytes()).hexdigest() for n in ['lunar_limb.py','fetch_limb_dem.py']}},
        'spk_vs_cubic_hermite_max_difference_km':spk_error,'orbit_interpolation_check':checks['state_interpolation'],
        'pre_epoch_light_time_halo':{'seconds':600,'method':'backward DOP853, same forces; forward RK45 round trip','maximum_position_round_trip_difference_km':rollback_error},
        'provenance':provenance,'extra_kernels':extra,'occultation_cross_checks':occultation_checks,
        'csv':{'path':str(csv_path.relative_to(sources.ROOT)),'sha256':hashlib.sha256(csv_path.read_bytes()).hexdigest()},
        'samples':{'path':str(sample_path.relative_to(sources.ROOT)),'sha256':hashlib.sha256(sample_path.read_bytes()).hexdigest()},
        'limitations':['Reference design, rounded states and unresolved element-table residuals; not operational trajectories',
            'Sampled horizon/occultation with explicit sensitivity margins, not uncertainty bounds',
            'Backhaul terrain uses 474 m LDEM_64 grid with sampled rays and 100 m engineering guard; sub-grid peaks, DEM errors, diffraction/Fresnel zones are not resolved',
            'Existing 0.1-degree spherical-limb guard is retained, so topographic valleys never add contacts',
            'Generic 10-degree receiver mask plus 0.35-degree Earth-orientation stress; no local station masks',
            'Rates, RF closure, pointing, relay power, allocation, antenna switching and service availability remain assumptions',
            'Single spacecraft only; no data teleportation or pooled buffer across satellites','No extrapolation outside the generated plan']}
    out=sources.ROOT/'data/validation'/f'{name}.json';out.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Wrote {name}: {len(passes)} contacts, access {access_hours.sum()} h, backhaul {backhaul_hours.sum()} h',flush=True)
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--site',default='c1');p.add_argument('--sv',type=int,default=1)
    p.add_argument('--days',type=int,default=7);p.add_argument('--cadence',type=int,default=30)
    p.add_argument('--access-kbps',type=float,default=512);p.add_argument('--backhaul-kbps',type=float,default=2048)
    p.add_argument('--limb-step-m',type=float,default=25)
    a=p.parse_args();build(a.site,a.sv-1,a.days,a.cadence,a.access_kbps,a.backhaul_kbps,a.limb_step_m)
