"""Precompute terrain horizons for curated sites and landing-dispersion grids around them.

Outputs (app/public/data):
  sites.json            site metadata, sources, horizons at 2 m and 10 m (0.5 deg bins, centi-degrees)
  disp/<id>.i16         dispersion grid: G x G points at STEP m, 360 bins each, centi-degrees (int16 LE)
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fetch_dem20 import fetch  # noqa: E402
from nac import nac_window  # noqa: E402
from global_dem import CylDEM, ldem512_window  # noqa: E402
from lunar_geo import R0, PolarDEM, compute_horizon, destination, disk_fraction_visible, latlon_to_xy, topocentric_azel, xy_to_latlon  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "app" / "public" / "data"
DISP_G, DISP_STEP = 21, 50.0  # +/- 500 m at 50 m spacing
GLOB_G, GLOB_STEP, GLOB_SLOPE_M = 11, 100.0, 120.0  # on the 59 m global grid: coarser points, a two-pixel slope baseline
HEIGHTS = (2.0, 10.0)

SITES = [
    dict(id="im2-actual", name="Athena (IM-2) touchdown", group="Flown", lat=-84.7906, lon=29.1957, nac="NOBILE03",
         date="2025-03-06T17:28:00Z", duration_days=10,
         note="Landed on its side in a small crater; the mission ended about 13 hours after touchdown, against a planned 10 days.",
         source="Touchdown coordinates: Wikipedia / Intuitive Machines (84°47′26″S 29°11′45″E); outcome: Spaceflight Now, 2025-03-07",
         url="https://spaceflightnow.com/2025/03/07/intuitive-machines-im-2-mission-ends-with-lander-on-its-side-on-the-moon/"),
    dict(id="im2-target", name="Athena (IM-2) intended site", group="Flown", lat=-84.78, lon=29.13, nac="NOBILE03",
         date="2025-03-06T17:28:00Z", duration_days=10,
         note="The planned Mons Mouton site, about 370 m from the published touchdown coordinates.",
         source="LROC image 1401, IM-2 Landing Region (Arizona State University)", url="https://www.lroc.asu.edu/images/1401"),
    dict(id="im1", name="Odysseus (IM-1) touchdown", group="Flown", lat=-80.13, lon=1.44,
         date="2024-02-22T23:23:00Z", duration_days=7,
         note="Landed tilted near Malapert A; operations ended as the Sun set on the site.",
         source="NASA, 'NASA's LRO Images Intuitive Machines' Odysseus Lander' (80.13°S, 1.44°E, 2,579 m)",
         url="https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/"),
    dict(id="ch3", name="Chandrayaan-3 Vikram (Statio Shiv Shakti)", group="Flown", lat=-69.373, lon=32.319, nac="VIKRAMSITE1",
         date="2023-08-23T12:33:00Z", duration_days=14,
         note="Operated through one lunar day; did not wake after the lunar night.",
         source="IAU-named landing site Statio Shiv Shakti, 69.373°S 32.319°E (Wikipedia)", url="https://en.wikipedia.org/wiki/Statio_Shiv_Shakti"),
    dict(id="c1", name="Connecting Ridge C1", group="Best-lit", lat=-89.4398, lon=222.83,
         date="2027-01-01T00:00:00Z", duration_days=30,
         note="Most illuminated south-polar point found at 2 m above ground over 2017–2037.",
         source="Gläser et al. (2018) Planet. Space Sci. 162, Table 2 (NASA NTRS 20170007365)",
         url="https://ntrs.nasa.gov/citations/20170007365"),
    dict(id="c2", name="Connecting Ridge C2", group="Best-lit", lat=-89.3130, lon=245.98,
         date="2027-01-01T00:00:00Z", duration_days=30, note="Second ridge location between Shackleton and de Gerlache.",
         source="Gläser et al. (2018) Table 2", url="https://ntrs.nasa.gov/citations/20170007365"),
    dict(id="shackleton", name="Shackleton rim", group="Best-lit", lat=-89.6866, lon=197.19,
         date="2027-01-01T00:00:00Z", duration_days=30, note="High-illumination point on the rim of Shackleton crater.",
         source="Gläser et al. (2018) Table 2", url="https://ntrs.nasa.gov/citations/20170007365"),
    dict(id="nobile-dm2", name="Nobile Rim 2 (site DM2)", group="Artemis III region", lat=-84.20156, lon=60.69989,
         date="2027-01-01T00:00:00Z", duration_days=7,
         note="A point inside NASA's Artemis III candidate region Nobile Rim 2, chosen by a published multi-criteria study.",
         source="Evaluating potential landing sites for the Artemis III mission using a multi-criteria decision making approach, Acta Astronautica (2024)",
         url="https://www.sciencedirect.com/science/article/pii/S0094576524006234"),
    *[
        dict(id=f"a3-{key}", name=name, group="Artemis III region", lat=lat, lon=lon, box_px=box,
             date="2027-06-01T00:00:00Z", duration_days=6.25,
             note="Centre of a NASA Artemis III candidate landing region, digitised from NASA's October 2024 map (about ±3 km). "
                  "A region is 15–30 km across and sunlight varies sharply inside it: use the touchdown grid, or click the map to test other points.",
             source="NASA, Artemis III candidate regions (Oct 2024); George, Rubio, Lawrence & Curell, LPSC 2026 abstract (NTRS 20250011660)",
             url="https://ntrs.nasa.gov/citations/20250011660")
        for key, name, lat, lon, box in [
            ("cabeus-b", "Peak near Cabeus B", -83.897, 291.09, (32, 69, 236, 272)),
            ("haworth", "Haworth", -86.879, 336.93, (276, 330, 189, 243)),
            ("malapert", "Malapert Massif", -86.163, 359.47, (351, 389, 142, 181)),
            ("mouton-plateau", "Mons Mouton Plateau", -84.572, 30.50, (458, 597, 62, 166)),
            ("mouton", "Mons Mouton", -85.642, 31.36, (484, 516, 153, 183)),
            ("nobile-1", "Nobile Rim 1", -85.657, 37.29, (503, 538, 165, 201)),
            ("nobile-2", "Nobile Rim 2", -84.220, 58.60, (632, 669, 190, 226)),
            ("degerlache-2", "de Gerlache Rim 2", -88.279, 294.98, (266, 302, 319, 355)),
            ("slater", "Slater Plain", -87.294, 125.67, (478, 514, 449, 485)),
        ]
    ],
    dict(id="pole", name="South pole (90°S)", group="Reference", lat=-89.9999, lon=0.0,
         date="2027-01-01T00:00:00Z", duration_days=30, note="The geographic pole itself sits low, inside Shackleton's rim region.",
         source="Geometric reference point", url=""),
    dict(id="apollo11", name="Apollo 11 Tranquility Base", group="Apollo", lat=0.67416, lon=23.47314, glob=True, date=None, duration_days=14,
         note="Landed 1969-07-20. Mare Tranquillitatis: a flat mare plain. Default date: a 2027 local morning.",
         source="Lunar Module position: NASA NSSDCA, from LRO images (Wagner et al. 2017, Icarus 283)",
         url="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html"),
    dict(id="apollo12", name="Apollo 12 Ocean of Storms", group="Apollo", lat=-3.0128, lon=336.5781, glob=True, date=None, duration_days=14,
         note="Landed 1969-11-19. Next to Surveyor 3 in Oceanus Procellarum. Default date: a 2027 local morning.",
         source="Lunar Module position: NASA NSSDCA, from LRO images (Wagner et al. 2017, Icarus 283)",
         url="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html"),
    dict(id="apollo14", name="Apollo 14 Fra Mauro", group="Apollo", lat=-3.64589, lon=342.52806, glob=True, date=None, duration_days=14,
         note="Landed 1971-02-05. Fra Mauro highlands, on ejecta from the Imbrium basin. Default date: a 2027 local morning.",
         source="Lunar Module position: NASA NSSDCA, from LRO images (Wagner et al. 2017, Icarus 283)",
         url="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html"),
    dict(id="apollo15", name="Apollo 15 Hadley–Apennine", group="Apollo", lat=26.13239, lon=3.6333, glob=True, date=None, duration_days=14,
         note="Landed 1971-07-30. Between Mons Hadley and Hadley Delta, beside Hadley Rille: the mountains raise the skyline by nearly 14°. Default date: a 2027 local morning.",
         source="Lunar Module position: NASA NSSDCA, from LRO images (Wagner et al. 2017, Icarus 283)",
         url="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html"),
    dict(id="apollo16", name="Apollo 16 Descartes Highlands", group="Apollo", lat=-8.9734, lon=15.5011, glob=True, date=None, duration_days=14,
         note="Landed 1972-04-21. The only Apollo landing in the central highlands. Default date: a 2027 local morning.",
         source="Lunar Module position: NASA NSSDCA, from LRO images (Wagner et al. 2017, Icarus 283)",
         url="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html"),
    dict(id="apollo17", name="Apollo 17 Taurus–Littrow", group="Apollo", lat=20.1911, lon=30.7723, glob=True, date=None, duration_days=14,
         note="Landed 1972-12-11. A valley between massifs about 2 km high: the Sun rises later and sets earlier than on open mare. Default date: a 2027 local morning.",
         source="Lunar Module position: NASA NSSDCA, from LRO images (Wagner et al. 2017, Icarus 283)",
         url="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html"),
    dict(id="slim", name="SLIM (JAXA)", group="Other landers", lat=-13.3160, lon=25.2510, glob=True,
         date="2024-01-19T15:20:00Z", duration_days=14,
         note="Japan's pinpoint lander touched down within about 100 m of its target, but upside down: its solar panels faced west and made power only once the afternoon Sun swung round.",
         source="JAXA SLIM briefing (Dec 2024), landing site from NASA LROC (13.3160°S, 25.2510°E)",
         url="https://www.isas.jaxa.jp/en/topics/files/SLIM-press-briefing-20241226.pdf"),
    dict(id="change6", name="Chang'e 6 (far side)", group="Other landers", lat=-41.6385, lon=206.0148, glob=True,
         date="2024-06-01T22:23:00Z", duration_days=3,
         note="China's far-side sample return in the Apollo basin. Earth never rises here, so every command went through the Queqiao-2 relay satellite.",
         source="NASA LROC landing site (41.6385°S, 206.0148°E)",
         url="https://www.nasa.gov/centers-and-facilities/goddard/nasas-lro-spots-chinas-change-6-spacecraft-on-lunar-far-side"),
    dict(id="change4", name="Chang'e 4 (far side)", group="Other landers", lat=-45.457, lon=177.589, glob=True, date=None, duration_days=14,
         note="First soft landing on the far side (2019), in Von Kármán crater: no direct line of sight to Earth. Default date: a 2027 local morning.",
         source="NASA LROC, Chang'e 4 lander coordinates (45.457°S, 177.589°E)", url="https://www.lroc.asu.edu/posts/1087"),
    dict(id="change5", name="Chang'e 5", group="Other landers", lat=43.0576, lon=308.0839, glob=True, date=None, duration_days=14,
         note="Sample return from Oceanus Procellarum (2020). Default date: a 2027 local morning.",
         source="NASA LROC, First Look: Chang'e 5 (43.0576°N, 308.0839°E)", url="https://www.lroc.asu.edu/posts/1172"),
    dict(id="reiner-gamma", name="Reiner Gamma (IM-3 target region)", group="Upcoming", lat=7.5, lon=301.0, glob=True, date=None, duration_days=14,
         note="Intuitive Machines' IM-3 (NASA CLPS) is to land at this lunar swirl, launch planned for early 2027. The point is the swirl's IAU centre, not the mission's target point. Default date: a 2027 local morning.",
         source="IAU Gazetteer of Planetary Nomenclature, Reiner Gamma (7.5°N, 59.0°W); NASA CLPS / Intuitive Machines",
         url="https://planetarynames.wr.usgs.gov/Feature/4987"),
    dict(id="blue-ghost", name="Blue Ghost M1 (Mare Crisium)", group="Other landers", lat=18.56, lon=61.81, glob=True,
         date="2025-03-02T08:34:00Z", duration_days=16,
         note="Firefly's CLPS lander worked through one full lunar day and went dark on 16 Mar 2025, about five hours into its first night by Firefly's account; with terrain, the Sun's last edge set 3.5 h before last contact. The rest was battery.",
         source="Firefly Aerospace / Space.com, 'Farewell, Blue Ghost' (2025)",
         url="https://www.space.com/the-universe/moon/farewell-blue-ghost-private-moon-lander-goes-dark-to-end-record-breaking-commercial-lunar-mission"),
]


# Artemis III regions: use the best landing point found inside each NASA box (search_regions.py)
_BEST = Path(__file__).resolve().parents[1] / "data" / "region_best.json"
if _BEST.exists():
    _best = json.loads(_BEST.read_text())["regions"]
    for _s in SITES:
        _k = _s["id"].removeprefix("a3-")
        if _s["id"].startswith("a3-") and _k in _best:
            b = _best[_k]
            _s.update(lat=b["lat"], lon=b["lon"],
                      note=f"Sunniest point under 8° slope in NASA's {_s['name']} region box ({b['sun_2027_pct']}% average sunlight in 2027).")

_DEM: dict[str, PolarDEM] = {}


def _dem(stem: str) -> PolarDEM:
    if stem not in _DEM:
        _DEM[stem] = PolarDEM.load_pds(stem)
    return _DEM[stem]


_G64: list[CylDEM] = []


def _dems_for(site_id: str):
    lat = SITE_LL[site_id][0]
    if site_id in SITE_GLOBAL:  # outside the polar grids: 59 m near field + 474 m whole-Moon grid
        if not _G64:
            _G64.append(CylDEM.load_global("ldem_64", 64))
        return [ldem512_window(site_id, *SITE_LL[site_id], 25_000.0), _G64[0]]
    nac = SITE_NAC.get(site_id)
    near = [nac_window(nac, site_id, *SITE_LL[site_id], 3_000.0)] if nac else []
    near = [d for d in near if d is not None]
    if lat < -80.0:  # inside the 20 m / 80 m polar grids
        return near + [fetch(site_id, *SITE_LL[site_id], 10.0), _dem("ldem_80s_80m"), _dem("ldem_75s_240m"), _dem("ldem_60s_240m")]
    return near + [_dem("ldem_75s_240m"), _dem("ldem_60s_240m")]


SITE_LL = {s["id"]: (s["lat"], s["lon"]) for s in SITES}
SITE_NAC = {s["id"]: s["nac"] for s in SITES if s.get("nac")}
SITE_GLOBAL = {s["id"] for s in SITES if s.get("glob")}


SLOPE_BASELINE_M = 40.0


def slope_deg(dems: list[PolarDEM], x: float, y: float, baseline: float = SLOPE_BASELINE_M) -> float:
    """Slope from central differences over a fixed baseline, on the finest grid with data there."""
    s = baseline / 2
    xs, ys = np.array([x + s, x - s, x, x]), np.array([y, y, y + s, y - s])
    for dem in dems:
        h = dem.sample(xs, ys)
        if np.all(np.isfinite(h)):
            break
    return float(np.degrees(np.arctan(np.hypot((h[0] - h[1]) / (2 * s), (h[2] - h[3]) / (2 * s)))))


def slope_ll(dems: list, lat: float, lon: float, baseline: float = SLOPE_BASELINE_M) -> float:
    """Same as slope_deg, on any grid type: heights baseline/2 north, south, east and west of the site."""
    la, lo = destination(lat, lon, np.radians([0.0, 180.0, 90.0, 270.0]), np.full(4, baseline / 2))
    for dem in dems:
        h = dem.sample_ll(la, lo)
        if np.all(np.isfinite(h)):
            break
    return float(np.degrees(np.arctan(np.hypot((h[0] - h[1]) / baseline, (h[2] - h[3]) / baseline))))


def morning_2027(lat: float, lon: float, ground_m: float, elev_deg: np.ndarray, after_h: float = 20.0) -> str:
    """First terrain sunrise (upper limb) after 2027-01-01, plus `after_h` hours: a low morning Sun."""
    meta = json.loads((OUT / "ephemeris.json").read_text())
    eph = np.fromfile(OUT / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    t0 = datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp()
    i0 = int((t0 - meta["start_unix"]) // 3600)
    az, el = topocentric_azel(lat, lon, R0 + ground_m + 2.0, eph[i0:i0 + 24 * 60, 0:3])
    az_bins = (np.arange(len(elev_deg)) + 0.5) * 360 / len(elev_deg)
    hz = np.interp(az, np.r_[az_bins - 360, az_bins, az_bins + 360], np.tile(elev_deg, 3))
    lit = disk_fraction_visible(el, hz, 0.2666) > 0
    k = int(np.argmax(~lit))  # first dark hour, then the first lit hour after it
    k += int(np.argmax(lit[k:]))
    t = meta["start_unix"] + (i0 + k) * 3600 + after_h * 3600
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")


def first_crew_day_2027(lat: float, lon: float, ground_m: float, elev_deg: np.ndarray, stay_h: int = 150, earth_min: float = 0.5,
                        margin_deg: float = 0.1) -> str | None:
    """First 00:00 UTC landing day of 2027 with Sun up for the whole Artemis III stay (6.25 d) and Earth in view half the time,
    still true with the skyline `margin_deg` higher (the typical terrain-model error, validate_skyline_error.py)."""
    meta = json.loads((OUT / "ephemeris.json").read_text())
    eph = np.fromfile(OUT / "ephemeris.f32", dtype="<f4").reshape(-1, 6).astype(np.float64)
    i0 = int((datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp() - meta["start_unix"]) // 3600)
    n = 24 * 365 + stay_h
    az_bins = (np.arange(len(elev_deg)) + 0.5) * 360 / len(elev_deg)
    ext = (np.r_[az_bins - 360, az_bins, az_bins + 360], np.tile(elev_deg + margin_deg, 3))
    saz, sel = topocentric_azel(lat, lon, R0 + ground_m + 2.0, eph[i0:i0 + n, 0:3])
    eaz, eel = topocentric_azel(lat, lon, R0 + ground_m + 2.0, eph[i0:i0 + n, 3:6])
    lit = disk_fraction_visible(sel, np.interp(saz, *ext), 0.2666) > 0
    earth = eel > np.interp(eaz, *ext)
    for d in range(365):
        k = 24 * d
        if lit[k:k + stay_h].all() and earth[k:k + stay_h].mean() >= earth_min:
            return datetime.fromtimestamp(meta["start_unix"] + (i0 + k) * 3600, timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    return None


def _disp_point(args):
    site_id, la, lo = args
    hz = compute_horizon(la, lo, _dems_for(site_id), observer_m=2.0, n_az=360)
    return np.round(hz.elev_deg * 100).astype(np.int16), hz.ground_m


def main(only: set[str] | None = None):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "disp").mkdir(exist_ok=True)
    previous = {}
    if only and (OUT / "sites.json").exists():
        previous = {s["id"]: s for s in json.loads((OUT / "sites.json").read_text(encoding="utf-8"))["sites"]}
    out_sites = []
    for s in SITES:
        if only and s["id"] not in only and s["id"] in previous:
            out_sites.append(previous[s["id"]])  # keep the earlier result
            continue
        rec = dict(s)
        if s.get("flat"):
            flat = [0] * 720
            rec.update(dem="none: flat horizon at 0° (no terrain model at this latitude)", ground_m=0.0, slope_deg=None,
                       horizons={str(int(h)): flat for h in HEIGHTS})
            out_sites.append(rec)
            print(s["id"], "flat", flush=True)
            continue
        dems = _dems_for(s["id"])
        if s.get("glob"):
            rec.pop("glob")
            rec["dem"] = "59 m LOLA near field (25 km) + 474 m whole-Moon far field"
            rec["horizons"] = {}
            for h in HEIGHTS:
                hz = compute_horizon(s["lat"], s["lon"], dems, observer_m=h)
                rec["ground_m"] = round(hz.ground_m, 1)
                rec["horizons"][str(int(h))] = np.round(hz.elev_deg * 100).astype(int).tolist()
            rec["slope_deg"] = round(slope_ll(dems, s["lat"], s["lon"], GLOB_SLOPE_M), 1)
            rec["slope_baseline_m"] = GLOB_SLOPE_M
            offs = (np.arange(GLOB_G) - GLOB_G // 2) * GLOB_STEP
            E, N = np.meshgrid(offs, offs[::-1])  # row 0 = north, col 0 = west
            la, lo = destination(s["lat"], s["lon"], np.arctan2(E, N).ravel(), np.hypot(E, N).ravel())
            pts = [(s["id"], float(a), float(b)) for a, b in zip(la, lo)]
            with ProcessPoolExecutor(12) as pool:
                res_pts = list(pool.map(_disp_point, pts, chunksize=4))
            np.stack([r[0] for r in res_pts]).astype("<i2").tofile(OUT / "disp" / f"{s['id']}.i16")
            rec["dispersion"] = dict(n=GLOB_G, step_m=GLOB_STEP, bins=360, observer_m=2.0, frame="enu",
                                     ground_m=[round(r[1], 1) for r in res_pts],
                                     slope_deg=[round(slope_ll(dems, p[1], p[2], GLOB_SLOPE_M), 1) for p in pts],
                                     slope_baseline_m=GLOB_SLOPE_M, layout="row-major; row 0 = north, col 0 = west")
            if not rec.get("date"):
                rec["date"] = morning_2027(s["lat"], s["lon"], rec["ground_m"], np.array(rec["horizons"]["2"]) / 100)
            out_sites.append(rec)
            print(s["id"], rec["ground_m"], rec["date"], "max skyline", max(rec["horizons"]["2"]) / 100, "slope", rec["slope_deg"], flush=True)
            continue
        if dems[0].name.startswith("NAC_DTM"):
            res = f"{dems[0].scale:.0f} m LROC {dems[0].name} near field (3 km) + LOLA far field"
        elif dems[0].scale == 20:
            res = "20 m near field + 80/240 m far field"
        else:
            res = "240 m (outside the 20 m polar grid)"
        rec["dem"] = res
        rec["horizons"] = {}
        for h in HEIGHTS:
            hz = compute_horizon(s["lat"], s["lon"], dems, observer_m=h)
            rec["ground_m"] = round(hz.ground_m, 1)
            rec["horizons"][str(int(h))] = np.round(hz.elev_deg * 100).astype(int).tolist()
        if s.get("box_px"):
            x1, x2, y1, y2 = s["box_px"]
            rec["region_xy"] = [round((x1 - 372) * 537.6), round((x2 - 372) * 537.6), round((378 - y2) * 537.6), round((378 - y1) * 537.6)]
            del rec["box_px"]
        sx, sy = latlon_to_xy(s["lat"], s["lon"])
        rec["slope_deg"] = round(slope_deg(dems, float(sx), float(sy)), 1)
        rec["slope_baseline_m"] = SLOPE_BASELINE_M
        if s["id"].startswith("a3-") or s["id"] in ("nobile-dm2", "pole"):  # open on a day a crew could land, not in the dark
            hz2 = np.array(rec["horizons"]["2"]) / 100
            rec["date"] = (first_crew_day_2027(s["lat"], s["lon"], rec["ground_m"], hz2)
                           or first_crew_day_2027(s["lat"], s["lon"], rec["ground_m"], hz2, earth_min=0.0) or rec["date"])
        if dems[0].scale <= 20:
            x, y = latlon_to_xy(s["lat"], s["lon"])
            offs = (np.arange(DISP_G) - DISP_G // 2) * DISP_STEP
            pts = []
            for dy in offs[::-1]:  # row 0 = max Y (map up)
                for dx in offs:
                    la, lo = xy_to_latlon(x + dx, y + dy)
                    pts.append((s["id"], float(la), float(lo)))
            with ProcessPoolExecutor(12) as pool:
                res_pts = list(pool.map(_disp_point, pts, chunksize=8))
            grid = np.stack([r[0] for r in res_pts])
            grid.astype("<i2").tofile(OUT / "disp" / f"{s['id']}.i16")
            rec["dispersion"] = dict(n=DISP_G, step_m=DISP_STEP, bins=360, observer_m=2.0,
                                     ground_m=[round(r[1], 1) for r in res_pts],
                                     slope_deg=[round(slope_deg(dems, *map(float, latlon_to_xy(p[1], p[2]))), 1) for p in pts],
                                     layout="row-major; row 0 = +Y (toward the Earth-facing side, lon 0 meridian), col 0 = -X")
        out_sites.append(rec)
        print(s["id"], rec["ground_m"], rec["dem"], flush=True)
    (OUT / "sites.json").write_text(json.dumps({"az_bins": 720, "units": "centidegrees", "sites": out_sites}, allow_nan=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    # usage: build_sites.py [--only id1,id2]  (recompute only those sites; new sites are always computed)
    args = sys.argv[1:]
    sel = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    main(sel)
