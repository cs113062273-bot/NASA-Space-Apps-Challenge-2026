// Engine checks that run in Node against the shipped data files.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ephemeris, Horizon, earthAt, indexOf, siteFrame, sunAt, R0_KM, diskFraction } from '../src/lib/astro'
import { computeTrack, windowStats } from '../src/lib/metrics'
import { Grid, computeHorizon, computeHorizonGlobal, globeSampler, globeTilesFor, inflate, undelta, toXY } from '../src/lib/terrain'
import { toLatLon as toLatLonPolar } from '../src/lib/data'

const DATA = resolve(__dirname, '../public/data')
const VALID = resolve(__dirname, '../../data/validation')

function loadEph(): Ephemeris {
  const meta = JSON.parse(readFileSync(`${DATA}/ephemeris.json`, 'utf8'))
  const buf = readFileSync(`${DATA}/ephemeris.f32`)
  return { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count, data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) }
}
const sites = JSON.parse(readFileSync(`${DATA}/sites.json`, 'utf8')).sites as { id: string; lat: number; lon: number; ground_m: number; horizons: Record<string, number[]>; dem?: string }[]

describe('Sun and Earth geometry', () => {
  const eph = loadEph()
  const ref = JSON.parse(readFileSync(`${VALID}/horizons-crosscheck.json`, 'utf8'))
  it('matches JPL Horizons topocentric elevation and azimuth within 0.001 deg', () => {
    let worst = 0
    for (const r of ref.rows) {
      const f = siteFrame(r.lat, r.lon, R0_KM)
      const idx = indexOf(eph, Date.parse(`${r.utc}:00Z`) / 1000)
      const p = r.body === 'sun' ? sunAt(eph, f, idx) : earthAt(eph, f, idx)
      const dAz = ((p.az - r.horizons_az + 540) % 360) - 180
      worst = Math.max(worst, Math.abs(p.el - r.horizons_el), Math.abs(dAz) * Math.cos((r.horizons_el * Math.PI) / 180))
    }
    expect(worst).toBeLessThan(0.001)
  })
})

describe('visible-disk model', () => {
  it('is 0 below, 1/2 at, 1 above the horizon', () => {
    expect(diskFraction(-1, 0, 0.27)).toBe(0)
    expect(diskFraction(0, 0, 0.27)).toBeCloseTo(0.5, 12)
    expect(diskFraction(1, 0, 0.27)).toBe(1)
  })
})

describe('mission-window statistics', () => {
  const eph = loadEph()
  const s = sites.find((x) => x.id === 'c2')!
  const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) })
  it('prefix sums agree with direct sums', () => {
    const i0 = 10_000
    const len = 24 * 30
    let sun = 0
    for (let i = i0; i < i0 + len; i++) sun += t.sunFrac[i]
    expect(windowStats(t, i0, len).sunEquivHours).toBeCloseTo(sun, 6)
  })
  it('longest darkness never exceeds the window and first sunset precedes darkness', () => {
    const st = windowStats(t, 20_000, 24 * 60)
    expect(st.longestDark).toBeLessThanOrEqual(st.hours)
    if (st.firstSunset !== null) expect(st.firstSunset).toBeLessThan(st.hours)
  })
})

