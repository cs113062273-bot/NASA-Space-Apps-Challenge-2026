"""Grid check against NASA Goddard's south-pole sunlight map (PGDA product 69, AVGVISIB_85S_060M_201608).

The Goddard map gives, per 60 m pixel, the share of hourly timesteps over 18.6 years in which any part of the
solar disk is above the terrain (Mazarico et al. 2011 method, LDEM_85S_060M). At random points between 85°S and
the pole we compute the same quantity with our own engine (80 m + 240 m LOLA horizons, 2 m above ground, DE440)
and compare it with the map's pixel and with the range of its 3x3 neighbourhood.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).parent))
from ephemeris import furnish  # noqa: E402
from lunar_geo import PolarDEM, R0, compute_horizon, disk_fraction_visible, topocentric_azel, xy_to_latlon  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PGDA = ROOT / "data" / "raw" / "pgda" / "AVGVISIB_85S_060M_201608.IMG"
OUT = ROOT / "data" / "validation" / "pgda-avgvisib-crosscheck.json"
N_POINTS = 300
SEED = 2026
SUN_RADIUS_KM = 696_000.0
YEARS = 18.6


def pgda_grid() -> PolarDEM:
    n = 5058
    dn = np.memmap(PGDA, dtype="<i2", mode="r", shape=(n, n))
    return PolarDEM("AVGVISIB_85S_060M", dn, 60.0, (1 - n / 2 - 0.5) * 60.0, -(1 - n / 2 - 0.5) * 60.0, 0.00004)


def sun_track() -> np.ndarray:
    furnish()
    n = int(YEARS * 365.25 * 24)
    ets = sp.str2et("2017-01-01T00:00:00") + 3600.0 * np.arange(n)
    pos, _ = sp.spkpos("SUN", ets, "MOON_ME", "LT+S", "MOON")
    return np.asarray(pos)


_ctx: dict = {}


def _init(sun):
    _ctx["sun"] = sun
    _ctx["dems"] = [PolarDEM.load_pds("ldem_80s_80m"), PolarDEM.load_pds("ldem_75s_240m")]


def ours(xy):
    x, y = xy
    lat, lon = xy_to_latlon(np.array([x]), np.array([y]))
    lat, lon = float(lat[0]), float(lon[0])
    sun = _ctx["sun"]
    hz = compute_horizon(lat, lon, _ctx["dems"], observer_m=2.0)
    az, el = topocentric_azel(lat, lon, R0 + hz.ground_m + 2.0, sun)
    hel = np.interp(az, np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360], np.r_[hz.elev_deg, hz.elev_deg, hz.elev_deg])
    rad = np.degrees(np.arcsin(SUN_RADIUS_KM / np.linalg.norm(sun, axis=1)))
    frac = disk_fraction_visible(el, hel, rad)
    return lat, lon, 100 * float((frac > 0).mean()), 100 * float(frac.mean())


def main() -> None:
    t0 = time.time()
    g = pgda_grid()
    rng = np.random.default_rng(SEED)
    r = 150_000 * np.sqrt(rng.uniform(0.0004, 1, N_POINTS))  # uniform by area, 3-150 km from the pole
    th = rng.uniform(0, 2 * np.pi, N_POINTS)
    xs, ys = r * np.cos(th), r * np.sin(th)
    sun = sun_track()
    with Pool(initializer=_init, initargs=(sun,)) as pool:
        res = pool.map(ours, list(zip(xs, ys)))
    rows = []
    for (x, y), (lat, lon, vis, avg) in zip(zip(xs, ys), res):
        c = int(round((x - g.x0) / g.scale))
        rr = int(round((g.y0 - y) / g.scale))
        win = np.asarray(g.heights[rr - 1: rr + 2, c - 1: c + 2], dtype=float) * g.factor * 100
        ref = float(g.heights[rr, c]) * g.factor * 100
        rows.append(dict(lat=round(lat, 5), lon=round(lon, 4), pgda_pct=round(ref, 2), pgda_3x3=[round(win.min(), 2), round(win.max(), 2)],
                         ours_any_sun_pct=round(vis, 2), ours_avg_disk_pct=round(avg, 2)))
    a = np.array([r["ours_any_sun_pct"] for r in rows])
    b = np.array([r["pgda_pct"] for r in rows])
    d = a - b
    within = np.mean([(r["pgda_3x3"][0] - 0.5 <= r["ours_any_sun_pct"] <= r["pgda_3x3"][1] + 0.5) for r in rows])
    lit = b > 1  # leave out permanently shadowed points, where both are ~0
    summary = {
        "n": len(rows), "n_lit": int(lit.sum()),
        "bias_pp": round(float(d.mean()), 2), "rmse_pp": round(float(np.sqrt((d ** 2).mean())), 2),
        "median_abs_pp": round(float(np.median(np.abs(d))), 2), "p90_abs_pp": round(float(np.percentile(np.abs(d), 90)), 2),
        "r": round(float(np.corrcoef(a, b)[0, 1]), 4),
        "share_within_3x3_range": round(float(within), 3),
        "lit_bias_pp": round(float(d[lit].mean()), 2), "lit_rmse_pp": round(float(np.sqrt((d[lit] ** 2).mean())), 2),
    }
    print(summary, f"{time.time() - t0:.0f} s")
    OUT.write_text(json.dumps({
        "checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reference": "NASA GSFC PGDA product 69, AVGVISIB_85S_060M_201608 (share of hourly timesteps over 18.6 years with any of the solar disk visible; LDEM_85S_060M)",
        "ours": "LDEM_80S_80M + LDEM_75S_240M horizons, 2 m above ground, DE440, hourly 2017-01-01 + 18.6 years",
        "points": f"{N_POINTS} random points, uniform by area 3-150 km from the pole, seed {SEED}",
        "summary": summary, "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
