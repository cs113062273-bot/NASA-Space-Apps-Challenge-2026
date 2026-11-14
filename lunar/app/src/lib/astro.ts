// Geometry shared by every view. Mirrors lunar/pipeline/lunar_geo.py (the reference
// implementation); tests check the two agree.

export const R0_KM = 1737.4
export const SUN_RADIUS_KM = 696_000
export const EARTH_RADIUS_KM = 6_371
export const AU_KM = 149_597_870.7
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

export interface Ephemeris {
  sha256?:string // actual retained six-channel body-vector file, when loaded by the app
  startUnix: number
  stepS: number
  count: number
  data: Float32Array // per sample: sun km xyz, earth km xyz (MOON_ME, from the Moon's centre)
  dsn?: Uint8Array // per sample: bit k set when DSN complex k (Goldstone, Madrid, Canberra) sees the Moon >= 10°
  stations?: StationEphemeris
}

export const DSN_STATIONS = ['Goldstone', 'Madrid', 'Canberra']
export const DSN_ANTENNAS = ['DSS-24', 'DSS-54', 'DSS-34']
export const DSN_MIN_EL_DEG = 10

export interface StationEphemeris {
  data: Float32Array // per epoch, 3 stations × (target xyz, receiver-to-Moon xyz, receiver zenith xyz)
  sha256?: string
  orientation: {
    recent_kernel_until_unix: number
    recent_ground_stress_deg: number
    long_term_ground_stress_deg: number
    recent_aim_stress_deg: number
    long_term_aim_stress_deg: number
  }
}

export interface SourceLoadProgress {file:string;loaded:number;total:number|null}
export async function loadEphemeris(base = './data/',onProgress?:(p:SourceLoadProgress)=>void): Promise<Ephemeris> {
  const checked = async (name: string) => {
    const response = await fetch(`${base}${name}`)
    if (!response.ok) throw new Error(`Cannot load ${name}: HTTP ${response.status}`)
    return response
  }
  const binary=async(name:string)=>{
    const response=await checked(name)
    if(!onProgress||!response.body)return response.arrayBuffer()
    const size=Number(response.headers.get('content-length')),total=size>0&&!response.headers.get('content-encoding')?size:null
    const reader=response.body.getReader(),chunks:Uint8Array[]=[],emit=(loaded:number)=>onProgress({file:name,loaded,total})
    let loaded=0,last=0;emit(0)
    while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);loaded+=value.length;if(performance.now()-last>80){emit(loaded);last=performance.now()}}
    const bytes=new Uint8Array(loaded);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}emit(loaded)
    return bytes.buffer
  }
  const [meta, buf, dsn, stationMeta, stationBuffer] = await Promise.all([
    checked('ephemeris.json').then((r) => r.json()),
    binary('ephemeris.f32'),
    fetch(`${base}dsn.u8`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
    checked('stations.json').then((r) => r.json()),
    binary('stations.f32'),
  ])
  if (buf.byteLength !== meta.count * 6 * 4) throw new Error('Invalid ephemeris data length')
  if (stationMeta.schema !== 1 || stationMeta.stride !== 27 || stationMeta.count !== meta.count
    || stationMeta.start_unix !== meta.start_unix || stationMeta.step_s !== meta.step_s
    || stationBuffer.byteLength !== meta.count * 27 * 4 || stationMeta.bytes !== stationBuffer.byteLength
    || stationMeta.stations?.map((s: { id: string }) => s.id).join(',') !== '399024,399054,399034') {
    throw new Error('Station geometry does not match the ephemeris')
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', stationBuffer))].map(b => b.toString(16).padStart(2, '0')).join('')
  if (digest !== stationMeta.sha256) throw new Error('Station geometry checksum mismatch')
  const orientation = stationMeta.earth_orientation as StationEphemeris['orientation']
  if (!orientation || !['recent_kernel_until_unix', 'recent_ground_stress_deg', 'long_term_ground_stress_deg', 'recent_aim_stress_deg', 'long_term_aim_stress_deg']
      .every(key => Number.isFinite((orientation as unknown as Record<string, unknown>)[key]) && Number((orientation as unknown as Record<string, unknown>)[key]) >= 0)) {
    throw new Error('Invalid station orientation metadata')
  }
  const bodySha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buf))].map(b=>b.toString(16).padStart(2,'0')).join('')
  const eph: Ephemeris = { sha256:bodySha,startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count, data: new Float32Array(buf) }
  if (dsn && dsn.byteLength === meta.count) eph.dsn = new Uint8Array(dsn)
  eph.stations = { data: new Float32Array(stationBuffer), orientation, sha256: digest }
  return eph
}

