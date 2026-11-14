import {
  Ephemeris,
  Horizon,
  earthAt,
  earthShadowFactor,
  eclipseGap,
  siteFrame,
  sunAt,
  sunRadiusDeg,
  visibleSunFraction,
  R0_KM,
  stationAt,
  DSN_MIN_EL_DEG,
} from './astro'
export type HorizonSampler=Pick<Horizon,'at'>&Partial<Pick<Horizon,'bins'|'elev'>>

/** Hour-by-hour visibility of the Sun and Earth at one site, over the whole ephemeris span. */
export interface Track {
  geometry?: { lat:number;lon:number;groundM:number;observerM:number;horizon:HorizonSampler }
  sunFrac: Float32Array // visible fraction of the solar disk, 0..1
  sunClear: Float32Array // Sun centre elevation minus terrain horizon (deg)
  sunEl: Float32Array // Sun centre elevation above the local horizontal (deg)
  sunR: Float32Array // solar angular radius (deg)
  sunAz: Float32Array
  earthClear: Float32Array // Earth centre elevation minus terrain horizon (deg)
  earthEl: Float32Array
  earthAz: Float32Array
  // prefix sums (length n + 1) for O(1) window queries
  cumSun: Float64Array
  cumSunUp: Float64Array
  cumEarth: Float64Array
  cumBoth: Float64Array
  earthMinClear: number
  eclipsed: Uint8Array // 1 when Earth hides the whole Sun (an eclipse seen from the Moon)
  eclipseGap: Float32Array // deg; negative while Earth covers the whole Sun
  lightReturn: Map<number, number> // hour i -> fraction of the hour when light returns, for dark-to-lit hours an eclipse is part of
  lightLoss?: Map<number, number> // eclipse-related lit-to-dark crossings, for the event table and exports
  partialEclipse?: Uint8Array
  visibleAt?: (index: number, skyShift: number) => number
  dsn: Uint8Array | null // DSN complexes that see the Moon (bit mask), shared by every site
  requireDsn: boolean // Earth only counts as in view when a DSN antenna also sees the Moon
  stations?: {
    clear: Float32Array // per epoch, lunar terrain clearance toward each reference antenna
    groundEl: Float32Array // receiving antenna elevation toward the lander at signal arrival
    distance: Float32Array
    aimStress: Float32Array // per epoch; additional clearance used only in sensitivity scenarios
    groundStress: Float32Array
    stressed: boolean
  }
}

export interface SiteGeom {
  lat: number
  lon: number
  groundM: number
  observerM: number
  horizon: HorizonSampler
  stationStress?: boolean // apply Earth-orientation sensitivity as well as the supplied horizon
}

