"""Does a LOLA skyline give the right mission PASS / FAIL? Check the whole decision, not just average sunlight.

validate_skyline_effect.py showed that annual sunlight shares agree with 2 m stereo terrain but single polar
sunsets can move by hours. Planners care about neither directly: they ask whether a given landing day meets the
mission's rules. So here, at the same 16 points (15 on DLR's 2 m south-pole stereo models, plus the Athena landing
point on the 4 m NOBILE03 model), every 2027 landing day is checked against the app's requirement presets with:

  - LOLA        the horizon the app uses (LOLA 20 / 80 / 240 m), hourly, like the app;
  - LOLA +0.1°  the same skyline raised 0.1°, the app's "still passes with the skyline 0.1° higher" test;
  - stereo      the horizon with the 2-4 m stereo model as near field, sampled every 10 minutes (the reference);
  - LOLA 10 min the app's horizon at 10-minute steps, to separate the time-step effect from the terrain effect.

For each preset we report how often the LOLA verdict matches the stereo verdict, the two kinds of disagreement,
how many passing days each point gets in the year under each horizon, and whether "passes with the skyline 0.1°
higher" really marks the days that stereo terrain confirms. Each terrain uses its own 40 m-baseline slope.
Earth's eclipse of the Sun is included, including partial eclipse together with terrain hiding the solar disk.
The curated C1 and Shackleton sites are checked separately wherever the cached stereo models cover them.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).parent))
import build_sites as B  # noqa: E402
from ephemeris import furnish  # noqa: E402
from lunar_geo import PolarDEM, R0, compute_horizon, latlon_to_xy, topocentric_azel, unit_vector, xy_to_latlon  # noqa: E402
from nac import nac_window  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
NAC = ROOT / "data" / "raw" / "nac"
DEM20 = ROOT / "data" / "raw" / "dem20"
OUT = ROOT / "data" / "validation" / "mission-effect.json"
SUN_RADIUS_KM = 696_000.0
DAYS = 365
STEP_MIN = 10
SHIFT = 0.1

# the app's presets (app/src/App.tsx REQ_PRESETS) with the stay each one is used with
PRESETS = {
    "Artemis III crew": dict(stay_h=150, daylight_h=150, dark_h=0, earth_pct=50, max_slope_deg=8),
    "No-night lander": dict(stay_h=240, daylight_h=240, dark_h=0, earth_pct=60, max_slope_deg=8),
    "Default (14-day stay)": dict(stay_h=336, daylight_h=168, dark_h=50, earth_pct=40, max_slope_deg=10),
    "Hardened (14-day stay)": dict(stay_h=336, daylight_h=72, dark_h=100, earth_pct=30, max_slope_deg=15),
}


def bodies():
    furnish()
    n = (DAYS + 15) * 24 * 60 // STEP_MIN
    ets = sp.str2et("2027-01-01T00:00:00") + 60.0 * STEP_MIN * np.arange(n)
    sun, _ = sp.spkpos("SUN", ets, "MOON_ME", "LT+S", "MOON")
    earth, _ = sp.spkpos("EARTH", ets, "MOON_ME", "LT+S", "MOON")
    return np.asarray(sun), np.asarray(earth)


def load(p: Path) -> PolarDEM:
    z = np.load(p)
    return PolarDEM(p.stem, z["h"], float(z["scale"]), float(z["x0"]), float(z["y0"]))


def clearances(lat, lon, hz, sun, earth):
    """Sun clearance over its lower limb (> 0: some of the disk is up) and Earth-centre clearance, per sample."""
    def at(az):
        return np.interp(az, np.r_[hz.az_deg - 360, hz.az_deg, hz.az_deg + 360], np.r_[hz.elev_deg, hz.elev_deg, hz.elev_deg])
    r = R0 + hz.ground_m + 2.0
    saz, sel = topocentric_azel(lat, lon, r, sun)
    eaz, eel = topocentric_azel(lat, lon, r, earth)
    position_km = unit_vector(lat, lon) * r / 1000
    rad = np.degrees(np.arcsin(SUN_RADIUS_KM / np.linalg.norm(sun - position_km, axis=1)))
    re = np.degrees(np.arcsin(6371 / np.linalg.norm(earth - position_km, axis=1)))
    sa, se, ea, ee = map(np.radians, (saz, sel, eaz, eel))
    dot = np.cos(se) * np.cos(ee) * np.cos(ea - sa) + np.sin(se) * np.sin(ee)
    dx = np.degrees(np.arctan2(np.cos(ee) * np.sin(ea - sa), dot))
    dy = np.degrees(np.arctan2(np.sin(ee) * np.cos(se) - np.cos(ee) * np.sin(se) * np.cos(ea - sa), dot))
    return sel - at(saz) + rad, eel - at(eaz), (rad, re, dx, dy)


def visible_sun(clear, eclipse):
    """Any uniform solar disk above the skyline and outside Earth, by the farthest point of its visible cap.

    Independent of the browser's flux quadrature. For a cap y >= skyline, the point farthest from Earth's centre
    is opposite that centre on the solar circle, or one of the cap's two end points. This also detects darkness
    when a partial eclipse covers only the sliver the terrain leaves visible.
    """
    rs, re, dx, dy = eclipse
    distance = np.hypot(dx, dy)
    cut = np.clip(rs - clear, -rs, rs)
    far_y = -rs * dy / np.maximum(distance, 1e-30)
    edge_x = np.sqrt(np.maximum(0, rs * rs - cut * cut))
    farthest2 = np.where(far_y >= cut, (distance + rs) ** 2, (np.abs(dx) + edge_x) ** 2 + (cut - dy) ** 2)
    return (clear > 0) & (farthest2 > re * re)


def longest_run(x: np.ndarray) -> int:
    """Longest run of True."""
    if not x.any():
        return 0
    d = np.diff(np.r_[0, x.astype(np.int8), 0])
    return int((np.nonzero(d == -1)[0] - np.nonzero(d == 1)[0]).max())


def verdicts(sun_clear, earth_clear, per_h: int, p: dict, slope: float, eclipse) -> np.ndarray:
    """PASS / FAIL for every landing day: the app's checkWindow on samples `per_h` to the hour."""
    out = np.zeros(DAYS, dtype=bool)
    if not np.isfinite(slope) or slope > p["max_slope_deg"]:
        return out
    sunlight = visible_sun(sun_clear, eclipse)
    n = p["stay_h"] * per_h
    need = min(p["daylight_h"], p["stay_h"]) * per_h
    for d in range(DAYS):
        a = d * 24 * per_h
        up = sunlight[a:a + n]
        if not up[0]:
            continue
        dark = ~up
        terrain_dark = sun_clear[a:a + n + 1] <= 0
        first_set = float(np.argmax(terrain_dark)) if terrain_dark.any() else float(n)
        if terrain_dark.any() and 0 < first_set <= n:
            k = int(first_set)
            left, right = sun_clear[a + k - 1:a + k + 1]
            first_set = k - 1 + float(left / (left - right))
        ok = first_set >= need
        ok &= longest_run(dark) / per_h <= p["dark_h"]
        ok &= 100 * float(np.mean(earth_clear[a:a + n] >= 0)) >= p["earth_pct"]
        out[d] = ok
    return out


