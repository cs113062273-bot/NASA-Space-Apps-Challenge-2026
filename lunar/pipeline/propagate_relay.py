"""Propagate the published five-spacecraft LCRNS 3.1 reference design.

No provider booking, RF service or real spacecraft prediction is established. DE421,
GRGM900C 25x25, six differential point masses and spherical SRP follow Table 3.
Finite uniform-Sun disk occultation by spherical Moon/Earth is our explicit shadow choice:
the white paper does not prescribe the shadow algorithm or occultor radii.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import time

import numpy as np
from scipy.integrate import quad, solve_ivp
import scipy
import spiceypy as sp

import fetch_kernels as kernels
import fetch_relay_sources as sources
from relay_orbits import EPOCH_UTC, INITIAL_STATES, PUBLISHED_ELEMENTS, de421_constants, load_gravity, third_body_acceleration

BODY_IDS = ['10','2','399','4','5','6']


def overlap_fraction(radius: float, other_radius: float, separation: float) -> float:
    """Area of overlap / area of first circle, including total and annular occultation."""
    r,b,d=radius,other_radius,separation
    if d>=r+b:return 0.
    if d<=abs(r-b):return min(r,b)**2/r**2
    a=np.arccos(np.clip((d*d+r*r-b*b)/(2*d*r),-1,1))
    beta=np.arccos(np.clip((d*d+b*b-r*r)/(2*d*b),-1,1))
    area=r*r*a+b*b*beta-.5*np.sqrt(max(0,(-d+r+b)*(d+r-b)*(d-r+b)*(d+r+b)))
    return float(np.clip(area/(np.pi*r*r),0,1))


def visible_sun_fraction(to_sun: np.ndarray, occultors: list[tuple[np.ndarray,float]], sun_radius: float) -> float:
    """Uniform apparent disks in a local angular plane. Not solar limb-darkening physics.

    Single-disk overlap is analytic; two partial disks use a union of clipped intervals,
    not multiplied remaining fractions. Adaptive quadrature is used only in that case.
    """
    distance=np.linalg.norm(to_sun);u=to_sun/distance;sun_angle=float(np.arcsin(sun_radius/distance))
    seed=np.array([0.,0.,1.]) if abs(u[2])<.9 else np.array([1.,0.,0.])
    east=np.cross(seed,u);east/=np.linalg.norm(east);north=np.cross(u,east)
    disks=[]
    for vector,radius in occultors:
        d=np.linalg.norm(vector)
        if d<=radius:raise ValueError('Reference orbit enters an occulting body')
        v=vector/d;projection=float(v@u)
        if projection<=0 or d>=distance:continue
        angle=float(np.arctan2(np.linalg.norm(np.cross(v,u)),projection));b=float(np.arcsin(radius/d))
        if angle>=sun_angle+b:continue
        if b>=angle+sun_angle:return 0.
        transverse=np.hypot(v@east,v@north)
        x=angle*(v@east)/transverse if transverse else 0.
        y=angle*(v@north)/transverse if transverse else 0.
        disks.append((x,y,b,angle))
    if not disks:return 1.
    if len(disks)==1:return 1-overlap_fraction(sun_angle,disks[0][2],disks[0][3])
    # Earth and Moon are the only supported occultors; union, including mutual overlap.
    if len(disks)!=2:raise ValueError('Shadow model supports only Moon and Earth')
    def union_length(x):
        half=np.sqrt(max(0,sun_angle**2-x*x));intervals=[]
        for a,b,r,_ in disks:
            h=np.sqrt(max(0,r*r-(x-a)**2));lo,hi=max(-half,b-h),min(half,b+h)
            intervals.append((lo,hi) if abs(x-a)<r and hi>lo else (0.,0.))
        (a,b),(c,d)=intervals
        return (b-a)+(d-c)-max(0,min(b,d)-max(a,c))
    points=sorted(set(p for a,_,r,_ in disks for p in [a-r,a,a+r] if -sun_angle<p<sun_angle))
    area,error=quad(union_length,-sun_angle,sun_angle,points=points,epsabs=1e-10*sun_angle**2,epsrel=1e-9,limit=200)
    if error>1e-7*np.pi*sun_angle**2:raise ValueError('Joint shadow integration did not converge')
    return float(np.clip(1-area/(np.pi*sun_angle**2),0,1))


def furnish() -> dict:
    manifest=sources.verify_sources()
    base=json.loads(kernels.MANIFEST.read_text(encoding='utf-8'))
    sp.kclear()
    for name in ['naif0012.tls','pck00011.tpc']:
        path=kernels.KDIR/name
        if kernels.digest(path)!=base['kernels'][name]['sha256']:raise ValueError(f'Base kernel changed: {name}')
        sp.furnsh(str(path))
    for name in ['de421.bsp','moon_pa_de421_1900-2050.bpc','moon_080317.tf']:
        sp.furnsh(str(sources.CACHE/name))
    return {'relay_sources':manifest,'shared_kernels':{name:base['kernels'][name] for name in ['naif0012.tls','pck00011.tpc']}}


def radiation_acceleration(sun_to_spacecraft: np.ndarray, au_km: float, c_km_s: float, visible: np.ndarray) -> np.ndarray:
    q=np.atleast_2d(sun_to_spacecraft);distance=np.linalg.norm(q,axis=1)
    # flux/c is N/m²; area=1 m², Cr=1.8, mass=850 kg. Convert m/s² to km/s².
    magnitude=1367/(c_km_s*1000)*1.8/850/1000*(au_km/distance)**2*np.asarray(visible)
    return magnitude[:,None]*q/distance[:,None]


def element_audit(gm: float) -> list[dict]:
    """Resolve dimensional/frame interpretation; do not infer precision from rounded tables."""
    rotation=sp.pxform('J2000','MOON_PA_DE421',0.)
    rows=[]
    for k,y in enumerate(INITIAL_STATES):
        def elements(state):
            el=sp.oscltx(np.r_[rotation@state[:3],rotation@state[3:]],0.,gm)
            return np.r_[el[9],el[1],np.rad2deg(el[2:5]),np.rad2deg(el[8])]
        actual=elements(y)
        delta=actual-PUBLISHED_ELEMENTS[k];delta[2:]=(delta[2:]+180)%360-180
        # All 64 corners of the printed six-decimal Cartesian quantization cell.
        # Extremal element samples are sensitivity, not rigorous nonlinear interval bounds.
        corner=[]
        for signs in itertools.product([-1,1],repeat=6):
            e=elements(y+np.array(signs)*.5e-6)
            d=e-actual;d[2:]=(d[2:]+180)%360-180;corner.append(d)
        corner=np.array(corner)
        if abs(delta[0])>.1 or abs(delta[1])>3e-6 or np.max(abs(delta[2:]))>.001:
            raise ValueError('Published tables do not support the assumed km, km/s and J2000-frozen PA interpretation')
        rows.append({'spacecraft':f'SV-{k+1}','reconstructed_elements':actual.tolist(),
            'minus_table1':[float(v) for v in delta], 'printed_state_corner_sensitivity_min':corner.min(axis=0).tolist(),
            'printed_state_corner_sensitivity_max':corner.max(axis=0).tolist()})
    return rows


class ReferenceDynamics:
    """Dedicated SPICE process: do not furnish other planetary ephemerides while integrating."""
    def __init__(self, degree=25, srp=True, shadow=True, third_bodies=True):
        self.provenance=furnish()
        self.gravity=load_gravity(degree)
        self.constants=de421_constants((sources.CACHE/'header.421').read_text())
        self.gm=np.array([self.constants[body] for body in BODY_IDS])
        self.et0=float(sp.str2et(EPOCH_UTC))
        self.sun_radius=float(sp.bodvrd('SUN','RADII',3)[1][0])
        self.earth_radius=float(sp.bodvrd('EARTH','RADII',3)[1][0])
        self.moon_radius=1737.4
        self.srp,self.shadow,self.third_bodies=srp,shadow,third_bodies
        self.calls=0

    def __call__(self, elapsed: float, state: np.ndarray):
        self.calls+=1
        y=np.asarray(state).reshape(-1,6);q=y[:,:3]
        et=self.et0+elapsed
        rotation=sp.pxform('J2000','MOON_PA_DE421',et)
        acceleration=self.gravity.acceleration(q@rotation.T)@rotation
        bodies=np.array([sp.spkpos(body,et,'J2000','NONE','MOON')[0] for body in BODY_IDS])
        if self.third_bodies:acceleration+=third_body_acceleration(q,bodies,self.gm)
        if self.srp:
            sun_to_spacecraft=q-bodies[0];distance=np.linalg.norm(sun_to_spacecraft,axis=1)
            visibility=np.array([visible_sun_fraction(-sun_to_spacecraft[i],[(-q[i],self.moon_radius),(bodies[2]-q[i],self.earth_radius)],self.sun_radius) for i in range(len(q))]) if self.shadow else np.ones(len(q))
            acceleration+=radiation_acceleration(sun_to_spacecraft,self.constants['AU'],self.constants['c_km_s'],visibility)
        return np.c_[y[:,3:],acceleration].ravel()


def integrate(model: ReferenceDynamics, days: float, step_s=300., method='DOP853', rtol=1e-12, max_step=300., state=None,
    position_atol=1e-9, velocity_atol=1e-12):
    if not 0<days<=90 or not np.isfinite(step_s) or step_s<=0:raise ValueError('Use a positive interval of at most 90 days')
    initial=INITIAL_STATES if state is None else np.asarray(state)
    end=days*86400
    times=np.r_[np.arange(0,end,step_s),end]
    solution=solve_ivp(model,(0,end),initial.ravel(),method=method,rtol=rtol,
        atol=np.tile([position_atol]*3+[velocity_atol]*3,len(initial)),max_step=max_step,t_eval=times,dense_output=True)
    if not solution.success or not np.isfinite(solution.y).all():raise ValueError(f'Orbit integration failed: {solution.message}')
    return times,solution


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--days',type=float,default=30)
    parser.add_argument('--step',type=float,default=300)
    args=parser.parse_args()
    model=ReferenceDynamics();audit=element_audit(model.gravity.gm)
    started=time.perf_counter();times,sol=integrate(model,args.days,args.step)
    states=sol.y.T.reshape(len(times),5,6)
    target=sources.CACHE/'lcrns-propagated.npz'
    np.savez_compressed(target,tdb_elapsed_s=times,states_icrf_km_kms=states,epoch_et=model.et0)
    report={'schema':1,'created_utc':datetime.now(timezone.utc).isoformat(),'epoch_utc':EPOCH_UTC,
        'epoch_et_tdb_s':model.et0,'days':args.days,'output_step_tdb_s':args.step,'count':len(times),
        'artifact':str(target.relative_to(sources.ROOT)),'artifact_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
        'frame':'Moon-centred ICRF/J2000; force rotates through MOON_PA_DE421, not epoch-frozen PA',
        'method':'SciPy DOP853','rtol':1e-12,'position_atol_km':1e-9,'velocity_atol_km_s':1e-12,'max_step_s':300,
        'force_calls':model.calls,'elapsed_s':time.perf_counter()-started,
        'gravity':{'name':'GRGM900C','degree':25,'order':25,'gm_km3_s2':model.gravity.gm,'reference_radius_km':model.gravity.radius,'normalization':'fully normalized geodesy; no Condon–Shortley phase'},
        'point_masses':{'ids':BODY_IDS,'gm_km3_s2':model.gm.tolist(),'note':'Venus and outer planetary system barycentres from DE421; Earth centre, not EMB'},
        'srp':{'flux_w_m2_at_au':1367,'cr':1.8,'area_m2':1,'mass_kg':850,'shadow':'uniform apparent angular disks; Moon/Earth union; analytic one disk, adaptive quadrature for two partial disks','sun_radius_km':model.sun_radius,'earth_radius_km':model.earth_radius,'moon_radius_km':model.moon_radius},
        'minimum_sampled_radius_km':np.linalg.norm(states[:,:,:3],axis=2).min(axis=0).tolist(),
        'maximum_sampled_radius_km':np.linalg.norm(states[:,:,:3],axis=2).max(axis=0).tolist(),
        'initial_states_icrf_km_kms':INITIAL_STATES.tolist(),'table_cross_check':audit,'de421_constants':model.constants,
        'provenance':model.provenance,'software':{'numpy':np.__version__,'scipy':scipy.__version__,'spiceypy':sp.__version__},
        'code_sha256':{name:hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest() for name in ['relay_orbits.py','propagate_relay.py']},
        'limitations':['Rounded initial reference states, not final provider or measured trajectories','No station keeping, actual area/attitude, unmodeled forces or covariance','Shadow algorithm/radii are explicit modeling choices beyond the white paper','No terrain/contact/RF/service coverage is inferred from propagation alone','Numerical convergence and independent integrator checks are recorded separately']}
    path=sources.ROOT/'data/validation/relay-propagation.json'
    path.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Propagated {args.days:g} days, {len(times)} samples, {model.calls} force calls, {report["elapsed_s"]:.1f}s',flush=True)
    print(f'Wrote {path.relative_to(sources.ROOT)}',flush=True)


if __name__=='__main__':main()
