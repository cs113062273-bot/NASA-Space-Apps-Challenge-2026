"""Independent check of the DSN contact mask: Moon elevation at each 70 m antenna vs JPL Horizons."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).parent))
import build_dsn as D  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "validation" / "dsn-horizons-crosscheck.json"
TIMES = ["2025-03-06T17:00", "2026-01-15T03:00", "2027-07-01T12:00", "2028-02-10T21:00", "2029-11-20T06:00", "2031-06-01T18:00"]


def horizons_el(lon_deg: float, lat_deg: float, alt_km: float, when: str) -> float:
    params = {
        "format": "json", "COMMAND": "'301'", "CENTER": "'coord@399'", "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon_deg:.6f},{lat_deg:.6f},{alt_km:.4f}'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'",
        "START_TIME": f"'{when}'", "STOP_TIME": f"'{when[:-2]}01'", "STEP_SIZE": "'1m'", "QUANTITIES": "'4'",
        "ANG_FORMAT": "'DEG'", "TIME_TYPE": "'UT'", "APPARENT": "'AIRLESS'",
    }
    r = httpx.get("https://ssd.jpl.nasa.gov/api/horizons.api", params=params, timeout=60)
    r.raise_for_status()
    row = r.json()["result"].split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()[0].split()
    return float(row[-1])


def main() -> None:
    rows = []
    for when in TIMES:
        t = np.array([datetime.fromisoformat(when).replace(tzinfo=timezone.utc).timestamp()])
        ours = D.elevations(t)
        for name, xyz in D.STATIONS.items():
            lon, lat, alt = sp.recgeo(np.array(xyz) / 1000.0, D.WGS84_RE, D.WGS84_F)
            h = horizons_el(np.degrees(lon) % 360, np.degrees(lat), alt, when)
            o = float(ours[name][0])
            rows.append(dict(utc=when, station=name, horizons_el=h, ours_el=round(o, 4), d_el=round(o - h, 4)))
            print(f"{when} {name:20s} H {h:+8.3f}  ours {o:+8.3f}  d {o - h:+.4f}")
    worst = max(abs(r["d_el"]) for r in rows)
    OUT.write_text(json.dumps({"checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "reference": "JPL Horizons API, Moon (301) from geodetic site on Earth, airless",
                               "max_abs_elevation_error_deg": worst, "n": len(rows), "rows": rows}, indent=2))
    print("max |dEl|", worst)


if __name__ == "__main__":
    main()
