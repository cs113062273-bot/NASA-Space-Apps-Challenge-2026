"""Analytic force checks; no raw research cache or network required."""
import unittest
import numpy as np

from relay_orbits import HarmonicGravity, de421_constants, third_body_acceleration
from propagate_relay import integrate, overlap_fraction, radiation_acceleration, visible_sun_fraction


class LunarGravityTests(unittest.TestCase):
    def model(self, degree=0):
        c=np.zeros((degree+1,degree+1));c[0,0]=1
        return HarmonicGravity(4902.8,1738.,c,np.zeros_like(c))

    def test_point_mass_batch_and_poles(self):
        model=self.model()
        q=np.array([[2500.,0,0],[0,0,3500.],[0,0,-3500.],[2000.,3000.,-4000.]])
        np.testing.assert_allclose(model.acceleration(q),-model.gm*q/np.linalg.norm(q,axis=1)[:,None]**3,rtol=2e-15,atol=1e-18)
        with self.assertRaises(ValueError):model.acceleration([0,0,1737.])
        with self.assertRaises(ValueError):model.acceleration([float('nan'),0,2000])

    def test_j2_has_geodesy_normalization_and_correct_sign(self):
        model=self.model(2);j2=2.03e-4;model.c[2,0]=-j2/np.sqrt(5)
        q=np.array([[2500.,-3200.,1100.],[-5000.,3000.,-2000.],[0,0,5000.]])
        r=np.linalg.norm(q,axis=1);z=q[:,2]/r
        correction=1.5*j2*model.gm*model.radius**2/r**5
        expected=-model.gm*q/r[:,None]**3+correction[:,None]*q*np.array([5*z*z-1,5*z*z-1,5*z*z-3]).T
        np.testing.assert_allclose(model.acceleration(q),expected,rtol=3e-15,atol=1e-18)

    def test_full_degree25_force_matches_independent_cartesian_potential_gradient(self):
        rng=np.random.default_rng(47);model=self.model(25)
        for n in range(1,26):
            model.c[n,:n+1]=rng.normal(0,1e-4/n**2,n+1)
            model.s[n,1:n+1]=rng.normal(0,1e-4/n**2,n)
        q=rng.normal(size=(24,3));q*=rng.uniform(2000,23000,(24,1))/np.linalg.norm(q,axis=1)[:,None]
        expected=np.array([model.cartesian_gradient(v) for v in q])
        np.testing.assert_allclose(model.acceleration(q),expected,rtol=1e-11,atol=1e-16)

    def test_polar_force_is_regular_with_tesseral_terms(self):
        model=self.model(4);model.c[3,1]=2e-4;model.s[4,1]=-3e-4
        q=np.array([[0.,0.,3000.],[1e-3,-1e-3,3000.],[0.,0.,-3000.]])
        actual=model.acceleration(q)
        np.testing.assert_allclose(actual,np.array([model.cartesian_gradient(v) for v in q]),rtol=2e-7,atol=1e-12)
        self.assertGreater(abs(actual[0,0]),1e-10)
        self.assertGreater(abs(actual[0,1]),1e-10)

    def test_third_body_is_differential_not_direct_attraction(self):
        bodies=np.array([[10000.,0,0]]);gm=np.array([1e5])
        np.testing.assert_array_equal(third_body_acceleration(np.zeros(3),bodies,gm),np.zeros(3))
        q=np.array([[1000.,0,0],[-1000.,0,0]])
        expected=np.array([[gm[0]*(1/9000**2-1/10000**2),0,0],[gm[0]*(1/11000**2-1/10000**2),0,0]])
        np.testing.assert_allclose(third_body_acceleration(q,bodies,gm),expected,rtol=3e-15,atol=1e-18)

    def test_header_constants_use_au_cubed_per_day_squared_and_earth_not_emb(self):
        names=['DENUM','AU','EMRAT','CLIGHT','GMS','GM2','GMB','GM4','GM5','GM6']
        vals=[421,149597870.7,81.3,299792.458,2.959122e-4,7.24e-10,8.997e-10,9.55e-11,2.825e-7,8.46e-8]
        header='GROUP 1040\n10 '+' '.join(names)+'\nGROUP 1041\n10 '+' '.join(str(v).replace('e','D') for v in vals)
        c=de421_constants(header)
        self.assertAlmostEqual(c['10'],vals[4]*vals[1]**3/86400**2)
        self.assertAlmostEqual(c['399'],vals[6]*vals[1]**3/86400**2*81.3/82.3)
        with self.assertRaises(ValueError):de421_constants(header.replace('1041\n10','1041\n11'))


