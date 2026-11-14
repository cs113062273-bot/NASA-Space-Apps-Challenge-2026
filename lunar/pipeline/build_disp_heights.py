"""Touchdown grids at the other panel height, so the touchdown map follows the page's 2 m / 10 m switch.

build_sites.py writes every grid at 2 m (disp/<id>.i16). This recomputes the same points with the observer 10 m
above the ground and writes disp/<id>.h10.i16 (same layout), then lists the heights in sites.json under
dispersion.heights. Usage: build_disp_heights.py [--only id1,id2]
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import build_sites as B  # noqa: E402
from lunar_geo import compute_horizon, destination, latlon_to_xy, xy_to_latlon  # noqa: E402

HEIGHT = 10.0


def _point(args):
    site_id, la, lo = args
    hz = compute_horizon(la, lo, B._dems_for(site_id), observer_m=HEIGHT, n_az=360)
    return np.round(hz.elev_deg * 100).astype(np.int16)


def grid_points(rec):
    """The grid's points in build_sites.py order."""
    d = rec["dispersion"]
    offs = (np.arange(d["n"]) - d["n"] // 2) * d["step_m"]
    if d.get("frame") == "enu":
        E, N = np.meshgrid(offs, offs[::-1])
        la, lo = destination(rec["lat"], rec["lon"], np.arctan2(E, N).ravel(), np.hypot(E, N).ravel())
        return [(rec["id"], float(a), float(b)) for a, b in zip(la, lo)]
    x, y = latlon_to_xy(rec["lat"], rec["lon"])
    pts = []
    for dy in offs[::-1]:
        for dx in offs:
            la, lo = xy_to_latlon(x + dx, y + dy)
            pts.append((rec["id"], float(la), float(lo)))
    return pts


def main(only):
    path = B.OUT / "sites.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    for rec in doc["sites"]:
        if not rec.get("dispersion") or (only and rec["id"] not in only):
            continue
        pts = grid_points(rec)
        with ProcessPoolExecutor(12) as pool:
            hz = list(pool.map(_point, pts, chunksize=8))
        np.stack(hz).astype("<i2").tofile(B.OUT / "disp" / f"{rec['id']}.h10.i16")
        rec["dispersion"]["heights"] = [2, 10]
        path.write_text(json.dumps(doc, allow_nan=False, separators=(",", ":")), encoding="utf-8")  # after each site: resumable
        print(rec["id"], len(pts), flush=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    main(set(args[args.index("--only") + 1].split(",")) if "--only" in args else None)
