"""Analytic spherical destinations, including both exact poles; no raw data."""
import unittest
import numpy as np
from lunar_geo import destination, R0

class GeodesicTests(unittest.TestCase):
    def test_south_pole_directions_keep_asymmetric_terrain_orientation(self):
        az=np.radians(np.arange(5,360,10))[:,None];d=np.array([1.,20.,1000.,300000.])[None,:]
        for lon in [0.,90.,222.83]:
            lat2,lon2=destination(-90,lon,az,d)
            np.testing.assert_allclose(lat2,np.broadcast_to(-90+np.degrees(d/R0),lat2.shape),rtol=0,atol=2e-12)
            # At the south pole, azimuth is clockwise from the meridian toward lon.
            error=np.angle(np.exp(1j*(np.radians(lon2)-np.radians(lon)-az)))
            np.testing.assert_allclose(error,0,rtol=0,atol=2e-9)

    def test_north_pole_and_equator_have_analytic_destinations(self):
        az=np.radians(np.arange(5,360,10));d=np.full(az.shape,1000.)
        lat,lon=destination(90,20,az,d)
        np.testing.assert_allclose(lat,90-np.degrees(d/R0),rtol=0,atol=2e-12)
        np.testing.assert_allclose(np.angle(np.exp(1j*(np.radians(lon)-np.radians(20)-np.pi+az))),0,atol=2e-12)
        lat,lon=destination(0,0,np.array([0.,np.pi/2]),np.array([1000.,1000.]))
        np.testing.assert_allclose(lat,[np.degrees(1000/R0),0],atol=2e-12)
        np.testing.assert_allclose(lon,[0,np.degrees(1000/R0)],atol=2e-12)

    def test_destinations_preserve_distance_and_local_azimuth(self):
        for lat,lon in [(-89.9999999,222.83),(-89.4398,222.83),(30.,50.)]:
            az=np.radians(np.arange(5,360,10))[:,None];d=np.array([20.,1000.,300000.])[None,:]
            a,b=destination(lat,lon,az,d);a=np.radians(a);b=np.radians(b)
            target=np.stack([np.cos(a)*np.cos(b),np.cos(a)*np.sin(b),np.sin(a)],axis=-1)
            la,lo=np.radians([lat,lon]);up=np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
            east=np.array([-np.sin(lo),np.cos(lo),0]);north=np.cross(up,east)
            dot=target@up;cross=np.linalg.norm(np.cross(up,target),axis=-1)
            np.testing.assert_allclose(np.arctan2(cross,dot)*R0,np.broadcast_to(d,a.shape),atol=2e-8,rtol=0)
            actual=np.arctan2(target@east,target@north)
            np.testing.assert_allclose(np.angle(np.exp(1j*(actual-az))),0,atol=2e-10,rtol=0)

if __name__=='__main__':unittest.main()
