"""Terrain patches around curated sites for the first-person 3D view.

Each patch is a 301 x 301 grid at 40 m (+/- 6 km) on the polar stereographic plane, sampled
from the finest terrain available at every point (NAC, 20 m, 80 m, 240 m), stored as int16
decimetres relative to the site's ground height. Row 0 = +Y (toward 0°E), column 0 = -X.
Sites away from the pole (LDEM_512 + LDEM_64) use a local east/north plane instead ("frame": "enu"):
row 0 = north, column 0 = west.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import build_sites as bs  # noqa: E402
from lunar_geo import destination, latlon_to_xy  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "app" / "public" / "data" / "patch"
N, STEP = 301, 40.0


def sample_finest(dems, X, Y):
    h = np.full(X.shape, np.nan, dtype=np.float32)
    todo = np.ones(X.shape, dtype=bool)
    for dem in dems:
        inside = todo & dem.contains(X, Y)
        if inside.any():
            vals = np.full(X.shape, np.nan, dtype=np.float32)
            vals[inside] = dem.sample(X[inside], Y[inside])
            ok = inside & np.isfinite(vals)
            h[ok] = vals[ok]
            todo &= ~ok
    return h


def sample_finest_ll(dems, lat, lon):
    h = np.full(lat.shape, np.nan, dtype=np.float32)
    todo = np.ones(lat.shape, dtype=bool)
    for dem in dems:
        inside = todo & dem.contains_ll(lat, lon)
        if inside.any():
            h[inside] = dem.sample_ll(lat[inside], lon[inside])
            todo &= ~(inside & np.isfinite(h))
    return h


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {}
    offs = (np.arange(N) - N // 2) * STEP
    for s in bs.SITES:
        dems = bs._dems_for(s["id"])
        enu = s["id"] in bs.SITE_GLOBAL
        if enu:
            E, Nn = np.meshgrid(offs, -offs)
            la, lo = destination(s["lat"], s["lon"], np.arctan2(E, Nn), np.hypot(E, Nn))
            h = sample_finest_ll(dems, la, lo)
            h0 = float(sample_finest_ll(dems, np.array([s["lat"]]), np.array([s["lon"]]))[0])
        else:
            cx, cy = latlon_to_xy(s["lat"], s["lon"])
            X, Y = np.meshgrid(cx + offs, cy - offs)
            h = sample_finest(dems, X, Y)
            h0 = float(sample_finest(dems, np.array([cx]), np.array([cy]))[0])
        rel = np.round((h - h0) * 10)
        rel = np.where(np.isfinite(rel), np.clip(rel, -32000, 32000), 0).astype("<i2")
        rel.tofile(OUT / f"{s['id']}.i16")
        meta[s["id"]] = {"n": N, "step_m": STEP, "units": "decimetres relative to site ground", "ground_m": round(h0, 1),
                         "layout": "row 0 = north, col 0 = west" if enu else "row 0 = +Y (0°E side), col 0 = -X",
                         "frame": "enu" if enu else "polar", "source": [d.name for d in dems[:2]]}
        print(s["id"], round(float(np.nanmin(h - h0)), 1), round(float(np.nanmax(h - h0)), 1), flush=True)
    (OUT / "patches.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
