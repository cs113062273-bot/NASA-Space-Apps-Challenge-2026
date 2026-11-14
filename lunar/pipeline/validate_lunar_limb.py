"""Real-DEM and moving-Moon limb stress cases, explicitly not station contacts.

The selected real reference SV has no near-terrain DSN rays during the retained
week. These deliberately aimed rays exercise that unvisited model branch.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
import spiceypy as sp

from build_relay_geometry import SV, verified_trajectory
import fetch_limb_dem as source
from global_dem import CylDEM
from lunar_limb import FRAME, LimbDEM, photon_ray, ray_clearance, C_KM_S
from propagate_relay import ReferenceDynamics


def main():
    dem,manifest=LimbDEM.load()
    independent=CylDEM.load_global('ldem_64',64)
    # Actual highest raster pixel. A tangent at +5 km clears the mean-radius
    # sphere but intersects this observed +10.757 km topography.
    row,col=np.unravel_index(np.argmax(dem.heights_dn),dem.heights_dn.shape)
    lat,lon=90-(row+.5)/64,(col+.5)/64
    la,lo=np.deg2rad([lat,lon]); up=np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
    east=np.array([-np.sin(lo),np.cos(lo),0.])
    origin=up*(1737.4+5)-300*east
    coarse=ray_clearance(origin,east,600,dem,25)
    fine=ray_clearance(origin,east,600,dem,12.5)
    qs=np.linspace(0,600,600001) # full finite segment, 1 m grid
    p=origin+qs[:,None]*east
    norms=np.linalg.norm(p,axis=1)
    latitudes=np.rad2deg(np.arctan2(p[:,2],np.hypot(p[:,0],p[:,1])))
    longitudes=np.rad2deg(np.arctan2(p[:,1],p[:,0]))%360
    independent_clear=(norms-1737.4)*1000-independent.sample_ll(latitudes,longitudes)
    dense_minimum=float(np.min(independent_clear))
    if fine['pass'] or fine['clearance_m']> -5000 or abs(fine['clearance_m']-dense_minimum)>10:
        raise ValueError('Real mountain or independent full-path dense-sampling check failed')
    mountain={'lat':float(lat),'lon':float(lon),'terrain_height_m':float(dem.heights_dn[row,col])*.5,
        'mean_sphere_clearance_m':5000.,'maximum_step_25_m':coarse,'maximum_step_12_5_m':fine,
        'independent_1_m_full_segment_minimum_m':dense_minimum,
        'absolute_12_5_m_vs_1_m_difference_m':abs(fine['clearance_m']-dense_minimum)}
    orbit,_,cache=verified_trajectory()
    ReferenceDynamics() # verified DE421 translation, PCK and explicit ME421 frame
    epochs=cache['epoch_et']+cache['tdb_elapsed_s']; states=cache['states_icrf_km_kms'][:,0,:]
    cases=[]; exact_checks=[]; sphere_checks=[]
    sphere=LimbDEM(np.zeros((180,360),dtype=np.int16),1)
    with tempfile.TemporaryDirectory() as temporary:
        path=Path(temporary)/'limb-stress.bsp';handle=sp.spkopn(str(path),'NONOPERATIONAL LIMB STRESS',0)
        try:
            sp.spkw13(handle,SV,301,'J2000',float(epochs[0]),float(epochs[-1]),'PUBLISHED SV1 STRESS OBSERVER',3,len(epochs),np.ascontiguousarray(states),epochs)
        finally:sp.spkcls(handle)
        sp.furnsh(str(path))
        try:
            for et in cache['epoch_et']+np.linspace(86400,6*86400,8):
                moon=np.asarray(sp.spkpos('MOON',et,'J2000','NONE',str(SV))[0]); distance=np.linalg.norm(moon); toward=moon/distance
                seed=np.array([0.,0.,1.]) if abs(toward[2])<.9 else np.array([1.,0.,0.])
                a=np.cross(toward,seed);a/=np.linalg.norm(a);b=np.cross(toward,a)
                for az in np.arange(4)*np.pi/2:
                    transverse=np.cos(az)*a+np.sin(az)*b
                    for height in [-12000.,-8000.,0.,5000.,12000.]:
                        angle=np.arcsin((1737.4+height/1000)/distance)
                        direction=np.cos(angle)*toward+np.sin(angle)*transverse
                        vector=direction*400000.
                        # A separate NAIF surface-intercept solver checks the
                        # moving photon geometry on an exactly spherical Moon.
                        spherical=photon_ray(float(et),str(SV),vector,sphere,guard_m=0)
                        with sp.no_found_check():
                            _,_,_,hit=sp.sincpt('ELLIPSOID','MOON',float(et),FRAME,'XCN',str(SV),'J2000',direction)
                        if spherical['pass']==bool(hit):raise ValueError('Moving spherical photon ray disagrees with SPICE sincpt XCN')
                        sphere_checks.append({'et':float(et),'limb_az_deg':float(np.rad2deg(az)),'aim_height_m':height,'spice_hit':bool(hit),'ray_clear':spherical['pass']})
                        c=photon_ray(float(et),str(SV),vector,dem,25)
                        f=photon_ray(float(et),str(SV),vector,dem,12.5)
                        if f['clearance_m']>c['clearance_m']+1e-6 or f['pass'] and not c['pass']:
                            raise ValueError('Nested stress-ray refinement added a failing grant')
                        cases.append({'et':float(et),'limb_az_deg':float(np.rad2deg(az)),'aim_height_m':height,
                            'coarse_clearance_m':c['clearance_m'],'fine':f})
                        if f['kind']=='sampled' and len(exact_checks)<12:
                            # Independent exact SPICE transformation at 1 m spacing
                            # around the minimum, using the older CylDEM sampler.
                            # The DEM branch samples only the outer bounding
                            # shell. Outside it, the *bound* already exceeds the
                            # radial guard; it is not a reported terrain minimum.
                            lo,hi=f['shell_q_km']
                            q=np.linspace(max(lo,f['q_km']-.25),min(hi,f['q_km']+.25),501)
                            transmitter=np.asarray(sp.spkssb(SV,float(et),'J2000'))[:3]
                            fixed=[]
                            for distance_along in q:
                                t=float(et+distance_along/C_KM_S)
                                centre=np.asarray(sp.spkssb(301,t,'J2000'))[:3]
                                fixed.append(np.asarray(sp.pxform('J2000',FRAME,t))@(transmitter+distance_along*direction-centre))
                            p=np.array(fixed);r=np.linalg.norm(p,axis=1)
                            lat=np.rad2deg(np.arctan2(p[:,2],np.hypot(p[:,0],p[:,1])))
                            lon=np.rad2deg(np.arctan2(p[:,1],p[:,0]))%360
                            exact_min=float(np.min((r-1737.4)*1000-independent.sample_ll(lat,lon)))
                            difference=abs(exact_min-f['clearance_m'])
                            if difference>10:raise ValueError(f'Exact moving-frame/local dense DEM cross-check exceeds 10 m: {difference:.6f} m; et={et}, az={az}, height={height}, sampled={f["clearance_m"]}, exact={exact_min}')
                            exact_checks.append({'case':len(cases)-1,'exact_local_1_m_minimum_m':exact_min,'difference_m':difference})
        finally:sp.unload(str(path));sp.kclear()
    sampled=[r for r in cases if r['fine']['kind']=='sampled']
    if len(sampled)<20 or len(exact_checks)!=12:raise ValueError('Insufficient near-limb stress cases')
    report={'schema':1,'checked_utc':datetime.now(timezone.utc).isoformat(),'source_files':manifest['files'],
        'orbit_artifact_sha256':orbit['artifact_sha256'],'real_mountain':mountain,
        'stress_rays':len(cases),'near_limb_rays':len(sampled),'exact_local_checks':exact_checks,'spice_spherical_intercept_checks':sphere_checks,
        'maximum_25_to_12_5_m_clearance_reduction_m':max(r['coarse_clearance_m']-r['fine']['clearance_m'] for r in cases),
        'maximum_moving_frame_error_m':max(r['fine']['linearization_max_error_m'] for r in sampled),
        'code_sha256':{n:source.digest(Path(__file__).parent/n) for n in ['lunar_limb.py','fetch_limb_dem.py','validate_lunar_limb.py','global_dem.py']},
        'cases':cases,'limitations':['Deliberately synthetic transmission directions, not Earth/station contacts or provider coverage',
            'Mountain check compares the full finite segment at 1 m, with an independent existing cylindrical sampler; same DEM, not independent surface truth',
            'Moving-frame exact checks cover only 12 local +/-250 m windows clipped to the bounding shell, at <=1 m spacing; not the entire ray',
            'Sampled numerical checks, no continuous proof or DEM uncertainty bound; sub-grid peaks and diffraction unresolved']}
    out=source.ROOT/'data/validation/lunar-limb-checks.json'
    out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Checked {len(cases)} deliberately aimed rays, {len(sampled)} near limb; moving frame {report["maximum_moving_frame_error_m"]:.6g} m; exact/local dense max {max(r["difference_m"] for r in exact_checks):.6g} m',flush=True)


if __name__=='__main__':main()
