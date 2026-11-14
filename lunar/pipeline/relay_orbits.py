"""LCRNS reference-orbit inputs and lunar gravity. Units: km, km/s, TDB seconds.

Reference design, never operational relay coverage. The published rounded initial states
are copied from Table 2; their units are cross-checked against Table 1's orbital elements.
The DE421 force frame is explicit and independent of the app's DE440 terrain frame.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import re

import numpy as np
from scipy.special import assoc_legendre_p_all

import fetch_relay_sources as sources

EPOCH_UTC = '2027-03-01T00:00:00'
INITIAL_STATES = np.array([
    [-198.931445,386.023132,3458.355412,-1.539867,0.022243,-0.091059],
    [1089.980598,-2260.918271,-18984.562823,0.280301,-0.004049,0.016575],
    [9187.665852,-260.470721,-8543.222759,0.273629,0.417588,-0.313828],
    [6484.019002,14329.883921,-7966.345594,-0.258433,0.033951,0.235264],
    [-5074.242314,14473.022751,-8638.530033,-0.229931,-0.026926,-0.264381],
], dtype=float)
# a, e, inclination, RAAN, argument of periapsis, true anomaly. Table 1 PA at J2000.
PUBLISHED_ELEMENTS = np.array([
    [11315.936501,.691982,59.373229,321.019197,92.494031,0.],
    [11317.948675,.691982,58.951732,320.997768,92.505016,180.],
    [11305.413654,.691982,52.733096,81.148790,92.062891,140.049207],
    [11326.302154,.691982,52.513419,81.138818,92.068945,195.992393],
    [11307.882863,.691982,56.310396,204.889626,85.444071,164.007607],
])


def de421_constants(text: str) -> dict[str,float]:
    groups = re.split(r'GROUP\s+(\d+)',text)
    fields = {int(groups[i]):groups[i+1].split() for i in range(1,len(groups),2)}
    names, vals = fields[1040], fields[1041]
    if int(names[0]) != len(names)-1 or int(vals[0]) != len(vals)-1 or len(names)!=len(vals):
        raise ValueError('Invalid JPL constant counts')
    c = dict(zip(names[1:],(float(v.replace('D','E')) for v in vals[1:])))
    if c['DENUM'] != 421 or not 1.49e8 < c['AU'] < 1.50e8 or not 80 < c['EMRAT'] < 82:
        raise ValueError('Unexpected DE421 constant identity or units')
    factor = c['AU']**3/86400**2
    return {'AU':c['AU'],'c_km_s':c['CLIGHT'],
        '10':c['GMS']*factor,'2':c['GM2']*factor,
        '399':c['GMB']*factor*c['EMRAT']/(1+c['EMRAT']),
        '4':c['GM4']*factor,'5':c['GM5']*factor,'6':c['GM6']*factor}


def normalization(degree: int) -> np.ndarray:
    """Geodesy fully normalized Pnm, no Condon–Shortley phase."""
    out = np.zeros((degree+1,degree+1))
    for n in range(degree+1):
        for m in range(n+1):
            out[n,m] = math.sqrt((1 if m==0 else 2)*(2*n+1)*math.exp(math.lgamma(n-m+1)-math.lgamma(n+m+1)))
    return out


@dataclass
class HarmonicGravity:
    gm: float
    radius: float
    c: np.ndarray # fully normalized, including C00=1
    s: np.ndarray

    def __post_init__(self):
        if self.c.shape != self.s.shape or self.c.ndim != 2 or self.c.shape[0]!=self.c.shape[1]:
            raise ValueError('Gravity coefficient shape mismatch')
        self.degree = len(self.c)-1
        self.norm = normalization(self.degree)
        self.ns,self.ms = np.indices(self.c.shape)
        self.phase = (-1.)**self.ms

    def potential_cartesian(self, xyz: np.ndarray):
        """Independent solid-harmonic recurrence, analytic for complex-step differentiation.

        Unnormalized V/W formulation avoids polar coordinates and stays regular at poles.
        Used as the force cross-check and for rare near-pole force evaluations, not SPICE.
        """
        x,y,z = np.asarray(xyz)
        r2=x*x+y*y+z*z
        v=np.zeros(self.c.shape,dtype=np.result_type(xyz,float));w=np.zeros_like(v)
        v[0,0]=self.radius/np.sqrt(r2)
        xr,yr,zr=self.radius*x/r2,self.radius*y/r2,self.radius*z/r2
        rr=self.radius**2/r2
        for m in range(self.degree+1):
            if m:
                v[m,m]=(2*m-1)*(xr*v[m-1,m-1]-yr*w[m-1,m-1])
                w[m,m]=(2*m-1)*(xr*w[m-1,m-1]+yr*v[m-1,m-1])
            for n in range(m+1,self.degree+1):
                v[n,m]=((2*n-1)*zr*v[n-1,m]-(n+m-1)*rr*(v[n-2,m] if n>=m+2 else 0))/(n-m)
                w[n,m]=((2*n-1)*zr*w[n-1,m]-(n+m-1)*rr*(w[n-2,m] if n>=m+2 else 0))/(n-m)
        return self.gm/self.radius*np.sum(self.norm*(self.c*v+self.s*w))

    def cartesian_gradient(self, xyz: np.ndarray) -> np.ndarray:
        h=1e-20
        return np.array([self.potential_cartesian(np.asarray(xyz,dtype=complex)+1j*h*np.eye(3)[k]).imag/h for k in range(3)])

    def acceleration(self, xyz: np.ndarray) -> np.ndarray:
        """Analytic spherical derivatives; batch (...,3), with a regular polar fallback."""
        a=np.atleast_2d(np.asarray(xyz,dtype=float))
        if a.ndim!=2 or a.shape[1]!=3 or not np.isfinite(a).all():
            raise ValueError('Invalid gravity position')
        r=np.linalg.norm(a,axis=1)
        if np.any(r<=self.radius):
            raise ValueError('External harmonic model requires positions outside its reference sphere')
        # sin(latitude) rounds toward ±1 near a pole; switch before its derivative
        # amplifies that lost precision, including nonzero tesseral horizontal force.
        rho=np.hypot(a[:,0],a[:,1]); polar=rho/r<1e-4
        out=np.empty_like(a)
        if np.any(polar):
            out[polar]=np.array([self.cartesian_gradient(v) for v in a[polar]])
        if np.any(~polar):
            q=a[~polar];rr=r[~polar];rh=rho[~polar]
            sine=q[:,2]/rr; cosine=rh/rr
            lon=np.arctan2(q[:,1],q[:,0]);cl,sl=np.cos(lon),np.sin(lon)
            p=assoc_legendre_p_all(self.degree,self.degree,sine,diff_n=1)[:,:,:self.degree+1,:]
            p=p*(self.norm*self.phase)[None,:,:,None]
            cs=np.cos(self.ms[:,:,None]*lon);ss=np.sin(self.ms[:,:,None]*lon)
            harmonic=self.c[:,:,None]*cs+self.s[:,:,None]*ss
            radial=(self.radius/rr)**self.ns[:,:,None]
            common=self.gm/rr**2
            ar=-common*np.sum((self.ns+1)[:,:,None]*radial*p[0]*harmonic,axis=(0,1))
            ap=common*cosine*np.sum(radial*p[1]*harmonic,axis=(0,1))
            al=common/cosine*np.sum(radial*p[0]*self.ms[:,:,None]*(-self.c[:,:,None]*ss+self.s[:,:,None]*cs),axis=(0,1))
            up=q/rr[:,None];north=np.array([-sine*cl,-sine*sl,cosine]).T;east=np.array([-sl,cl,np.zeros_like(sl)]).T
            out[~polar]=ar[:,None]*up+ap[:,None]*north+al[:,None]*east
        return out[0] if np.ndim(xyz)==1 else out


def load_gravity(degree: int = 25) -> HarmonicGravity:
    if not 0<=degree<=25:
        raise ValueError('This reference implementation is limited to degree/order 25')
    # The caller verifies the pinned source bytes once before invoking a source loader.
    c=np.zeros((degree+1,degree+1));s=np.zeros_like(c);c[0,0]=1
    found=set()
    with (sources.CACHE/'gggrx_0900c_sha.tab').open('rb') as f:
        header=f.read(244).decode('ascii').split(',')
        radius,gm=float(header[0]),float(header[1])
        if radius!=1738. or abs(gm-4902.79996708864)>1e-9 or int(header[5])!=1 or float(header[6])!=0 or float(header[7])!=0:
            raise ValueError('GRGM900C header/frame/normalization changed')
        while row:=f.read(122):
            if len(row)!=122:raise ValueError('Truncated gravity record')
            fields=row.decode('ascii').split(',');n,m=int(fields[0]),int(fields[1])
            if n>degree:break
            if not 1<=n<=degree or not 0<=m<=n or (n,m) in found:
                raise ValueError('Invalid gravity degree/order records')
            found.add((n,m));c[n,m]=float(fields[2]);s[n,m]=float(fields[3])
    if found!={(n,m) for n in range(1,degree+1) for m in range(n+1)} or not np.isfinite(c).all() or not np.isfinite(s).all():
        raise ValueError('Incomplete gravity truncation')
    return HarmonicGravity(gm,radius,c,s)


def third_body_acceleration(xyz: np.ndarray, bodies: np.ndarray, gm: np.ndarray) -> np.ndarray:
    """Differential acceleration in a translating Moon-centred inertial frame."""
    q=np.atleast_2d(xyz)
    delta=bodies[None,:,:]-q[:,None,:]
    out=np.sum(gm[None,:,None]*(delta/np.linalg.norm(delta,axis=2)[:,:,None]**3-bodies[None,:,:]/np.linalg.norm(bodies,axis=1)[None,:,None]**3),axis=1)
    return out[0] if np.ndim(xyz)==1 else out