def points():
    """(label, lat, lon, slope, stereo dem list, lola dem list) for every point with stereo terrain."""
    d80, d240 = B._dem("ldem_80s_80m"), B._dem("ldem_75s_240m")
    for product in ["ESALL_CR1", "ESALL_SR12", "ESALL_MP1"]:
        for k in range(5):
            pn, pd = NAC / f"val_{product}_{k}_{product}.npz", DEM20 / f"val_{product}_{k}.npz"
            if not pn.exists():
                continue
            nac, d20 = load(pn), load(pd)
            n = nac.heights.shape[0]
            x = nac.x0 + (n // 2) * nac.scale
            y = nac.y0 - (n // 2) * nac.scale
            la, lo = (float(v[0]) for v in xy_to_latlon(np.array([x]), np.array([y])))
            hx = nac.sample(np.array([x + 20, x - 20]), np.array([y, y]))
            hy = nac.sample(np.array([x, x]), np.array([y + 20, y - 20]))
            slope = float(np.degrees(np.arctan(np.hypot((hx[0] - hx[1]) / 40, (hy[0] - hy[1]) / 40))))
            yield f"{product} #{k}", product, la, lo, slope, [nac, d20, d80, d240], [d20, d80, d240]
    dems = B._dems_for("im2-actual")
    lat, lon = B.SITE_LL["im2-actual"]
    nac = dems[0]
    x, y = (float(v[0]) for v in latlon_to_xy(np.array([lat]), np.array([lon])))
    hx = nac.sample(np.array([x + 20, x - 20]), np.array([y, y]))
    hy = nac.sample(np.array([x, x]), np.array([y + 20, y - 20]))
    slope = float(np.degrees(np.arctan(np.hypot((hx[0] - hx[1]) / 40, (hy[0] - hy[1]) / 40))))
    yield "Athena (IM-2)", "NOBILE03", lat, lon, slope, dems, dems[1:]
    curated = json.loads((B.OUT / "sites.json").read_text(encoding="utf-8"))["sites"]
    for sid, product in [("c1", "ESALL_CR1"), ("shackleton", "ESALL_SR12")]:
        site = next(s for s in curated if s["id"] == sid)
        nac = nac_window(product, "mission_" + sid, site["lat"], site["lon"])
        if nac is None:
            raise RuntimeError(f"Curated validation point {sid} is outside the stereo terrain")
        dems = B._dems_for(sid)
        x, y = latlon_to_xy(site["lat"], site["lon"])
        slope = B.slope_deg([nac, *dems], float(x), float(y))
        yield site["name"], product, site["lat"], site["lon"], slope, [nac, *dems], dems


def main():
    sun, earth = bodies()
    per_h = 60 // STEP_MIN
    rows = []
    for label, model, la, lo, slope, dems_st, dems_lola in points():
        st = compute_horizon(la, lo, dems_st, observer_m=2.0)
        lola = compute_horizon(la, lo, dems_lola, observer_m=2.0)
        # The shipped skyline is quantised to centidegrees; the finer reference retains its native precision.
        lola.elev_deg[:] = np.round(lola.elev_deg * 100) / 100
        s_st, e_st, eclipse_st = clearances(la, lo, st, sun, earth)
        s_lo, e_lo, eclipse_lo = clearances(la, lo, lola, sun, earth)
        x, y = latlon_to_xy(la, lo)
        slope_lo = round(B.slope_deg(dems_lola, float(x), float(y)), 1)
        slope_st = round(slope, 1)
        row = dict(point=label, model=model, lat=round(la, 5), lon=round(lo, 4), slope_deg=slope_st,
                   lola_slope_deg=slope_lo, curated=label in ["Connecting Ridge C1", "Shackleton rim"], presets={})
        coarse_eclipse = tuple(v[::per_h] for v in eclipse_lo)
        for name, p in PRESETS.items():
            ref = verdicts(s_st, e_st, per_h, p, slope_st, eclipse_st)
            nom = verdicts(s_lo[::per_h], e_lo[::per_h], 1, p, slope_lo, coarse_eclipse)
            hi = verdicts(s_lo[::per_h] - SHIFT, e_lo[::per_h] - SHIFT, 1, p, slope_lo, coarse_eclipse)
            fine = verdicts(s_lo, e_lo, per_h, p, slope_lo, eclipse_lo)
            st_h = verdicts(s_st[::per_h], e_st[::per_h], 1, p, slope_st, tuple(v[::per_h] for v in eclipse_st))
            row["presets"][name] = dict(
                days_lola=int(nom.sum()), days_lola_raised=int(hi.sum()), days_stereo=int(ref.sum()),
                agree=int((nom == ref).sum()), lola_pass_stereo_fail=int((nom & ~ref).sum()), lola_fail_stereo_pass=int((~nom & ref).sum()),
                raised_pass=int(hi.sum()), raised_pass_stereo_fail=int((hi & ~ref).sum()),
                nominal_only=int((nom & ~hi).sum()), nominal_only_stereo_fail=int((nom & ~hi & ~ref).sum()),
                timestep_lola_disagree=int((nom != fine).sum()), timestep_stereo_disagree=int((st_h != ref).sum()),
            )
        rows.append(row)
        print(label, {k: (v["days_lola"], v["days_stereo"], v["agree"]) for k, v in row["presets"].items()}, flush=True)

    summary = {"all points": summarise(rows),
               "random points and Athena": summarise([r for r in rows if not r["curated"]]),
               "curated ridge and rim": summarise([r for r in rows if r["curated"]]),
               "by model": {model: summarise([r for r in rows if r["model"] == model]) for model in sorted({r["model"] for r in rows})}}
    OUT.write_text(json.dumps({"checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "landing_days": "every day of 2027, 00:00 UTC",
                               "reference": "2-4 m stereo near field, 10-minute steps; terrain-specific slopes and joint eclipse visibility included",
                               "observer_m": 2.0, "skyline_shift_deg": SHIFT,
                               "presets": PRESETS, "summary": summary, "rows": rows}, indent=1))


def summarise(rows):
    summary = {"points": len(rows)}
    for name in PRESETS:
        cs = [r["presets"][name] for r in rows]
        tot = lambda k: int(sum(c[k] for c in cs))  # noqa: E731
        active = [c for c in cs if c["days_lola"] or c["days_stereo"]]
        diffs = [abs(c["days_lola"] - c["days_stereo"]) for c in active]
        n = DAYS * len(cs)
        summary[name] = dict(
            point_days=n, points_with_any_pass=len(active),
            lola_slope_eligible=sum(r["lola_slope_deg"] <= PRESETS[name]["max_slope_deg"] for r in rows),
            stereo_slope_eligible=sum(r["slope_deg"] <= PRESETS[name]["max_slope_deg"] for r in rows),
            agree_pct=round(100 * tot("agree") / n, 1),
            # agreement where it matters: of the point-days either terrain calls PASS, the share both call PASS
            pass_overlap_pct=round(100 * (tot("days_lola") - tot("lola_pass_stereo_fail")) / (tot("days_lola") + tot("lola_fail_stereo_pass")), 1) if tot("days_lola") + tot("lola_fail_stereo_pass") else None,
            lola_pass_stereo_fail=tot("lola_pass_stereo_fail"), lola_fail_stereo_pass=tot("lola_fail_stereo_pass"),
            lola_pass_days=tot("days_lola"), stereo_pass_days=tot("days_stereo"),
            # of the days LOLA calls PASS, the share stereo terrain also passes
            lola_pass_confirmed_pct=round(100 * (1 - tot("lola_pass_stereo_fail") / tot("days_lola")), 1) if tot("days_lola") else None,
            raised_pass_confirmed_pct=round(100 * (1 - tot("raised_pass_stereo_fail") / tot("raised_pass")), 1) if tot("raised_pass") else None,
            nominal_only_days=tot("nominal_only"),
            nominal_only_confirmed_pct=round(100 * (1 - tot("nominal_only_stereo_fail") / tot("nominal_only")), 1) if tot("nominal_only") else None,
            annual_days_abs_diff_median=float(np.median(diffs)) if diffs else None,
            annual_days_abs_diff_max=int(max(diffs)) if diffs else None,
            annual_days_rel_diff_median_pct=round(float(np.median([100 * abs(c["days_lola"] - c["days_stereo"]) / max(c["days_stereo"], 1) for c in active])), 0) if active else None,
            timestep_lola_disagree=tot("timestep_lola_disagree"), timestep_stereo_disagree=tot("timestep_stereo_disagree"),
        )
        print(name, summary[name], flush=True)
    return summary


if __name__ == "__main__":
    main()
