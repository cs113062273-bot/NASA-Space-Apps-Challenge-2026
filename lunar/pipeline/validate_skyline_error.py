"""How far off is a LOLA skyline? Compare it with the sharper LROC NAC stereo terrain where both exist.

The horizon is computed twice at each point: with the NAC stereo model as near field, and with LOLA alone.
The per-azimuth difference is our estimate of the terrain-model error behind every event time; the app turns
it into sunset sensitivity ranges (SKYLINE_ERR_DEG).

- Flown sites: Athena (NOBILE03, 4 m) and Chandrayaan-3 (VIKRAMSITE1, 3 m), at the landing point.
- South-pole ridges and rims: DLR's 2 m models of the Connecting Ridge (ESALL_CR1), Shackleton rim (ESALL_SR12)
  and Malapert peak (ESALL_MP1), at the model's centre and four random points within 1.5 km of it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform

sys.path.insert(0, str(Path(__file__).parent))
import build_sites as B  # noqa: E402
from fetch_dem20 import fetch  # noqa: E402
from lunar_geo import compute_horizon, latlon_to_xy, xy_to_latlon  # noqa: E402
from nac import CACHE, nac_window  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "validation" / "skyline-nac-vs-lola.json"
POLAR_MODELS = ["ESALL_CR1", "ESALL_SR12", "ESALL_MP1"]


def stats(d):
    return dict(median_deg=round(float(np.median(d)), 3), p90_deg=round(float(np.percentile(d, 90)), 3), max_deg=round(float(d.max()), 3))


def flown():
    rows = []
    for sid in ["im2-actual", "ch3"]:
        dems = B._dems_for(sid)
        lat, lon = B.SITE_LL[sid]
        nac = compute_horizon(lat, lon, dems, observer_m=2.0)
        lola = compute_horizon(lat, lon, dems[1:], observer_m=2.0)
        d = np.abs(nac.elev_deg - lola.elev_deg)
        rows.append(dict(site=sid, nac=dems[0].name, nac_m=round(float(dems[0].scale), 1), lola=f"LOLA {dems[1].scale:.0f} m", points=1, **stats(d)))
        print(rows[-1])
    return rows


def polar():
    rows = []
    rng = np.random.default_rng(2026)
    d80, d240 = B._dem("ldem_80s_80m"), B._dem("ldem_75s_240m")
    for product in POLAR_MODELS:
        with rasterio.open(CACHE / f"NAC_DTM_{product}.TIF") as ds:
            b = ds.bounds
            lon, lat = transform(ds.crs, "+proj=longlat +R=1737400 +no_defs", [(b.left + b.right) / 2], [(b.bottom + b.top) / 2])
        cx, cy = latlon_to_xy(lat[0], lon[0])
        pts = [(float(cx), float(cy))] + [(float(cx + dx), float(cy + dy)) for dx, dy in rng.uniform(-1500, 1500, (4, 2))]
        diffs, used = [], 0
        for k, (x, y) in enumerate(pts):
            la, lo = xy_to_latlon(np.array([x]), np.array([y]))
            la, lo = float(la[0]), float(lo[0])
            nac = nac_window(product, f"val_{product}_{k}", la, lo, 2_500.0)
            if nac is None:  # a shadow gap in the stereo model at this point
                continue
            d20 = fetch(f"val_{product}_{k}", la, lo, 10.0)
            with_nac = compute_horizon(la, lo, [nac, d20, d80, d240], observer_m=2.0)
            lola = compute_horizon(la, lo, [d20, d80, d240], observer_m=2.0)
            diffs.append(np.abs(with_nac.elev_deg - lola.elev_deg))
            used += 1
        d = np.concatenate(diffs)
        rows.append(dict(site=product, nac=f"NAC_DTM_{product}", nac_m=2.0, lola="LOLA 20 m", points=used, **stats(d)))
        print(rows[-1])
    return rows


def main():
    rows = flown() + polar()
    OUT.write_text(json.dumps({"observer_m": 2.0, "azimuths": 720, "sites": rows}, indent=2))


if __name__ == "__main__":
    main()