export function computeTrack(eph: Ephemeris, g: SiteGeom, earthMinClear = 0, requireDsn = false): Track {
  const n = eph.count
  const f = siteFrame(g.lat, g.lon, R0_KM + (g.groundM + g.observerM) / 1000)
  const t: Track = {
    geometry:{lat:g.lat,lon:g.lon,groundM:g.groundM,observerM:g.observerM,horizon:g.horizon},
    sunFrac: new Float32Array(n),
    sunClear: new Float32Array(n),
    sunEl: new Float32Array(n),
    sunR: new Float32Array(n),
    sunAz: new Float32Array(n),
    earthClear: new Float32Array(n),
    earthEl: new Float32Array(n),
    earthAz: new Float32Array(n),
    cumSun: new Float64Array(n + 1),
    cumSunUp: new Float64Array(n + 1),
    cumEarth: new Float64Array(n + 1),
    cumBoth: new Float64Array(n + 1),
    earthMinClear,
    eclipsed: new Uint8Array(n),
    eclipseGap: new Float32Array(n),
    lightReturn: new Map(),
    lightLoss: new Map(),
    dsn: eph.dsn ?? null,
    requireDsn: requireDsn && !!(eph.stations || eph.dsn),
    stations: eph.stations ? { clear: new Float32Array(n * 3), groundEl: new Float32Array(n * 3),
      distance: new Float32Array(n * 3), aimStress: new Float32Array(n), groundStress: new Float32Array(n), stressed: !!g.stationStress } : undefined,
  }
  const partial = new Uint8Array(n) // Earth covers some of the Sun
  t.partialEclipse = partial
  t.visibleAt = (x, shift) => {
    const s = sunAt(eph, f, x)
    return visibleSunFraction(s, g.horizon.at(s.az) + shift, earthAt(eph, f, x))
  }
  for (let i = 0; i < n; i++) {
    const s = sunAt(eph, f, i)
    const e = earthAt(eph, f, i)
    const hs = g.horizon.at(s.az)
    const shade = earthShadowFactor(s, e)
    if (shade < 1) partial[i] = 1
    const r = sunRadiusDeg(s.dist)
    if (shade === 0) t.eclipsed[i] = 1
    t.eclipseGap[i] = eclipseGap(s, e)
    // terrain and Earth can cover the same part of the disk: take what is above the skyline and outside Earth
    const frac = visibleSunFraction(s, hs, e)
    t.sunR[i] = r
    t.sunFrac[i] = frac
    t.sunClear[i] = s.el - hs
    t.sunEl[i] = s.el
    t.sunAz[i] = s.az
    const he = g.horizon.at(e.az)
    t.earthClear[i] = e.el - he
    t.earthEl[i] = e.el
    t.earthAz[i] = e.az
    if (t.stations && eph.stations) {
      const o = eph.stations.orientation
      const recent = eph.startUnix + i * eph.stepS < o.recent_kernel_until_unix
      t.stations.aimStress[i] = recent ? o.recent_aim_stress_deg : o.long_term_aim_stress_deg
      t.stations.groundStress[i] = recent ? o.recent_ground_stress_deg : o.long_term_ground_stress_deg
      for (let j = 0; j < 3; j++) {
        const s = stationAt(eph, f, i, j), k = i * 3 + j
        t.stations.clear[k] = s.el - g.horizon.at(s.az)
        t.stations.groundEl[k] = s.receiverEl
        t.stations.distance[k] = s.dist
      }
    }
    const up = frac > 0 ? 1 : 0
    const ev = earthVisible(t, i) ? 1 : 0
    t.cumSun[i + 1] = t.cumSun[i] + frac
    t.cumSunUp[i + 1] = t.cumSunUp[i] + up
    t.cumEarth[i + 1] = t.cumEarth[i] + ev
    t.cumBoth[i + 1] = t.cumBoth[i] + (up & ev)
  }
  // where an eclipse ends the dark, light comes back when Earth uncovers a part of the Sun the terrain does not hide:
  // neither the eclipse nor the skyline alone gives that moment, so find it within the hour (to about a second)
  const lit = (x: number) => {
    const s = sunAt(eph, f, x)
    return visibleSunFraction(s, g.horizon.at(s.az), earthAt(eph, f, x)) > 0
  }
  for (let i = 0; i + 1 < n; i++) {
    const rising = t.sunFrac[i + 1] > 0
    if ((t.sunFrac[i] > 0) === rising || !(partial[i] || partial[i + 1])) continue
    let lo = 0
    let hi = 1
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2
      if (lit(i + mid) === rising) hi = mid
      else lo = mid
    }
    if (rising) t.lightReturn.set(i, hi)
    else t.lightLoss!.set(i, hi)
  }
  return t
}

/** Both ends of one named station path must clear their own masks; never gate it on Earth's centre. */
export function stationScore(t: Track, i: number, station: number, skyShift = 0): number {
  const s = t.stations
  if (!s) return -Infinity
  const stress = s.stressed || skyShift > 0, k = i * 3 + station
  return Math.min(s.clear[k] - t.earthMinClear - skyShift - (stress ? s.aimStress[i] : 0),
    s.groundEl[k] - DSN_MIN_EL_DEG - (stress ? s.groundStress[i] : 0))
}

export function availableStationMask(t: Track, i: number, skyShift = 0): number {
  if (!t.stations) return t.earthClear[i] - skyShift >= t.earthMinClear ? t.dsn?.[i] ?? 7 : 0
  let mask = 0
  for (let j = 0; j < 3; j++) if (stationScore(t, i, j, skyShift) >= 0) mask |= 1 << j
  return mask
}

