"""Merge the 1 km inner and 2 km outer average-sunlight grids into one map overlay.

The value grid is resampled to 200 m/px over +/-200 km; inside the inner square the 1 km grid
takes over, blended across its outer 10%. One shared palette; the outer edge fades to clear.
Output: app/public/data/illumination.webp and its entry in basemap.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "public" / "data"
TOP = 0.70  # brightest colour; the 2027 map peaks at 66%, so a higher top would leave colours unused
STOPS = np.array([[0.0, 0, 0, 0, 0], [0.066, 40, 20, 4, 40], [0.206, 140, 80, 14, 150], [0.37, 235, 150, 40, 215],
                  [0.535, 255, 205, 95, 245], [TOP, 255, 246, 214, 255]])
INNER = (ROOT / "data" / "illumination-2027-1km.npy", 75_000.0, 1_000.0)
OUTER = (ROOT / "data" / "illumination_outer-2027-2000m.npy", 200_000.0, 2_000.0)
HALF, PX = 200_000.0, 2000


def sample(grid: np.ndarray, half: float, step: float, X: np.ndarray, Y: np.ndarray) -> np.ndarray:
    """Bilinear lookup of a grid whose row 0 is +half (Y) and column 0 is -half (X)."""
    c = (X + half) / step
    r = (half - Y) / step
    return map_coordinates(grid, [r, c], order=1, mode="nearest")


def edge_weight(X, Y, half, frac=0.10):
    d = half - np.maximum(np.abs(X), np.abs(Y))
    return np.clip(d / (frac * 2 * half), 0, 1)


def main():
    xs = np.linspace(-HALF, HALF, PX)
    X, Y = np.meshgrid(xs, xs[::-1])
    outer = sample(np.load(OUTER[0]), *OUTER[1:], X, Y)
    inner = sample(np.load(INNER[0]), *INNER[1:], X, Y)
    w = edge_weight(X, Y, INNER[1])
    v = w * inner + (1 - w) * outer
    rgba = np.zeros(v.shape + (4,), np.float32)
    for ch in range(4):
        rgba[..., ch] = np.interp(v, STOPS[:, 0], STOPS[:, ch + 1])
    rgba[..., 3] *= edge_weight(X, Y, HALF, 0.04)
    Image.fromarray(rgba.astype(np.uint8), "RGBA").save(OUT / "illumination.webp", quality=88, method=6)
    meta = json.loads((OUT / "basemap.json").read_text())
    meta.pop("illumination_outer", None)
    meta["illumination"] = {"file": "illumination.webp", "half_extent_m": HALF, "px": PX, "m_per_px": 2 * HALF / PX, "period": "2027",
                            "observer_m": 2.0, "grid_m": "1000 within 75 km, 2000 beyond", "max_pct": round(float(v.max()) * 100, 1), "top_pct": TOP * 100}
    (OUT / "basemap.json").write_text(json.dumps(meta, indent=2))
    print("wrote illumination.webp", (OUT / "illumination.webp").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
