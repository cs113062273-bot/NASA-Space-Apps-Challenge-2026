"""Sample a finite radio photon path against the pixel-registered LOLA radial DEM.

Clearance is radial distance above a bilinearly interpolated grid, not diffraction,
Fresnel clearance, a measurement uncertainty bound, or continuous visibility proof.
Minimum/maximum DEM spheres accelerate definite interior/exterior paths only.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
import spiceypy as sp

import fetch_limb_dem as source

C_KM_S = 299792.458
FRAME = 'MOON_ME_DE421'


@dataclass
class LimbDEM:
    heights_dn: np.ndarray
    res: float
    factor_m: float = .5
    radius_km: float = 1737.4

    def __post_init__(self):
        if self.heights_dn.shape != (round(180*self.res), round(360*self.res)):
            raise ValueError('Global pixel-registered DEM dimensions mismatch')
        # These are actual raster extrema, not arbitrary inflated sphere radii.
        self.minimum_km = self.radius_km + float(np.min(self.heights_dn))*self.factor_m/1000
        self.maximum_km = self.radius_km + float(np.max(self.heights_dn))*self.factor_m/1000

    @classmethod
    def load(cls):
        manifest = source.verify()
        return cls(np.memmap(source.CACHE/'ldem_64.img', dtype='<i2', mode='r', shape=(11520,23040)),64), manifest

    def radius(self, points: np.ndarray) -> np.ndarray:
        p = np.asarray(points, dtype=float)
        if p.shape[-1] != 3 or not np.isfinite(p).all() or np.any(np.linalg.norm(p,axis=-1)==0):
            raise ValueError('Invalid Cartesian terrain sample')
        lat = np.rad2deg(np.arctan2(p[...,2],np.hypot(p[...,0],p[...,1])))
        lon = np.rad2deg(np.arctan2(p[...,1],p[...,0]))%360
        r = (90-lat)*self.res-.5; c = (lon*self.res-.5)%self.heights_dn.shape[1]
        # Polar half-pixels have no bracketing data: no silent cap extrapolation.
        if np.any(r < -1e-8) or np.any(r > self.heights_dn.shape[0]-1+1e-8):
            raise ValueError('DEM ray enters unsupported polar half-pixel')
        r = np.clip(r,0,self.heights_dn.shape[0]-1)
        r0 = np.minimum(np.floor(r).astype(int),self.heights_dn.shape[0]-2)
        c0 = np.floor(c).astype(int); c1 = (c0+1)%self.heights_dn.shape[1]
        fr = r-r0; fc = c-c0; h = self.heights_dn
        z = ((1-fr)*((1-fc)*h[r0,c0]+fc*h[r0,c1]) + fr*((1-fc)*h[r0+1,c0]+fc*h[r0+1,c1]))
        return self.radius_km+z*self.factor_m/1000


def ray_clearance(origin: np.ndarray, direction: np.ndarray, length_km: float,
                  dem: LimbDEM, step_m=100., guard_m=100.) -> dict:
    """Screen an affine finite segment (km inputs) against the radial guard.

    Exterior/interior shortcuts return rigorous bounds for this interpolated DEM.
    Near-limb paths include both shell endpoints and their closest-radius point.
    A 100 m additional engineering guard is independent of the angular guard.
    For kind=sampled, clearance_m is the minimum of samples *inside the bounding
    shell*, not the entire path's global minimum. Outside that shell the DEM's
    actual maximum-radius bound already exceeds the guard. For the other kinds
    clearance_m is respectively a lower (outer) or upper (inner) bound.
    """
    o=np.asarray(origin,dtype=float); d=np.asarray(direction,dtype=float)
    if o.shape!=(3,) or d.shape!=(3,) or not np.isfinite(np.r_[o,d,length_km,step_m,guard_m]).all() or length_km<=0 or step_m<=0 or guard_m<0 or np.linalg.norm(d)==0:
        raise ValueError('Invalid finite ray or terrain sampling settings')
    a=float(d@d); q=float(np.clip(-(o@d)/a,0,length_km))
    impact=float(np.linalg.norm(o+q*d)); outer=dem.maximum_km+guard_m/1000
    common={'q_km':q,'samples':0,'kind':'outer_bound'}
    if impact>outer:
        return {**common,'clearance_m':(impact-dem.maximum_km)*1000,'pass':True}
    if impact<dem.minimum_km:
        return {**common,'kind':'inner_bound','clearance_m':(impact-dem.minimum_km)*1000,'pass':False}
    # Infinite line's outer-shell roots, clipped to the finite signal path.
    centre=-(o@d)/a; half=math.sqrt(max(0,(outer**2-(o+centre*d)@(o+centre*d))/a))
    lo=max(0.,float(centre-half)); hi=min(length_km,float(centre+half))
    if hi<lo:raise ValueError('Inconsistent finite-ray shell intersection')
    # Dyadic shell grid: halving the requested step retains every old sample.
    required=max(1.,(hi-lo)*math.sqrt(a)*1000/step_m)
    n=2**max(0,int(math.ceil(math.log2(required))))
    qs=np.unique(np.r_[np.linspace(lo,hi,n+1),q])
    p=o+qs[:,None]*d
    clear=(np.linalg.norm(p,axis=1)-dem.radius(p))*1000
    i=int(np.argmin(clear)); minimum=float(clear[i])
    return {'clearance_m':minimum,'q_km':float(qs[i]),'samples':len(qs),'kind':'sampled','pass':minimum>=guard_m,
        'shell_q_km':[lo,hi]}


def photon_ray(et: float, sv: str, target_vector: np.ndarray, dem: LimbDEM,
               step_m=100., guard_m=100., check_exact=True) -> dict:
    """Inertial straight radio ray to an XCN station target at its arrival epoch.

    Moon translation and ME421 rotation are linearized at closest photon approach,
    using SPICE velocities and sxform. Exact moving-frame positions at shell ends
    and the sampled minimum are checked; >1 m linearization error rejects the ray.
    This is geometric propagation (no stellar aberration applied to the photon).
    """
    vector=np.asarray(target_vector,dtype=float); length=float(np.linalg.norm(vector)); u=vector/length
    transmitter=np.asarray(sp.spkssb(int(sv),et,'J2000'))[:3]
    moon0=np.asarray(sp.spkssb(301,et,'J2000'))
    relative=transmitter-moon0[:3]; drift=u-moon0[3:]/C_KM_S
    qcentre=float(np.clip(-(relative@drift)/(drift@drift),0,length))
    centre_et=et+qcentre/C_KM_S
    moon=np.asarray(sp.spkssb(301,centre_et,'J2000'))
    r=transmitter+qcentre*u-moon[:3]
    transform=np.asarray(sp.sxform('J2000',FRAME,centre_et))
    fixed=transform[:3,:3]@r
    slope=transform[:3,:3]@(u-moon[3:]/C_KM_S)+(transform[3:,:3]@r)/C_KM_S
    origin=fixed-qcentre*slope
    result=ray_clearance(origin,slope,length,dem,step_m,guard_m)
    result['linearization_max_error_m']=0.
    if check_exact and result['kind']=='sampled':
        errors=[]
        for q in [*result['shell_q_km'],result['q_km']]:
            t=et+q/C_KM_S
            moon_position=np.asarray(sp.spkssb(301,t,'J2000'))[:3]
            exact=np.asarray(sp.pxform('J2000',FRAME,t))@(transmitter+q*u-moon_position)
            errors.append(float(np.linalg.norm(exact-(origin+q*slope)))*1000)
        result['linearization_max_error_m']=max(errors)
        if max(errors)>1.:raise ValueError('Moving-Moon photon-ray affine error exceeds 1 m')
    return result
