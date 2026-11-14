import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ephemeris, Horizon } from '../src/lib/astro'
import type { SiteRecord } from '../src/lib/data'
import { decisionBrief, decisionSummary, rankDecision, replanLanding } from '../src/lib/decision'
import { DEFAULT_RADIO } from '../src/lib/link'
import { Track, computeTrack } from '../src/lib/metrics'
import { DEFAULT_POWER, IDEAL_STORAGE, LOSS_AWARE_EXAMPLE } from '../src/lib/power'
import { DEFAULT_REQ } from '../src/lib/requirements'
import { decodeShare, encodeShare, DEFAULT_PINS } from '../src/lib/share'

const root = resolve(__dirname, '../public/data')
const raw = readFileSync(`${root}/ephemeris.f32`)
const meta = JSON.parse(readFileSync(`${root}/ephemeris.json`, 'utf8'))
const stationRaw = readFileSync(`${root}/stations.f32`)
const eph: Ephemeris = { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count,
  stations: { data: new Float32Array(stationRaw.buffer, stationRaw.byteOffset, stationRaw.byteLength / 4), orientation: JSON.parse(readFileSync(`${root}/stations.json`, 'utf8')).earth_orientation },
  data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), dsn: new Uint8Array(readFileSync(`${root}/dsn.u8`)) }
const sites = JSON.parse(readFileSync(`${root}/sites.json`, 'utf8')).sites as SiteRecord[]
const cache = new Map<string, Track>()
const trackFor = (s: SiteRecord) => {
  let t = cache.get(s.id)
  if (!t) { t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }); cache.set(s.id, t) }
  return t
}
const crew = { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }
const scenario = { eph, anchor: sites.find(s => s.id === 'a3-haworth')!, originalUnix: Date.parse('2027-01-11T00:00:00Z') / 1000,
  delayDays: 7, candidates: sites.filter(s => s.id.startsWith('a3-')), trackFor, len: 150, observerM: 2,
  req: crew, power: DEFAULT_POWER, radio: DEFAULT_RADIO }

