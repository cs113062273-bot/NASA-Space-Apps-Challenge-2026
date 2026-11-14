"""Analytic finite rays and deliberately non-spherical synthetic terrain; no downloads."""
import unittest
from unittest.mock import patch
import numpy as np

from lunar_limb import LimbDEM, photon_ray, ray_clearance


class LunarLimbTests(unittest.TestCase):
    def test_constant_sphere_tangent_and_finite_segment(self):
        dem=LimbDEM(np.zeros((180,360)),1)
        # Analytic closest point lies on the segment, so distance-R is exact.
        result=ray_clearance(np.array([-2000.,1737.45,0]),np.array([1.,0,0]),4000,dem)
        self.assertEqual(result['kind'],'sampled')
        self.assertAlmostEqual(result['clearance_m'],50.,places=6)
        self.assertFalse(result['pass'])
        # A line would cross the sphere, but this outward finite segment cannot.
        result=ray_clearance(np.array([1800.,0,0]),np.array([1.,0,0]),1000,dem)
        self.assertTrue(result['pass']); self.assertEqual(result['kind'],'outer_bound')
        result=ray_clearance(np.array([-2000.,0,0]),np.array([1.,0,0]),4000,dem)
        self.assertFalse(result['pass']); self.assertEqual(result['kind'],'inner_bound')

    def test_real_terrain_not_mean_radius_decides_blockage(self):
        heights=np.zeros((180,360)); heights[88:92,88:92]=4000 # +2 km at 90E
        dem=LimbDEM(heights,1)
        o=np.array([-300.,1738.4,0]); d=np.array([1.,0,0])
        self.assertGreater(np.linalg.norm(o+300*d)-1737.4,0) # sphere would pass
        result=ray_clearance(o,d,600,dem,100,100)
        self.assertEqual(result['kind'],'sampled'); self.assertFalse(result['pass'])
        self.assertAlmostEqual(result['clearance_m'],-1000.,places=6)
        np.testing.assert_allclose(dem.radius(np.array([[0,1800,0]])),[1739.4])

    def test_seam_centres_pole_and_invalid_data(self):
        h=np.zeros((180,360)); h[:,0]=200; h[:,-1]=600
        dem=LimbDEM(h,1)
        # 0E lies halfway between 359.5 and 0.5 degree centres.
        self.assertAlmostEqual(float(dem.radius(np.array([1800.,0,0]))),1737.6)
        for lon,dn in [(.5,200),(359.5,600)]:
            p=1800*np.array([np.cos(np.deg2rad(lon)),np.sin(np.deg2rad(lon)),0])
            self.assertAlmostEqual(float(dem.radius(p)),1737.4+dn*.0005)
        with self.assertRaises(ValueError):dem.radius(np.array([0.,0,1800.]))
        with self.assertRaises(ValueError):ray_clearance(np.ones(3),np.zeros(3),10,dem)
        with self.assertRaises(ValueError):ray_clearance(np.ones(3),np.ones(3),-1,dem)

    def test_scalar_brute_force_independent_bilinear_reference(self):
        # Smooth nonconstant terrain, checked against a separately written scalar
        # four-corner sampler in latitude/longitude, not another production call.
        h=np.arange(180*360,dtype=float).reshape(180,360)%1000
        dem=LimbDEM(h,1)
        lat,lon=12.34,359.87
        la,lo=np.deg2rad([lat,lon]); p=1800*np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
        row=89.5-lat; col=(lon-.5)%360; a,b=int(np.floor(row)),int(np.floor(col)); fr,fc=row-a,col-b
        height=sum(h[a+dr,(b+dc)%360]*wr*wc for dr,wr in [(0,1-fr),(1,fr)] for dc,wc in [(0,1-fc),(1,fc)])
        self.assertAlmostEqual(float(dem.radius(p)),1737.4+height*.0005,places=11)

    def test_photon_uses_moon_at_signal_passage_not_transmission(self):
        dem=LimbDEM(np.zeros((180,360)),1)
        transmitter=np.array([-3000.,1740.,0.,0.,0.,0.])
        velocity=np.array([0.,1000.,0.]) # exaggerated, analytic moving-sphere case
        def state(body,t,frame):
            return transmitter if body==-1 else np.r_[velocity*t,velocity]
        with patch('lunar_limb.sp.spkssb',side_effect=state),patch('lunar_limb.sp.sxform',return_value=np.eye(6)):
            moving=photon_ray(0.,'-1',np.array([6000.,0,0]),dem)
        self.assertFalse(moving['pass'])
        frozen=ray_clearance(transmitter[:3],np.array([1.,0,0]),6000,dem)
        self.assertTrue(frozen['pass'])

    def test_moving_frame_exact_check_and_rejection(self):
        dem=LimbDEM(np.zeros((180,360)),1)
        transmitter=np.array([-2000.,1737.45,0.,0.,0.,0.])
        def state(body,t,frame):return transmitter if body==-1 else np.zeros(6)
        with patch('lunar_limb.sp.spkssb',side_effect=state),patch('lunar_limb.sp.sxform',return_value=np.eye(6)),patch('lunar_limb.sp.pxform',return_value=np.eye(3)):
            result=photon_ray(0.,'-1',np.array([4000.,0,0]),dem)
            self.assertAlmostEqual(result['clearance_m'],50.,places=6)
            self.assertLess(result['linearization_max_error_m'],1e-8)
        # Deliberately inconsistent exact frame must fail rather than grant service.
        with patch('lunar_limb.sp.spkssb',side_effect=state),patch('lunar_limb.sp.sxform',return_value=np.eye(6)),patch('lunar_limb.sp.pxform',return_value=2*np.eye(3)):
            with self.assertRaises(ValueError):photon_ray(0.,'-1',np.array([4000.,0,0]),dem)


if __name__=='__main__':unittest.main()
