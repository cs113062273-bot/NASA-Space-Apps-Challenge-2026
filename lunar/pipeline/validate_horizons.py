"""Independent check: our Sun/Earth topocentric az/el vs JPL Horizons (observer on the Moon).

Horizons is queried live once; responses are saved under data/validation so the check is
reproducible offline.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import httpx

sys.path.insert(0, str(Path(__file__).parent))
from lunar_geo import R0, topocentric_azel  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EPH = ROOT / "app" / "public" / "data"
OUT = ROOT / "data" / "validation"

CASES = [  # (label, lat, lon_east)
    ("Shackleton connecting ridge", -89.45, 222.69),
    ("Mons Mouton (IM-2 area)", -84.79, 29.20),
    ("Malapert region", -86.0, 2.7),
    ("IM-1 landing area", -80.13, 1.44),
]
TIMES = ["2025-03-06T17:00", "2026-01-15T00:00", "2027-07-01T12:00", "2029-11-20T06:00", "2031-06-01T18:00"]


def load_eph():
    meta = json.loads((EPH / "ephemeris.json").read_text())
    arr = np.fromfile(EPH / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    return meta, arr


def ours(meta, arr, when: str, lat: float, lon: float, body: str):
    t = datetime.fromisoformat(when).replace(tzinfo=timezone.utc).timestamp()
    i = (t - meta["start_unix"]) / meta["step_s"]
    k = int(np.floor(i))
    f = i - k
    v = arr[k] * (1 - f) + arr[k + 1] * f
    vec = v[0:3] if body == "sun" else v[3:6]
    az, el = topocentric_azel(lat, lon, R0, vec[None, :])
    return float(az[0]), float(el[0])


def horizons(lat: float, lon: float, body: str, when: str) -> tuple[float, float, str]:
    params = {
        "format": "json",
        "COMMAND": "'10'" if body == "sun" else "'399'",
        "CENTER": "'coord@301'",
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon % 360:.6f},{lat:.6f},0'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "START_TIME": f"'{when}'",
        "STOP_TIME": f"'{when[:-2]}01'",
        "STEP_SIZE": "'1m'",
        "QUANTITIES": "'4'",
        "ANG_FORMAT": "'DEG'",
        "TIME_TYPE": "'UT'",
        "APPARENT": "'AIRLESS'",
    }
    r = httpx.get("https://ssd.jpl.nasa.gov/api/horizons.api", params=params, timeout=60)
    r.raise_for_status()
    text = r.json()["result"]
    body_rows = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    parts = body_rows[0].split()
    az, el = float(parts[-2]), float(parts[-1])
    return az, el, text


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    meta, arr = load_eph()
    rows = []
    for label, lat, lon in CASES:
        for when in TIMES:
            for body in ("sun", "earth"):
                haz, hel, raw = horizons(lat, lon, body, when)
                oaz, oel = ours(meta, arr, when, lat, lon, body)
                daz = (oaz - haz + 180) % 360 - 180
                rows.append(dict(site=label, lat=lat, lon=lon, utc=when, body=body,
                                 horizons_az=haz, horizons_el=hel, ours_az=round(oaz, 5), ours_el=round(oel, 5),
                                 d_az=round(daz, 5), d_el=round(oel - hel, 5)))
                print(f"{label:30s} {when} {body:5s} dEl={oel - hel:+.4f} dAz={daz:+.4f} (H el={hel:.3f})")
    worst_el = max(abs(r["d_el"]) for r in rows)
    worst_az = max(abs(r["d_az"]) for r in rows)
    result = {"checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "reference": "JPL Horizons API, observer coord@301 geodetic, airless apparent az/el",
              "max_abs_elevation_error_deg": worst_el, "max_abs_azimuth_error_deg": worst_az,
              "n": len(rows), "rows": rows}
    (OUT / "horizons-crosscheck.json").write_text(json.dumps(result, indent=2))
    print("max |dEl|", worst_el, "max |dAz|", worst_az)


if __name__ == "__main__":
    main()
