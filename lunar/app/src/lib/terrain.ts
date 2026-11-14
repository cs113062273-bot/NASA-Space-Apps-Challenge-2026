// In-browser terrain horizon: a port of compute_horizon() in lunar/pipeline/lunar_geo.py.
// South of 75°S it uses 80 m tiles (near field) and a 480 m grid (far field);
// elsewhere the 1.9 km whole-Moon grid (LDEM_16) for both.

import { DSN_MIN_EL_DEG, R0_KM, siteFrame, stationAtVector, visibleSunFraction } from './astro'

const R0 = 1737400

export interface TerrainMeta {
  factor: number
  near: { scale: number; x0: number; y0: number; n: number; tile: number; tiles: number }
  far: { scale: number; x0: number; y0: number; n: number }
  globe: GlobeMeta
}

/** Whole-Moon lat/lon grid in tiles; pixel centres lat = 90 - (row + 0.5) / res, lon = (col + 0.5) / res. */
export interface GlobeMeta {
  res: number
  tile: number
  rows: number
  cols: number
  m_per_px: number
}

export async function inflate(buf: ArrayBuffer): Promise<Int16Array> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  const raw = await new Response(stream).arrayBuffer()
  return new Int16Array(raw)
}

/** Undo the row-delta encoding in place (int16 wraparound matches the encoder). */
export function undelta(a: Int16Array, width: number) {
  for (let r = 0; r < a.length; r += width) {
    for (let c = 1; c < width; c++) a[r + c] = (a[r + c] + a[r + c - 1]) << 16 >> 16
  }
  return a
}

export interface Grid {
  data: Int16Array | null
  scale: number
  x0: number
  y0: number
  rows: number
  cols: number
  factor: number
  nodata?: number
}

/** Bilinear height (m) or NaN outside / unloaded. */
export function sampleGrid(g: Grid, x: number, y: number): number {
  if (!g.data) return NaN
  const c = (x - g.x0) / g.scale
  const r = (g.y0 - y) / g.scale
  if (c < 0 || r < 0 || c > g.cols - 1 || r > g.rows - 1) return NaN
  const c0 = Math.min(Math.floor(c), g.cols - 2)
  const r0 = Math.min(Math.floor(r), g.rows - 2)
  const fc = c - c0
  const fr = r - r0
  const d = g.data
  const i = r0 * g.cols + c0
  if(g.nodata!==undefined&&[d[i],d[i+1],d[i+g.cols],d[i+g.cols+1]].some(v=>v===g.nodata))return NaN
  const top = d[i] * (1 - fc) + d[i + 1] * fc
  const bot = d[i + g.cols] * (1 - fc) + d[i + g.cols + 1] * fc
  return (top * (1 - fr) + bot * fr) * g.factor
}

export function toXY(latDeg: number, lonDeg: number): [number, number] {
  const rho = 2 * R0 * Math.tan(((90 + latDeg) * Math.PI) / 360)
  const lo = (lonDeg * Math.PI) / 180
  return [rho * Math.sin(lo), rho * Math.cos(lo)]
}

// ray sampling [from, to, step] in metres, matched to each grid's resolution
const POLAR_SEGS: [number, number, number][] = [[20, 2_000, 20], [2_000, 10_000, 40], [10_000, 25_000, 80], [25_000, 60_000, 240], [60_000, 300_000, 480]]
const GLOBE_SEGS: [number, number, number][] = [[50, 2_000, 50], [2_000, 25_000, 250], [25_000, 300_000, 950]]

/** Distances (m) along each azimuth: fine near the observer, coarse far away. */
export function rayDistances(segs = POLAR_SEGS): Float64Array {
  const out: number[] = []
  for (const [a, b, s] of segs) for (let d = a; d < b; d += s) out.push(d)
  return Float64Array.from(out)
}

export interface HorizonResult {
  elev: Float32Array // degrees per azimuth bin
  groundM: number
}

/** Terrain height (m) at a point given in radians, or NaN where there is no data. */
export type Sampler = (latRad: number, lonRad: number) => number

/** Polar-stereographic grid as a sampler. */
export function polarSampler(g: Grid): Sampler {
  return (la, lo) => {
    const rho = 2 * R0 * Math.tan((Math.PI / 2 - Math.abs(la)) / 2)
    return la < 0 ? sampleGrid(g, rho * Math.sin(lo), rho * Math.cos(lo)) : NaN
  }
}

/** Whole-Moon tiles (index row * cols + col, null where not loaded) as a bilinear sampler. */
export function globeSampler(m: GlobeMeta, tiles: (Int16Array | null)[], factor: number): Sampler {
  const nR = m.rows * m.tile
  const nC = m.cols * m.tile
  const px = (R: number, C: number) => {
    R = Math.max(0, Math.min(nR - 1, R))
    C = ((C % nC) + nC) % nC
    const t = tiles[Math.floor(R / m.tile) * m.cols + Math.floor(C / m.tile)]
    return t ? t[(R % m.tile) * m.tile + (C % m.tile)] : NaN
  }
  const k = (180 / Math.PI) * m.res
  return (la, lo) => {
    const r = (Math.PI / 2 - la) * k - 0.5
    const c = lo * k - 0.5
    const r0 = Math.floor(r)
    const c0 = Math.floor(c)
    const fr = r - r0
    const fc = c - c0
    const top = px(r0, c0) * (1 - fc) + px(r0, c0 + 1) * fc
    const bot = px(r0 + 1, c0) * (1 - fc) + px(r0 + 1, c0 + 1) * fc
    return (top * (1 - fr) + bot * fr) * factor
  }
}

