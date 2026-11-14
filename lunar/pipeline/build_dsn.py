"""Which Deep Space Network complex can see the Moon, hour by hour.

Earth above a lander's skyline is not a radio link: a ground antenna must also see the Moon. For every
hour of the ephemeris this writes one byte: bit 0 Goldstone (DSS-14), bit 1 Madrid (DSS-63), bit 2
Canberra (DSS-43) has the Moon's centre at least MIN_EL above its horizon.

Antenna positions: ITRF93 Cartesian coordinates from DSN 810-005 (301 Coverage and Geometry), as carried
in NAIF's earthstns_itrf93 station kernel comments. Earth orientation: IAU_EARTH from pck00011, which
leaves out nutation and polar motion (under 0.01 deg), far below the 10 deg mask.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).parent))
import ephemeris as E  # noqa: E402

MIN_EL = 10.0  # deg, the usual DSN elevation mask
STATIONS = {  # metres, ITRF93
    "Goldstone (DSS-14)": (-2353621.420, -4641341.472, 3677052.318),
    "Madrid (DSS-63)": (4849092.518, -360180.348, 4115109.251),
    "Canberra (DSS-43)": (-4460894.917, 2682361.507, -3674748.152),
}
WGS84_RE, WGS84_F = 6378.137, 1 / 298.257223563


def elevations(unix_s: np.ndarray) -> dict[str, np.ndarray]:
    E.furnish()
    et0 = sp.str2et(np.datetime_as_string(np.datetime64(int(unix_s[0]), "s")) + "Z")
    ets = et0 + (unix_s - unix_s[0])
    moon, _ = sp.spkpos("MOON", ets, "IAU_EARTH", "LT+S", "EARTH")
    moon = np.asarray(moon)
    out = {}
    for name, xyz in STATIONS.items():
        st = np.array(xyz) / 1000.0
        lon, lat, _ = sp.recgeo(st, WGS84_RE, WGS84_F)
        up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
        d = moon - st
        out[name] = np.degrees(np.arcsin(d @ up / np.linalg.norm(d, axis=1)))
    return out


def build(out_dir: Path) -> dict:
    t = E.utc_hours()
    el = elevations(t)
    bits = np.zeros(len(t), np.uint8)
    for k, name in enumerate(STATIONS):
        bits |= ((el[name] >= MIN_EL).astype(np.uint8) << k)
    bits.tofile(out_dir / "dsn.u8")
    any_ = bits > 0
    # longest stretch with no complex in view, as a sanity number
    run = longest = 0
    for v in any_:
        run = 0 if v else run + 1
        longest = max(longest, run)
    meta = {
        "start_unix": float(t[0]), "step_s": 3600, "count": int(len(t)),
        "layout": "uint8 per hour; bit k set when station k sees the Moon's centre at >= min_el_deg",
        "stations": list(STATIONS), "min_el_deg": MIN_EL,
        "share_any_pct": round(100 * float(any_.mean()), 2),
        "share_each_pct": {n: round(100 * float((el[n] >= MIN_EL).mean()), 2) for n in STATIONS},
        "longest_gap_h": int(longest),
        "source": "DSN 810-005 station coordinates (ITRF93) via NAIF earthstns kernel comments; DE440 + pck00011 IAU_EARTH",
    }
    (out_dir / "dsn.json").write_text(json.dumps(meta, indent=2))
    return meta


if __name__ == "__main__":
    print(build(Path(__file__).resolve().parents[1] / "app" / "public" / "data"))
