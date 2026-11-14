"""Terrain tiles for in-browser horizon computation at any south-polar point.

near/<row>_<col>.i16z : LDEM_80S_80M in 200 x 200 tiles (int16 DN, 0.5 m units), gzip
far.i16z              : LDEM_75S_240M block-averaged to 480 m (int16 DN), gzip
globe/<row>_<col>.i16z: LDEM_16 (1.9 km, whole Moon) in 15 x 15 degree tiles, for custom sites anywhere else
terrain.json          : grid geometry  (--globe rebuilds only the whole-Moon tiles)
The .i16z extension keeps static servers from adding Content-Encoding; the browser
inflates with DecompressionStream.
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from global_dem import CylDEM  # noqa: E402
from lunar_geo import PolarDEM  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "app" / "public" / "data" / "terrain"
TILE = 200


def write(path: Path, arr: np.ndarray) -> int:
    """Row-delta encode (first column raw, then differences) and gzip; terrain deltas are small."""
    a = np.asarray(arr, dtype=np.int16)
    delta = a.copy()
    delta[:, 1:] = np.diff(a, axis=1)  # int16 wraparound is reversed exactly by cumulative int16 addition
    data = gzip.compress(np.ascontiguousarray(delta, dtype="<i2").tobytes(), compresslevel=9, mtime=0)
    path.write_bytes(data)
    return len(data)


def globe_tiles(meta: dict) -> None:
    g = CylDEM.load_global("ldem_16", 16)
    (OUT / "globe").mkdir(parents=True, exist_ok=True)
    t, rows, cols = 240, 12, 24  # 15 degrees at 16 px/deg
    total = sum(write(OUT / "globe" / f"{r}_{c}.i16z", g.heights[r * t:(r + 1) * t, c * t:(c + 1) * t]) for r in range(rows) for c in range(cols))
    # pixel centres: lat = 90 - (row + 0.5) / res, lon = (col + 0.5) / res, rows and cols counted over the whole globe
    meta["globe"] = {"source": "LDEM_16 (1.9 km/px)", "res": 16, "tile": t, "rows": rows, "cols": cols, "m_per_px": round(g.scale, 1)}
    meta["bytes"]["globe_total"] = total


def main():
    if "--globe" in sys.argv:
        meta = json.loads((OUT / "terrain.json").read_text())
        globe_tiles(meta)
        (OUT / "terrain.json").write_text(json.dumps(meta, indent=2))
        print(meta["globe"], meta["bytes"])
        return
    (OUT / "near").mkdir(parents=True, exist_ok=True)
    near = PolarDEM.load_pds("ldem_80s_80m")
    n = near.heights.shape[0]
    tiles = (n + TILE - 1) // TILE
    total = 0
    for r in range(tiles):
        for c in range(tiles):
            block = np.asarray(near.heights[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE])
            if block.shape != (TILE, TILE):
                pad = np.zeros((TILE, TILE), dtype=np.int16)
                pad[: block.shape[0], : block.shape[1]] = block
                block = pad
            total += write(OUT / "near" / f"{r}_{c}.i16z", block)
    far = PolarDEM.load_pds("ldem_75s_240m")
    m = (far.heights.shape[0] // 2) * 2
    f = np.asarray(far.heights[:m, :m], dtype=np.float32).reshape(m // 2, 2, m // 2, 2).mean(axis=(1, 3))
    far_bytes = write(OUT / "far.i16z", np.round(f).astype(np.int16))
    meta = {
        "factor": 0.5,
        "encoding": "int16 LE, row-delta (x[0], x[1]-x[0], ...), gzip",
        "near": {"source": "LDEM_80S_80M", "scale": near.scale, "x0": near.x0, "y0": near.y0, "n": n, "tile": TILE, "tiles": tiles},
        "far": {"source": "LDEM_75S_240M averaged 2x2", "scale": far.scale * 2, "x0": far.x0 + far.scale / 2, "y0": far.y0 - far.scale / 2, "n": m // 2},
        "bytes": {"near_total": total, "far": far_bytes},
    }
    globe_tiles(meta)
    (OUT / "terrain.json").write_text(json.dumps(meta, indent=2))
    print(meta)


if __name__ == "__main__":
    main()