/** Keep every geometry channel aligned when computing a short mission window. */
export function sliceEphemeris(eph: Ephemeris, first: number, count: number): Ephemeris {
  return { ...eph, startUnix: timeOf(eph, first), count,
    data: eph.data.subarray(first * 6, (first + count) * 6), dsn: eph.dsn?.subarray(first, first + count),
    stations: eph.stations ? { ...eph.stations, data: eph.stations.data.subarray(first * 27, (first + count) * 27) } : undefined }
}

/** Transmit aim at a moving reference antenna and the matching reception elevation.
 * Vectors include light time and stellar aberration; the small lander-origin approximation is cross-checked in SPICE.
 */
export function stationAt(eph: Ephemeris, f: SiteFrame, index: number, station: number): AzEl & { receiverEl: number } {
  if (!eph.stations) throw new Error('Station geometry unavailable')
  return stationAtVector(f, eph.stations.data, index * 27 + station * 9)
}

/** One station record, also shared by the terrain worker and smooth-Moon map. */
export function stationAtVector(f: SiteFrame, d: ArrayLike<number>, k = 0): AzEl & { receiverEl: number } {
  const aim = bodyAtVector(f, [d[k], d[k + 1], d[k + 2]])
  const x = d[k + 3] + f.pos[0], y = d[k + 4] + f.pos[1], z = d[k + 5] + f.pos[2]
  const dot = (x * d[k + 6] + y * d[k + 7] + z * d[k + 8]) / Math.hypot(x, y, z)
  return { ...aim, receiverEl: Math.asin(Math.max(-1, Math.min(1, dot))) * R2D }
}

export const indexOf = (eph: Ephemeris, unixS: number) => (unixS - eph.startUnix) / eph.stepS
export const timeOf = (eph: Ephemeris, index: number) => eph.startUnix + index * eph.stepS

/** Topocentric frame of a surface site. */
export interface SiteFrame {
  e: [number, number, number]
  n: [number, number, number]
  u: [number, number, number]
  pos: [number, number, number] // km, MOON_ME
}

export function siteFrame(latDeg: number, lonDeg: number, radiusKm = R0_KM): SiteFrame {
  const la = latDeg * D2R
  const lo = lonDeg * D2R
  const u: [number, number, number] = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  return {
    e: [-Math.sin(lo), Math.cos(lo), 0],
    n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    u,
    pos: [u[0] * radiusKm, u[1] * radiusKm, u[2] * radiusKm],
  }
}

export interface AzEl {
  az: number // deg, clockwise from north
  el: number // deg above the local horizontal
  dist: number // km
}

function azel(f: SiteFrame, x: number, y: number, z: number): AzEl {
  const ve = x * f.e[0] + y * f.e[1] + z * f.e[2]
  const vn = x * f.n[0] + y * f.n[1] + z * f.n[2]
  const vu = x * f.u[0] + y * f.u[1] + z * f.u[2]
  const az = ((Math.atan2(ve, vn) * R2D) % 360 + 360) % 360
  return { az, el: Math.atan2(vu, Math.hypot(ve, vn)) * R2D, dist: Math.hypot(x, y, z) }
}

/** Sun az/el at a (fractional) ephemeris index. */
export function sunAt(eph: Ephemeris, f: SiteFrame, index: number): AzEl {
  return bodyAtVector(f, sample(eph, index, 0))
}