describe('landing decisions, using the shipped lunar data', () => {
  it('sizes rated storage with losses and partial initial charge, then rechecks both skylines', () => {
    const input = { ...scenario, anchor: sites.find(s => s.id === 'a3-degerlache-2')!, candidates: [], searchDays: 0,
      power: { ...DEFAULT_POWER, areaM2: 0.1, storage: { ...LOSS_AWARE_EXAMPLE } } }
    const result = replanLanding(input)
    const fix = result.powerAdjustment!
    expect(result.idealPower).toBe(false)
    expect(result.delayed!.powerPass).toBe(false)
    expect(fix).not.toBeNull()
    expect(fix.option.clearsScreen).toBe(true)
    expect(fix.batteryWh).toBeGreaterThan(17089)
    expect(replanLanding({ ...input, power: { ...input.power, batteryWh: fix.batteryWh - 1 } }).delayed!.clearsScreen).toBe(false)
    const brief = decisionBrief(result, input.anchor, input.originalUnix, 7)
    expect(brief).toContain('rated battery with selected losses and limits')
    expect(brief).toContain('Initial charge 90%')
    expect(brief).toContain('250 / 250 W')
  })

  it('never recommends more capacity for a discharge-rate bottleneck', () => {
    const input = { ...scenario, anchor: sites.find(s => s.id === 'a3-degerlache-2')!, candidates: [], searchDays: 0,
      power: { ...DEFAULT_POWER, areaM2: 0.1, batteryWh: 1e6, storage: { ...IDEAL_STORAGE, maxDischargeW: 1 } } }
    const result = replanLanding(input)
    expect(result.delayed!.rulesPass).toBe(true)
    expect(result.delayed!.powerPass).toBe(false)
    expect(result.delayed!.batteryEmptyAt).toBeNull()
    expect(result.delayed!.powerShortfallAt).toBe(0)
    expect(result.delayed!.batteryNeededWh).toBe(Infinity)
    expect(result.powerAdjustment).toBeNull()
  })

  it('measures additional delay with the same rules, raised skyline and power model', () => {
    const result = replanLanding(scenario)
    console.log('Replacement tradeoffs:', result.alternatives.map(o => ({ site: o.site.name, slope: o.site.slope_deg, extraDelay: o.furtherDelay, batteryWh: o.batteryNeededWh })))
    const delayed = rankDecision(result, 'delay').changeSite!
    expect(delayed.furtherDelay!.days).toBeGreaterThanOrEqual(result.changeSite!.furtherDelay!.days)
    expect(rankDecision(result, 'slope').changeSite!.site.slope_deg).toBe(Math.min(...result.alternatives.map(o => o.site.slope_deg!)))
    expect(result.before!.furtherDelay?.days).toBe(1)
    expect(delayed.site.id).toBe('a3-mouton-plateau')
    expect(delayed.furtherDelay).toEqual({ days: 7, openEnded: false })
    expect(rankDecision(result, 'slope').changeSite!.site.id).toBe('a3-degerlache-2')
    expect(decisionBrief(rankDecision(result, 'delay'), scenario.anchor, scenario.originalUnix, 7, delayed, 'delay')).toContain('Replacement priority: More delay')
    expect(result.powerAdjustment).toBeNull() // a larger battery cannot fix the lost crew daylight
  })

  it('derives and verifies a battery change only when every non-power requirement still passes', () => {
    const input = { ...scenario, anchor: sites.find(s => s.id === 'a3-degerlache-2')!, candidates: [], searchDays: 2,
      power: { ...DEFAULT_POWER, areaM2: 0.1 } }
    const result = replanLanding(input)
    const fix = result.powerAdjustment!
    expect(result.delayed!.rulesPass && result.delayed!.shiftedRulesPass).toBe(true)
    expect(result.delayed!.powerPass).toBe(false)
    expect(fix.option.clearsScreen).toBe(true)
    expect(fix.batteryWh).toBeGreaterThan(input.power.batteryWh)
    expect(fix.batteryWh).toBeGreaterThanOrEqual(result.delayed!.batteryNeededWh)
    expect(fix.batteryWh - result.delayed!.batteryNeededWh).toBeLessThanOrEqual(1.0001)
    expect(fix.option.unix).toBe(result.delayed!.unix)
    expect(replanLanding({ ...input, power: { ...input.power, batteryWh: fix.batteryWh - 1 } }).delayed!.clearsScreen).toBe(false)
    expect(input.power.batteryWh).toBe(1000)
    expect(decisionBrief(result, input.anchor, input.originalUnix, 7)).toContain(`1000 → ${fix.batteryWh} Wh`)
    console.log('Battery recovery:', { fromWh: fix.fromWh, toWh: fix.batteryWh, requiredWh: result.delayed!.batteryNeededWh })
  })

  it('lets the user choose a passing replacement beyond the first-ranked point and exports that choice', () => {
    const result = replanLanding(scenario)
    expect(result.alternatives.map(o => o.site.id)).toEqual([
      'a3-degerlache-2', 'a3-malapert', 'a3-mouton', 'a3-mouton-plateau', 'a3-nobile-1', 'a3-nobile-2',
    ])
    const chosen = result.alternatives[5]
    expect(chosen.clearsScreen).toBe(true)
    expect(result.alternatives.map(o => o.stats.earthHours)).toEqual([150, 150, 150, 150, 150, 150])
    expect(decisionSummary(result, chosen)).toContain('equal Earth visibility')
    expect(decisionSummary(result, chosen)).not.toContain('It ranks first')
    const note = decisionBrief(result, scenario.anchor, scenario.originalUnix, 7, chosen)
    expect(note).toContain('| Keep delayed date | Nobile Rim 2 |')
    expect(note).toContain('Nobile Rim 2: Earth 100%; slope')
    expect(note.split('\n').filter(line => line.endsWith('— replacement shown in decision panel'))).toHaveLength(1)
  })

  it('turns the seven-day Haworth delay into concrete same-date and same-site choices', () => {
    const result = replanLanding(scenario)
    expect(result.before!.clearsScreen).toBe(true)
    expect(result.delayed!.clearsScreen).toBe(false)
    expect(result.changeSite?.clearsScreen).toBe(true)
    expect(result.changeSite!.site.id).not.toBe(scenario.anchor.id)
    expect(result.changeSite!.unix).toBe(scenario.originalUnix + 7 * 86400)
    expect(result.waitHere?.clearsScreen).toBe(true)
    expect(result.waitHere!.site.id).toBe(scenario.anchor.id)
    expect(result.waitHere!.unix).toBeGreaterThan(result.delayed!.unix)
    expect(result.changeSite!.site.id).toBe('a3-degerlache-2')
    expect(result.waitHere!.unix).toBe(Date.parse('2027-05-26T00:00:00Z') / 1000)
    expect(result.searchedDays).toBe(128)
    expect(result.passingSites).toBe(6)
    console.log('7-day delay:', { delayedMisses: result.delayed!.misses,
      replacement: result.changeSite!.site.name, replacementEarthPct: Math.round(100 * result.changeSite!.stats.earthHours / 150),
      waitUntil: new Date(result.waitHere!.unix * 1000).toISOString(), extraDays: result.searchedDays,
      passingReplacements: result.passingSites })
    expect(decisionBrief(result, scenario.anchor, scenario.originalUnix, 7)).toContain('not a confidence interval')
  })

  it('does not recommend a rule PASS when the selected hardware cannot carry the load', () => {
    const result = replanLanding({ ...scenario, searchDays: 3, power: { ...DEFAULT_POWER, areaM2: 0, batteryWh: 0 } })
    expect(result.before?.rulesPass).toBe(true)
    expect(result.before?.clearsScreen).toBe(false)
    expect(result.before?.misses).toContain('power supply')
    expect(result.changeSite).toBeNull()
    expect(result.waitHere).toBeNull()
    expect(result.searchedDays).toBe(3)
  })

  it('keeps a plan that already tolerates the delay without inventing a replacement', () => {
    const result = replanLanding({ ...scenario, anchor: sites.find(s => s.id === 'c1')!,
      originalUnix: Date.parse('2027-01-01T00:00:00Z') / 1000, len: 30 * 24, req: DEFAULT_REQ })
    expect(result.delayed?.clearsScreen).toBe(true)
    expect(result.changeSite).toBeNull()
    expect(result.waitHere).toBeNull()
    expect(result.searchedDays).toBe(0)
  })

  it('does not invent a direct-to-Earth fix when only far-side sites are allowed', () => {
    const farSide = sites.filter(s => ['change6', 'change4'].includes(s.id))
    const result = replanLanding({ ...scenario, anchor: farSide[0], candidates: farSide, searchDays: 14 })
    expect(result.before?.misses).toContain('Earth contact')
    expect(result.changeSite).toBeNull()
    expect(result.waitHere).toBeNull()
  })

  it('never searches past the bundled ephemeris', () => {
    const result = replanLanding({ ...scenario, originalUnix: eph.startUnix + (eph.count - 1 - 150) * eph.stepS })
    expect(result.delayed).toBeNull()
    expect(result.changeSite).toBeNull()
    expect(result.waitHere).toBeNull()
    expect(result.searchedDays).toBe(0)
    const end = (scenario.originalUnix - eph.startUnix) / eph.stepS + scenario.len + 24 + 1
    const limited = replanLanding({ ...scenario, delayDays: 1, eph: { ...eph, count: end } })
    expect(limited.before!.furtherDelay).toEqual({ days: 1, openEnded: true })
    expect(limited.delayed!.furtherDelay).toEqual({ days: 0, openEnded: true })
    expect(decisionBrief(limited, scenario.anchor, scenario.originalUnix, 1)).toContain('≥ marks a search limit')
  })

  it('shares the original plan independently of whichever option is now selected', () => {
    const plan: [string, number, number] = ['pt:-85.5000:35.0000', scenario.originalUnix, 7]
    const q = encodeShare({ site: 'a3-malapert', date: scenario.originalUnix + 7 * 86400, days: 6.25,
      req: crew, h: 2, ec: 0, cmp: DEFAULT_PINS, pw: DEFAULT_POWER, plan, goal: 'delay' })
    expect(decodeShare(`?${q}`).plan).toEqual(plan)
    expect(decodeShare(`?${q}`).goal).toBe('delay')
    expect(decodeShare('?goal=madeup').goal).toBeUndefined()
    expect(decodeShare('?plan=c1@2027-01-01T00:00@-7').plan).toBeUndefined()
    expect(decodeShare('?plan=c1@notadate@7').plan).toBeUndefined()
  })
})
