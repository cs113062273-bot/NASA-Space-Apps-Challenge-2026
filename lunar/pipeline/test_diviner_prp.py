"""Independent analytic geometry cases for PRP sampling, without the raw source cache."""
import unittest
import numpy as np

from diviner_prp import contains_by_edges, direction, great_circle_m, ray_triangle


class DivinerFacetTests(unittest.TestCase):
    def setUp(self):
        self.triangle = np.eye(3)

    def test_ray_intersection_has_known_equal_barycentric_weights(self):
        p = np.ones(3)/np.sqrt(3)
        weights, distance = ray_triangle(p,self.triangle)
        np.testing.assert_allclose(weights,[1/3]*3,atol=1e-12)
        self.assertAlmostEqual(distance,1/np.sqrt(3))
        np.testing.assert_allclose(weights @ self.triangle,distance*p,atol=1e-12)

    def test_winding_does_not_change_physical_intersection(self):
        p = np.array([1,2,3])/np.sqrt(14)
        forward = ray_triangle(p,self.triangle)
        reverse = ray_triangle(p,self.triangle[::-1])
        self.assertAlmostEqual(forward[1],reverse[1])
        np.testing.assert_allclose(forward[0],reverse[0][::-1],atol=1e-12)
        self.assertTrue(contains_by_edges(p,self.triangle))
        self.assertTrue(contains_by_edges(p,self.triangle[::-1]))

    def test_outside_backwards_and_degenerate_faces_are_not_extrapolated(self):
        self.assertIsNone(ray_triangle(np.array([-1,1,1])/np.sqrt(3),self.triangle))
        self.assertIsNone(ray_triangle(-np.ones(3)/np.sqrt(3),self.triangle))
        self.assertIsNone(ray_triangle(np.ones(3)/np.sqrt(3),np.ones((3,3))))
        self.assertFalse(contains_by_edges(np.array([-1,1,1])/np.sqrt(3),self.triangle))
        self.assertFalse(contains_by_edges(-np.ones(3)/np.sqrt(3),self.triangle))

    def test_boundary_can_belong_to_both_faces_without_interpolating_values(self):
        p = np.array([1,1,0])/np.sqrt(2)
        w,_ = ray_triangle(p,self.triangle)
        self.assertAlmostEqual(w[2],0)
        self.assertTrue(contains_by_edges(p,self.triangle))

    def test_longitude_wrap_and_distance_are_spherical(self):
        np.testing.assert_allclose(direction(-89,-1),direction(-89,359),atol=1e-14)
        self.assertAlmostEqual(np.linalg.norm(direction(-89,359)),1)
        self.assertAlmostEqual(great_circle_m(direction(0,0),direction(0,90)),1737400*np.pi/2)
        self.assertAlmostEqual(great_circle_m(direction(-90,0),direction(-90,170)),0,places=6)


if __name__ == "__main__":
    unittest.main()