/** Earth az/el, topocentric (Earth's parallax is ~1 deg and is applied). */
export function earthAt(eph: Ephemeris, f: SiteFrame, index: number): AzEl {
  return bodyAtVector(f, sample(eph, index, 3))
}

/** The same topocentric geometry when a map worker already has the body vector. */
export function bodyAtVector(f: SiteFrame, body: readonly number[]): AzEl {
  return azel(f, body[0] - f.pos[0], body[1] - f.pos[1], body[2] - f.pos[2])
}

/** Sun (off 0) or Earth (off 3) position, km in MOON_ME from the Moon's centre, at a fractional index. */
export const bodyVector = (eph: Ephemeris, index: number, body: 'sun' | 'earth') => sample(eph, index, body === 'sun' ? 0 : 3)

function sample(eph: Ephemeris, index: number, off: number): [number, number, number] {
  const i = Math.max(0, Math.min(eph.count - 1.000001, index))
  const k = Math.floor(i)
  const t = i - k
  const a = k * 6 + off
  const b = a + 6
  const d = eph.data
  return [d[a] * (1 - t) + d[b] * t, d[a + 1] * (1 - t) + d[b + 1] * t, d[a + 2] * (1 - t) + d[b + 2] * t]
}

/** Terrain horizon as elevation (deg) per azimuth bin, bins centred at (i + 0.5) * 360 / n. */
export class Horizon {
  readonly elev: Float32Array
  constructor(centideg: ArrayLike<number>) {
    this.elev = Float32Array.from(centideg, (v) => v / 100)
  }
  get bins() {
    return this.elev.length
  }
  at(azDeg: number): number {
    const n = this.elev.length
    const p = (((azDeg % 360) + 360) % 360) * (n / 360) - 0.5
    const k = Math.floor(p)
    const t = p - k
    const a = this.elev[(k + n) % n]
    const b = this.elev[(k + 1) % n]
    return a * (1 - t) + b * t
  }
  max(): number {
    let m = -90
    for (const v of this.elev) m = Math.max(m, v)
    return m
  }
}

/**
 * Share of the Sun's disk NOT covered by Earth's disk, seen from the site: below 1 only during an eclipse
 * of the Sun by Earth (a lunar eclipse seen from Earth). Small-angle overlap of two circles.
 */
export function earthShadowFactor(s: AzEl, e: AzEl): number {
  const rs = sunRadiusDeg(s.dist)
  const re = earthRadiusDeg(e.dist)
  const cs = Math.cos(s.el * D2R)
  const ce = Math.cos(e.el * D2R)
  const dot = cs * ce * Math.cos((s.az - e.az) * D2R) + Math.sin(s.el * D2R) * Math.sin(e.el * D2R)
  const d = Math.acos(Math.max(-1, Math.min(1, dot))) * R2D
  if (d >= rs + re) return 1
  if (d <= re - rs) return 0 // Earth (about 1.9° across) covers the whole Sun (0.53°)
  // lens area of the overlap, divided by the Sun's area
  const a1 = rs * rs * Math.acos((d * d + rs * rs - re * re) / (2 * d * rs))
  const a2 = re * re * Math.acos((d * d + re * re - rs * rs) / (2 * d * re))
  const a3 = 0.5 * Math.sqrt(Math.max(0, (-d + rs + re) * (d + rs - re) * (d - rs + re) * (d + rs + re)))
  return Math.max(0, 1 - (a1 + a2 - a3) / (Math.PI * rs * rs))
}

/**
 * Angular gap (deg) between the Sun–Earth centre separation and the separation below which Earth covers the
 * whole Sun: negative during the total part of an eclipse. Changes smoothly, so it can be interpolated in time.
 */
