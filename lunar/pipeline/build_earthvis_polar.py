"""Earth-visibility map of the south polar region (map overlay).

Grid: 2 km spacing within +/- 200 km of the pole. Each point gets its own 360-bin horizon
(80 m + 240 m terrain, 2 m above ground, out to 200 km) and is tested against hourly DE440 Earth
positions for 2027 (with parallax): the value is the share of hours with Earth's centre above the skyline.
Output: data/earthvis_polar-2027-2000m.npy, app/public/data/earthvis_polar.webp, and "earthvis_polar" in basemap.json.
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
from lunar_geo import R0, PolarDEM, compute_horizon, topocentric_azel, xy_to_latlon  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "public" / "data"
HALF, STEP, PX = 200_000.0, 2_000.0, 1000
_DEMS = None
_EARTH = None


def _init():
    global _DEMS, _EARTH
    _DEMS = [PolarDEM.load_pds("ldem_80s_80m"), PolarDEM.load_pds("ldem_75s_240m")]
    meta = json.loads((OUT / "ephemeris.json").read_text())
    eph = np.fromfile(OUT / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    i0 = int((datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp() - meta["start_unix"]) // 3600)
    _EARTH = eph[i0:i0 + 8760, 3:6]


def _point(xy):
    lat, lon = xy_to_latlon(*xy)
    hz = compute_horizon(float(lat), float(lon), _DEMS, observer_m=2.0, n_az=360, d_max=200_000.0)
    az, el = topocentric_azel(float(lat), float(lon), R0 + hz.ground_m + 2.0, _EARTH)
    h = np.interp(az, np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360], np.r_[hz.elev_deg, hz.elev_deg, hz.elev_deg])
    return float((el > h).mean())


def colour(v: np.ndarray) -> Image.Image:
    """Blue ramp, screen-blended over the relief like the sunlight layer: brighter = Earth in view more often."""
    stops = np.array([[0.0, 0, 0, 0, 0], [0.1, 10, 30, 60, 60], [0.35, 30, 90, 170, 160], [0.6, 70, 150, 240, 220], [0.85, 175, 215, 255, 255]])
    rgba = np.zeros(v.shape + (4,), np.float32)
    for ch in range(4):
        rgba[..., ch] = np.interp(v, stops[:, 0], stops[:, ch + 1])
    img = np.asarray(Image.fromarray(rgba.astype(np.uint8), "RGBA").resize((PX, PX), Image.BICUBIC)).copy()
    # fade the square's outer 4% to clear, like the sunlight layer
    xs = np.linspace(-1, 1, PX)
    edge = np.clip((1 - np.maximum(np.abs(xs)[None, :], np.abs(xs)[:, None])) / 0.08, 0, 1)
    img[..., 3] = (img[..., 3] * edge).astype(np.uint8)
    return Image.fromarray(img, "RGBA")


def main():
    if "--colour-only" in sys.argv:  # re-colour the saved grid without recomputing
        colour(np.load(ROOT / "data" / "earthvis_polar-2027-2000m.npy")).save(OUT / "earthvis_polar.webp", quality=88, method=6)
        return
    xs = np.arange(-HALF, HALF + 1, STEP)
    pts = [(x, y) for y in xs[::-1] for x in xs]
    with ProcessPoolExecutor(18, initializer=_init) as pool:
        vals = np.array(list(pool.map(_point, pts, chunksize=64)), dtype=np.float32).reshape(len(xs), len(xs))
    np.save(ROOT / "data" / "earthvis_polar-2027-2000m.npy", vals)
    colour(vals).save(OUT / "earthvis_polar.webp", quality=88, method=6)
    meta = json.loads((OUT / "basemap.json").read_text())
    meta["earthvis_polar"] = {"file": "earthvis_polar.webp", "half_extent_m": HALF + STEP / 2, "px": PX, "m_per_px": (2 * HALF + STEP) / PX,
                              "period": "2027", "observer_m": 2.0, "grid_m": STEP, "max_pct": round(float(vals.max()) * 100, 1)}
    (OUT / "basemap.json").write_text(json.dumps(meta, indent=2))
    print("earthvis_polar: max", vals.max(), "mean", vals.mean(), "share never", float((vals == 0).mean()))


if __name__ == "__main__":
    main()