class RelayShadowAndIntegrationTests(unittest.TestCase):
    def test_circle_overlap_total_annular_separated_and_partial(self):
        self.assertEqual(overlap_fraction(1,2,0),1)
        self.assertEqual(overlap_fraction(2,1,0),.25)
        self.assertEqual(overlap_fraction(1,1,2),0)
        self.assertAlmostEqual(overlap_fraction(1,1,1),2/3-np.sqrt(3)/(2*np.pi),14)

    def test_occultors_behind_observer_or_beyond_sun_do_not_block(self):
        sun=np.array([1e8,0,0])
        self.assertEqual(visible_sun_fraction(sun,[(np.array([-1e4,0,0]),1000)],1e6),1)
        self.assertEqual(visible_sun_fraction(sun,[(np.array([2e8,0,0]),1e7)],1e6),1)
        self.assertEqual(visible_sun_fraction(sun,[(np.array([1e4,0,0]),1000)],1e6),0)
        with self.assertRaises(ValueError):visible_sun_fraction(sun,[(np.zeros(3),1000)],1e6)

    def test_partial_shadow_uses_union_not_product_or_sum(self):
        sun=np.array([1e8,0,0]);angle=np.arcsin(.01)
        v=np.array([np.cos(angle),np.sin(angle),0])*1e4;other=v*np.array([1,-1,1])
        expected=1-overlap_fraction(angle,angle,angle)
        self.assertAlmostEqual(visible_sun_fraction(sun,[(v,100)],1e6),expected,12)
        duplicate=visible_sun_fraction(sun,[(v,100),(v,100)],1e6)
        self.assertLess(abs(duplicate-expected),3e-4)
        self.assertLess(abs(visible_sun_fraction(sun,[(v,100),(other,100)],1e6)-(2*expected-1)),3e-4)
        self.assertGreater(duplicate,expected**2+.1)

    def test_srp_units_inverse_square_direction_and_shadow(self):
        au=149597870.7;c=299792.458
        q=np.array([[au,0,0],[0,-2*au,0],[0,0,au]])
        a=radiation_acceleration(q,au,c,np.array([1,.5,0]))
        expected=1367/299792458*1.8/850/1000
        np.testing.assert_allclose(a,np.array([[expected,0,0],[0,-expected/8,0],[0,0,0]]),rtol=1e-15,atol=1e-25)

    def test_kepler_orbit_closes_without_raw_data_or_spice(self):
        gm=4902.8;a=5000.;rp=3500.;period=2*np.pi*np.sqrt(a**3/gm)
        initial=np.array([[rp,0,0,0,np.sqrt(gm*(2/rp-1/a)),0]])
        def force(t,y):
            q=y[:3];return np.r_[y[3:],-gm*q/np.linalg.norm(q)**3]
        times,sol=integrate(force,period/86400,step_s=period/16,state=initial,rtol=1e-12,max_step=300)
        self.assertEqual(times[0],0)
        self.assertAlmostEqual(times[-1],period)
        np.testing.assert_allclose(sol.y[:,-1],initial.ravel(),rtol=0,atol=2e-5)
        energy=.5*np.sum(sol.y[3:]**2,axis=0)-gm/np.linalg.norm(sol.y[:3],axis=0)
        self.assertLess(np.ptp(energy),1e-9)


if __name__=='__main__':unittest.main()