export function eclipseGap(s: AzEl, e: AzEl): number {
  const cs = Math.cos(s.el * D2R)
  const ce = Math.cos(e.el * D2R)
  const dot = cs * ce * Math.cos((s.az - e.az) * D2R) + Math.sin(s.el * D2R) * Math.sin(e.el * D2R)
  return Math.acos(Math.max(-1, Math.min(1, dot))) * R2D - (earthRadiusDeg(e.dist) - sunRadiusDeg(s.dist))
}

/** Adaptive quadrature on a smooth piece of the solar disk. */
function integrate(f: (x: number) => number, a: number, b: number, tolerance: number): number {
  const mid = (a + b) / 2
  const fa = f(a), fm = f(mid), fb = f(b)
  const whole = (b - a) * (fa + 4 * fm + fb) / 6
  const split = (lo: number, hi: number, fl: number, fc: number, fh: number, sum: number, eps: number, depth: number): number => {
    const centre = (lo + hi) / 2
    const leftMid = (lo + centre) / 2, rightMid = (centre + hi) / 2
    const leftVal = f(leftMid), rightVal = f(rightMid)
    const left = (centre - lo) * (fl + 4 * leftVal + fc) / 6
    const right = (hi - centre) * (fc + 4 * rightVal + fh) / 6
    const delta = left + right - sum
    if (depth === 0 || Math.abs(delta) <= 15 * eps) return left + right + delta / 15
    return split(lo, centre, fl, leftVal, fc, left, eps / 2, depth - 1)
      + split(centre, hi, fc, rightVal, fh, right, eps / 2, depth - 1)
  }
  return split(a, b, fa, fm, fb, whole, tolerance, 16)
}

/**
 * Share of the Sun's disk that is both above the terrain horizon and not behind Earth. The two coverings can
 * overlap, so their separate remaining shares do not multiply. Uniform disk, locally flat horizon at `horizonEl`
 * (deg); when both cover part of the disk the common area is integrated in strips on the sky plane around the Sun.
 */
export function visibleSunFraction(s: AzEl, horizonEl: number, e: AzEl): number {
  const rs = sunRadiusDeg(s.dist)
  const terrain = diskFraction(s.el, horizonEl, rs)
  if (terrain === 0) return 0
  const shade = earthShadowFactor(s, e)
  if (shade === 1 || shade === 0) return terrain * shade
  if (terrain === 1) return shade
  const re = earthRadiusDeg(e.dist)
  // sky-plane axes at the Sun: x to the right (increasing azimuth), y up (toward the zenith)
  const v = (az: number, el: number) => [Math.cos(el * D2R) * Math.sin(az * D2R), Math.cos(el * D2R) * Math.cos(az * D2R), Math.sin(el * D2R)]
  const sv = v(s.az, s.el)
  const ev = v(e.az, e.el)
  const zs = sv[2]
  let up = [-zs * sv[0], -zs * sv[1], 1 - zs * zs]
  const un = Math.hypot(up[0], up[1], up[2]) || 1
  up = up.map((x) => x / un)
  const right = [sv[1] * up[2] - sv[2] * up[1], sv[2] * up[0] - sv[0] * up[2], sv[0] * up[1] - sv[1] * up[0]]
  const es = ev[0] * sv[0] + ev[1] * sv[1] + ev[2] * sv[2]
  const dx = Math.atan2(ev[0] * right[0] + ev[1] * right[1] + ev[2] * right[2], es) * R2D
  const dy = Math.atan2(ev[0] * up[0] + ev[1] * up[1] + ev[2] * up[2], es) * R2D
  const yh = horizonEl - s.el // the skyline, relative to the Sun's centre
  // Integrate only above the skyline. A fixed strip grid can miss a thin visible crescent entirely.
  // Split at the circle intersections and Earth's vertical extremes, where the overlap formula changes.
  const lower = Math.max(-rs, yh)
  const edges = [lower, rs]
  const addEdge = (y: number) => { if (y > lower && y < rs) edges.push(y) }
  addEdge(dy - re)
  addEdge(dy + re)
  const distance = Math.hypot(dx, dy)
  if (distance > 0 && distance < rs + re && distance > Math.abs(re - rs)) {
    const along = (rs * rs - re * re + distance * distance) / (2 * distance)
    const across = Math.sqrt(Math.max(0, rs * rs - along * along))
    addEdge((along * dy + across * dx) / distance)
    addEdge((along * dy - across * dx) / distance)
  }
  edges.sort((a, b) => a - b)
  const strip = (th: number) => {
    const y = rs * Math.sin(th)
    const a = rs * Math.cos(th)
    let covered = 0
    const q = re * re - (y - dy) * (y - dy)
    if (q > 0) {
      const b = Math.sqrt(q)
      covered = Math.max(0, Math.min(a, dx + b) - Math.max(-a, dx - b))
    }
    return Math.max(0, 2 * a - covered) * rs * Math.cos(th)
  }
  let vis = 0
  for (let i = 1; i < edges.length; i++) {
    vis += integrate(strip, Math.asin(edges[i - 1] / rs), Math.asin(edges[i] / rs), rs * rs * 1e-9)
  }
  return Math.max(0, Math.min(terrain, shade, vis / (Math.PI * rs * rs)))
}

