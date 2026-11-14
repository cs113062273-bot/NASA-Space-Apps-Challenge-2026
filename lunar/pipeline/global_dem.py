"""Global LOLA terrain in simple cylindrical (lat/lon) projection, for sites outside the polar grids.

Sources (PDS Geosciences Node, LOLA GDR cylindrical):
  LDEM_64   474 m/px at the equator, whole Moon, downloaded once (531 MB)
  LDEM_512  59 m/px, 90 x 45 degree tiles of 2.1 GB each; read here in windows with HTTP range requests
Pixel centres: lat = MAX_LAT - (row + 0.5) / res, lon = WEST_LON + (col + 0.5) / res (PDS label convention).
Heights are DN * 0.5 m above the 1737.4 km sphere, the same datum as the polar grids.
"""
from __future__ import annotations

import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np

from lunar_geo import R0, RAW

BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img"
CACHE = RAW / "ldem512"
_local = threading.local()


def _client() -> httpx.Client:
    if not hasattr(_local, "c"):
        _local.c = httpx.Client(timeout=60)
    return _local.c


@dataclass
class CylDEM:
    """A lat/lon grid (whole globe when `wrap`, else a window). Row 0 is the northernmost."""

    name: str
    heights: np.ndarray
    res: float  # pixels per degree
    lat0: float  # latitude of row 0 centre
    lon0: float  # east longitude of column 0 centre
    factor: float = 0.5
    wrap: bool = False

    @property
    def scale(self) -> float:
        """Metres per pixel along a meridian."""
        return math.radians(1.0) * R0 / self.res

    @classmethod
    def load_global(cls, stem: str, res: int) -> "CylDEM":
        n_rows, n_cols = 180 * res, 360 * res
        dn = np.memmap(RAW / "dem" / f"{stem}.img", dtype="<i2", mode="r", shape=(n_rows, n_cols))
        return cls(stem, dn, res, 90 - 0.5 / res, 0.5 / res, 0.5, wrap=True)

    def _rc(self, lat, lon):
        r = (self.lat0 - np.asarray(lat, dtype=np.float64)) * self.res
        c = (np.asarray(lon, dtype=np.float64) - self.lon0) * self.res
        if self.wrap:
            c = np.mod(c, self.heights.shape[1])
        else:
            c = np.mod(c + 180 * self.res, 360 * self.res) - 180 * self.res  # nearest branch to column 0
        return r, c

    def contains_ll(self, lat, lon, margin: float = 1.0) -> np.ndarray:
        r, c = self._rc(lat, lon)
        rows, cols = self.heights.shape
        ok = (r >= margin) & (r <= rows - 1 - margin)
        if not self.wrap:
            ok &= (c >= margin) & (c <= cols - 1 - margin)
        return ok

    def sample_ll(self, lat, lon) -> np.ndarray:
        """Bilinear height (m); NaN outside a window."""
        r, c = self._rc(lat, lon)
        rows, cols = self.heights.shape
        ok = (r >= 0) & (r <= rows - 1)
        if not self.wrap:
            ok &= (c >= 0) & (c <= cols - 1)
        r = np.clip(r, 0, rows - 1.000001)
        c0f = np.floor(np.clip(c, 0, cols - 1.000001) if not self.wrap else c)
        r0 = np.floor(r).astype(np.int64)
        c0 = c0f.astype(np.int64) % cols
        c1 = (c0 + 1) % cols if self.wrap else np.minimum(c0 + 1, cols - 1)
        fc = (np.clip(c, 0, cols - 1) - c0f if not self.wrap else c - c0f).astype(np.float32)
        fr = (r - r0).astype(np.float32)
        h = self.heights
        top = h[r0, c0] * (1 - fc) + h[r0, c1] * fc
        bot = h[r0 + 1, c0] * (1 - fc) + h[r0 + 1, c1] * fc
        out = (top * (1 - fr) + bot * fr) * np.float32(self.factor)
        return np.where(ok, out, np.nan)


# LDEM_512 tiles: 4 latitude bands x 4 longitude quadrants, 23040 x 46080 int16 each
_BANDS = ["45n_90n", "00n_45n", "45s_00s", "90s_45s"]
_QUADS = ["000_090", "090_180", "180_270", "270_360"]
RES512, TILE_R, TILE_C = 512, 23040, 46080


def _get(client: httpx.Client, url: str, start: int, length: int) -> bytes:
    for attempt in range(8):
        try:
            r = client.get(url, headers={"Range": f"bytes={start}-{start + length - 1}"})
            if r.status_code == 206 and len(r.content) == length:
                return r.content
        except httpx.HTTPError:
            pass
        time.sleep(0.5 * 2 ** attempt)
    raise RuntimeError(f"range read failed: {url} @ {start}")


def ldem512_window(key: str, lat: float, lon: float, half_m: float) -> CylDEM:
    """A +/- half_m window of the 59 m global grid around (lat, lon), stitched across tiles; cached."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{key}.npz"
    if f.exists():
        z = np.load(f)
        return CylDEM(f"LDEM_512[{key}]", z["h"], RES512, float(z["lat0"]), float(z["lon0"]))
    kr = int(math.ceil(half_m / (math.radians(1) * R0 / RES512)))
    kc = int(math.ceil(kr / max(math.cos(math.radians(lat)), 0.05)))
    R = int(round((90 - lat) * RES512 - 0.5))  # global row of the site
    C = int(round((lon % 360) * RES512 - 0.5))
    rows = list(range(R - kr, R + kr + 1))
    cols = np.arange(C - kc, C + kc + 1) % (360 * RES512)
    out = np.zeros((len(rows), len(cols)), np.int16)
    # contiguous column runs within one longitude quadrant -> one range request per row and run
    runs, s = [], 0
    for i in range(1, len(cols) + 1):
        if i == len(cols) or cols[i] != cols[i - 1] + 1 or cols[i] // TILE_C != cols[s] // TILE_C:
            runs.append((s, i))
            s = i

    def read_row(k: int):
        g = rows[k]
        band = _BANDS[g // TILE_R]
        for a, b in runs:
            q = _QUADS[cols[a] // TILE_C]
            url = f"{BASE}/ldem_512_{band}_{q}.img"
            start = ((g % TILE_R) * TILE_C + cols[a] % TILE_C) * 2
            out[k, a:b] = np.frombuffer(_get(_client(), url, start, (b - a) * 2), "<i2")

    with ThreadPoolExecutor(12) as pool:
        list(pool.map(read_row, range(len(rows))))
    lat0 = 90 - (rows[0] + 0.5) / RES512
    lon0 = (C - kc + 0.5) / RES512
    np.savez_compressed(f, h=out, lat0=lat0, lon0=lon0)
    return CylDEM(f"LDEM_512[{key}]", out, RES512, lat0, lon0)