/** Indices of the whole-Moon tiles within `radius` of a site (all longitudes near a pole). */
export function globeTilesFor(m: GlobeMeta, lat: number, lon: number, radius = 300_000): number[] {
  const dl = ((radius / R0) * 180) / Math.PI + 0.5
  const span = m.tile / m.res
  const r1 = Math.max(0, Math.floor((90 - (lat + dl)) / span))
  const r2 = Math.min(m.rows - 1, Math.floor((90 - (lat - dl)) / span))
  const edge = Math.max(Math.abs(lat - dl), Math.abs(lat + dl))
  const dlon = edge >= 89 ? 180 : dl / Math.cos((edge * Math.PI) / 180)
  const cols = new Set<number>()
  if (dlon >= 180) for (let c = 0; c < m.cols; c++) cols.add(c)
  else for (let c = Math.floor((lon - dlon) / span); c <= Math.floor((lon + dlon) / span); c++) cols.add(((c % m.cols) + m.cols) % m.cols)
  const out: number[] = []
  for (let r = r1; r <= r2; r++) for (const c of cols) out.push(r * m.cols + c)
  return out
}

/** Polar terrain horizon: 80 m near field within `nearRadius`, 480 m beyond. */
export function computeHorizon(lat: number, lon: number, near: Grid, far: Grid, observerM = 2, nAz = 720, nearRadius = 25_000): HorizonResult {
  return traceHorizon(lat, lon, polarSampler(near), polarSampler(far), observerM, nAz, nearRadius, rayDistances(POLAR_SEGS))
}

/** Horizon anywhere on the Moon from the 1.9 km whole-Moon grid. */
export function computeHorizonGlobal(lat: number, lon: number, globe: Sampler, observerM = 2, nAz = 720): HorizonResult {
  return traceHorizon(lat, lon, globe, globe, observerM, nAz, 0, rayDistances(GLOBE_SEGS))
}

/**
 * Terrain horizon with lunar curvature. `near` covers up to `nearRadius`, `far` beyond (and fills gaps).
 * elev = atan2(Rt cos t - Ro, Rt sin t) maximised along each ray.
 */
export function traceHorizon(lat: number, lon: number, near: Sampler, far: Sampler, observerM: number, nAz: number, nearRadius: number, d: Float64Array): HorizonResult {
  const la1 = (lat * Math.PI) / 180
  const lo1 = (lon * Math.PI) / 180
  let ground = near(la1, lo1)
  if (!Number.isFinite(ground)) ground = far(la1, lo1)
  if (!Number.isFinite(ground)) throw new Error('Outside terrain coverage')
  const ro = R0 + ground + observerM
  const nd = d.length
  const cosT = new Float64Array(nd)
  const sinT = new Float64Array(nd)
  for (let k = 0; k < nd; k++) {
    cosT[k] = Math.cos(d[k] / R0)
    sinT[k] = Math.sin(d[k] / R0)
  }
  const sl = Math.sin(la1)
  const cl = Math.cos(la1)
  const so=Math.sin(lo1),co=Math.cos(lo1)
  const elev = new Float32Array(nAz)
  for (let j = 0; j < nAz; j++) {
    const az = ((j + 0.5) * 2 * Math.PI) / nAz
    const sa = Math.sin(az)
    const ca = Math.cos(az)
    const tx=-sl*co*ca-so*sa,ty=-sl*so*ca+co*sa,tz=cl*ca
    let best = -90
    for (let k = 0; k < nd; k++) {
      const sd = sinT[k]
      const cd = cosT[k]
      const vx=cl*co*cd+tx*sd,vy=cl*so*cd+ty*sd,vz=sl*cd+tz*sd
      const lat2=Math.atan2(vz,Math.hypot(vx,vy)),lon2=Math.atan2(vy,vx)
      let h = d[k] < nearRadius ? near(lat2, lon2) : NaN
      if (!Number.isFinite(h)) h = far(lat2, lon2)
      if (!Number.isFinite(h)) continue
      const rt = R0 + h
      const e = Math.atan2(rt * cd - ro, rt * sd)
      if (e > best) best = e
    }
    elev[j] = best === -90 ? -90 : (best * 180) / Math.PI
  }
  return { elev, groundM: ground }
}

// ---- light at one moment: a single-azimuth horizon march per point ----
const SHADE_D: number[] = []
for (let d = 60; d < 300_000; d *= 1.035) SHADE_D.push(d)
const SHADE_CA = SHADE_D.map((d) => Math.cos(d / R0))
const SHADE_SA = SHADE_D.map((d) => Math.sin(d / R0))

