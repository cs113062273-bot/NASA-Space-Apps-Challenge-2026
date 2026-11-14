"""External-service comparison of reference-antenna Moon elevation.

Horizons is a separate JPL service (not an independent flight measurement). The comparison
isolates the Earth receiving side; fixed-lander origin corrections are tested separately.
Cached API responses retain their hash and parameters so later EOP updates are not hidden.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import httpx
import numpy as np
import spiceypy as sp

import build_station_ephemeris as B

ROOT = Path(__file__).resolve().parents[1]
TIMES = ["2025-03-06T17:00:00", "2026-11-05T00:00:00", "2027-01-09T21:00:00",
    "2027-07-01T12:00:00", "2029-11-20T06:00:00", "2031-06-01T18:00:00"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="refetch cached Horizons responses")
    args = parser.parse_args()
    B.furnish()
    cache = ROOT / "data/raw/research/station-receivers"
    cache.mkdir(parents=True, exist_ok=True)
    rows = []
    with httpx.Client(timeout=60) as client:
        for when in TIMES:
            et = sp.str2et(when + "Z")
            for body, name, antenna in B.STATIONS:
                station, _ = sp.spkpos(body, et, "ITRF93", "NONE", "EARTH")
                lon, lat, alt = sp.recgeo(station, 6378.137, 1/298.257223563)
                up = np.array([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])
                moon, _ = sp.spkpos("MOON", et, "ITRF93", "CN+S", body)
                ours = float(np.rad2deg(np.arcsin(moon @ up / np.linalg.norm(moon))))
                end = (datetime.fromisoformat(when) + timedelta(minutes=1)).isoformat()
                params = {"format": "json", "COMMAND": "'301'", "CENTER": "'coord@399'", "COORD_TYPE": "'GEODETIC'",
                    "SITE_COORD": f"'{np.rad2deg(lon) % 360:.9f},{np.rad2deg(lat):.9f},{alt:.7f}'",
                    "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'", "START_TIME": f"'{when}'", "STOP_TIME": f"'{end}'",
                    "STEP_SIZE": "'1m'", "QUANTITIES": "'4'", "ANG_FORMAT": "'DEG'", "TIME_TYPE": "'UT'", "APPARENT": "'AIRLESS'"}
                cached = cache / f"{antenna}-{when.replace(':', '')}.json"
                if args.refresh or not cached.exists():
                    response = client.get("https://ssd.jpl.nasa.gov/api/horizons.api", params=params)
                    response.raise_for_status()
                    content = response.json()
                    if "$$SOE" not in content.get("result", ""):
                        raise RuntimeError(content)
                    cached.write_text(json.dumps({"fetched_utc": datetime.now(timezone.utc).isoformat(), "params": params, "response": content}, indent=2), encoding="utf-8")
                saved = json.loads(cached.read_text(encoding="utf-8"))
                if saved["params"] != params:
                    raise RuntimeError(f"Cached parameters changed: use --refresh for {cached.name}")
                row = saved["response"]["result"].split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()[0].split()
                theirs = float(row[-1])
                item = {"utc": when + "Z", "antenna": antenna, "complex": name, "spice_el_deg": ours,
                    "horizons_el_deg": theirs, "delta_deg": ours-theirs,
                    "earth_orientation": "recent" if datetime.fromisoformat(when).replace(tzinfo=timezone.utc).timestamp() < B.PRECISE_UNTIL else "long-term-prediction",
                    "params": params, "response_sha256": hashlib.sha256(cached.read_bytes()).hexdigest(), "fetched_utc": saved["fetched_utc"]}
                rows.append(item)
                print(f"{when} {antenna}: SPICE {ours:+.6f}, Horizons {theirs:+.6f}, delta {ours-theirs:+.6f} deg", flush=True)
    maxes = {kind: max(abs(r["delta_deg"]) for r in rows if r["earth_orientation"] == kind) for kind in ["recent", "long-term-prediction"]}
    report = {"reference": "JPL Horizons API, Moon centre from identical WGS84 reference-antenna coordinates, airless elevation at receive time",
        "scope": "Separate-service Earth receiver check; not independent measured ephemeris truth, terrain or full end-to-end link validation",
        "station_source": "earthstns_itrf93_260814.bsp", "kernel_manifest": "kernels.json",
        "max_abs_error_deg": maxes, "sample_acceptance_deg": {"recent": 0.005, "long-term-prediction": 0.4}, "rows": rows}
    (ROOT / "data/validation/station-receivers-horizons.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(maxes, indent=2))
    assert maxes["recent"] < 0.005 and maxes["long-term-prediction"] < 0.4


if __name__ == "__main__":
    main()
