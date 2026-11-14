import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ephemeris, Horizon, indexOf, sliceEphemeris } from '../src/lib/astro'
import type { SiteRecord } from '../src/lib/data'
import type { LandingOption } from '../src/lib/decision'
import { DEFAULT_RADIO, missionBudget } from '../src/lib/link'
import { computeTrack, skylineErr, windowStats } from '../src/lib/metrics'
import { DEFAULT_POWER, LOSS_AWARE_EXAMPLE } from '../src/lib/power'
import { checkWindow, slopeOk } from '../src/lib/requirements'
import { SearchRow, SearchSettings, paretoFrontier, searchCsv, searchMissions, serviceRow } from '../src/lib/search'
import { DEFAULT_PINS, decodeShare, encodeShare } from '../src/lib/share'
import { DEFAULT_REQ } from '../src/lib/requirements'

const root = resolve(__dirname, '../public/data')
const raw = readFileSync(`${root}/ephemeris.f32`)
const meta = JSON.parse(readFileSync(`${root}/ephemeris.json`, 'utf8'))
const stationRaw = readFileSync(`${root}/stations.f32`)
const eph: Ephemeris = { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count,
  stations: { data: new Float32Array(stationRaw.buffer, stationRaw.byteOffset, stationRaw.byteLength / 4), orientation: JSON.parse(readFileSync(`${root}/stations.json`, 'utf8')).earth_orientation },
  data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), dsn: new Uint8Array(readFileSync(`${root}/dsn.u8`)) }
const sites = JSON.parse(readFileSync(`${root}/sites.json`, 'utf8')).sites as SiteRecord[]
const candidates = sites.filter(s => ['a3-haworth', 'a3-mouton-plateau', 'a3-degerlache-2'].includes(s.id))
const settings: SearchSettings = { startUnix: Date.parse('2027-01-18T00:00:00Z') / 1000, days: 7, stepDays: 1, minDataGb: 10, maxSilenceH: 12 }
const tracks = new Map(candidates.map(s => [s.id, computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) })]))
const input = { eph, candidates, settings, trackFor: (s: SiteRecord) => tracks.get(s.id)!, observerM: 2,
  len: 150, req: { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 },
  power: { ...DEFAULT_POWER, storage: { ...LOSS_AWARE_EXAMPLE } }, radio: DEFAULT_RADIO }

