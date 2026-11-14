"""Average-sunlight map of the south polar region (map overlay).

Grid: 1 km spacing within +/- 75 km of the pole; each point gets its own 360-bin horizon
(80 m + 240 m terrain, 2 m above ground) and is illuminated with hourly DE440 Sun positions
for calendar year 2027. Output: a colour PNG with alpha (bright = sunnier) and the raw grid.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from lunar_geo import R0, PolarDEM, compute_horizon, disk_fraction_visible, topocentric_azel, xy_to_latlon  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "app" / "public" / "data"
HALF, STEP, NAME = 75_000.0, 1_000.0, "illumination"
if len(sys.argv) > 1 and sys.argv[1] == "--outer":  # wider, coarser layer drawn underneath the inner one
    HALF, STEP, NAME = 200_000.0, 2_000.0, "illumination_outer"
_DEMS = None
_SUN = None


def _init():
    global _DEMS, _SUN
    _DEMS = [PolarDEM.load_pds("ldem_80s_80m"), PolarDEM.load_pds("ldem_75s_240m")]
    meta = json.loads((OUT / "ephemeris.json").read_text())
    eph = np.fromfile(OUT / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    t0 = datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp()
    i0 = int((t0 - meta["start_unix"]) // 3600)
    _SUN = eph[i0:i0 + 8760, 0:3]


def _point(xy):
    x, y = xy
    lat, lon = xy_to_latlon(x, y)
    hz = compute_horizon(float(lat), float(lon), _DEMS, observer_m=2.0, n_az=360, d_max=200_000.0)
    az, el = topocentric_azel(float(lat), float(lon), R0 + hz.ground_m + 2.0, _SUN)
    h = np.interp(az, np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360], np.r_[hz.elev_deg, hz.elev_deg, hz.elev_deg])
    return float(disk_fraction_visible(el, h, 0.2666).mean())


def colour(v: np.ndarray) -> np.ndarray:
    stops = np.array([[0.0, 0, 0, 0, 0], [0.15, 60, 30, 5, 70], [0.4, 170, 100, 20, 170], [0.65, 255, 190, 70, 225], [0.9, 255, 246, 214, 255]])
    out = np.zeros(v.shape + (4,), dtype=np.float32)
    for ch in range(4):
        out[..., ch] = np.interp(v, stops[:, 0], stops[:, ch + 1])
    return out.astype(np.uint8)


def main():
    xs = np.arange(-HALF, HALF + 1, STEP)
    pts = [(x, y) for y in xs[::-1] for x in xs]
    with ProcessPoolExecutor(16, initializer=_init) as pool:
        vals = np.array(list(pool.map(_point, pts, chunksize=64)), dtype=np.float32).reshape(len(xs), len(xs))
    np.save(OUT.parent.parent.parent / "data" / f"{NAME}-2027-{int(STEP)}m.npy", vals)
    img = Image.fromarray(colour(vals), "RGBA").resize((900, 900), Image.BICUBIC)
    img.save(OUT / f"{NAME}.png", optimize=True)
    meta = json.loads((OUT / "basemap.json").read_text())
    meta[NAME] = {"file": f"{NAME}.png", "half_extent_m": HALF + STEP / 2, "px": 900, "m_per_px": (2 * HALF + STEP) / 900,
                  "period": "2027", "observer_m": 2.0, "grid_m": STEP, "max_pct": round(float(vals.max()) * 100, 1)}
    (OUT / "basemap.json").write_text(json.dumps(meta, indent=2))
    print("max", vals.max(), "mean", vals.mean())


if __name__ == "__main__":
    main()
