"""What the LOLA-vs-stereo skyline difference does to the numbers people use: sunlight share and sunset times.

At the 15 points of the three DLR south-pole stereo models (validate_skyline_error.py) the horizon is computed with
and without the 2 m stereo near field. For each point we report the slope (40 m baseline on the stereo model), the
skyline difference, the share of 2027 with any Sun above the skyline under each horizon, and the shift of every
sunset in 2027 (sunsets matched within 48 h).
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).parent))
import build_sites as B  # noqa: E402
from ephemeris import furnish  # noqa: E402
from fetch_dem20 import fetch  # noqa: E402
from lunar_geo import PolarDEM, R0, compute_horizon, disk_fraction_visible, topocentric_azel, xy_to_latlon  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
NAC = ROOT / "data" / "raw" / "nac"
OUT = ROOT / "data" / "validation" / "skyline-effect.json"
SUN_RADIUS_KM = 696_000.0


def sun_2027():
    furnish()
    n = 365 * 24
    ets = sp.str2et("2027-01-01T00:00:00") + 3600.0 * np.arange(n)
    pos, _ = sp.spkpos("SUN", ets, "MOON_ME", "LT+S", "MOON")
    return np.asarray(pos)


def load(p: Path) -> PolarDEM:
    z = np.load(p)
    return PolarDEM(p.stem, z["h"], float(z["scale"]), float(z["x0"]), float(z["y0"]))


def lit(lat, lon, hz, sun):
    az, el = topocentric_azel(lat, lon, R0 + hz.ground_m + 2.0, sun)
    hel = np.interp(az, np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360], np.r_[hz.elev_deg, hz.elev_deg, hz.elev_deg])
    rad = np.degrees(np.arcsin(SUN_RADIUS_KM / np.linalg.norm(sun, axis=1)))
    return disk_fraction_visible(el, hel, rad) > 0


def sunsets(up):
    return np.nonzero(up[:-1] & ~up[1:])[0] + 1


def main():
    sun = sun_2027()
    d80, d240 = B._dem("ldem_80s_80m"), B._dem("ldem_75s_240m")
    rows = []
    pooled, pooled_flat = [], []
    for product in ["ESALL_CR1", "ESALL_SR12", "ESALL_MP1"]:
        for k in range(5):
            pn, pd = NAC / f"val_{product}_{k}_{product}.npz", ROOT / "data" / "raw" / "dem20" / f"val_{product}_{k}.npz"
            if not pn.exists():
                continue
            nac, d20 = load(pn), load(pd)
            n = nac.heights.shape[0]
            x = nac.x0 + (n // 2) * nac.scale
            y = nac.y0 - (n // 2) * nac.scale
            la, lo = (float(v[0]) for v in xy_to_latlon(np.array([x]), np.array([y])))
            # slope over a 40 m baseline on the stereo model
            hx = nac.sample(np.array([x + 20, x - 20]), np.array([y, y]))
            hy = nac.sample(np.array([x, x]), np.array([y + 20, y - 20]))
            slope = float(np.degrees(np.arctan(np.hypot((hx[0] - hx[1]) / 40, (hy[0] - hy[1]) / 40))))
            with_nac = compute_horizon(la, lo, [nac, d20, d80, d240], observer_m=2.0)
            lola = compute_horizon(la, lo, [d20, d80, d240], observer_m=2.0)
            dsky = np.abs(with_nac.elev_deg - lola.elev_deg)
            up_n, up_l = lit(la, lo, with_nac, sun), lit(la, lo, lola, sun)
            sn, sl = sunsets(up_n), sunsets(up_l)
            shifts = [float(sn[np.argmin(np.abs(sn - s))] - s) for s in sl if len(sn) and np.min(np.abs(sn - s)) <= 48]
            pooled += [abs(v) for v in shifts]
            if slope <= 10:
                pooled_flat += [abs(v) for v in shifts]
            rows.append(dict(model=product, point=k, lat=round(la, 5), lon=round(lo, 4), slope_deg=round(slope, 1),
                             skyline_median_deg=round(float(np.median(dsky)), 3), skyline_p90_deg=round(float(np.percentile(dsky, 90)), 3),
                             sun_pct_stereo=round(100 * float(up_n.mean()), 1), sun_pct_lola=round(100 * float(up_l.mean()), 1),
                             sunset_shift_median_h=round(float(np.median(np.abs(shifts))), 1) if shifts else None,
                             sunset_shift_p90_h=round(float(np.percentile(np.abs(shifts), 90)), 1) if shifts else None,
                             sunsets_matched=len(shifts), sunsets_lola=int(len(sl))))
            print(rows[-1], flush=True)
    flat = [r for r in rows if r["slope_deg"] <= 10]
    summary = {
        "points": len(rows), "flat_points": len(flat),
        "sun_pct_abs_diff_median_all": round(float(np.median([abs(r["sun_pct_stereo"] - r["sun_pct_lola"]) for r in rows])), 1),
        "sun_pct_abs_diff_median_flat": round(float(np.median([abs(r["sun_pct_stereo"] - r["sun_pct_lola"]) for r in flat])), 1) if flat else None,
        "skyline_p90_median_flat": round(float(np.median([r["skyline_p90_deg"] for r in flat])), 3) if flat else None,
        "sunsets_pooled": len(pooled),
        "sunset_shift_h_pooled": {q: round(float(np.percentile(pooled, p)), 1) for q, p in [("median", 50), ("p75", 75), ("p90", 90)]},
        "sunset_within_1h_pct": round(100 * float(np.mean(np.array(pooled) <= 1)), 0),
        "sunset_shift_h_pooled_flat": {q: round(float(np.percentile(pooled_flat, p)), 1) for q, p in [("median", 50), ("p75", 75), ("p90", 90)]} if pooled_flat else None,
        "skyline_p90_median_steep": round(float(np.median([r["skyline_p90_deg"] for r in rows if r["slope_deg"] > 10])), 3) if len(flat) < len(rows) else None,
    }
    print(summary)
    OUT.write_text(json.dumps({"checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "summary": summary, "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