describe('browser horizon vs pipeline', () => {
  it('80 m browser horizon tracks the 20 m pipeline horizon at curated sites', async () => {
    const meta = JSON.parse(readFileSync(`${DATA}/terrain/terrain.json`, 'utf8'))
    const farRaw = undelta(await inflate(readFileSync(`${DATA}/terrain/far.i16z`).buffer as ArrayBuffer), meta.far.n)
    const far: Grid = { data: farRaw, scale: meta.far.scale, x0: meta.far.x0, y0: meta.far.y0, rows: meta.far.n, cols: meta.far.n, factor: meta.factor }
    const m = meta.near
    const results: Record<string, number> = {}
    for (const id of ['c1', 'shackleton', 'nobile-dm2', 'im2-actual']) {
      const s = sites.find((x) => x.id === id)!
      const [x, y] = toXY(s.lat, s.lon)
      const span = m.tile * m.scale
      const c1 = Math.floor((x - 26_000 - m.x0) / span), c2 = Math.floor((x + 26_000 - m.x0) / span)
      const r1 = Math.floor((m.y0 - (y + 26_000)) / span), r2 = Math.floor((m.y0 - (y - 26_000)) / span)
      const cols = (c2 - c1 + 1) * m.tile
      const data = new Int16Array((r2 - r1 + 1) * m.tile * cols)
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const t = undelta(await inflate(readFileSync(`${DATA}/terrain/near/${r}_${c}.i16z`).buffer as ArrayBuffer), m.tile)
        for (let k = 0; k < m.tile; k++) data.set(t.subarray(k * m.tile, (k + 1) * m.tile), ((r - r1) * m.tile + k) * cols + (c - c1) * m.tile)
      }
      const near: Grid = { data, scale: m.scale, x0: m.x0 + c1 * span, y0: m.y0 - r1 * span, rows: (r2 - r1 + 1) * m.tile, cols, factor: meta.factor }
      const js = computeHorizon(s.lat, s.lon, near, far, 2)
      const ref = s.horizons['2'].map((v) => v / 100)
      const diffs = Array.from(js.elev, (v, k) => Math.abs(v - ref[k])).sort((a, b) => a - b)
      results[id] = diffs[Math.floor(diffs.length / 2)]
      expect(diffs[Math.floor(diffs.length / 2)]).toBeLessThan(0.5)
    }
    console.log('median |dElev| browser(80 m) vs pipeline(20 m), deg:', results)
  }, 120_000)

  it('1.9 km whole-Moon browser horizon vs the 59 m pipeline horizon away from the pole', async () => {
    const meta = JSON.parse(readFileSync(`${DATA}/terrain/terrain.json`, 'utf8'))
    const g = meta.globe
    const results: Record<string, [number, number]> = {}
    for (const s of sites.filter((x) => x.dem?.includes('whole-Moon'))) {
      const tiles: (Int16Array | null)[] = new Array(g.rows * g.cols).fill(null)
      for (const i of globeTilesFor(g, s.lat, s.lon)) {
        tiles[i] = undelta(await inflate(readFileSync(`${DATA}/terrain/globe/${Math.floor(i / g.cols)}_${i % g.cols}.i16z`).buffer as ArrayBuffer), g.tile)
      }
      const js = computeHorizonGlobal(s.lat, s.lon, globeSampler(g, tiles, meta.factor), 2)
      const ref = s.horizons['2'].map((v) => v / 100)
      const diffs = Array.from(js.elev, (v, k) => Math.abs(v - ref[k])).sort((a, b) => a - b)
      results[s.id] = [+diffs[Math.floor(diffs.length / 2)].toFixed(2), +diffs[diffs.length - 1].toFixed(2)]
      expect(diffs[Math.floor(diffs.length / 2)]).toBeLessThan(1.0)
    }
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(10)
    console.log('[median, max] |dElev| browser(1.9 km) vs pipeline(59 m), deg:', results)
  }, 120_000)
})

