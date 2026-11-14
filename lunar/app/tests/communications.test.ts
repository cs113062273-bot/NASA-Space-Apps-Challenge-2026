import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AU_KM, Ephemeris, Horizon, indexOf } from '../src/lib/astro'
import { DEFAULT_OPERATIONS, CommOperations, TrafficModel, contactPlanCsv, dataLossPass, deliveryStats, parseContactPlanCsv, plannedMask } from '../src/lib/communications'
import { DEFAULT_RADIO, Radio, linkStats, missionBudget, radioDcW } from '../src/lib/link'
import { Track, computeTrack } from '../src/lib/metrics'
import { DEFAULT_POWER } from '../src/lib/power'
import { DEFAULT_REQ } from '../src/lib/requirements'
import { DEFAULT_PINS, decodeShare, encodeShare } from '../src/lib/share'
import { replanLanding } from '../src/lib/decision'
import type { SiteRecord } from '../src/lib/data'
import { searchMissions } from '../src/lib/search'

const start = Date.parse('2027-01-01T00:00:00Z') / 1000
const ops = (patch: Partial<CommOperations> = {}): CommOperations => ({ ...DEFAULT_OPERATIONS, ...patch })
const traffic = (patch: Partial<TrafficModel> = {}): TrafficModel => ({ generatedKbps: 0.001, initialGb: 0, bufferGb: 5 / 8e9, maxLossGb: 0, ...patch })
function scene(mask: number[], sun = 1) {
  const n = mask.length
  const eph: Ephemeris = { startUnix: start, stepS: 3600, count: n, dsn: Uint8Array.from(mask),
    data: Float32Array.from({ length: n * 6 }, (_, k) => k % 6 === 0 ? AU_KM : k % 6 === 3 ? 384400 : 0) }
  const t = { sunFrac: new Float32Array(n).fill(sun), sunAz: new Float32Array(n), sunEl: new Float32Array(n),
    earthClear: new Float32Array(n).fill(5), earthMinClear: 0 } as Track
  return { eph, t, n }
}

describe('DSN station selection and user-planned UTC allocations', () => {
  it('keeps daily UTC slots half-open and wraps midnight without a local-time dependency', () => {
    const o = ops({ stationMask: 3, schedule: 'daily', dailyStartHour: 22, dailyHours: 4 })
    expect(Array.from({ length: 24 }, (_, h) => plannedMask(o, start + h * 3600))).toEqual([3, 3, ...new Array(20).fill(0), 3, 3])
    expect(plannedMask({ ...o, dailyHours: 0 }, start)).toBe(0)
    expect(plannedMask({ ...o, dailyHours: 24 }, start + 12 * 3600)).toBe(3)
  })
  it('distinguishes unavailable geometry, excluded complexes and hours outside allocation', () => {
    const { eph, t, n } = scene([0, 2, 1, 1, 4])
    const r = { ...DEFAULT_RADIO, operations: ops({ stationMask: 1, schedule: 'daily', dailyStartHour: 3, dailyHours: 1 }) }
    const s = linkStats(eph, t, 0, n, r)
    expect(Array.from(s.state)).toEqual([1, 3, 4, 2, 3])
    expect(Array.from(s.receivingMask)).toEqual([0, 0, 0, 1, 0])
    expect(s.geometryContactH).toBe(4)
    expect(s.excludedStationH).toBe(2)
    expect(s.unscheduledH).toBe(1)
    expect(s.contactH).toBe(1)
    expect(s.geometryBits).toBeCloseTo(s.bits * 4, -3)
    const off = linkStats(eph, t, 0, n, { ...r, operations: ops({ stationMask: 0 }) })
    expect(off.contactH).toBe(0)
  })
  it('overlapping explicit passes do not multiply capacity and retain absolute UTC in a sliced ephemeris', () => {
    const { eph, t } = scene([7, 7, 7, 7])
    const r = { ...DEFAULT_RADIO, operations: ops({ schedule: 'windows', windows: [
      { startUnix: start, endUnix: start + 7200, stationMask: 1 },
      { startUnix: start + 3600, endUnix: start + 10800, stationMask: 3 },
    ] }) }
    const s = linkStats(eph, t, 0, 4, r)
    expect(Array.from(s.receivingMask)).toEqual([1, 3, 3, 0])
    const full = linkStats(eph, t, 0, 4, DEFAULT_RADIO)
    expect(s.bits).toBeCloseTo(full.bits * 0.75, 2)
    const local = { ...eph, startUnix: start + 7200, count: 2, data: eph.data.slice(12), dsn: eph.dsn!.slice(2) }
    expect(Array.from(linkStats(local, t, 0, 2, r).state)).toEqual([2, 4])
  })
  it('adds transmitter DC demand only in planned, geometrically valid hours', () => {
    const { eph, t, n } = scene([7, 7, 7, 7])
    const radio = { ...DEFAULT_RADIO, operations: ops({ schedule: 'daily', dailyStartHour: 1, dailyHours: 1 }) }
    const b = missionBudget(eph, t, 0, n, DEFAULT_POWER, radio)
    expect(Array.from(b.power.load)).toEqual([120, expect.closeTo(120 + radioDcW(radio), 4), 120, 120])
    expect(b.power.extraWh).toBe(Math.fround(radioDcW(radio)))
    expect(b.link.contactH).toBe(1)
  })
})

