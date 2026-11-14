"""Compare browser station vectors with full SPICE fixed-lander observers.

This measures the site-origin/float32 approximation, not independent ephemeris truth.
Receiver geometry is evaluated at signal arrival, with moving station positions.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
import spiceypy as sp

import build_station_ephemeris as B

ROOT = Path(__file__).resolve().parents[1]


def frame(lat: float, lon: float, radius: float):
    la, lo = np.deg2rad([lat, lon])
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    return np.array([-np.sin(lo), np.cos(lo), 0]), np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)]), up, radius * up


def azel(v, f):
    e, n, u, _ = f
    return np.array([np.rad2deg(np.arctan2(v @ e, v @ n)) % 360,
        np.rad2deg(np.arctan2(v @ u, np.hypot(v @ e, v @ n))), np.linalg.norm(v)])


def main():
    B.furnish()
    data = ROOT / "app/public/data"
    meta = json.loads((data / "stations.json").read_text())
    raw = (data / "stations.f32").read_bytes()
    assert len(raw) == meta["bytes"] and hashlib.sha256(raw).hexdigest() == meta["sha256"]
    vectors = np.frombuffer(raw, dtype="<f4").reshape(meta["count"], 3, 9)
    sites = json.loads((data / "sites.json").read_text())["sites"]
    chosen = [sites[i] for i in [0, 2, 4, 6, 10, 16]]
    # Include an equatorial and a northern site, plus changing height above the landing surface.
    chosen += [{"id": "equator-test", "lat": 0., "lon": 0., "ground_m": 0.},
               {"id": "north-test", "lat": 89.5, "lon": 180., "ground_m": 5000.}]
    dates = ["2023-01-01T00:00:00Z", "2025-03-06T18:00:00Z", "2026-11-05T00:00:00Z",
        "2027-01-09T21:00:00Z", "2027-01-29T22:00:00Z", "2027-01-30T01:00:00Z",
        "2028-07-01T06:00:00Z", "2031-12-31T20:00:00Z"]
    ets = np.asarray(sp.str2et(dates))
    rows = []
    errors = {"lunar_az_deg": 0., "lunar_el_deg": 0., "receiver_el_deg": 0., "range_km": 0.}
    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "fixed_landers.bsp")
        handle = sp.spkopn(path, "VALIDATION LANDERS", 0)
        frames = []
        for k, site in enumerate(chosen):
            # Existing site JSON uses elevation_m; synthetic sites use ground_m.
            ground = float(site.get("elevation_m", site.get("ground_m", 0)))
            height = 2. if k % 2 == 0 else 10.
            f = frame(site["lat"], site["lon"], 1737.4 + (ground + height) / 1000)
            frames.append((f, ground, height))
            states = np.tile(np.r_[f[3], [0., 0., 0.]], (2, 1))
            first, last = float(ets.min() - 86400), float(ets.max() + 86400)
            sp.spkw08(handle, -990001-k, 301, "MOON_ME", first, last, f"LANDER {k}", 1, 2, states, first, last-first)
        sp.spkcls(handle)
        sp.furnsh(path)
        for k, site in enumerate(chosen):
            f, ground, height = frames[k]
            for date, et in zip(dates, ets):
                unix = datetime.fromisoformat(date.replace("Z", "+00:00")).timestamp()
                index = round((unix - meta["start_unix"]) / meta["step_s"])
                for j, (body, name, antenna) in enumerate(B.STATIONS):
                    row = vectors[index, j].astype(float)
                    approx = azel(row[:3] - f[3], f)
                    target, lt = sp.spkpos(body, float(et), "MOON_ME", "XCN+S", str(-990001-k))
                    exact = azel(target, f)
                    received = float(et + lt)
                    moon, _ = sp.spkpos(str(-990001-k), received, "ITRF93", "CN+S", body)
                    station, _ = sp.spkpos(body, received, "ITRF93", "NONE", "EARTH")
                    lon, lat, _ = sp.recgeo(station, 6378.137, 1/298.257223563)
                    up = np.array([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])
                    exact_el = np.rad2deg(np.arcsin(moon @ up / np.linalg.norm(moon)))
                    receiver = row[3:6] + f[3]
                    approx_el = np.rad2deg(np.arcsin(np.clip(receiver @ row[6:9] / np.linalg.norm(receiver), -1, 1)))
                    deltas = [abs((approx[0]-exact[0]+180)%360-180), abs(approx[1]-exact[1]), abs(approx_el-exact_el), abs(approx[2]-exact[2])]
                    for key, delta in zip(errors, deltas):
                        errors[key] = max(errors[key], float(delta))
                    rows.append({"site": site["id"], "lat": site["lat"], "lon": site["lon"], "ground_m": ground, "observer_m": height,
                        "utc": date, "index": index, "station": j, "antenna": antenna,
                        "exact": {"az_deg": float(exact[0]), "el_deg": float(exact[1]), "receiver_el_deg": float(exact_el), "range_km": float(exact[2])}})
        sp.unload(path)
    report = {"method": "Complete fixed-lander SPK as observer/target; XCN+S station at emission and CN+S lander at reception; WGS84 geodetic zenith in ITRF93",
        "scope": "Numerical approximation cross-check against the same kernels; not independent validation of Earth-orientation prediction or terrain",
        "station_sha256": meta["sha256"], "samples": len(rows), "max_abs_error": errors,
        # 0.25 km is <0.00001 dB free-space-loss error at lunar distance. Angular
        # tolerance is deliberately much tighter than the terrain sensitivity shift.
        "acceptance": {"angles_deg": 0.0002, "range_km": 0.25}, "cases": rows}
    out = ROOT / "data/validation/station-geometry-crosscheck.json"
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "cases"}, indent=2))
    assert max(errors[k] for k in ["lunar_az_deg", "lunar_el_deg", "receiver_el_deg"]) <= 0.0002
    assert errors["range_km"] <= 0.25


if __name__ == "__main__":
    main()
