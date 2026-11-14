"""LOLA polar DEM access and terrain-horizon computation (reference implementation).

Geometry: spherical Moon, R0 = 1737.4 km (the LOLA GDR reference sphere), coordinates in
the MOON_ME (mean Earth / polar axis) frame, planetocentric latitude and east longitude.
Polar stereographic mapping follows the PDS LOLA DSMAP_POLAR.CAT definition.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

R0 = 1737400.0  # m, LOLA reference radius
RAW = Path(__file__).resolve().parents[1] / "data" / "raw"


@dataclass
class PolarDEM:
    """A south polar stereographic LOLA grid (or a window of one)."""

    name: str
    heights: np.ndarray  # raw grid values, shape (rows, cols); metres = value * factor
    scale: float  # metres per pixel
    x0: float  # projected X (m) of column 0 centre
    y0: float  # projected Y (m) of row 0 centre (Y decreases with row)
    factor: float = 1.0

    @classmethod
    def load_pds(cls, stem: str) -> "PolarDEM":
        lbl = (RAW / "dem" / f"{stem}.lbl").read_text()
        n = int(re.search(r"LINES\s*=\s*(\d+)", lbl).group(1))
        scale = float(re.search(r"MAP_SCALE\s*=\s*([\d.]+)", lbl).group(1))
        factor = float(re.search(r"SCALING_FACTOR\s*=\s*([\d.]+)", lbl).group(1))
        # memory-mapped int16 so parallel workers share the OS page cache
        dn = np.memmap(RAW / "dem" / f"{stem}.img", dtype="<i2", mode="r", shape=(n, n))
        # PDS: X = (I - N/2 - 0.5)*s, Y = -(J - N/2 - 0.5)*s with 1-based I (sample), J (line)
        x0 = (1 - n / 2 - 0.5) * scale
        y0 = -(1 - n / 2 - 0.5) * scale
        return cls(stem, dn, scale, x0, y0, factor)

    def contains(self, x: np.ndarray, y: np.ndarray, margin: float = 1.0) -> np.ndarray:
        c = (x - self.x0) / self.scale
        r = (self.y0 - y) / self.scale
        rows, cols = self.heights.shape
        return (c >= margin) & (r >= margin) & (c <= cols - 1 - margin) & (r <= rows - 1 - margin)

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Bilinear height (m) at projected coordinates; NaN outside the grid."""
        c = (x - self.x0) / self.scale
        r = (self.y0 - y) / self.scale
        rows, cols = self.heights.shape
        ok = (c >= 0) & (r >= 0) & (c <= cols - 1) & (r <= rows - 1)
        c = np.clip(c, 0, cols - 1.000001)
        r = np.clip(r, 0, rows - 1.000001)
        c0 = np.floor(c).astype(np.int64)
        r0 = np.floor(r).astype(np.int64)
        fc = (c - c0).astype(np.float32)
        fr = (r - r0).astype(np.float32)
        h = self.heights
        top = h[r0, c0] * (1 - fc) + h[r0, c0 + 1] * fc
        bot = h[r0 + 1, c0] * (1 - fc) + h[r0 + 1, c0 + 1] * fc
        out = (top * (1 - fr) + bot * fr) * np.float32(self.factor)
        return np.where(ok, out, np.nan)

    def contains_ll(self, lat, lon, margin: float = 1.0) -> np.ndarray:
        x, y = latlon_to_xy(lat, lon)
        return (np.asarray(lat) < 0) & self.contains(x, y, margin)  # south polar grids only

    def sample_ll(self, lat, lon) -> np.ndarray:
        x, y = latlon_to_xy(lat, lon)
        return np.where(np.asarray(lat) < 0, self.sample(x, y), np.nan)

    def window(self, x: float, y: float, half_m: float) -> "PolarDEM":
        c = int(round((x - self.x0) / self.scale))
        r = int(round((self.y0 - y) / self.scale))
        k = int(math.ceil(half_m / self.scale))
        r1, r2 = max(r - k, 0), min(r + k + 1, self.heights.shape[0])
        c1, c2 = max(c - k, 0), min(c + k + 1, self.heights.shape[1])
        return PolarDEM(
            f"{self.name}[window]",
            np.array(self.heights[r1:r2, c1:c2]),
            self.scale,
            self.x0 + c1 * self.scale,
            self.y0 - r1 * self.scale,
            self.factor,
        )


def latlon_to_xy(lat_deg, lon_deg):
    """South polar stereographic (PDS LOLA convention). Valid for the southern hemisphere."""
    lat = np.asarray(lat_deg, dtype=np.float64)
    lon = np.radians(np.asarray(lon_deg, dtype=np.float64))
    rho = 2 * R0 * np.tan(np.radians(90 - np.abs(lat)) / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def xy_to_latlon(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    rho = np.hypot(x, y)
    lat = -90 + np.degrees(2 * np.arctan(0.5 * rho / R0))
    lon = np.degrees(np.arctan2(x, y)) % 360
    return lat, lon


def unit_vector(lat_deg, lon_deg):
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)


def enu_basis(lat_deg: float, lon_deg: float):
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    east = np.array([-math.sin(lon), math.cos(lon), 0.0])
    north = np.array([-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)])
    up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    return east, north, up