describe('joint site/date search over real NASA-derived data', () => {
  it('matches an explicit complete nominal/raised evaluation of every sampled stay', async () => {
    const expected: string[] = []
    for (let d = 0; d < settings.days; d++) for (const s of candidates) {
      const unix = settings.startUnix + d * 86400, i = indexOf(eph, unix)
      const local = sliceEphemeris(eph, i, input.len + 1)
      const raised = computeTrack(local, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2,
        horizon: new Horizon(s.horizons['2'].map(v => v + skylineErr(s) * 100)), stationStress: true })
      const nominalTrack = input.trackFor(s)
      const budgets = [missionBudget(eph, nominalTrack, i, input.len, input.power, input.radio),
        missionBudget(local, raised, 0, input.len, input.power, input.radio)]
      const ruleChecks = [checkWindow(windowStats(nominalTrack, i, input.len), input.req), checkWindow(windowStats(raised, 0, input.len), input.req)]
      const pass = ruleChecks.every(p => p.daylight && p.dark && p.earth) && slopeOk(s, input.req.maxSlopeDeg) &&
        budgets.every(b => b.power.unpoweredH < 1e-6 && b.link.bitsPowered / 8e9 >= settings.minDataGb && b.link.longestPoweredGapH <= settings.maxSilenceH!)
      if (pass) expected.push(`${s.id}@${unix}`)
    }
    const result = await searchMissions(input, { yieldTask: async () => {} })
    expect(result.attempted).toBe(21)
    expect(result.unavailable).toBe(0)
    expect(result.rows).toHaveLength(21)
    expect(result.passing.map(r => `${r.option.site.id}@${r.option.unix}`).sort()).toEqual(expected.sort())
    expect(result.passing.length).toBeGreaterThan(0)
    expect(result.passing.length).toBeLessThan(21)
    // Independent all-pairs dominance enumeration, not the incremental frontier algorithm.
    const dimensions = (r: SearchRow) => [r.option.unix, r.option.site.slope_deg!, r.option.batteryNeededWh, r.silenceH, -r.dataGb]
    const brute = result.passing.filter(r => !result.passing.some(q => {
      const rv = dimensions(r), qv = dimensions(q)
      return qv.every((v, k) => v <= rv[k]) && qv.some((v, k) => v < rv[k])
    }))
    expect(new Set(result.frontier)).toEqual(new Set(brute))
    const csv = searchCsv(result, { restoreUrl: 'https://example.invalid/?find=test', assumptions: input.power })
    expect(csv.split('\n').filter(l => l && !l.startsWith('#'))).toHaveLength(22)
    expect(csv).toContain('"arrayFactor":0.85')
    expect(csv).toContain('no launch, transfer or thermal clearance')
  })

  it('reports ephemeris boundaries and does not duplicate sites', async () => {
    const lastStart = eph.startUnix + (eph.count - 1 - input.len) * eph.stepS
    const result = await searchMissions({ ...input, candidates: [candidates[0], candidates[0]],
      settings: { ...settings, startUnix: lastStart, days: 7, stepDays: 3 } }, { yieldTask: async () => {} })
    expect(result.siteCount).toBe(1)
    expect(result.attempted).toBe(3)
    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe(2)
  })

  it('cancels between bounded chunks instead of publishing a partial search as complete', async () => {
    const controller = new AbortController()
    let done = 0
    await expect(searchMissions(input, { signal: controller.signal, onProgress: n => { done = n; controller.abort() }, yieldTask: async () => {} })).rejects.toMatchObject({ name: 'AbortError' })
    expect(done).toBe(8)
    await expect(searchMissions({ ...input, settings: { ...settings, days: 500 } })).rejects.toThrow('Invalid search')
  })
})

describe('service constraints and visible trade-offs', () => {
  const option = { clearsScreen: true, misses: [], bits: 80e9, shiftedBits: 40e9,
    longestPoweredGapH: 1, shiftedLongestPoweredGapH: 3 } as unknown as LandingOption
  it('uses both skyline runs rather than the more favorable service result', () => {
    expect(serviceRow(option, { ...settings, minDataGb: 5, maxSilenceH: 3 })).toMatchObject({ dataGb: 5, silenceH: 3, pass: true })
    expect(serviceRow(option, { ...settings, minDataGb: 6, maxSilenceH: 2 }).misses).toEqual(['data return', 'powered silence'])
  })
  const row = (name: string, day: number, data: number, gap = 1): SearchRow => ({ option: { site: { name, slope_deg: 2 }, unix: day, batteryNeededWh: 100 } as LandingOption,
    dataGb: data, silenceH: gap, pass: true, misses: [] })
  it('keeps real conflicts and equivalent points, but removes strictly dominated options', () => {
    const a = row('A', 1, 10), same = row('Same', 1, 10), b = row('B', 2, 5), c = row('C', 2, 20), d = row('D', 3, 20, 2)
    expect(paretoFrontier([b, d, c, a, same])).toEqual([c, a, same])
    expect(paretoFrontier([{ ...a, pass: false }])).toEqual([])
  })
  it('search inputs round-trip independently of the currently inspected plan', () => {
    const q = encodeShare({ site: 'c1', date: settings.startUnix - 86400, days: 7, req: DEFAULT_REQ, h: 2, ec: 0, cmp: DEFAULT_PINS, pw: DEFAULT_POWER, search: settings })
    expect(decodeShare(q.toString()).search).toEqual(settings)
    expect(decodeShare(q.toString()).date).not.toBe(settings.startUnix)
    expect(decodeShare('find=2027-01-01T00:00,365,0,1,2').search).toBeUndefined()
    expect(decodeShare('find=2027-01-01T00:00,30,1,0,').search?.maxSilenceH).toBeNull()
  })
})
