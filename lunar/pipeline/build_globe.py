"""Whole-Moon map layers (simple cylindrical, lon -180..180, lat 90..-90).

globe.jpg     shaded relief from LOLA LDEM_16 (1.9 km/px), 2048 x 1024
earthvis.webp share of 2027 with Earth's centre above a flat horizon (every 2 h, DE440, with parallax),
              blue alpha = share^0.8 x 150/255; the libration band where Earth is only sometimes in view stands out
(--colour-only re-colours the saved grid without recomputing)
Both are recorded under "globe" in basemap.json.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from global_dem import CylDEM  # noqa: E402
from lunar_geo import R0  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "app" / "public" / "data"
W, H = 2048, 1024


def relief() -> None:
    g = CylDEM.load_global("ldem_16", 16)
    h = np.asarray(g.heights, dtype=np.float32) * g.factor
    h = np.roll(h, h.shape[1] // 2, axis=1)  # columns 0..360E -> -180..180
    lat = np.radians(90 - (np.arange(h.shape[0]) + 0.5) / 16)[:, None]
    step = np.radians(1 / 16) * R0
    dzdx = np.gradient(h, axis=1) / (step * np.maximum(np.cos(lat), 0.02))
    dzdy = -np.gradient(h, axis=0) / step  # northward
    az, alt = np.radians(300.0), np.radians(35.0)  # light from the north-west
    nx, ny, nz = -dzdx, -dzdy, np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + 1)
    shade = (nx * np.sin(az) * np.cos(alt) + ny * np.cos(az) * np.cos(alt) + nz * np.sin(alt)) / norm
    shade = np.clip(shade, 0, 1)
    elev = (h - np.percentile(h, 1)) / (np.percentile(h, 99) - np.percentile(h, 1))
    v = 0.10 + 0.50 * shade ** 1.2 + 0.38 * np.clip(elev, 0, 1) ** 0.8  # low maria read dark, highlands bright
    img = Image.fromarray((np.clip(v, 0, 1) * 255).astype(np.uint8), "L").resize((W, H), Image.LANCZOS)
    img.convert("RGB").save(OUT / "globe.jpg", quality=84, optimize=True, progressive=True)


def earth_visibility() -> np.ndarray:
    meta = json.loads((OUT / "ephemeris.json").read_text())
    eph = np.fromfile(OUT / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    i0 = int((datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp() - meta["start_unix"]) // 3600)
    earth = eph[i0:i0 + 8760:2, 3:6]  # km, MOON_ME
    lat = np.radians(90 - (np.arange(180) + 0.5))
    lon = np.radians(-180 + (np.arange(360) + 0.5))
    LA, LO = np.meshgrid(lat, lon, indexing="ij")
    up = np.stack([np.cos(LA) * np.cos(LO), np.cos(LA) * np.sin(LO), np.sin(LA)], -1).reshape(-1, 3)
    site = up * (R0 / 1000)
    seen = np.zeros(len(up))
    for e in earth:  # sin(elevation) = (E - site) . up / |E - site|
        v = e[None, :] - site
        seen += (np.einsum("ij,ij->i", v, up) > 0)
    return (seen / len(earth)).reshape(180, 360)


def colour(frac: np.ndarray) -> Image.Image:
    up = np.kron(frac, np.ones((4, 4)))  # 1 deg -> 0.25 deg, then smooth when resized
    img = Image.fromarray((up * 255).astype(np.uint8), "L").resize((W, H), Image.BILINEAR)
    f = np.asarray(img, dtype=np.float32) / 255
    rgba = np.zeros(f.shape + (4,), np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = 90, 169, 255
    # stronger blue where Earth is up more of the time, clear where it never rises (same sense as the polar layer)
    rgba[..., 3] = (np.clip(f, 0, 1) ** 0.8 * 150).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def main():
    if "--colour-only" in sys.argv:
        colour(np.load(Path(__file__).resolve().parents[1] / "data" / "earthvis-2027-1deg.npy")).save(OUT / "earthvis.webp", quality=90, method=6)
        return
    relief()
    frac = earth_visibility()
    colour(frac).save(OUT / "earthvis.webp", quality=90, method=6)
    np.save(Path(__file__).resolve().parents[1] / "data" / "earthvis-2027-1deg.npy", frac)
    meta = json.loads((OUT / "basemap.json").read_text())
    meta["globe"] = {"relief": "globe.jpg", "earthvis": "earthvis.webp", "px": [W, H], "lon_range": [-180, 180], "lat_range": [90, -90],
                     "relief_source": "LOLA LDEM_16 (1.9 km/px)", "earthvis_period": "2027, every 2 h, flat horizon",
                     "always_pct": round(float((frac >= 0.999).mean()) * 100, 1), "never_pct": round(float((frac <= 0.001).mean()) * 100, 1)}
    (OUT / "basemap.json").write_text(json.dumps(meta, indent=2))
    print("globe written; Earth always up on", meta["globe"]["always_pct"], "% of the surface, never on", meta["globe"]["never_pct"], "%")


if __name__ == "__main__":
    main()