function earthScore(t: Track, i: number, skyShift = 0): number {
  if (t.requireDsn && t.stations) return Math.max(stationScore(t, i, 0, skyShift), stationScore(t, i, 1, skyShift), stationScore(t, i, 2, skyShift))
  return t.earthClear[i] - t.earthMinClear - skyShift
}

export const earthVisible = (t: Track, i: number, skyShift = 0) => earthScore(t, i, skyShift) >= 0
  && (!t.requireDsn || !!t.stations || !!t.dsn?.[i])
export const sunUp = (t: Track, i: number) => t.sunFrac[i] > 0
/** Contact crossing between hourly samples: DSN availability is piecewise constant, terrain is interpolated. */
export function earthTransition(t: Track, i: number, skyShift = 0): number {
  if (t.requireDsn && t.stations) {
    const y0 = earthScore(t, i, skyShift), y1 = earthScore(t, i + 1, skyShift)
    return i + (y0 === y1 ? 0.5 : Math.max(0, Math.min(1, y0 / (y0 - y1))))
  }
  if (t.requireDsn && !t.dsn?.[i]) return i + 1 // reacquisition waits for the DSN's next sampled hour
  if (t.requireDsn && !t.dsn?.[i + 1] && t.earthClear[i + 1] - skyShift >= t.earthMinClear) return i + 1
  // If terrain sets and DSN also disappears at the next boundary, terrain may end contact first.
  return crossing(t.earthClear, i, t.earthMinClear + skyShift)
}
const earthVisibleNominal = earthVisible
const sunUpNominal = sunUp

export interface WindowStats {
  hours: number
  sunEquivHours: number // sum of visible solar-disk fraction: hours of full-Sun equivalent
  sunUpHours: number // hours with any part of the Sun above the terrain
  earthHours: number
  bothHours: number
  dsnEarthHours: number | null // Earth above the skyline and a DSN antenna sees the Moon (null: no DSN data)
  longestDark: number // longest stretch with no Sun at all (h)
  longestNoEarth: number // longest stretch without Earth in view (h)
  darkOpenEnded: boolean // the longest dark stretch runs into the window edge, so it is a lower bound
  noEarthOpenEnded: boolean
  firstSunset: number | null // hours from start until terrain fully hides the Sun (null: never in window); eclipses are not sunsets
  eclipseHours: number // hours with Earth hiding the whole Sun
  firstEclipse: number | null // hours from start to the first such hour
  firstEarthset: number | null
  earthsetByDsn: boolean // the first loss of Earth comes from the DSN, not the terrain
  startsDark: boolean
  startsNoEarth: boolean
  firstSunrise: number | null // if the window starts dark: hours until first light
  startsInEclipse: boolean // dark at touchdown because Earth hides the Sun, not the terrain
  meanSunElevUp: number // mean Sun elevation while up (deg) — panel incidence matters
  maxEarthClear: number // highest Earth-centre clearance over the skyline in the window (deg): tells "below the skyline" from "under the clearance asked"
  startEarthClear: number
}

/**
 * Statistics over hours [i0, i0 + len) (integer ephemeris indices).
 * `skyShift` raises the whole skyline by that many degrees (negative lowers it) to test robustness to terrain error;
 * with a shift, sunEquivHours stays the nominal value.
 */
