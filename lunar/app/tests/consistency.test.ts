import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AU_KM, Ephemeris, Horizon, R0_KM, earthAt, indexOf, siteFrame, sunAt, visibleSunFraction } from '../src/lib/astro'
import { Track, computeTrack, windowStats } from '../src/lib/metrics'
import { windows } from '../src/lib/events'
import { DEFAULT_RADIO, linkStats } from '../src/lib/link'
import { bodyFractionAt, toXY } from '../src/lib/terrain'
import { checkWindow, slopeOk } from '../src/lib/requirements'
import type { SiteRecord } from '../src/lib/data'

const data = resolve(__dirname, '../public/data')
function ephemeris(): Ephemeris {
  const meta = JSON.parse(readFileSync(`${data}/ephemeris.json`, 'utf8'))
  const raw = readFileSync(`${data}/ephemeris.f32`)
  return { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count,
    data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) }
}

function alwaysVisible(n: number): Track {
  const f = (value: number) => new Float32Array(n).fill(value)
  return {
    sunFrac: f(1), sunClear: f(5), sunEl: f(5), sunR: f(0.2666), sunAz: f(0), earthClear: f(5), earthEl: f(5), earthAz: f(0),
    cumSun: Float64Array.from({ length: n + 1 }, (_, i) => i), cumSunUp: Float64Array.from({ length: n + 1 }, (_, i) => i),
    cumEarth: Float64Array.from({ length: n + 1 }, (_, i) => i), cumBoth: Float64Array.from({ length: n + 1 }, (_, i) => i),
    earthMinClear: 0, requireDsn: false, dsn: null, eclipsed: new Uint8Array(n), eclipseGap: f(5), lightReturn: new Map(),
  }
}

describe('interval exports agree with the analysis', () => {
  it('ends contact at terrain setting when it precedes a DSN gap at the next hour boundary', () => {
    const t = alwaysVisible(3)
    t.requireDsn = true
    t.dsn = Uint8Array.from([1, 0, 1])
    t.earthClear = Float32Array.from([1, -1, -1])
    expect(windowStats(t, 0, 2).firstEarthset).toBe(0.5)
    expect(windows(t, 0, 2).find(w => w.kind === 'earth')!.end).toBe(0.5)
  })
  it('includes a sunset inside the last hour without counting the endpoint as another hour', () => {
    const t = alwaysVisible(3)
    t.sunClear[2] = -1
    t.sunFrac[2] = 0
    const s = windowStats(t, 0, 2)
    expect(s.hours).toBe(2)
    expect(s.sunUpHours).toBe(2) // the availability metric remains explicitly hourly
    expect(s.firstSunset).toBeGreaterThan(1)
    expect(s.firstSunset).toBeLessThan(2)
    expect(windows(t, 0, 2).find(w => w.kind === 'sun')!.end).toBe(s.firstSunset)
    expect(checkWindow(s, { minDaylightH: 2, maxDarkH: 0, minEarthPct: 0, maxSlopeDeg: 90 }).daylight).toBe(false)
  })
  it('exports the eclipse recovery at 04:29, rather than an apparent terrain sunrise at 04:00', () => {
    const eph = ephemeris()
    const site = JSON.parse(readFileSync(`${data}/sites.json`, 'utf8')).sites.find((s: { id: string }) => s.id === 'shackleton')
    const i0 = indexOf(eph, Date.parse('2028-01-12T04:00:00Z') / 1000)
    const t = computeTrack(eph, { lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: 2, horizon: new Horizon(site.horizons['2']) })
    const stats = windowStats(t, i0, 24)
    const first = windows(t, i0, i0 + 24).find((w) => w.kind === 'sun')!
    expect(first.start - i0).toBeCloseTo(stats.firstSunrise!, 8)
    expect((first.start - i0) * 60).toBeGreaterThan(28)
    expect((first.start - i0) * 60).toBeLessThan(30)
  })

  it('breaks Earth-contact exports at the same DSN gaps as the KPI', () => {
    const t = alwaysVisible(6)
    t.requireDsn = true
    t.dsn = Uint8Array.from([1, 0, 0, 1, 1, 0])
    const contacts = windows(t, 0, 6).filter((w) => w.kind === 'earth')
    expect(contacts.map(({ start, end }) => [start, end])).toEqual([[0, 1], [3, 5]])
    expect(contacts.reduce((sum, w) => sum + w.end - w.start, 0)).toBe(windowStats(t, 0, 6).dsnEarthHours)
  })
})

describe('power-aware silence', () => {
  const n = 6
  const eph: Ephemeris = { startUnix: 0, stepS: 3600, count: n,
    data: Float32Array.from({ length: n * 6 }, (_, k) => k % 6 === 0 ? AU_KM : k % 6 === 3 ? 384400 : 0) }
  it('counts the unpowered tail of a contact hour and the following dead hours', () => {
    const st = linkStats(eph, alwaysVisible(n), 0, n, DEFAULT_RADIO, Float32Array.from([1, 0.5, 0, 0, 0, 0]))
    expect(st.longestGapH).toBe(0)
    expect(st.longestPoweredGapH).toBe(4.5)
    expect(st.longestPoweredGapStart).toBe(1.5)
    expect(st.poweredGapOpenEnded).toBe(true)
    expect(st.bitsPowered / st.bits).toBeCloseTo(1.5 / 6, 6)
  })
  it('keeps an open-boundary marker when a tied longest gap reaches the end', () => {
    const t = alwaysVisible(n)
    t.dsn = Uint8Array.from([1, 0, 0, 1, 0, 0])
    const st = linkStats({ ...eph, dsn: t.dsn }, t, 0, n, DEFAULT_RADIO)
    expect(st.longestGapH).toBe(2)
    expect(st.longestGapStart).toBe(4)
    expect(st.gapOpenEnded).toBe(true)
  })
})

