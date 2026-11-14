"""Fetch 20 m/pixel LOLA windows around sites with HTTP range reads of LDEM_80S_20M.IMG.

Only the needed byte ranges of the 1.8 GB PDS file are downloaded; each window is cached as
an .npz holding DN-scaled heights and its projected origin.
"""
from __future__ import annotations

import concurrent.futures as cf
import math
import sys
import time
from pathlib import Path

import httpx
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from lunar_geo import PolarDEM, latlon_to_xy  # noqa: E402

URL = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_20m.img"
N, SCALE, FACTOR = 30400, 20.0, 0.5
CACHE = Path(__file__).resolve().parents[1] / "data" / "raw" / "dem20"


def _row(client: httpx.Client, r: int, c1: int, c2: int) -> np.ndarray:
    a = (r * N + c1) * 2
    b = (r * N + c2) * 2 - 1
    for attempt in range(8):
        try:
            resp = client.get(URL, headers={"Range": f"bytes={a}-{b}"}, timeout=60)
            if resp.status_code == 206 and len(resp.content) == b - a + 1:
                return np.frombuffer(resp.content, dtype="<i2")
        except httpx.HTTPError:
            pass
        time.sleep(0.5 * 2 ** attempt)  # back off: the archive throttles bursts
    raise RuntimeError(f"row {r} failed")


def fetch(key: str, lat: float, lon: float, half_km: float = 10.0) -> PolarDEM:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{key}.npz"
    if path.exists():
        z = np.load(path)
        return PolarDEM(key, z["h"], float(z["scale"]), float(z["x0"]), float(z["y0"]))
    x, y = latlon_to_xy(lat, lon)
    x0g = (1 - N / 2 - 0.5) * SCALE
    y0g = -(1 - N / 2 - 0.5) * SCALE
    c = int(round((float(x) - x0g) / SCALE))
    r = int(round((y0g - float(y)) / SCALE))
    k = int(math.ceil(half_km * 1000 / SCALE))
    r1, r2, c1, c2 = max(r - k, 0), min(r + k + 1, N), max(c - k, 0), min(c + k + 1, N)
    rows = list(range(r1, r2))
    out = np.empty((len(rows), c2 - c1), dtype="<i2")
    with httpx.Client(http2=False, limits=httpx.Limits(max_connections=16)) as client:
        with cf.ThreadPoolExecutor(16) as pool:
            for i, arr in enumerate(pool.map(lambda rr: _row(client, rr, c1, c2), rows)):
                out[i] = arr
    h = (out * FACTOR).astype(np.float32)
    x0 = x0g + c1 * SCALE
    y0 = y0g - r1 * SCALE
    np.savez_compressed(path, h=h, scale=SCALE, x0=x0, y0=y0, lat=lat, lon=lon, half_km=half_km)
    return PolarDEM(key, h, SCALE, x0, y0)


if __name__ == "__main__":
    import time

    t = time.time()
    d = fetch("test_c1", -89.4398, 222.83, 2.0)
    print(d.heights.shape, d.heights.min(), d.heights.max(), time.time() - t)