describe('finite payload storage with simultaneous arrival and transmission', () => {
  it('conserves recorded data and reports overflow before a later pass', () => {
    const m = traffic(), rates = new Float32Array([0, 2, 0, 2]), powered = new Float32Array(4).fill(1)
    const d = deliveryStats(m, rates, powered, 10)
    expect(Array.from(d.buffer)).toEqual([5, 0, 5, 0])
    expect(Array.from(d.delivered)).toEqual([0, 15, 0, 15])
    expect(d.producedBits).toBe(40)
    expect(d.deliveredBits).toBe(30)
    expect(d.lostBits).toBe(10)
    expect(d.bufferNeededBits).toBe(10)
    expect(d.firstOverflowH).toBeCloseTo(5 / 3600)
    expect(d.initialBits + d.producedBits).toBe(d.deliveredBits + d.pendingBits + d.lostBits)
    expect(dataLossPass(d, ops({ traffic: m }))).toBe(false)
    expect(dataLossPass(d, ops({ traffic: { ...m, maxLossGb: 10 / 8e9 } }))).toBe(true)
  })
  it('zero storage can directly forward simultaneous input without fictitious overflow', () => {
    const d = deliveryStats(traffic({ bufferGb: 0 }), new Float32Array([2, 2]), new Float32Array([1, 1]), 10)
    expect(d.deliveredBits).toBe(20)
    expect(d.lostBits).toBe(0)
    expect(d.bufferNeededBits).toBe(0)
  })
  it('initial data exceeding storage is lost at touchdown and remains in the conservation equation', () => {
    const d = deliveryStats(traffic({ initialGb: 20 / 8e9, generatedKbps: 0 }), new Float32Array([2]), new Float32Array([1]), 10)
    expect(d.initialBits).toBe(20)
    expect(d.lostBits).toBe(15)
    expect(d.deliveredBits).toBe(5)
    expect(d.firstOverflowH).toBe(0)
    expect(d.bufferNeededBits).toBe(20)
  })
  it('power loss suppresses acquisition as well as data transmission', () => {
    const d = deliveryStats(traffic({ bufferGb: 100 / 8e9 }), new Float32Array([2, 0]), new Float32Array([0.5, 0]), 10)
    expect(d.producedBits).toBe(5)
    expect(d.deliveredBits).toBe(5)
    expect(d.missedProductionBits).toBe(15)
    expect(d.pendingBits).toBe(0)
  })
  it('agrees with an independent fine-step queue over varied contact and power histories', () => {
    let seed = 871
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let example = 0; example < 30; example++) {
      const rates = Float32Array.from({ length: 12 }, () => Math.round(rnd() * 4))
      const powered = Float32Array.from({ length: 12 }, () => Math.round(rnd() * 2) / 2)
      const m = traffic({ initialGb: 3 / 8e9 })
      const result = deliveryStats(m, rates, powered, 10)
      let queue = 3, lost = 0, sent = 0
      for (let i = 0; i < rates.length; i++) for (let k = 0; k < 1000; k++) {
        if (k / 1000 >= powered[i]) continue
        const incoming = 0.01
        const service = Math.min(rates[i] * 0.01, queue + incoming)
        const overflow = Math.max(0, queue + incoming - service - 5)
        queue += incoming - service - overflow
        sent += service; lost += overflow
      }
      expect(result.deliveredBits).toBeCloseTo(sent, 6)
      expect(result.lostBits).toBeCloseTo(lost, 6)
      expect(result.pendingBits).toBeCloseTo(queue, 6)
      expect(result.initialBits + result.producedBits).toBeCloseTo(result.deliveredBits + result.lostBits + result.pendingBits, 7)
    }
  })
})

