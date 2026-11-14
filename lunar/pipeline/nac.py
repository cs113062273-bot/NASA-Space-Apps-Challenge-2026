"""LROC NAC stereo DTMs as a high-resolution near field for the horizon engine.

A window around the site is read straight from the PDS GeoTIFF (HTTP range reads through
GDAL /vsicurl/), reprojected onto the LOLA south polar stereographic grid and cached.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.errors import WindowError
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds

from lunar_geo import PolarDEM, latlon_to_xy

CACHE = Path(__file__).resolve().parents[1] / "data" / "raw" / "nac"
PDS = "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM"
POLAR = CRS.from_proj4("+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs")
GEO = CRS.from_proj4("+proj=longlat +R=1737400 +no_defs")
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="2")


def nac_window(product: str, key: str, lat: float, lon: float, half_m: float = 2_500.0) -> PolarDEM | None:
    """NAC DTM `product` (e.g. 'NOBILE03') around (lat, lon) on the polar grid, or None if no data there."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{key}_{product}.npz"
    if path.exists():
        z = np.load(path)
        return PolarDEM(f"NAC_DTM_{product}", z["h"], float(z["scale"]), float(z["x0"]), float(z["y0"]))
    local = CACHE / f"NAC_DTM_{product}.TIF"
    src_url = str(local) if local.exists() else f"/vsicurl/{PDS}/{product}/NAC_DTM_{product}.TIF"
    with rasterio.Env(**ENV), rasterio.open(src_url) as ds:
        res = float(ds.res[0])
        cx, cy = latlon_to_xy(lat, lon)
        n = int(2 * half_m / res) + 1
        dst_transform = from_origin(float(cx) - half_m - res / 2, float(cy) + half_m + res / 2, res, res)
        # read only the source window that covers the destination square (+10% margin)
        corners_x = np.array([cx - half_m, cx + half_m, cx - half_m, cx + half_m], dtype=float) * 1.0
        corners_y = np.array([cy - half_m, cy - half_m, cy + half_m, cy + half_m], dtype=float) * 1.0
        from rasterio.warp import transform as tf
        sx, sy = tf(POLAR, ds.crs, corners_x.tolist(), corners_y.tolist())
        pad = 0.1 * 2 * half_m
        win = from_bounds(min(sx) - pad, min(sy) - pad, max(sx) + pad, max(sy) + pad, ds.transform)
        try:
            win = win.round_offsets().round_lengths().intersection(rasterio.windows.Window(0, 0, ds.width, ds.height))
        except WindowError:
            return None
        src = ds.read(1, window=win).astype(np.float32)
        src[src < -1e30] = np.nan
        dst = np.full((n, n), np.nan, dtype=np.float32)
        reproject(src, dst, src_transform=ds.window_transform(win), src_crs=ds.crs, src_nodata=np.nan,
                  dst_transform=dst_transform, dst_crs=POLAR, dst_nodata=np.nan, resampling=Resampling.bilinear)
    valid = np.isfinite(dst)
    if valid[n // 2 - 2:n // 2 + 3, n // 2 - 2:n // 2 + 3].mean() < 1:
        return None
    x0 = float(cx) - half_m
    y0 = float(cy) + half_m
    np.savez_compressed(path, h=dst, scale=res, x0=x0, y0=y0, product=product, valid_fraction=valid.mean())
    return PolarDEM(f"NAC_DTM_{product}", dst, res, x0, y0)