export function windowStats(t: Track, i0: number, len: number, skyShift = 0): WindowStats {
  const n = t.sunFrac.length
  const a = Math.max(0, Math.min(n, Math.round(i0)))
  const b = Math.max(a, Math.min(n, a + Math.round(len)))
  const sunUp = skyShift ? (_t: Track, i: number) => {
    if (t.sunClear[i] - skyShift <= -sunEdge(t, i) || t.eclipsed[i]) return false
    return t.partialEclipse?.[i] && t.visibleAt ? t.visibleAt(i, skyShift) > 0 : true
  } : sunUpNominal
  const earthVisible = skyShift ? (_t: Track, i: number) => earthVisibleNominal(t, i, skyShift) : earthVisibleNominal
  let dsnEarthHours = 0
  let eclipseHours = 0
  let firstEclipse: number | null = null
  const terrainUp = (i: number) => t.sunClear[i] - skyShift > -sunEdge(t, i)
  let sunUpHours = 0
  let earthHours = 0
  let bothHours = 0
  let longestDark = 0
  let runDark = 0
  let longestNoEarth = 0
  let runNoEarth = 0
  let darkOpen = false
  let noEarthOpen = false
  let firstSunset: number | null = null
  let firstEarthset: number | null = null
  let firstSunrise: number | null = null
  let earthsetByDsn = false
  let elevSum = 0
  let elevN = 0
  let maxEarthClear = -90
  const startsDark = a < b ? !sunUp(t, a) : true
  const startsNoEarth = a < b ? !earthVisible(t, a) : true
  for (let i = a; i < b; i++) {
    const up = sunUp(t, i)
    const ev = earthVisible(t, i)
    if (t.earthClear[i] > maxEarthClear) maxEarthClear = t.earthClear[i]
    if ((t.stations || t.dsn) && availableStationMask(t, i, skyShift)) dsnEarthHours++
    if (t.eclipsed[i] && terrainUp(i)) {
      eclipseHours++
      if (firstEclipse === null) firstEclipse = i - a
    }
    if (skyShift) {
      sunUpHours += +up
      earthHours += +ev
      bothHours += +(up && ev)
    }
    if (up) {
      elevSum += t.sunEl[i]
      elevN++
    }
    runDark = up ? 0 : runDark + 1
    if (runDark > longestDark || (runDark === longestDark && runDark > 0 && i === b - 1)) {
      longestDark = runDark
      darkOpen = runDark === i - a + 1 || i === b - 1 // touches the window start or end
    }
    runNoEarth = ev ? 0 : runNoEarth + 1
    if (runNoEarth > longestNoEarth || (runNoEarth === longestNoEarth && runNoEarth > 0 && i === b - 1)) {
      longestNoEarth = runNoEarth
      noEarthOpen = runNoEarth === i - a + 1 || i === b - 1
    }
    if (i > a) {
      if (firstSunset === null && !startsDark && !terrainUp(i) && terrainUp(i - 1)) firstSunset = crossing(t.sunClear, i - 1, skyShift - sunEdge(t, i)) - a
      if (firstSunrise === null && startsDark && up && !sunUp(t, i - 1)) firstSunrise = firstLight(t, i - 1, skyShift) - a
      if (firstEarthset === null && !startsNoEarth && !ev && earthVisible(t, i - 1)) {
        // lost to the DSN rather than the terrain: the change happens within the hour, not at a skyline crossing
        earthsetByDsn = t.stations ? !!t.stations.clear.subarray(i * 3, i * 3 + 3).some(v => v - skyShift >= t.earthMinClear) : t.earthClear[i] - skyShift >= t.earthMinClear
        firstEarthset = earthTransition(t, i - 1, skyShift) - a
      }
    }
  }
  // Samples are left-closed hourly bins, but interpolated events can occur in the final bin.
  // The sample at b is an interpolation endpoint, never another hour of availability.
  if (b > a && b < n) {
    if (firstSunset === null && !startsDark && terrainUp(b - 1) && !terrainUp(b)) {
      firstSunset = crossing(t.sunClear, b - 1, skyShift - sunEdge(t, b)) - a
    }
    if (firstSunrise === null && startsDark && !sunUp(t, b - 1) && sunUp(t, b)) {
      const at = firstLight(t, b - 1, skyShift)
      if (at < b) firstSunrise = at - a
    }
    if (firstEarthset === null && !startsNoEarth && earthVisible(t, b - 1) && !earthVisible(t, b)) {
      earthsetByDsn = t.stations ? !!t.stations.clear.subarray(b * 3, b * 3 + 3).some(v => v - skyShift >= t.earthMinClear) : t.earthClear[b] - skyShift >= t.earthMinClear
      const at = earthTransition(t, b - 1, skyShift)
      if (at < b) firstEarthset = at - a
    }
  }
  return {
    hours: b - a,
    sunEquivHours: t.cumSun[b] - t.cumSun[a],
    sunUpHours: skyShift ? sunUpHours : t.cumSunUp[b] - t.cumSunUp[a],
    earthHours: skyShift ? earthHours : t.cumEarth[b] - t.cumEarth[a],
    bothHours: skyShift ? bothHours : t.cumBoth[b] - t.cumBoth[a],
    dsnEarthHours: t.stations || t.dsn ? dsnEarthHours : null,
    eclipseHours,
    firstEclipse,
    longestDark,
    longestNoEarth,
    darkOpenEnded: darkOpen && longestDark > 0,
    noEarthOpenEnded: noEarthOpen && longestNoEarth > 0,
    firstSunset,
    firstEarthset,
    earthsetByDsn,
    startsDark,
    startsNoEarth,
    firstSunrise,
    startsInEclipse: startsDark && a < b && !!t.eclipsed[a] && terrainUp(a),
    meanSunElevUp: elevN ? elevSum / elevN : NaN,
    maxEarthClear,
    startEarthClear: a < b ? t.earthClear[a] : NaN,
  }
}

