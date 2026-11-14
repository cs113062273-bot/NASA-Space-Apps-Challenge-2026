import { describe, expect, it } from 'vitest'
import { Track, windowStats } from '../src/lib/metrics'

/** Synthetic track from a 0/1 sunlight pattern (Earth always visible). */
function track(sun: number[]): Track {
  const n = sun.length
  const t: Track = {
    sunFrac: Float32Array.from(sun), sunClear: Float32Array.from(sun, (v) => (v ? 1 : -1)), sunEl: new Float32Array(n), sunR: new Float32Array(n).fill(0.2666), sunAz: new Float32Array(n),
    earthClear: new Float32Array(n).fill(5), earthEl: new Float32Array(n).fill(5), earthAz: new Float32Array(n),
    cumSun: new Float64Array(n + 1), cumSunUp: new Float64Array(n + 1), cumEarth: new Float64Array(n + 1), cumBoth: new Float64Array(n + 1), earthMinClear: 0, eclipsed: new Uint8Array(n), dsn: null, requireDsn: false,
  }
  for (let i = 0; i < n; i++) {
    t.cumSun[i + 1] = t.cumSun[i] + sun[i]
    t.cumSunUp[i + 1] = t.cumSunUp[i] + (sun[i] > 0 ? 1 : 0)
    t.cumEarth[i + 1] = t.cumEarth[i] + 1
    t.cumBoth[i + 1] = t.cumBoth[i] + (sun[i] > 0 ? 1 : 0)
  }
  return t
}

describe('longest darkness and window edges', () => {
  it('flags darkness that runs into the end of the window', () => {
    const s = windowStats(track([1, 1, 0, 0, 0]), 0, 5)
    expect([s.longestDark, s.darkOpenEnded]).toEqual([3, true])
    expect(s.firstSunset).toBeGreaterThan(1)
    expect(s.firstSunset).toBeLessThan(2.01)
  })
  it('flags darkness that starts at the beginning', () => {
    const s = windowStats(track([0, 0, 1, 1, 0, 1]), 0, 6)
    expect([s.longestDark, s.darkOpenEnded, s.startsDark]).toEqual([2, true, true])
  })
  it('does not flag an interior night', () => {
    expect(windowStats(track([1, 0, 0, 1, 0, 1]), 0, 6).darkOpenEnded).toBe(false)
    expect(windowStats(track([1, 0, 0, 0, 1, 0, 0]), 0, 7)).toMatchObject({ longestDark: 3, darkOpenEnded: false })
  })
  it('reports no darkness and no sunset when always lit', () => {
    expect(windowStats(track([1, 1, 1, 1]), 0, 4)).toMatchObject({ longestDark: 0, darkOpenEnded: false, firstSunset: null })
  })
})

import { incidence } from '../src/lib/power'
describe('solar array incidence', () => {
  it('vertical tracking panels catch a low Sun, flat panels do not', () => {
    expect(incidence('tracking', 0, 1)).toBeCloseTo(Math.cos(Math.PI / 180), 6)
    expect(incidence('horizontal', 0, 1)).toBeCloseTo(Math.sin(Math.PI / 180), 6)
    expect(incidence('fixed', 90, 0, 0)).toBeCloseTo(0, 6)
    expect(incidence('fixed', 180, 0, 0)).toBe(0)
  })
})

import { powerStats } from '../src/lib/power'
import { AU_KM, Ephemeris } from '../src/lib/astro'
describe('battery', () => {
  // Sun at 1 au; tracking array at 0° elevation gives 1361 × area × efficiency W while lit
  const n = 12
  const eph: Ephemeris = { startUnix: 0, stepS: 3600, count: n, data: Float32Array.from({ length: n * 6 }, (_, k) => (k % 6 === 0 ? AU_KM : 0)) }
  const p = { mode: 'tracking' as const, facingAz: 0, areaM2: 1, efficiency: 100 / 1361, loadW: 50, batteryWh: 125 }
  it('carries the load into the dark until the stored energy is gone', () => {
    const st = powerStats(eph, track([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]), 0, n, p)
    expect(st.emptyAt).toBeCloseTo(4 + 125 / 50, 6) // 2.5 h after sunset
    expect(st.unpoweredH).toBeCloseTo(n - 6.5, 6)
    expect(st.batteryNeededWh).toBeCloseTo(8 * 50, 6)
  })
  it('recharges in sunlight and never runs flat when big enough', () => {
    const st = powerStats(eph, track([0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1]), 0, n, { ...p, batteryWh: 100 })
    expect(st.emptyAt).toBeNull()
    expect(Math.max(...st.soc)).toBeLessThanOrEqual(100)
  })
})