describe('mission validation reproduces the shipped sites', () => {
  it('reproduces the nine-region availability example quoted in Evidence', () => {
    const eph = ephemeris()
    const sites = (JSON.parse(readFileSync(`${data}/sites.json`, 'utf8')).sites as SiteRecord[]).filter(s => s.id.startsWith('a3-'))
    expect(sites).toHaveLength(9)
    const start = indexOf(eph, Date.parse('2027-01-07T00:00:00Z') / 1000)
    const req = { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }
    const nominal = new Set<number>(), raised = new Set<number>()
    let best = 0
    for (const site of sites) {
      const t = computeTrack(eph, { lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: 2, horizon: new Horizon(site.horizons['2']) })
      let count = 0
      for (let day = 0; day < 365; day++) {
        const pass = (shift: number) => {
          const p = checkWindow(windowStats(t, start + day * 24, 150, shift), req)
          return p.daylight && p.dark && p.earth && slopeOk(site, req.maxSlopeDeg)
        }
        if (pass(0)) { nominal.add(day); count++ }
        if (pass(0.1)) raised.add(day)
      }
      best = Math.max(best, count)
    }
    expect({ best, any: nominal.size, raised: raised.size }).toEqual({ best: 133, any: 283, raised: 279 })
  })

  it('matches the C1 and Shackleton annual PASS counts, including slope, eclipses and all four rule presets', () => {
    const eph = ephemeris()
    const sites = JSON.parse(readFileSync(`${data}/sites.json`, 'utf8')).sites as SiteRecord[]
    const reference = JSON.parse(readFileSync(resolve(__dirname, '../../data/validation/mission-effect.json'), 'utf8'))
    const start = indexOf(eph, Date.parse('2027-01-01T00:00:00Z') / 1000)
    for (const id of ['c1', 'shackleton']) {
      const s = sites.find((row) => row.id === id)!
      const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) })
      const row = reference.rows.find((row: { point: string }) => row.point === s.name)
      for (const [name, p] of Object.entries(reference.presets) as [string, { stay_h: number; daylight_h: number; dark_h: number; earth_pct: number; max_slope_deg: number }][]) {
        const req = { minDaylightH: p.daylight_h, maxDarkH: p.dark_h, minEarthPct: p.earth_pct, maxSlopeDeg: p.max_slope_deg }
        let count = 0
        for (let d = 0; d < 365; d++) {
          const pass = checkWindow(windowStats(t, start + d * 24, p.stay_h), req)
          if (pass.daylight && pass.dark && pass.earth && slopeOk(s, req.maxSlopeDeg)) count++
        }
        expect(count, `${s.name}: ${name}`).toBe(row.presets[name].days_lola)
      }
    }
  })
})

describe('map contact geometry', () => {
  it('uses the selected observer height and Earth-centre clearance, not the visible Earth limb', () => {
    const lat = -89.5, lon = 0
    const frame = siteFrame(lat, lon)
    const el = -0.15 * Math.PI / 180
    const body = frame.pos.map((x, k) => x + 384400 * (frame.u[k] * Math.sin(el) + frame.n[k] * Math.cos(el)))
    const [x, y] = toXY(lat, lon)
    expect(bodyFractionAt(() => 0, x, y, body, 0, undefined, 2)).toBe(0)
    expect(bodyFractionAt(() => 0, x, y, body, 0, undefined, 10)).toBe(1)
    expect(bodyFractionAt(() => 0, x, y, body, 0, undefined, 10, 0.1)).toBe(0)
  })
})

describe('joint solar-area quadrature', () => {
  it('does not lose a thin visible cap between fixed integration strips', () => {
    const s = { az: 0, el: 0, dist: AU_KM }
    const e = { az: 1, el: 0, dist: 384400 }
    const radius = Math.asin(696000 / AU_KM) * 180 / Math.PI
    const visible = visibleSunFraction(s, radius * 0.99999, e)
    expect(visible).toBeGreaterThan(0)
    expect(visible).toBeLessThan(1e-5)
  })
  it('has the same visibility when the sky rotates in azimuth', () => {
    const frame = siteFrame(-89.6866, 197.19, R0_KM + 1.731)
    const eph = ephemeris()
    const i = indexOf(eph, Date.parse('2028-01-12T03:00:00Z') / 1000)
    const s = sunAt(eph, frame, i), e = earthAt(eph, frame, i)
    const original = visibleSunFraction(s, -0.116, e)
    expect(original).toBeCloseTo(0.292, 2)
    expect(visibleSunFraction({ ...s, az: s.az + 150 }, -0.116, { ...e, az: e.az + 150 })).toBeCloseTo(original, 8)
  })
})