const sunEdge = (t: Track, i: number) => t.sunR[i]

/**
 * When light returns between dark hour i and lit hour i + 1 (fractional index). Darkness can come from the terrain,
 * from Earth eclipsing the Sun, or both: light returns once every cause has cleared, so take the later crossing.
 */
function firstLight(t: Track, i: number, skyShift: number): number {
  if (skyShift && (t.partialEclipse?.[i] || t.partialEclipse?.[i + 1]) && t.visibleAt) {
    let lo = i, hi = i + 1
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2
      if (t.visibleAt(mid, skyShift) > 0) hi = mid
      else lo = mid
    }
    return hi
  }
  const back = skyShift ? undefined : t.lightReturn?.get(i) // synthetic tracks in tests may not carry the map
  if (back !== undefined) return i + back
  const terrainWasUp = t.sunClear[i] - skyShift > -sunEdge(t, i)
  const terrain = terrainWasUp ? i : crossing(t.sunClear, i, skyShift - sunEdge(t, i + 1))
  const eclipse = t.eclipsed[i] ? crossing(t.eclipseGap, i, 0) : i
  // neither alone explains the dark hour (Earth covers just the sliver above the skyline): mid-hour estimate
  return terrainWasUp && !t.eclipsed[i] ? i + 0.5 : Math.max(terrain, eclipse)
}

/** Shared Sun event time for the headline, interval table and mission brief. */
export function sunTransition(t: Track, i: number, rising: boolean): number {
  if (rising) return firstLight(t, i, 0)
  const eclipse = t.lightLoss?.get(i)
  if (eclipse !== undefined) return i + eclipse
  return crossing(t.sunClear, i, -sunEdge(t, i + 1))
}

/** Skyline error used for event-time ranges: 90% of azimuths where LROC 3-4 m stereo terrain and LOLA disagree
 * at the Athena and Chandrayaan-3 sites fall within 0.07-0.12° (VALIDATION.md). */
export const SKYLINE_ERR_DEG = 0.1

/** Horizons from the 1.9 km whole-Moon grid (sites added north of 75°S) differ from 59 m terrain by a median
 * 0.02-0.9° and up to 4° (VALIDATION.md), so their sensitivity ranges use a 1° shift instead. */
export const COARSE_SKYLINE_ERR_DEG = 1

/** Skyline shift for a site's sensitivity ranges. A sensitivity test, not an error bound. */
export const skylineErr = (s: { skyline_err_deg?: number }) => s.skyline_err_deg ?? SKYLINE_ERR_DEG

/** "the skyline 0.1° higher", or a generic phrase when the sites use different shifts. */
export function raisedPhrase(errs: number[]): string {
  const u = [...new Set(errs)]
  return u.length === 1 ? `the skyline ${u[0]}° higher` : `each skyline raised by its sensitivity shift (${u.sort((a, b) => a - b).join('° or ')}°)`
}

