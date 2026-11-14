import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Ephemeris, Horizon, R0_KM, indexOf, loadEphemeris, siteFrame, sliceEphemeris, stationAt } from '../src/lib/astro'
import { DEFAULT_RADIO, linkStats, rateBps } from '../src/lib/link'
import { Track, availableStationMask, computeTrack, earthVisible, windowStats } from '../src/lib/metrics'
import type { SiteRecord } from '../src/lib/data'
import { stationFractionAt, toXY } from '../src/lib/terrain'
import { windows } from '../src/lib/events'

const data = new URL('../public/data/', import.meta.url)
const raw = readFileSync(new URL('ephemeris.f32', data))
const meta = JSON.parse(readFileSync(new URL('ephemeris.json', data), 'utf8'))
const stationRaw = readFileSync(new URL('stations.f32', data))
const stationMeta = JSON.parse(readFileSync(new URL('stations.json', data), 'utf8'))
const eph: Ephemeris = { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count,
  data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
  dsn: new Uint8Array(readFileSync(new URL('dsn.u8', data))),
  stations: { data: new Float32Array(stationRaw.buffer, stationRaw.byteOffset, stationRaw.byteLength / 4), orientation: stationMeta.earth_orientation } }
const crosscheck = JSON.parse(readFileSync(new URL('../../data/validation/station-geometry-crosscheck.json', import.meta.url), 'utf8'))
const sites = JSON.parse(readFileSync(new URL('sites.json', data), 'utf8')).sites as SiteRecord[]

