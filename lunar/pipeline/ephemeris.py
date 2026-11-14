"""Sun and Earth positions in the lunar MOON_ME frame from JPL DE440 (NAIF SPICE).

Output (hourly, UTC): Sun unit direction and Earth position (km) as seen from the Moon's
centre, apparent (light time + stellar aberration). Topocentric parallax is applied later
per site; for the Sun it is below 0.001 deg and ignored.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as sp

KDIR = Path(__file__).resolve().parents[1] / "data" / "raw" / "kernels"
KERNELS = ["naif0012.tls", "pck00011.tpc", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf", "de440s.bsp"]

START = "2023-01-01T00:00:00"
END = "2032-01-01T00:00:00"


def furnish() -> None:
    sp.kclear()
    for k in KERNELS:
        sp.furnsh(str(KDIR / k))


def utc_hours(start: str = START, end: str = END) -> np.ndarray:
    t0 = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
    t1 = datetime.fromisoformat(end).replace(tzinfo=timezone.utc)
    n = int((t1 - t0).total_seconds() // 3600)
    return t0.timestamp() + 3600.0 * np.arange(n)


def positions(unix_s: np.ndarray, body: str) -> np.ndarray:
    furnish()
    et0 = sp.str2et(datetime.fromtimestamp(float(unix_s[0]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"))
    ets = et0 + (unix_s - unix_s[0])  # ET-UTC offset is constant without leap seconds in range
    pos, _ = sp.spkpos(body, ets, "MOON_ME", "LT+S", "MOON")
    return np.asarray(pos)


def build(out_dir: Path) -> dict:
    t = utc_hours()
    sun = positions(t, "SUN")
    earth = positions(t, "EARTH")
    out_dir.mkdir(parents=True, exist_ok=True)
    np.concatenate([sun, earth], axis=1).astype("<f4").tofile(out_dir / "ephemeris.f32")
    meta = {
        "start_unix": float(t[0]),
        "step_s": 3600,
        "count": int(len(t)),
        "layout": "per sample: sun_km_x, sun_km_y, sun_km_z, earth_km_x, earth_km_y, earth_km_z (float32 LE)",
        "frame": "MOON_ME (DE440 ME421 via moon_de440_250416.tf)",
        "aberration": "LT+S, observer at Moon centre",
        "kernels": KERNELS,
        "source": "NASA/JPL NAIF generic kernels, https://naif.jpl.nasa.gov/pub/naif/generic_kernels/",
    }
    (out_dir / "ephemeris.json").write_text(json.dumps(meta, indent=2))
    return meta


if __name__ == "__main__":
    out = Path(__file__).resolve().parents[1] / "app" / "public" / "data"
    print(build(out))
