"""Shaded-relief basemaps of the lunar south pole from LOLA polar DEMs.

overview.png : LDEM_60S_240M resampled, +/-700 km
detail.png   : LDEM_80S_80M resampled, +/-150 km
Both are polar stereographic, +Y (toward 0 deg longitude, the Earth-facing meridian) up.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from lunar_geo import PolarDEM  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "app" / "public" / "data"


def crop(dem: PolarDEM, half_m: float, px: int) -> tuple[np.ndarray, float]:
    xs = np.linspace(-half_m, half_m, px)
    ys = np.linspace(half_m, -half_m, px)
    X, Y = np.meshgrid(xs, ys)
    return dem.sample(X, Y), xs[1] - xs[0]


def hillshade(z: np.ndarray, res: float, az_deg=315.0, alt_deg=35.0, exag=1.0) -> np.ndarray:
    gy, gx = np.gradient(np.nan_to_num(z, nan=np.nanmean(z)) * exag, res)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(shade, 0, 1)


def render(z, res, name, half_m):
    hs = hillshade(z, res)
    zn = (z - np.nanpercentile(z, 1)) / (np.nanpercentile(z, 99) - np.nanpercentile(z, 1))
    zn = np.clip(np.nan_to_num(zn, nan=0.5), 0, 1)
    val = 0.05 + 0.50 * (0.80 * hs + 0.20 * zn)
    img = (np.clip(val, 0, 1) * 255).astype(np.uint8)
    img[np.isnan(z)] = 0
    Image.fromarray(img, "L").save(OUT / f"{name}.jpg", quality=88, optimize=True, progressive=True)
    return {"file": f"{name}.jpg", "half_extent_m": half_m, "px": int(z.shape[0]), "m_per_px": float(res),
            "z_min_m": float(np.nanmin(z)), "z_max_m": float(np.nanmax(z))}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"projection": "south polar stereographic, sphere R=1737.4 km, +Y toward 0°E, +X toward 90°E",
            "source": "NASA LRO LOLA GDR polar DEMs (PDS LRO-L-LOLA-4-GDR-V1.0)"}
    z, res = crop(PolarDEM.load_pds("ldem_60s_240m"), 700_000, 1750)
    meta["overview"] = render(z, res, "overview", 700_000)
    z, res = crop(PolarDEM.load_pds("ldem_80s_80m"), 150_000, 2500)
    meta["detail"] = render(z, res, "detail", 150_000)
    (OUT / "basemap.json").write_text(json.dumps(meta, indent=2))
    print(meta)


if __name__ == "__main__":
    main()