/**
 * First sunset (hours after i0) if the whole skyline were `dDeg` higher, or null if the Sun stays up through the window.
 * 0 when the window would start dark. Reuses the track's Sun clearance, so it costs one pass over the window.
 */
export function sunsetWithSkylineShift(t: Track, i0: number, len: number, dDeg: number): number | null {
  const n = t.sunClear.length
  const a = Math.max(0, Math.min(n, Math.round(i0)))
  const b = Math.max(a, Math.min(n, a + Math.round(len)))
  const up = (i: number) => t.sunClear[i] - dDeg > -sunEdge(t, i)
  if (a >= b || !up(a)) return 0
  for (let i = a + 1; i <= b && i < n; i++) if (!up(i)) return crossing(t.sunClear, i - 1, dDeg - sunEdge(t, i)) - a
  return null
}

/** Earliest and latest first sunset for a skyline `err` degrees higher or lower (null = Sun stays up). */
export function sunsetRange(t: Track, i0: number, len: number, err = SKYLINE_ERR_DEG) {
  return { early: sunsetWithSkylineShift(t, i0, len, err), late: sunsetWithSkylineShift(t, i0, len, -err) }
}

/** Fractional index where series crosses `level` between i and i+1 (linear). */
function crossing(series: Float32Array, i: number, level: number): number {
  const y0 = series[i] - level
  const y1 = series[i + 1] - level
  if (y0 === y1) return i + 0.5
  return i + Math.max(0, Math.min(1, y0 / (y0 - y1)))
}

/** Longest dark run for every landing day (fast path for the date-slip heatmap). */
export function dailyMetric(
  t: Track,
  firstIndex: number,
  days: number,
  windowHours: number,
  metric: MetricKey,
): Float32Array {
  const out = new Float32Array(days)
  for (let d = 0; d < days; d++) {
    const i0 = firstIndex + d * 24
    if (i0 + windowHours > t.sunFrac.length) {
      out[d] = NaN
      continue
    }
    out[d] = metricValue(t, i0, windowHours, metric)
  }
  return out
}

export type MetricKey = 'sun' | 'earth' | 'longestDark' | 'firstSunset' | 'both'

export const METRICS: Record<MetricKey, { label: string; short: string; unit: string; better: 'high' | 'low'; help: string }> = {
  firstSunset: { label: 'Daylight left after landing', short: 'Until sunset', unit: 'h', better: 'high', help: 'Hours from touchdown until the Sun is fully hidden by terrain. Zero if it lands in darkness.' },
  sun: { label: 'Sunlight in window', short: 'Sunlight', unit: '%', better: 'high', help: 'Visible solar disk averaged over the mission window (100% = full Sun all the time).' },
  longestDark: { label: 'Longest darkness', short: 'Longest night', unit: 'h', better: 'low', help: 'Longest stretch with no part of the Sun visible: what batteries and heaters must survive.' },
  earth: { label: 'Earth in view', short: 'Earth contact', unit: '%', better: 'high', help: 'Terrain view of Earth’s centre; with +DSN, both-end geometry toward a named reference antenna. Allocation, power and rate are checked separately in Communication.' },
  both: { label: 'Sun and Earth together', short: 'Sun + Earth', unit: '%', better: 'high', help: 'Share of the window with power and a direct link at the same time.' },
}

export function metricValue(t: Track, i0: number, len: number, metric: MetricKey): number {
  const a = Math.round(i0)
  const b = a + Math.round(len)
  switch (metric) {
    case 'sun':
      return (100 * (t.cumSun[b] - t.cumSun[a])) / (b - a)
    case 'earth':
      return (100 * (t.cumEarth[b] - t.cumEarth[a])) / (b - a)
    case 'both':
      return (100 * (t.cumBoth[b] - t.cumBoth[a])) / (b - a)
    case 'longestDark':
    case 'firstSunset': {
      const s = windowStats(t, a, b - a)
      if (metric === 'longestDark') return s.longestDark
      if (s.startsDark) return 0
      return s.firstSunset ?? s.hours
    }
  }
}