describe('moving reference antenna geometry', () => {
  it('matches complete SPICE lander observers at both ends across 2023–2031', () => {
    expect(createHash('sha256').update(stationRaw).digest('hex')).toBe(stationMeta.sha256)
    expect(crosscheck.station_sha256).toBe(stationMeta.sha256)
    expect(crosscheck.cases).toHaveLength(192)
    for (const c of crosscheck.cases) {
      const f = siteFrame(c.lat, c.lon, R0_KM + (c.ground_m + c.observer_m) / 1000)
      const g = stationAt(eph, f, c.index, c.station)
      expect(Math.abs((g.az - c.exact.az_deg + 540) % 360 - 180)).toBeLessThan(0.0002)
      expect(Math.abs(g.el - c.exact.el_deg)).toBeLessThan(0.0002)
      expect(Math.abs(g.receiverEl - c.exact.receiver_el_deg)).toBeLessThan(0.0002)
      expect(Math.abs(g.dist - c.exact.range_km)).toBeLessThan(0.25)
    }
  })

  it('keeps data channels and signal-arrival geometry aligned when slicing', () => {
    const i = indexOf(eph, Date.parse('2027-01-09T21:00:00Z') / 1000), f = siteFrame(-89.44, 222.83)
    const local = sliceEphemeris(eph, i, 169)
    expect(local.stations!.data).toHaveLength(169 * 27)
    expect(stationAt(local, f, 0, 0)).toEqual(stationAt(eph, f, i, 0))
    expect(local.startUnix).toBe(eph.startUnix + i * 3600)
  })

  it('requires the same named antenna to clear the lunar terrain and its receiver mask', () => {
    const i = indexOf(eph, Date.parse('2027-01-09T21:00:00Z') / 1000)
    const s = sites.find(s => s.id === 'best-connecting-ridge') ?? sites.find(s => s.name === 'Connecting Ridge C1')!
    expect(s).toBeDefined()
    const local = sliceEphemeris(eph, i, 169)
    const g = { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }
    const t = computeTrack(local, g, 0, true)
    for (let k = 0; k < 168; k++) {
      let expected = 0
      for (let j = 0; j < 3; j++) if (t.stations!.clear[k * 3 + j] >= 0 && t.stations!.groundEl[k * 3 + j] >= 10) expected |= 1 << j
      expect(availableStationMask(t, k)).toBe(expected)
      expect(earthVisible(t, k)).toBe(expected > 0)
    }
    const l = linkStats(local, t, 0, 168, DEFAULT_RADIO)
    expect(windowStats(t, 0, 168).earthHours).toBe(l.contactH)
    expect(windowStats(t, 0, 168).dsnEarthHours).toBe(l.contactH)
    expect(l.stationGeometry).toBe(true)
    // An Earth-centre proxy can claim Goldstone contact while that antenna is behind terrain.
    expect(t.earthClear[0]).toBeGreaterThan(0)
    expect(local.dsn![0] & 1).toBe(1)
    expect(t.stations!.clear[0]).toBeLessThan(-0.5)
    expect(l.receivingMask[0] & 1).toBe(0)
  })

  it('does not reject a usable station because the Earth centre is below the skyline; never sums stations', () => {
    const t = { earthClear: Float32Array.of(-1), earthMinClear: 0, requireDsn: true,
      stations: { clear: Float32Array.of(1, 1, 1), groundEl: Float32Array.of(20, 20, 5), distance: Float32Array.of(390000, 380000, 370000),
        aimStress: Float32Array.of(0.006), groundStress: Float32Array.of(0.35), stressed: false } } as Track
    const l = linkStats(eph, t, 0, 1, DEFAULT_RADIO)
    expect(earthVisible(t, 0)).toBe(true)
    expect(l.receivingMask[0]).toBe(3)
    expect(l.chosenStation[0]).toBe(2)
    expect(l.rate[0]).toBe(Math.fround(rateBps(DEFAULT_RADIO, 380000)))
    const selected = linkStats(eph, t, 0, 1, { ...DEFAULT_RADIO, operations: { stationMask: 1, schedule: 'all', dailyStartHour: 0, dailyHours: 24, windows: [], traffic: null } })
    expect(selected.rate[0]).toBe(Math.fround(rateBps(DEFAULT_RADIO, 390000)))
    expect(selected.chosenStation[0]).toBe(1)
  })

  it('includes orientation sensitivity in raised runs, without silently changing nominal geometry', () => {
    const t = { earthClear: Float32Array.of(5), earthMinClear: 0, requireDsn: true,
      stations: { clear: Float32Array.of(1, 1, 1), groundEl: Float32Array.of(10.2, 5, 5), distance: Float32Array.of(380000, 380000, 380000),
        aimStress: Float32Array.of(0.006), groundStress: Float32Array.of(0.35), stressed: false } } as Track
    expect(availableStationMask(t, 0)).toBe(1)
    expect(availableStationMask(t, 0, 0.1)).toBe(0)
    t.stations!.stressed = true
    expect(availableStationMask(t, 0)).toBe(0)
    expect(linkStats(eph, t, 0, 1, DEFAULT_RADIO).contactH).toBe(0)
  })

  it('keeps fast raised-window rule checks equal to a complete raised track across the PCK boundary', () => {
    const s = sites.find(s => s.id === 'c1')!
    for (const date of ['2027-01-01', '2027-01-29', '2028-07-01']) {
      const i = indexOf(eph, Date.parse(`${date}T00:00:00Z`) / 1000)
      const local = sliceEphemeris(eph, i, 721)
      const geom = { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }
      const nominal = computeTrack(local, geom, 0, true)
      const raised = computeTrack(local, { ...geom, horizon: new Horizon(s.horizons['2'].map(v => v + 10)), stationStress: true }, 0, true)
      const fast = windowStats(nominal, 0, 720, 0.1), full = windowStats(raised, 0, 720)
      expect(fast.earthHours).toBe(full.earthHours)
      expect(fast.bothHours).toBe(full.bothHours)
      expect(fast.longestNoEarth).toBe(full.longestNoEarth)
      expect(fast.firstEarthset).toBeCloseTo(full.firstEarthset!, 4)
      expect(raised.stations!.groundStress[0]).toBeCloseTo(date === '2028-07-01' ? 0.35 : 0.001, 6)
      expect(windows(nominal, 0, 720).filter(w => w.kind === 'earth').length).toBeGreaterThan(0)
    }
  })

  it('maps both ends of station paths against exact SPICE on a smooth spherical terrain', () => {
    const groups = new Map<string, typeof crosscheck.cases>()
    for (const c of crosscheck.cases) if (c.lat < -80) {
      const key = `${c.site}/${c.utc}`
      groups.set(key, [...(groups.get(key) ?? []), c])
    }
    let checked = 0
    for (const group of groups.values()) {
      const c = group[0], [x, y] = toXY(c.lat, c.lon)
      const horizon = -Math.acos((R0_KM + c.ground_m / 1000) / (R0_KM + (c.ground_m + c.observer_m) / 1000)) * 180 / Math.PI
      // Skip a mask boundary where finite ray-march spacing can change the last decimal.
      if (group.some((q: typeof c) => Math.abs(q.exact.el_deg - horizon) < 0.005 || Math.abs(q.exact.receiver_el_deg - 10) < 0.005)) continue
      const expected = group.some((q: typeof c) => q.exact.el_deg >= horizon && q.exact.receiver_el_deg >= 10)
      expect(stationFractionAt(() => c.ground_m, x, y, eph.stations!.data.subarray(c.index * 27, (c.index + 1) * 27), c.observer_m)).toBe(+expected)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(40)
    expect(stationFractionAt(() => NaN, 0, 0, new Float32Array(27))).toBeNull()
  })
})

describe('station data loading fails visibly rather than falling back to a mission pass', () => {
  afterEach(() => vi.unstubAllGlobals())
  const mockData = (change?: string) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const name = url.split('/').pop()!
    if (change === 'missing' && name === 'stations.f32') return new Response('', { status: 404 })
    const bytes = readFileSync(new URL(name, data))
    if (name === 'stations.json' && change === 'mismatch') return Response.json({ ...stationMeta, count: 1 })
    if (name === 'stations.f32' && change === 'corrupt') bytes[0] ^= 1
    return new Response(bytes)
  }))
  it('accepts the verified asset and rejects missing, misaligned or corrupted geometry', async () => {
    mockData()
    expect((await loadEphemeris()).stations!.data.length).toBe(meta.count * 27)
    mockData('missing'); await expect(loadEphemeris()).rejects.toThrow('Cannot load stations.f32')
    mockData('mismatch'); await expect(loadEphemeris()).rejects.toThrow('does not match')
    mockData('corrupt'); await expect(loadEphemeris()).rejects.toThrow('checksum')
  })
})
