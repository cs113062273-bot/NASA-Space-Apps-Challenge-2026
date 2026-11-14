"""Reference 34 m station targets and receiver geometry for arbitrary lunar surface sites.

Targets use official moving-station SPKs in ITRF93 and XCN+S transmission corrections from the
Moon centre. Receiver vectors use CN+S at arrival; both are expressed in MOON_ME at emission.
The browser applies lander position to each vector. validate_station_geometry.py compares that
small-origin approximation with complete SPICE lander-observer SPKs, including receiver parallax.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
import spiceypy as sp

import ephemeris as E
import fetch_kernels as K

ROOT = Path(__file__).resolve().parents[1]
EXTRA_KERNELS = ["earth_1962_260806_2126_combined.bpc", "earth_000101_270129_261103.bpc", "earthstns_itrf93_260814.bsp"]
STATIONS = [("399024", "Goldstone", "DSS-24"), ("399054", "Madrid", "DSS-54"), ("399034", "Canberra", "DSS-34")]
PRECISE_UNTIL = datetime(2027, 1, 30, tzinfo=timezone.utc).timestamp()


def furnish() -> None:
    manifest = json.loads(K.MANIFEST.read_text(encoding="utf-8"))
    for name in E.KERNELS + EXTRA_KERNELS:
        expected = manifest["kernels"][name]
        if K.digest(E.KDIR / name) != expected["sha256"]:
            raise ValueError(f"Kernel provenance mismatch: {name}; run fetch_kernels.py --verify")
    E.furnish()
    for name in EXTRA_KERNELS:
        sp.furnsh(str(E.KDIR / name))


def vectors(ets: np.ndarray) -> np.ndarray:
    out = np.empty((len(ets), 3, 9), dtype="<f4")
    for k, (body, _, _) in enumerate(STATIONS):
        target, lt = sp.spkpos(body, ets, "MOON_ME", "XCN+S", "MOON")
        received = ets + np.asarray(lt)
        moon, _ = sp.spkpos("MOON", received, "ITRF93", "CN+S", body)
        station, _ = sp.spkpos(body, received, "ITRF93", "NONE", "EARTH")
        out[:, k, :3] = target
        for j, (emit, receive) in enumerate(zip(ets, received)):
            lon, lat, _ = sp.recgeo(station[j], 6378.137, 1 / 298.257223563)
            up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
            rotation = sp.pxfrm2("ITRF93", "MOON_ME", float(receive), float(emit))
            out[j, k, 3:6] = rotation @ moon[j]
            out[j, k, 6:9] = rotation @ up
    return out


def main() -> None:
    furnish()
    data = ROOT / "app" / "public" / "data"
    times = E.utc_hours()
    out = np.empty((len(times), 3, 9), dtype="<f4")
    for a in range(0, len(times), 2016):
        chunk = times[a:a + 2016]
        ets = sp.str2et([datetime.fromtimestamp(u, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") for u in chunk])
        out[a:a + len(chunk)] = vectors(np.asarray(ets))
        print(f"Built {a + len(chunk)}/{len(times)} station epochs", flush=True)
    filename = "stations.f32"
    out.tofile(data / filename)
    sha = hashlib.sha256((data / filename).read_bytes()).hexdigest()
    metadata = {"schema": 1, "start_unix": float(times[0]), "step_s": 3600, "count": len(times),
        "filename": filename, "bytes": out.nbytes, "sha256": sha, "stride": 27,
        "layout": "float32 LE; each epoch: 3 stations x [target xyz km, receiver-to-Moon xyz km, receiver zenith unit xyz]; MOON_ME at emission",
        "stations": [{"id": body, "complex": name, "antenna": antenna} for body, name, antenna in STATIONS],
        "method": "NAIF moving-station SPK; XCN+S from Moon centre; CN+S from station at reception; pxfrm2 ITRF93(reception) to MOON_ME(emission); site-origin corrections in browser",
        "kernels": E.KERNELS + EXTRA_KERNELS, "kernel_manifest": "lunar/data/validation/kernels.json",
        "earth_orientation": {"last_datum_utc": "2026-11-03T00:00:00Z", "recent_kernel_until_unix": PRECISE_UNTIL,
            "recent_ground_stress_deg": 0.001, "long_term_ground_stress_deg": 0.35,
            "recent_aim_stress_deg": 0.00002, "long_term_aim_stress_deg": 0.006,
            "note": "After recent-kernel coverage, uses low-accuracy long-term Earth prediction; stress values are engineering sensitivity inputs motivated by NAIF's 5-6 mrad orientation estimate, not confidence bounds."},
        "limitations": ["One named reference 34 m antenna per complex, not every antenna", "Earth orientation after the recent-kernel interval is low-accuracy prediction",
            "Receiver horizon uses a 10 degree geometric mask, not azimuth-dependent local masks or cable wraps", "No booking, weather or station hardware/configuration validity guarantee",
            "Small site-origin/light-time and differential-aberration approximation is validated separately"]}
    (data / "stations.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {filename}: {out.nbytes:,} bytes; SHA256 {sha}", flush=True)


if __name__ == "__main__":
    main()