import { DEFAULT_RADIO, missionBudget } from '../src/lib/link'
import { missionBrief } from '../src/lib/brief'
import { DEFAULT_POWER, powerStats } from '../src/lib/power'
describe('mission brief', () => {
  it('reports the same numbers as the engine, with event windows and limits', () => {
    const eph = loadEph()
    const s = sites.find((x) => x.id === 'blue-ghost')! as unknown as import('../src/lib/data').SiteRecord
    const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
    const i0 = Math.round(indexOf(eph, Date.parse(s.date) / 1000))
    const len = 16 * 24
    const st = windowStats(t, i0, len)
    const bud = missionBudget(eph, t, i0, len, DEFAULT_POWER, DEFAULT_RADIO)
    const md = missionBrief({
      eph, site: s, track: t, landingUnix: Date.parse(s.date) / 1000, i0, len, stats: st, observerM: 2, earthMinClear: 0,
      req: { minDaylightH: 168, maxDarkH: 50, minEarthPct: 40, maxSlopeDeg: 10 },
      pass: { daylight: true, dark: true, earth: true, slope: true },
      power: DEFAULT_POWER, powerStats: bud.power, slip: { days: 365, total: 30, tolerance: 2 }, url: 'https://example.invalid/?site=blue-ghost', skyErr: 0.1,
      radio: DEFAULT_RADIO, link: bud.link, radioW: bud.radioW,
    })
    expect(md).toContain('# Mission brief: Blue Ghost M1')
    // Mare Crisium faces Earth: the downlink section reports contact and a data volume
    // the volume counts only hours the radio has power; the battery runs flat in this 16-day window, so it is below the link limit
    expect(md).toMatch(/## Communication[\s\S]*Data home with the power above: [\d.]+ (GB|MB|TB) \(full power unavailable for [^)]+\); link limit if the radio always had power: [\d.]+ (GB|TB)/)
    expect(md).toContain("plus the radio's 33 W while it transmits")
    expect(md).toContain('Nominal screens: Sun/Earth/slope PASS; selected power FAIL')
    expect(md).toContain('Result: misses a selected check')
    // the 14 March 2025 eclipse (Earth hiding the Sun) splits the sunlight; terrain sunset follows on the 16th
    expect(md).toMatch(/\| Sun up \| before landing \| 14 Mar 2025 0[6-8]:\d\d UTC \|/)
    expect(md).toMatch(/\| Sun up \| 14 Mar 2025 0[8-9]:\d\d UTC \| 16 Mar 2025 19:5\d UTC \|/)
    expect(md).toContain('| Eclipse (Earth hides the Sun) |')
    expect(md).toContain('Not modelled')
    expect(md).toMatch(/14 d 1\d h; with the skyline 0\.1° higher \/ lower: 14 d 1\d h \/ 14 d 1\d h/)
    expect(md).toContain('Landing 2 Mar 2025 08:34 UTC')
    expect(md).toContain('not an error bound')

    // a site without a measured slope, a requirement longer than the stay, and coarse terrain
    const coarse = { ...s, slope_deg: null, skyline_err_deg: 1 }
    const md2 = missionBrief({
      eph, site: coarse, track: t, landingUnix: Date.parse(s.date) / 1000, i0, len: 24, stats: windowStats(t, i0, 24), observerM: 2, earthMinClear: 0,
      req: { minDaylightH: 168, maxDarkH: 50, minEarthPct: 40, maxSlopeDeg: 10 },
      pass: { daylight: true, dark: true, earth: true, slope: false },
      power: DEFAULT_POWER, powerStats: powerStats(eph, t, i0, 24, DEFAULT_POWER), slip: { days: 365, total: 0, tolerance: 0 }, url: 'https://example.invalid/', skyErr: 1,
    })
    expect(md2).toContain('| Ground slope | not measured | ≤ 10° | UNVERIFIED |')
    expect(md2).toContain('(longer than the stay: Sun up for all 24 h)')
    expect(md2).toContain('Result: misses a selected check')
    expect(md2).toContain('1.9 km whole-Moon grid')
  })
})

/** A file as its own ArrayBuffer (a Node Buffer may be a view into a shared pool). */
const ab = (f: string) => {
  const b = readFileSync(f)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

describe('polar map layers vs the browser engine', () => {
  // The layers come from the Python pipeline; here the TypeScript engine recomputes random grid points from scratch.
  it('Earth-in-view and sunlight layers match independent recomputation at random grid points', async () => {
    const b = JSON.parse(readFileSync(`${DATA}/basemap.json`, 'utf8'))
    const lv = b.layer_values
    if (!lv) return
    const vals = new Uint8Array(readFileSync(`${DATA}/${lv.file}`))
    const meta = JSON.parse(readFileSync(`${DATA}/terrain/terrain.json`, 'utf8'))
    const farRaw = undelta(await inflate(ab(`${DATA}/terrain/far.i16z`)), meta.far.n)
    const far: Grid = { data: farRaw, scale: meta.far.scale, x0: meta.far.x0, y0: meta.far.y0, rows: meta.far.n, cols: meta.far.n, factor: meta.factor }
    const m = meta.near
    const eph = loadEph()
    const i0 = Math.round(indexOf(eph, Date.parse('2027-01-01T00:00:00Z') / 1000))
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const out: { earth: number; sun: number }[] = []
    for (let n = 0; n < 8; n++) {
      // a 2 km grid node within 150 km of the pole (both layers are defined exactly there)
      const x = (Math.round((rand() * 300_000 - 150_000) / 2000)) * 2000
      const y = (Math.round((rand() * 300_000 - 150_000) / 2000)) * 2000
      const span = m.tile * m.scale
      const c1 = Math.floor((x - 26_000 - m.x0) / span), c2 = Math.floor((x + 26_000 - m.x0) / span)
      const r1 = Math.floor((m.y0 - (y + 26_000)) / span), r2 = Math.floor((m.y0 - (y - 26_000)) / span)
      const cols = (c2 - c1 + 1) * m.tile
      const data = new Int16Array((r2 - r1 + 1) * m.tile * cols)
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const t = undelta(await inflate(ab(`${DATA}/terrain/near/${r}_${c}.i16z`)), m.tile)
        for (let k = 0; k < m.tile; k++) data.set(t.subarray(k * m.tile, (k + 1) * m.tile), ((r - r1) * m.tile + k) * cols + (c - c1) * m.tile)
      }
      const near: Grid = { data, scale: m.scale, x0: m.x0 + c1 * span, y0: m.y0 - r1 * span, rows: (r2 - r1 + 1) * m.tile, cols, factor: meta.factor }
      const [lat, lon] = toLatLonPolar(x, y)
      const hz = computeHorizon(lat, lon, near, far, 2, 360)
      const t = computeTrack(eph, { lat, lon, groundM: hz.groundM, observerM: 2, horizon: new Horizon(Array.from(hz.elev, (v) => Math.round(v * 100))) }, 0)
      const st = windowStats(t, i0, 8760)
      const k = Math.round((lv.half_extent_m - y) / lv.step_m) * lv.n + Math.round((x + lv.half_extent_m) / lv.step_m)
      out.push({ earth: (100 * vals[lv.n * lv.n + k]) / lv.scale - (100 * st.earthHours) / st.hours, sun: (100 * vals[k]) / lv.scale - (100 * st.sunEquivHours) / st.hours })
    }
    const med = (a: number[]) => [...a].map(Math.abs).sort((p, q) => p - q)[Math.floor(a.length / 2)]
    console.log('layer minus browser engine at random nodes, percentage points:', out.map((d) => `E${d.earth.toFixed(1)} S${d.sun.toFixed(1)}`).join(' · '))
    expect(med(out.map((d) => d.earth))).toBeLessThan(3)
    expect(med(out.map((d) => d.sun))).toBeLessThan(3)
  }, 120_000)
})

import { sunsetRange, sunsetWithSkylineShift } from '../src/lib/metrics'
describe('sunset range from skyline error', () => {
  it('a higher skyline brings sunset earlier, a lower one later, and zero shift reproduces windowStats', () => {
    const eph = loadEph()
    const rows: string[] = []
    for (const [id, date, days] of [['im1', '2024-02-22T23:23:00Z', 40], ['ch3', '2023-08-23T12:33:00Z', 40], ['im2-actual', '2025-03-06T17:28:00Z', 14], ['blue-ghost', '2025-03-02T08:34:00Z', 16], ['c1', '2027-01-01T00:00:00Z', 30]] as const) {
      const s = sites.find((x) => x.id === id)!
      const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
      const i0 = Math.round(indexOf(eph, Date.parse(date) / 1000))
      const st = windowStats(t, i0, days * 24)
      const z = sunsetWithSkylineShift(t, i0, days * 24, 0)
      if (st.firstSunset === null) expect(z).toBeNull()
      else expect(z).toBeCloseTo(st.firstSunset, 6)
      const r = sunsetRange(t, i0, days * 24)
      expect((r.early ?? Infinity) <= (st.firstSunset ?? Infinity)).toBe(true)
      expect((r.late ?? Infinity) >= (st.firstSunset ?? Infinity)).toBe(true)
      rows.push(`${id}: ${r.early?.toFixed(1)} / ${st.firstSunset?.toFixed(1)} / ${r.late?.toFixed(1)} h`)
    }
    console.log(rows.join('\n'))
  })
})

describe('window statistics with a shifted skyline', () => {
  it('a tiny shift matches the nominal statistics and a raised skyline only removes Sun and Earth time', () => {
    const eph = loadEph()
    for (const id of ['c2', 'a3-haworth', 'ch3']) {
      const s = sites.find((x) => x.id === id)!
      const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
      for (const i0 of [35_000, 37_000, 39_000]) {
        const nom = windowStats(t, i0, 720)
        const eps = windowStats(t, i0, 720, 1e-6)
        expect(Math.abs(eps.earthHours - nom.earthHours)).toBeLessThanOrEqual(1)
        expect(Math.abs(eps.sunUpHours - nom.sunUpHours)).toBeLessThanOrEqual(1)
        const hi = windowStats(t, i0, 720, 0.1)
        const lo = windowStats(t, i0, 720, -0.1)
        expect(hi.earthHours).toBeLessThanOrEqual(nom.earthHours)
        expect(hi.sunUpHours).toBeLessThanOrEqual(eps.sunUpHours)
        expect(hi.longestDark).toBeGreaterThanOrEqual(eps.longestDark)
        expect(lo.sunUpHours).toBeGreaterThanOrEqual(eps.sunUpHours)
      }
    }
  })
})

import { earthPhase } from '../src/lib/astro'
describe('Earth phase seen from the Moon', () => {
  it('geometry: full opposite the Sun, new toward it, half at 90° with the bright limb toward the Sun', () => {
    expect(earthPhase(180, 0, 0, 0).lit).toBeCloseTo(1, 6)
    expect(earthPhase(0, 10, 0, 10).lit).toBeCloseTo(0, 6)
    const q = earthPhase(90, 0, 0, 0)
    expect(q.lit).toBeCloseTo(0.5, 6)
    expect(q.pa).toBeCloseTo(0, 6) // Sun at higher azimuth: bright limb to the right
    expect(earthPhase(0, 30, 0, 0).pa).toBeCloseTo(-Math.PI / 2, 6) // Sun straight above: bright limb up
  })
  it('is the complement of the Moon phase: Chandrayaan-3 landed a day before first quarter', () => {
    const eph = loadEph()
    const s = sites.find((x) => x.id === 'ch3')!
    const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
    const i = Math.round(indexOf(eph, Date.UTC(2023, 7, 23, 12, 33) / 1000))
    const p = earthPhase(t.sunAz[i], t.sunEl[i], t.earthAz[i], t.earthEl[i])
    expect(p.lit).toBeGreaterThan(0.53) // Moon about 42% lit, so Earth about 58%
    expect(p.lit).toBeLessThan(0.63)
  })
})

import { eclipseContacts } from '../src/lib/astro'
describe('eclipse of the Sun by Earth, seen by Blue Ghost on 14 March 2025', () => {
  it('matches the times Firefly reported within 5 minutes', () => {
    // Reported (KUT, Firefly images; Central Daylight Time = UTC-5): eclipse 05:00-09:52 UTC, totality from 06:18,
    // diamond ring as the Sun came back at 08:30 UTC.
    const eph = loadEph()
    const s = sites.find((x) => x.id === 'blue-ghost')!
    const f = siteFrame(s.lat, s.lon, R0_KM + (s.ground_m + 2) / 1000)
    const c = eclipseContacts(eph, f, indexOf(eph, Date.UTC(2025, 2, 14, 3) / 1000), indexOf(eph, Date.UTC(2025, 2, 14, 11) / 1000))
    const min = (u: number | null, h: number, m: number) => Math.abs((u! - Date.UTC(2025, 2, 14, h, m) / 1000) / 60)
    expect(min(c.start, 5, 0)).toBeLessThan(5)
    expect(min(c.totalStart, 6, 18)).toBeLessThan(5)
    expect(min(c.totalEnd, 8, 30)).toBeLessThan(5)
    expect(min(c.end, 9, 52)).toBeLessThan(5)
  })
})

import { bodyFractionAt, sampleGrid } from '../src/lib/terrain'
import { bodyVector } from '../src/lib/astro'
describe('light-and-shadow map vs site horizons', () => {
  it('the map, marching 80 m terrain toward the Sun, calls lit or dark like the 20 m site horizon', async () => {
    const eph = loadEph()
    const meta = JSON.parse(readFileSync(`${DATA}/terrain/terrain.json`, 'utf8'))
    const farRaw = undelta(await inflate(readFileSync(`${DATA}/terrain/far.i16z`).buffer as ArrayBuffer), meta.far.n)
    const far: Grid = { data: farRaw, scale: meta.far.scale, x0: meta.far.x0, y0: meta.far.y0, rows: meta.far.n, cols: meta.far.n, factor: meta.factor }
    const m = meta.near
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const out: Record<string, number> = {}
    let agree = 0, total = 0
    for (const id of ['c1', 'shackleton', 'nobile-dm2', 'im2-actual']) {
      const s = sites.find((x) => x.id === id)!
      const [x, y] = toXY(s.lat, s.lon)
      const span = m.tile * m.scale
      const c1 = Math.floor((x - 26_000 - m.x0) / span), c2 = Math.floor((x + 26_000 - m.x0) / span)
      const r1 = Math.floor((m.y0 - (y + 26_000)) / span), r2 = Math.floor((m.y0 - (y - 26_000)) / span)
      const cols = (c2 - c1 + 1) * m.tile
      const data = new Int16Array((r2 - r1 + 1) * m.tile * cols)
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const t = undelta(await inflate(readFileSync(`${DATA}/terrain/near/${r}_${c}.i16z`).buffer as ArrayBuffer), m.tile)
        for (let k = 0; k < m.tile; k++) data.set(t.subarray(k * m.tile, (k + 1) * m.tile), ((r - r1) * m.tile + k) * cols + (c - c1) * m.tile)
      }
      const near: Grid = { data, scale: m.scale, x0: m.x0 + c1 * span, y0: m.y0 - r1 * span, rows: (r2 - r1 + 1) * m.tile, cols, factor: meta.factor }
      const hAt = (px: number, py: number) => { const v = sampleGrid(near, px, py); return Number.isFinite(v) ? v : sampleGrid(far, px, py) }
      const track = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
      let ok = 0
      for (let k = 0; k < 200; k++) {
        const i = Math.floor(rnd() * (eph.count - 1))
        const f = bodyFractionAt(hAt, x, y, bodyVector(eph, i, 'sun'), 696_000)!
        ok += +((f > 0) === (track.sunFrac[i] > 0))
      }
      out[id] = ok / 200
      agree += ok
      total += 200
    }
    console.log('map lit/dark agreement with site horizons:', out, 'overall', (agree / total).toFixed(3))
    expect(agree / total).toBeGreaterThan(0.9)
  }, 120_000)
})