describe('portable contact plans and payload assumptions', () => {
  const windows = [{ startUnix: start, endUnix: start + 3600, stationMask: 5 }, { startUnix: start + 3600, endUnix: start + 10800, stationMask: 2 }]
  it('round-trips UTC passes through CSV and all settings through links', () => {
    expect(parseContactPlanCsv(contactPlanCsv(windows))).toEqual(windows)
    const radio: Radio = { ...DEFAULT_RADIO, operations: ops({ stationMask: 5, schedule: 'windows', windows, traffic: traffic() }) }
    const q = encodeShare({ site: 'c1', date: start, days: 7, req: DEFAULT_REQ, h: 2, ec: 0, cmp: DEFAULT_PINS, pw: DEFAULT_POWER, rd: radio })
    expect(q.has('rd')).toBe(false)
    expect(decodeShare(q.toString()).rd).toEqual(radio)
    expect(decodeShare('rd=X,10,12').rd).toEqual(DEFAULT_RADIO)
  })
  it('rejects malformed windows and traffic without partly applying an import', () => {
    for (const line of ['2027-01-01T00:30Z,2027-01-01T01:00Z,Madrid', '2027-02-30T00:00Z,2027-03-03T01:00Z,Madrid',
      '2027-01-01T00:00,2027-01-01T01:00,Madrid', '2027-01-01T01:00Z,2027-01-01T00:00Z,Madrid', '2027-01-01T00:00Z,2027-01-01T01:00Z,unknown']) {
      expect(() => parseContactPlanCsv('start_utc,end_utc,complexes\n' + line)).toThrow()
    }
    for (const patch of [{ stationMask: 8 }, { dailyHours: 1.5 }, { traffic: { ...traffic(), bufferGb: -1 } }, { windows: [{ ...windows[0], endUnix: start + 30 }] }]) {
      expect(decodeShare('ops=' + encodeURIComponent(JSON.stringify(ops(patch as Partial<CommOperations>)))).rd).toBeUndefined()
    }
  })
})

describe('data loss inside the real-data decision and search screens', () => {
  const root = resolve(__dirname, '../public/data'), raw = readFileSync(`${root}/ephemeris.f32`)
  const meta = JSON.parse(readFileSync(`${root}/ephemeris.json`, 'utf8'))
  const stationRaw = readFileSync(`${root}/stations.f32`)
  const eph: Ephemeris = { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count,
    stations: { data: new Float32Array(stationRaw.buffer, stationRaw.byteOffset, stationRaw.byteLength / 4), orientation: JSON.parse(readFileSync(`${root}/stations.json`, 'utf8')).earth_orientation },
    data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), dsn: new Uint8Array(readFileSync(`${root}/dsn.u8`)) }
  const site = (JSON.parse(readFileSync(`${root}/sites.json`, 'utf8')).sites as SiteRecord[]).find(s => s.id === 'a3-degerlache-2')!
  const track = computeTrack(eph, { lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: 2, horizon: new Horizon(site.horizons['2']) })
  const unix = Date.parse('2027-01-18T00:00:00Z') / 1000
  const radio = { ...DEFAULT_RADIO, operations: ops({ schedule: 'daily', dailyHours: 0,
    traffic: { generatedKbps: 100, initialGb: 0, bufferGb: 0.01, maxLossGb: 0 } }) }
  const input = { eph, trackFor: () => track, len: 150, observerM: 2, req: { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }, power: DEFAULT_POWER, radio }
  it('does not recommend a point that has power and light but discards the payload', async () => {
    const b = missionBudget(eph, track, indexOf(eph, unix), 150, DEFAULT_POWER, radio)
    expect(b.power.unpoweredH).toBe(0)
    expect(b.link.contactH).toBe(0)
    expect(b.dataPass).toBe(false)
    const plan = replanLanding({ ...input, anchor: site, originalUnix: unix - 86400, delayDays: 1, candidates: [], searchDays: 0 })
    expect(plan.delayed!.rulesPass).toBe(true)
    expect(plan.delayed!.powerPass).toBe(true)
    expect(plan.delayed!.misses).toContain('onboard data loss')
    expect(plan.delayed!.clearsScreen).toBe(false)
    const result = await searchMissions({ ...input, candidates: [site], settings: { startUnix: unix, days: 1, stepDays: 1, minDataGb: 0, maxSilenceH: null } })
    expect(result.passing).toHaveLength(0)
    expect(result.reasons['onboard data loss']).toBe(1)
  })
})
