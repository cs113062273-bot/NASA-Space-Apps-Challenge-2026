"""Raw values behind the polar map layers, for the map's hover readout.

layers.u8: two 401 x 401 grids (1 km spacing, +/- 200 km, row 0 = +Y, col 0 = -X), one byte per point,
value = share x 200 (255 = no data): average sunlight (1 km grid within 75 km, 2 km beyond) then Earth in view.
Recorded as "layer_values" in basemap.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from color_illumination import INNER, OUTER, edge_weight, sample

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "public" / "data"
EARTH = (ROOT / "data" / "earthvis_polar-2027-2000m.npy", 200_000.0, 2_000.0)
HALF, STEP = 200_000.0, 1_000.0


def main():
    xs = np.arange(-HALF, HALF + 1, STEP)
    X, Y = np.meshgrid(xs, xs[::-1])
    w = edge_weight(X, Y, INNER[1])
    sun = w * sample(np.load(INNER[0]), *INNER[1:], X, Y) + (1 - w) * sample(np.load(OUTER[0]), *OUTER[1:], X, Y)
    earth = sample(np.load(EARTH[0]), *EARTH[1:], X, Y)
    out = np.stack([sun, earth])
    u8 = np.where(np.isfinite(out), np.clip(np.round(out * 200), 0, 200), 255).astype(np.uint8)
    u8.tofile(OUT / "layers.u8")
    meta = json.loads((OUT / "basemap.json").read_text())
    meta["layer_values"] = {"file": "layers.u8", "half_extent_m": HALF, "step_m": STEP, "n": len(xs), "scale": 200, "layers": ["sun", "earth"]}
    (OUT / "basemap.json").write_text(json.dumps(meta, indent=2))
    print("layers.u8", u8.nbytes // 1024, "KB")


if __name__ == "__main__":
    main()
