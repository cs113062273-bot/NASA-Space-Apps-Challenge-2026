"""Find the best landing point inside each NASA Artemis III candidate region box.

Stage 1 (coarse): ~600 points per region on LOLA 80/240 m terrain; each gets a 360-bin horizon,
2027 hourly sunlight and Earth visibility, and an 80 m-grid slope.
Stage 2 (fine): around the best coarse candidates, 9 x 9 points at 100 m on 20 m terrain with a
40 m-baseline slope. Pick the sunniest point with slope <= MAX_SLOPE (ties: more Earth in view).
Output: data/region_best.json, read by build_sites.py.
"""
from __future__ import annotations

import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fetch_dem20 import fetch  # noqa: E402
from lunar_geo import R0, PolarDEM, compute_horizon, disk_fraction_visible, topocentric_azel, xy_to_latlon  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EPH = ROOT / "app" / "public" / "data"
MAX_SLOPE = 8.0
REGIONS = {  # NASA October 2024 figure, pixel boxes (x1, x2, y1, y2); pole at (372, 378), 537.6 m/px, 0°E up
    "cabeus-b": (32, 69, 236, 272), "haworth": (276, 330, 189, 243), "malapert": (351, 389, 142, 181),
    "mouton-plateau": (458, 597, 62, 166), "mouton": (484, 516, 153, 183), "nobile-1": (503, 538, 165, 201),
    "nobile-2": (632, 669, 190, 226), "degerlache-2": (266, 302, 319, 355), "slater": (478, 514, 449, 485),
}
_D: list[PolarDEM] = []
_SUN = _EARTH = None


def box_xy(b):
    x1, x2, y1, y2 = b
    return (x1 - 372) * 537.6, (x2 - 372) * 537.6, (378 - y2) * 537.6, (378 - y1) * 537.6


def _init():
    global _D, _SUN, _EARTH
    _D = [PolarDEM.load_pds("ldem_80s_80m"), PolarDEM.load_pds("ldem_75s_240m")]
    meta = json.loads((EPH / "ephemeris.json").read_text())
    eph = np.fromfile(EPH / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    i0 = int((datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp() - meta["start_unix"]) // 3600)
    _SUN, _EARTH = eph[i0:i0 + 8760, 0:3], eph[i0:i0 + 8760, 3:6]


def _slope(dem: PolarDEM, x: float, y: float, s: float) -> float:
    h = dem.sample(np.array([x + s, x - s, x, x]), np.array([y, y, y + s, y - s]))
    return float(np.degrees(np.arctan(np.hypot((h[0] - h[1]) / (2 * s), (h[2] - h[3]) / (2 * s)))))


def _evaluate(x: float, y: float, dems: list[PolarDEM], n_az: int) -> tuple[float, float]:
    lat, lon = map(float, xy_to_latlon(x, y))
    hz = compute_horizon(lat, lon, dems, observer_m=2.0, n_az=n_az, d_max=200_000.0)
    rad = R0 + hz.ground_m + 2.0
    xp = np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360]
    fp = np.tile(hz.elev_deg, 3)
    az, el = topocentric_azel(lat, lon, rad, _SUN)
    sun = float(disk_fraction_visible(el, np.interp(az, xp, fp), 0.2666).mean())
    eaz, eel = topocentric_azel(lat, lon, rad, _EARTH)
    earth = float((eel >= np.interp(eaz, xp, fp)).mean())
    return sun, earth


def _coarse(args):
    x, y = args
    slope = _slope(_D[0], x, y, 80.0)
    if slope > 15:  # far too steep even at 160 m baseline: skip the horizon
        return x, y, slope, 0.0, 0.0
    sun, earth = _evaluate(x, y, _D, 180)
    return x, y, slope, sun, earth


def _fine(args):
    key, x, y, cx, cy = args
    d20 = fetch(f"region-{key}-{int(cx)}-{int(cy)}", *map(float, xy_to_latlon(cx, cy)), 3.0)
    slope = _slope(d20, x, y, 20.0)
    if slope > MAX_SLOPE:
        return x, y, slope, 0.0, 0.0
    sun, earth = _evaluate(x, y, [d20] + _D, 360)
    return x, y, slope, sun, earth


def main():
    out = {}
    with ProcessPoolExecutor(16, initializer=_init) as pool:
        for key, b in REGIONS.items():
            x1, x2, y1, y2 = box_xy(b)
            step = math.sqrt((x2 - x1) * (y2 - y1) / 600)
            pts = [(x, y) for x in np.arange(x1 + step / 2, x2, step) for y in np.arange(y1 + step / 2, y2, step)]
            coarse = list(pool.map(_coarse, pts, chunksize=8))
            flat = [c for c in coarse if c[2] <= 12] or coarse
            top = sorted(flat, key=lambda c: (c[3], c[4]), reverse=True)[:3]
            for (cx, cy, *_rest) in top:  # download the 20 m windows here, once, before the workers need them
                fetch(f"region-{key}-{int(cx)}-{int(cy)}", *map(float, xy_to_latlon(cx, cy)), 3.0)
            fine_pts = []
            for (cx, cy, *_rest) in top:
                for dx in np.arange(-400, 401, 100):
                    for dy in np.arange(-400, 401, 100):
                        x, y = cx + dx, cy + dy
                        if x1 <= x <= x2 and y1 <= y <= y2:
                            fine_pts.append((key, x, y, cx, cy))
            fine = list(pool.map(_fine, fine_pts, chunksize=4))
            ok = [f for f in fine if f[2] <= MAX_SLOPE and f[3] > 0]
            best = max(ok, key=lambda f: (round(f[3], 3), f[4])) if ok else max(fine, key=lambda f: f[3])
            lat, lon = map(float, xy_to_latlon(best[0], best[1]))
            out[key] = {"lat": round(lat, 5), "lon": round(lon, 4), "slope_deg": round(best[2], 1),
                        "sun_2027_pct": round(100 * best[3], 1), "earth_2027_pct": round(100 * best[4], 1),
                        "coarse_points": len(pts), "fine_points": len(fine_pts), "coarse_step_m": round(step)}
            print(key, out[key], flush=True)
    (ROOT / "data" / "region_best.json").write_text(json.dumps({
        "method": "coarse 180-bin horizons on LOLA 80/240 m over the NASA region box, then 9x9 x 100 m refinement on 20 m terrain around the 3 best; "
                  f"choose max 2027 mean visible solar disk with 40 m-baseline slope <= {MAX_SLOPE} deg (tie: Earth in view)",
        "regions": out}, indent=2))


if __name__ == "__main__":
    main()
