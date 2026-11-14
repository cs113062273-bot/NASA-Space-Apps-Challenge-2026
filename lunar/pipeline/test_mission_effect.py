"""Small independent checks for the decisions used by the terrain-validation pipeline."""
import unittest
import numpy as np
from validate_mission_effect import DAYS, PRESETS, verdicts, visible_sun


class MissionValidationTests(unittest.TestCase):
    def setUp(self):
        self.n = (DAYS + 15) * 24
        self.sun = np.ones(self.n)
        self.earth = np.ones(self.n)
        self.eclipse = tuple(np.full(self.n, v) for v in (0.27, 1.0, 10.0, 0.0))

    def test_a_steep_site_does_not_pass_a_crew_mission(self):
        self.assertFalse(verdicts(self.sun, self.earth, 1, PRESETS['Artemis III crew'], 8.1, self.eclipse).any())
        self.assertTrue(verdicts(self.sun, self.earth, 1, PRESETS['Artemis III crew'], 8.0, self.eclipse).all())

    def test_a_partial_eclipse_can_hide_the_entire_cap_above_terrain(self):
        eclipse = tuple(np.array([v]) for v in (0.27, 1.0, 0.0, 0.9))
        self.assertFalse(visible_sun(np.array([0.01]), eclipse)[0])
        # The same Earth disk, below the Sun rather than above it, leaves the cap visible.
        self.assertTrue(visible_sun(np.array([0.01]), (*eclipse[:3], np.array([-0.9])))[0])

    def test_first_sunset_is_interpolated_before_a_daylight_threshold(self):
        self.sun[168:] = -0.5
        self.sun[167] = 0.5
        self.assertFalse(verdicts(self.sun, self.earth, 1, PRESETS['Default (14-day stay)'], 0, self.eclipse)[0])

    def test_eclipse_darkness_is_not_a_terrain_sunset(self):
        eclipse = tuple(v.copy() for v in self.eclipse)
        eclipse[2][10] = 0
        default = verdicts(self.sun, self.earth, 1, PRESETS['Default (14-day stay)'], 0, eclipse)
        crew = verdicts(self.sun, self.earth, 1, PRESETS['Artemis III crew'], 0, eclipse)
        self.assertTrue(default[0])
        self.assertFalse(crew[0])

    def test_sunset_inside_the_final_hour_is_not_continuous_daylight(self):
        self.sun[150:] = -0.5
        self.sun[149] = 0.5
        self.assertFalse(verdicts(self.sun, self.earth, 1, PRESETS['Artemis III crew'], 0, self.eclipse)[0])


if __name__ == '__main__':
    unittest.main()