import { globeSampler, globeTilesFor } from '../src/lib/terrain'
describe('whole-Moon tiles', () => {
  const m = { res: 16, tile: 240, rows: 12, cols: 24, m_per_px: 1895 }
  it('covers 300 km around a site, wrapping across 0°E', () => {
    const t = globeTilesFor(m, 0, 1)
    const cols = new Set(t.map((i) => i % m.cols))
    expect(cols.has(0) && cols.has(23)).toBe(true) // 1°E reaches back past 0° into the last column
    expect(new Set(t.map((i) => Math.floor(i / m.cols)))).toEqual(new Set([5, 6]))
  })
  it('takes every longitude near a pole', () => {
    expect(new Set(globeTilesFor(m, 85, 10).map((i) => i % m.cols)).size).toBe(24)
  })
  it('samples bilinearly across tile edges and wraps in longitude', () => {
    // each tile is filled with its column index, so heights step at tile edges
    const tiles = Array.from({ length: m.rows * m.cols }, (_, i) => new Int16Array(m.tile * m.tile).fill(i % m.cols))
    const s = globeSampler(m, tiles, 1)
    const D = Math.PI / 180
    expect(s(0, 7.5 * D)).toBe(0) // middle of column 0
    expect(s(0, 15 * D)).toBeCloseTo(0.5, 6) // exactly on the 0|1 edge
    expect(s(0, 360 * D + 7.5 * D)).toBe(0) // wraps
    expect(s(0, -0.0001 * D)).toBeGreaterThan(11) // just west of 0°E is the last column (23), blended with column 0
  })
})

import { DEFAULT_RADIO, gOverT, linkStats, rateBps } from '../src/lib/link'
describe('downlink to the DSN', () => {
  it('matches a hand link budget and scales as it should', () => {
    // X band, 10 W, 12 dBi, 384 400 km: path loss 222.65 dB, G/T on the Moon 68.3 − 10 log 211 = 45.06 dB/K,
    // C/N0 = 10 + 12 − 222.65 − 2 + 45.06 + 228.6 = 71.0 dB-Hz; minus 2.5 dB Eb/N0 and 3 dB margin: 65.5 dB-bit/s
    const r = rateBps(DEFAULT_RADIO, 384_400)
    expect(r / 10 ** 6.5503).toBeCloseTo(1, 2)
    expect(rateBps({ ...DEFAULT_RADIO, txW: 100 }, 384_400) / r).toBeCloseTo(10, 6)
    expect(rateBps(DEFAULT_RADIO, 2 * 384_400) / r).toBeCloseTo(0.25, 6)
    // the Moon in the beam costs a 34 m antenna about 10 dB at X band and 7.4 dB at S band (DSN 810-005, Morabito 2006)
    expect(gOverT('X', false) - gOverT('X', true)).toBeCloseTo(9.82, 1)
    expect(gOverT('S', false) - gOverT('S', true)).toBeCloseTo(7.43, 1)
  })
  it('counts contact only while Earth is up and a DSN complex sees the Moon', () => {
    const n = 8
    const eph: Ephemeris = { startUnix: 0, stepS: 3600, count: n, data: Float32Array.from({ length: n * 6 }, (_, k) => (k % 6 === 3 ? 384_400 : k % 6 === 0 ? AU_KM : 0)) }
    eph.dsn = Uint8Array.from([1, 1, 0, 0, 2, 4, 4, 1])
    const t = track(new Array(n).fill(1))
    t.earthClear = Float32Array.from([5, 5, 5, 5, 5, -1, 5, 5])
    const st = linkStats(eph, t, 0, n, DEFAULT_RADIO)
    expect(Array.from(st.state)).toEqual([2, 2, 1, 1, 2, 0, 2, 2])
    expect(st.contactH).toBe(5)
    expect(st.longestGapH).toBe(2)
    expect(st.longestGapStart).toBe(2)
    expect(st.bits / (5 * 3600 * rateBps(DEFAULT_RADIO, 384_400))).toBeCloseTo(1, 6)
  })
})
