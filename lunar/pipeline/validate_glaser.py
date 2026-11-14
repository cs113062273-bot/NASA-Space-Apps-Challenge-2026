"""Reproduce published south-polar illumination statistics (Glaser et al. 2018, PSS 162, Table 2).

Reference: 2 m above ground, hourly 2017-01-01..2037-01-01, 20 m/pixel LOLA DTM, solar disk.
Ours: public PDS LDEM_80S_20M near field (10 km) + LDEM_80S_80M + LDEM_75S_240M far field,
DE440 Sun positions, the same averaging definitions. Because the published maxima were located
on a different (track-adjusted) DTM, we report the value at the published coordinate and the
best value within 100 m of it.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).parent))
from ephemeris import furnish  # noqa: E402
from fetch_dem20 import fetch  # noqa: E402
from lunar_geo import (PolarDEM, R0, compute_horizon, disk_fraction_visible, latlon_to_xy,  # noqa: E402
                       topocentric_azel, xy_to_latlon)

OUT = Path(__file__).resolve().parents[1] / "data" / "validation"

REFERENCE = [  # site, lat, lon, avg illumination %, solar visibility %, max shadow h  (Table 2, 2 m)
    ("Connecting Ridge C1", -89.4398, 222.83, 88.0, 92.1, 112),
    ("Connecting Ridge C2", -89.3130, 245.98, 78.1, 82.0, 165),
    ("Shackleton rim S", -89.6866, 197.19, 85.5, 89.4, 66),
]
SUN_RADIUS_KM = 696_000.0


def sun_track():
    furnish()
    t0 = datetime(2017, 1, 1, tzinfo=timezone.utc).timestamp()
    n = int((datetime(2037, 1, 1, tzinfo=timezone.utc).timestamp() - t0) // 3600)
    et0 = sp.str2et("2017-01-01T00:00:00")
    ets = et0 + 3600.0 * np.arange(n)  # leap seconds after 2017 are not scheduled
    pos, _ = sp.spkpos("SUN", ets, "MOON_ME", "LT+S", "MOON")
    return np.asarray(pos)


SKYLINE_ERR_DEG = 0.1  # typical LOLA skyline error (validate_skyline_error.py)


def _longest(dark):
    longest, run = 0, 0
    for d in dark:
        run = run + 1 if d else 0
        longest = max(longest, run)
    return longest


def stats(lat, lon, dems, sun, observer_m=2.0):
    """Average illumination %, solar visibility %, longest shadow (h), and the longest shadow with the skyline 0.1° lower / higher."""
    hz = compute_horizon(lat, lon, dems, observer_m=observer_m)
    az, el = topocentric_azel(lat, lon, R0 + hz.ground_m + observer_m, sun)
    hel = np.interp(az, np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360], np.r_[hz.elev_deg, hz.elev_deg, hz.elev_deg])
    rad = np.degrees(np.arcsin(SUN_RADIUS_KM / np.linalg.norm(sun, axis=1)))
    frac = disk_fraction_visible(el, hel, rad)
    dark = frac <= 0.0
    lo = _longest(disk_fraction_visible(el, hel - SKYLINE_ERR_DEG, rad) <= 0.0)
    hi = _longest(disk_fraction_visible(el, hel + SKYLINE_ERR_DEG, rad) <= 0.0)
    return 100 * frac.mean(), 100 * (~dark).mean(), _longest(dark), lo, hi


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    d80 = PolarDEM.load_pds("ldem_80s_80m")
    d240 = PolarDEM.load_pds("ldem_75s_240m")
    sun = sun_track()
    rows = []
    for name, lat, lon, ref_avg, ref_vis, ref_shadow in REFERENCE:
        d20 = fetch(name.lower().replace(" ", "_"), lat, lon, 10.0)
        dems = [d20, d80, d240]
        at_point = stats(lat, lon, dems, sun)
        x, y = latlon_to_xy(lat, lon)
        best = (at_point, lat, lon)
        shadows = [at_point[2]]
        shadows_lo = [at_point[3]]
        for dx in np.arange(-100, 101, 20):
            for dy in np.arange(-100, 101, 20):
                if dx == 0 and dy == 0:
                    continue
                la, lo = xy_to_latlon(x + dx, y + dy)
                s = stats(float(la), float(lo), dems, sun)
                shadows.append(s[2])
                shadows_lo.append(s[3])
                if s[0] > best[0][0]:
                    best = (s, float(la), float(lo))
        row = dict(site=name, lat=lat, lon=lon,
                   reference=dict(avg_illumination_pct=ref_avg, solar_visibility_pct=ref_vis, max_shadow_h=ref_shadow),
                   ours_at_point=dict(avg_illumination_pct=round(at_point[0], 2), solar_visibility_pct=round(at_point[1], 2), max_shadow_h=int(at_point[2])),
                   ours_best_within_100m=dict(lat=round(best[1], 5), lon=round(best[2], 4), avg_illumination_pct=round(best[0][0], 2),
                                              solar_visibility_pct=round(best[0][1], 2), max_shadow_h=int(best[0][2]),
                                              max_shadow_h_skyline_lower=int(best[0][3]), max_shadow_h_skyline_higher=int(best[0][4])),
                   max_shadow_h_range_within_100m=[int(min(shadows)), int(max(shadows))],
                   min_max_shadow_h_within_100m_skyline_lower=int(min(shadows_lo)))
        rows.append(row)
        print(json.dumps(row))
    result = {
        "reference": "Glaser, Oberst, Neumann, Mazarico, Speyerer, Robinson (2018), Illumination conditions at the lunar poles: "
                     "Implications for future exploration, Planet. Space Sci. 162, Table 2; NASA NTRS 20170007365",
        "period": "2017-01-01..2037-01-01 hourly, observer 2 m above ground",
        "ours": "PDS LOLA LDEM_80S_20M (10 km) + LDEM_80S_80M + LDEM_75S_240M, 720 azimuth bins, DE440 apparent Sun, finite solar disk",
        "checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": rows,
    }
    (OUT / "glaser2018-crosscheck.json").write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