def destination(lat_deg: float, lon_deg: float, az_rad: np.ndarray, d_m: np.ndarray):
    """Great-circle destination points. az measured clockwise from north. Broadcasts az x d."""
    lat1, lon1 = math.radians(lat_deg), math.radians(lon_deg)
    delta = d_m / R0
    sd, cd = np.sin(delta), np.cos(delta)
    sa, ca = np.sin(az_rad), np.cos(az_rad)
    # Rotate observer-up toward the azimuth tangent. The usual longitude
    # expression cancels to 0/0 at an exact pole and loses nearby directions.
    sl, cl, so, co = math.sin(lat1), math.cos(lat1), math.sin(lon1), math.cos(lon1)
    x = cl * co * cd + (-sl * co * ca - so * sa) * sd
    y = cl * so * cd + (-sl * so * ca + co * sa) * sd
    z = sl * cd + cl * ca * sd
    lat2 = np.arctan2(z, np.hypot(x, y))
    lon2 = np.arctan2(y, x)
    return np.degrees(lat2), np.degrees(lon2)


def ray_distances(d_max: float = 300_000.0, step0: float = 10.0) -> np.ndarray:
    """Sample distances along each azimuth: fine near the observer, coarser far away.
    `step0` below 10 m adds a finer first kilometre for metre-scale near-field terrain."""
    segs = [(10, 2_000, 10), (2_000, 10_000, 20), (10_000, 40_000, 60), (40_000, 150_000, 160), (150_000, d_max, 400)]
    if step0 < 10:
        segs = [(step0, 1_000, step0), (1_000, 2_000, 10)] + segs[1:]
    return np.concatenate([np.arange(a, b, s, dtype=np.float64) for a, b, s in segs])


@dataclass
class Horizon:
    lat: float
    lon: float
    ground_m: float  # DEM height at site (m above R0)
    observer_m: float  # observer height above ground (m)
    az_deg: np.ndarray  # bin centres, clockwise from north
    elev_deg: np.ndarray  # terrain horizon elevation per azimuth bin
    dist_m: np.ndarray  # distance to the horizon-defining terrain


def compute_horizon(
    lat: float,
    lon: float,
    dems: list,  # PolarDEM or global_dem.CylDEM, finest first
    observer_m: float = 2.0,
    n_az: int = 720,
    d_max: float = 300_000.0,
) -> Horizon:
    """Max terrain elevation angle per azimuth, including lunar curvature.

    `dems` must be ordered finest first; each sample uses the finest grid that covers it.
    Elevation angle of a terrain point at central angle t and radius Rt seen from radius Ro:
        elev = atan2(Rt*cos(t) - Ro, Rt*sin(t))
    """
    ground = np.nan
    for dem in dems:
        if dem.contains_ll(np.array([lat]), np.array([lon]))[0]:
            ground = float(dem.sample_ll(np.array([lat]), np.array([lon]))[0])
            if np.isfinite(ground):
                break
    if not np.isfinite(ground):
        raise ValueError(f"site {lat},{lon} outside DEM coverage")
    ro = R0 + ground + observer_m

    az = (np.arange(n_az) + 0.5) * (360.0 / n_az)
    d = ray_distances(d_max, step0=min(10.0, dems[0].scale / 2))
    plat, plon = destination(lat, lon, np.radians(az)[:, None], d[None, :])
    h = np.full(plat.shape, np.nan, dtype=np.float32)
    todo = np.ones(plat.shape, dtype=bool)
    for dem in dems:
        inside = todo & dem.contains_ll(plat, plon)
        if inside.any():
            vals = np.full(plat.shape, np.nan, dtype=np.float32)
            vals[inside] = dem.sample_ll(plat[inside], plon[inside])
            ok = inside & np.isfinite(vals)  # gaps (e.g. outside a NAC strip) fall through to coarser grids
            h[ok] = vals[ok]
            todo &= ~ok
    t = d / R0
    rt = R0 + h.astype(np.float64)
    elev = np.degrees(np.arctan2(rt * np.cos(t)[None, :] - ro, rt * np.sin(t)[None, :]))
    elev = np.where(np.isfinite(elev), elev, -90.0)
    k = np.argmax(elev, axis=1)
    return Horizon(lat, lon, ground, observer_m, az, elev[np.arange(n_az), k], d[k])


def topocentric_azel(lat: float, lon: float, site_radius_m: float, body_km: np.ndarray):
    """Azimuth (deg, clockwise from north) and elevation (deg) of body positions given in
    MOON_ME kilometres, seen from a surface site. Works for (N,3) arrays."""
    e, n, u = enu_basis(lat, lon)
    site = unit_vector(lat, lon) * site_radius_m / 1000.0
    v = body_km - site
    ve, vn, vu = v @ e, v @ n, v @ u
    az = np.degrees(np.arctan2(ve, vn)) % 360
    el = np.degrees(np.arctan2(vu, np.hypot(ve, vn)))
    return az, el


def disk_fraction_visible(center_el, horizon_el, radius_deg):
    """Fraction of a uniform disk above a locally flat horizon line (circular-segment area)."""
    z = np.clip((center_el - horizon_el) / radius_deg, -1.0, 1.0)
    return (np.arcsin(z) + z * np.sqrt(1 - z * z) + math.pi / 2) / math.pi
