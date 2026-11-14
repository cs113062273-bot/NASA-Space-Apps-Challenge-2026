// Touchdown grid: window metrics and PASS / FAIL for every point around a target, shared by the touchdown map and the tests.
import { Ephemeris, Horizon, sliceEphemeris } from './astro'
import { SiteRecord, toLatLon, toXY } from './data'
import { MetricKey, computeTrack, windowStats } from './metrics'
import { Requirements, daylightPass } from './requirements'

/** Window metrics, plus the requirement-relevant ones with the skyline `dh` higher (`hi`). */
export type CellStats = Record<MetricKey, number> & { startsDark: boolean; hi: { earth: number; longestDark: number; firstSunset: number; startsDark: boolean } }

/** All window metrics for one touchdown point, evaluated hour by hour. */
export function cellStats(eph: Ephemeris, lat: number, lon: number, groundM: number, hz: Horizon, i0: number, len: number, earthMinClear: number, dh: number, requireDsn: boolean, observerM: number): CellStats {
  // Only this window, plus its right-hand sample for event interpolation. Reuse the main engine so eclipses,
  // fractional sunsets, DSN contact and raised-skyline tests cannot drift between the grid and the headline.
  const local = sliceEphemeris(eph, i0, len + 1)
  const track = computeTrack(local, { lat, lon, groundM, observerM, horizon: hz }, earthMinClear, requireDsn)
  const nominal = windowStats(track, 0, len)
  const hi = windowStats(track, 0, len, dh)
  const daylight = (s: typeof nominal) => s.startsDark ? 0 : s.firstSunset ?? s.hours
  return {
    sun: 100 * nominal.sunEquivHours / len,
    earth: 100 * nominal.earthHours / len,
    both: 100 * nominal.bothHours / len,
    longestDark: nominal.longestDark,
    firstSunset: daylight(nominal), startsDark: nominal.startsDark,
    hi: { earth: 100 * hi.earthHours / len, longestDark: hi.longestDark, firstSunset: daylight(hi), startsDark: hi.startsDark },
  }
}

const R_M = 1737400
const D2R = Math.PI / 180

/** Grid offsets (m, east/up on the map) to latitude and longitude, in the grid's own frame. */
export function gridToLatLon(site: SiteRecord, dx: number, dy: number): [number, number] {
  if (site.dispersion!.frame === 'enu') return [site.lat + dy / R_M / D2R, site.lon + dx / (R_M * Math.cos(site.lat * D2R)) / D2R]
  const [cx, cy] = toXY(site.lat, site.lon)
  return toLatLon(cx + dx, cy + dy)
}

/** Latitude and longitude of grid point k (row-major, row 0 at the top of the map). */
export function cellLatLon(site: SiteRecord, k: number): [number, number] {
  const d = site.dispersion!
  const mid = (d.n - 1) / 2
  return gridToLatLon(site, ((k % d.n) - mid) * d.step_m, (mid - Math.floor(k / d.n)) * d.step_m)
}

export interface TouchdownOpts { earthMinClear: number; skyErr: number; requireDsn: boolean; observerM: number }

/** Window metrics for every point of a site's touchdown grid. */
export function touchdownCells(eph: Ephemeris, site: SiteRecord, grid: Horizon[], i0: number, len: number, o: TouchdownOpts): CellStats[] {
  const d = site.dispersion!
  const out: CellStats[] = []
  for (let k = 0; k < d.n * d.n; k++) {
    const [lat, lon] = cellLatLon(site, k)
    out.push(cellStats(eph, lat, lon, d.ground_m[k], grid[k], Math.round(i0), Math.round(len), o.earthMinClear, o.skyErr, o.requireDsn, o.observerM))
  }
  return out
}

/** Each point's checks, whether it meets every requirement, and whether it still does with the skyline raised. */
export function touchdownPass(site: SiteRecord, cells: CellStats[], req: Requirements, len: number) {
  const d = site.dispersion!
  const pass = cells.map((s, k) => ({
    daylight: daylightPass({ ...s, hours: len }, req.minDaylightH),
    dark: s.longestDark <= req.maxDarkH,
    earth: s.earth >= req.minEarthPct,
    slope: Number.isFinite(d.slope_deg[k]) && d.slope_deg[k] <= req.maxSlopeDeg,
  }))
  const ok = pass.map((p) => p.daylight && p.dark && p.earth && p.slope)
  const okHi = cells.map((s, k) => ok[k] && daylightPass({ ...s.hi, hours: len }, req.minDaylightH) && s.hi.longestDark <= req.maxDarkH && s.hi.earth >= req.minEarthPct)
  return { pass, ok, okHi }
}

/** Share (%) of the 500 m circle meeting every requirement, nominal and with the skyline raised. */
export function areaShare(site: SiteRecord, ok: boolean[], okHi: boolean[]) {
  const d = site.dispersion!
  const mid = (d.n - 1) / 2
  let n = 0, a = 0, b = 0
  for (let k = 0; k < d.n * d.n; k++) {
    if (Math.hypot(Math.floor(k / d.n) - mid, (k % d.n) - mid) * d.step_m > 500 + 1) continue
    n++
    if (ok[k]) a++
    if (okHi[k]) b++
  }
  return { okPct: (100 * a) / n, okPctHi: (100 * b) / n }
}