/** Fraction of a uniform disk above a locally flat horizon line (circular segment). */
export function diskFraction(centerEl: number, horizonEl: number, radiusDeg: number): number {
  const z = Math.max(-1, Math.min(1, (centerEl - horizonEl) / radiusDeg))
  return (Math.asin(z) + z * Math.sqrt(1 - z * z) + Math.PI / 2) / Math.PI
}

export const sunRadiusDeg = (distKm = AU_KM) => Math.asin(SUN_RADIUS_KM / distKm) * R2D
export const earthRadiusDeg = (distKm: number) => Math.asin(EARTH_RADIUS_KM / distKm) * R2D

/**
 * Earth's phase seen from the site. Sun and Earth directions are taken from the observer; the Sun is
 * 400 times farther than Earth, so Earth sees it in the same direction (parallax under 0.15°).
 * `lit`: illuminated fraction of the disk. `pa`: direction of the bright limb on a sky chart drawn with
 * azimuth increasing to the right and up at the top (radians, canvas convention: 0 = right, π/2 = down).
 */
export function earthPhase(sunAz: number, sunEl: number, earthAz: number, earthEl: number) {
  const v = (az: number, el: number) => {
    const a = az * D2R
    const e = el * D2R
    return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)]
  }
  const s = v(sunAz, sunEl)
  const e = v(earthAz, earthEl)
  const cosAlpha = -(s[0] * e[0] + s[1] * e[1] + s[2] * e[2]) // phase angle at Earth: 0 = full
  // the Sun's direction projected on the sky plane at Earth's position
  const dAz = (sunAz - earthAz) * D2R
  const right = Math.cos(sunEl * D2R) * Math.sin(dAz)
  const up = Math.sin(sunEl * D2R) * Math.cos(earthEl * D2R) - Math.cos(sunEl * D2R) * Math.sin(earthEl * D2R) * Math.cos(dAz)
  return { lit: (1 + cosAlpha) / 2, cosAlpha, pa: Math.atan2(-up, right) }
}

/**
 * Contacts of an eclipse of the Sun by Earth at a site, found minute by minute between two ephemeris indices:
 * first and last minute with any of the Sun covered, and the span with all of it covered (unix s; null when absent).
 */
export function eclipseContacts(eph: Ephemeris, f: SiteFrame, from: number, to: number) {
  let start: number | null = null
  let end: number | null = null
  let totalStart: number | null = null
  let totalEnd: number | null = null
  for (let i = from; i <= to; i += 1 / 60) {
    const k = earthShadowFactor(sunAt(eph, f, i), earthAt(eph, f, i))
    const u = timeOf(eph, i)
    if (k < 1) {
      start ??= u
      end = u
    }
    if (k === 0) {
      totalStart ??= u
      totalEnd = u
    }
  }
  return { start, end, totalStart, totalEnd }
}
