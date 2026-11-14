"""Geometry-product interval and terrain conventions without raw data."""
import unittest
import numpy as np
from build_relay_geometry import contact_runs, full_hours, terrain_clearance


class RelayGeometryTests(unittest.TestCase):
    def test_every_sample_and_both_endpoints_must_pass(self):
        good=np.ones(9,dtype=bool)
        np.testing.assert_array_equal(full_hours(good,4),[True,True])
        good[4]=False
        np.testing.assert_array_equal(full_hours(good,4),[False,False])
        good[4]=True;good[6]=False
        np.testing.assert_array_equal(full_hours(good,4),[True,False])
        with self.assertRaises(ValueError):full_hours(good[:-1],4)
        with self.assertRaises(ValueError):full_hours(good,0)

    def test_contacts_merge_only_adjacent_hours_and_keep_legs_distinct(self):
        start=1803859200.
        windows=contact_runs(np.array([False,True,True,False,True]),start,'access',512)
        self.assertEqual(windows,[{'startUnix':start+3600,'endUnix':start+10800,'leg':'access','kbps':512},
            {'startUnix':start+14400,'endUnix':start+18000,'leg':'access','kbps':512}])
        self.assertEqual(contact_runs(np.zeros(4,dtype=bool),start,'backhaul',2048),[])
        with self.assertRaises(ValueError):contact_runs(np.ones(2),start,'uplink',512)
        with self.assertRaises(ValueError):contact_runs(np.ones(2),start,'access',-1)

    def test_east_north_elevation_and_wrapped_centidegree_horizon(self):
        # At lat/lon 0: up +X, east +Y, north +Z. Four bin CENTRES at 45/135/225/315 deg.
        h=np.array([0,100,200,300])
        v=np.array([[1,0,1],[1,1,0],[1,0,-1],[1,-1,0],[1,-1,1]])
        got=terrain_clearance(v,0,0,h)
        np.testing.assert_allclose(got[:4],[43.5,44.5,43.5,42.5],atol=1e-12)
        self.assertAlmostEqual(got[4],np.rad2deg(np.arctan2(1,np.sqrt(2)))-3)


if __name__=='__main__':unittest.main()
