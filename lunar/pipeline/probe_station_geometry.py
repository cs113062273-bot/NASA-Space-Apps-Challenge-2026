"""Quantify the gap between Earth-centre terrain clearance and individual Earth-station targets.

Diagnostic, not a new flight-validation result. Keeps the shipped complex masks and lunar DEM
skylines, and changes only the lunar-side target direction using NAIF SPICE transmission geometry.
Station coordinates are the existing DSS-14/63/43 proxies, not 34 m antenna-specific coordinates.
Run fetch_kernels.py first. Output is intentionally separate from validated Horizons comparisons.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path

import numpy as np
import spiceypy as sp

import ephemeris as E
from build_dsn import STATIONS

ROOT = Path(__file__).resolve().parents[1]
SITE_IDS = ["c1", "shackleton", "a3-haworth", "a3-degerlache-2", "a3-nobile-2", "change4"]


def azel(vector: np.ndarray, frame: np.ndarray, position: np.ndarray) -> tuple[float, float]:
    east, north, up = frame @ (vector - position)
    return float(np.degrees(np.arctan2(east, north)) % 360), float(np.degrees(np.arctan2(up, np.hypot(east, north))))


def skyline(horizon: np.ndarray, azimuth: float) -> float:
    k = azimuth / 360 * len(horizon) - 0.5
    a = int(np.floor(k))
    f = k - a
    return float((horizon[a % len(horizon)] * (1 - f) + horizon[(a + 1) % len(horizon)] * f) / 100)


def main() -> None:
    E.furnish()
    data = ROOT / "app" / "public" / "data"
    meta = json.loads((data / "ephemeris.json").read_text())
    vectors = np.fromfile(data / "ephemeris.f32", dtype="<f4").reshape((-1, 6))
    masks = np.fromfile(data / "dsn.u8", dtype=np.uint8)
    sites = json.loads((data / "sites.json").read_text())["sites"]
    times = E.utc_hours("2027-01-01T00:00:00", "2027-02-01T00:00:00")
    indices = ((times - meta["start_unix"]) / meta["step_s"]).astype(int)
    targets = np.empty((len(times), 3, 3))
    for i, unix in enumerate(times):
        et = sp.str2et(datetime.fromtimestamp(unix, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        for station, xyz in enumerate(STATIONS.values()):
            state, _ = sp.spkcpt(np.array(xyz) / 1000, "EARTH", "IAU_EARTH", et, "MOON_ME", "OBSERVER", "XLT+S", "MOON")
            targets[i, station] = state[:3]
    results = []
    for site in (s for s in sites if s["id"] in SITE_IDS):
        la, lo = np.radians([site["lat"], site["lon"]])
        up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
        position = up * (1737.4 + (site["ground_m"] + 2) / 1000)
        frame = np.array([[-np.sin(lo), np.cos(lo), 0],
            [-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)], up])
        horizon = np.array(site["horizons"]["2"])
        count = center_only = station_only = 0
        differences = []
        examples = []
        for i, idx in enumerate(indices):
            ca, ce = azel(vectors[idx, 3:], frame, position)
            center_clear = ce - skyline(horizon, ca)
            for station, name in enumerate(STATIONS):
                if not (int(masks[idx]) & (1 << station)):
                    continue
                sa, se = azel(targets[i, station], frame, position)
                station_clear = se - skyline(horizon, sa)
                differences.append(station_clear - center_clear)
                count += 1
                c, s = center_clear >= 0, station_clear >= 0
                center_only += int(c and not s)
                station_only += int(s and not c)
                if c != s and len(examples) < 3:
                    examples.append({"utc": datetime.fromtimestamp(times[i], timezone.utc).isoformat(), "station": name,
                        "center_clearance_deg": round(center_clear, 5), "station_clearance_deg": round(station_clear, 5)})
        results.append({"site": site["id"], "name": site["name"], "eligible_station_hours": count,
            "earth_center_pass_station_fail": center_only, "earth_center_fail_station_pass": station_only,
            "max_abs_clearance_change_deg": round(float(np.max(np.abs(differences))), 5), "examples": examples})
    output = {"purpose": "Model-gap diagnostic, not independent ground truth or flight validation",
        "period_utc": ["2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z"], "step_s": 3600,
        "method": "Shipped Earth-centre LT+S vectors vs SPICE spkcpt XLT+S station targets; 2 m viewpoint and shipped complex visibility mask",
        "limitations": ["DSS-14/63/43 70 m complex proxies, not 34 m coordinates", "IAU_EARTH orientation, without measured EOP",
            "Same terrain and sampling in both cases; no new terrain validation", "Earth-centre optical LT+S vs transmit XLT+S includes both target-location and aberration differences"],
        "kernels_manifest": "kernels.json", "results": results}
    path = ROOT / "data" / "validation" / "station-geometry-gap.json"
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