/**
 * Visible fraction of a body's disk at polar-stereographic point (x, y), 2 m above the terrain: march along the
 * ground toward the body's azimuth (60 m, growing 3.5% a step, to 300 km) and keep the highest terrain angle, the
 * same horizon method as the sites. `body` is its position in km (MOON_ME, from the Moon's centre), so each point
 * gets its own direction (Earth's parallax included). Null where there is no terrain.
 */
export function stationFractionAt(hAt: (x: number, y: number) => number, x: number, y: number, stations: Float32Array, observerM = 2, clearanceDeg = 0): number | null {
  const ground = hAt(x, y)
  if (!Number.isFinite(ground)) return null
  const lat = -90 + 2 * Math.atan(Math.hypot(x, y) / (2 * R0)) * 180 / Math.PI
  const lon = Math.atan2(x, y) * 180 / Math.PI
  const f = siteFrame(lat, lon, R0_KM + (ground + observerM) / 1000)
  for (let j = 0; j < 3; j++) {
    const k = j * 9
    if (stationAtVector(f, stations, k).receiverEl < DSN_MIN_EL_DEG) continue
    if (bodyFractionAt(hAt, x, y, [stations[k], stations[k + 1], stations[k + 2]], 0, undefined, observerM, clearanceDeg)) return 1
  }
  return 0
}

export function bodyFractionAt(hAt: (x: number, y: number) => number, x: number, y: number, body: number[], radiusKm: number, occluder?: number[], observerM = 2, clearanceDeg = 0): number | null {
  const h0 = hAt(x, y)
  if (!Number.isFinite(h0)) return null
  const D = 180 / Math.PI
  const rho0 = Math.hypot(x, y)
  const la = -90 + 2 * Math.atan(rho0 / (2 * R0)) * D
  const lo = Math.atan2(x, y)
  const cl = Math.cos(la / D), sl = Math.sin(la / D), co = Math.cos(lo), so = Math.sin(lo)
  const u0 = cl * co, u1 = cl * so, u2 = sl
  const rP = R0 + h0 + observerM
  const bx = body[0] * 1000 - rP * u0, by = body[1] * 1000 - rP * u1, bz = body[2] * 1000 - rP * u2
  const bl = Math.hypot(bx, by, bz)
  const el = Math.asin((bx * u0 + by * u1 + bz * u2) / bl) * D
  const rad = Math.asin((radiusKm * 1000) / bl) * D
  // horizontal direction toward the body (east, north components)
  const be = (-bx * so + by * co) / bl
  const bn = (-bx * sl * co - by * sl * so + bz * cl) / bl
  const bh = Math.hypot(be, bn) || 1
  const t0 = (be * -so + bn * -sl * co) / bh, t1 = (be * co + bn * -sl * so) / bh, t2 = (bn * cl) / bh
  let maxEl = -90
  for (let k = 0; k < SHADE_D.length; k++) {
    const ca = SHADE_CA[k], sa = SHADE_SA[k]
    const qx = ca * u0 + sa * t0, qy = ca * u1 + sa * t1, qz = ca * u2 + sa * t2
    // south polar stereographic straight from the unit vector
    const hyp = Math.hypot(qx, qy) || 1e-12
    const rho = 2 * R0 * Math.sqrt(Math.max(0, (1 + qz) / (1 - qz)))
    const hq = hAt((rho * qy) / hyp, (rho * qx) / hyp)
    if (!Number.isFinite(hq)) break
    const rq = R0 + hq
    const e2 = Math.atan2(rq * ca - rP, rq * sa) * D
    if (e2 > maxEl) {
      maxEl = e2
      if (maxEl > el + rad - clearanceDeg) return 0 // the whole disk (or centre + selected clearance) is hidden
    }
  }
  if (radiusKm === 0) return el - maxEl >= clearanceDeg ? 1 : 0
  if (occluder) {
    // the Sun with Earth in front of it: the share above this pixel's skyline and outside Earth's disk, as in the site engine
    const ox = occluder[0] * 1000 - rP * u0, oy = occluder[1] * 1000 - rP * u1, oz = occluder[2] * 1000 - rP * u2
    const ol = Math.hypot(ox, oy, oz)
    const azOf = (e: number, n: number) => ((Math.atan2(e, n) * D) % 360 + 360) % 360
    const s = { az: azOf(be, bn), el, dist: bl / 1000 }
    const e = { az: azOf((-ox * so + oy * co) / ol, (-ox * sl * co - oy * sl * so + oz * cl) / ol), el: Math.asin((ox * u0 + oy * u1 + oz * u2) / ol) * D, dist: ol / 1000 }
    return visibleSunFraction(s, maxEl, e)
  }
  const z = Math.max(-1, Math.min(1, (el - maxEl) / rad))
  return (Math.asin(z) + z * Math.sqrt(1 - z * z) + Math.PI / 2) / Math.PI
}
