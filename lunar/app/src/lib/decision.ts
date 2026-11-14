import { Ephemeris, Horizon, indexOf, sliceEphemeris } from './astro'
import type { SiteRecord } from './data'
import { Radio, missionBudget } from './link'
import { Track, WindowStats, computeTrack, skylineErr, windowStats } from './metrics'
import { PowerSystem, StorageModel, batteryRequirement, isIdealStorage, storageLabel, storageModel } from './power'
import { operationsFor } from './communications'
import { Requirements, checkWindow, slopeOk } from './requirements'
import { fmtDate, fmtHours } from './ui'
import { thermalPass } from './thermal'
import type {TerrainCheck,TerrainPointScreen} from './terrain-constraint'
import {terrainForPoint} from './terrain-constraint'

export interface LandingOption {
  site: SiteRecord
  unix: number
  stats: WindowStats
  shiftedStats: WindowStats
  rulesPass: boolean
  shiftedRulesPass: boolean
  powerPass: boolean
  shiftedPowerPass: boolean
  thermalPass: boolean
  shiftedThermalPass: boolean
  temperatureMinK: number | null
  temperatureMaxK: number | null
  shiftedTemperatureMinK: number | null
  shiftedTemperatureMaxK: number | null
  batteryEmptyAt: number | null
  shiftedBatteryEmptyAt: number | null
  bits: number
  shiftedBits: number
  longestPoweredGapH: number
  shiftedLongestPoweredGapH: number
  dataPass: boolean
  shiftedDataPass: boolean
  dataLossBits: number
  shiftedDataLossBits: number
  batteryNeededWh: number // greater of nominal / raised-skyline rated sizing; Infinity if capacity alone cannot fix
  powerShortfallAt: number | null
  shiftedPowerShortfallAt: number | null
  furtherDelay: { days: number; openEnded: boolean } | null // additional passing daily starts, up to 30 days
  clearsScreen: boolean
  misses: string[]
  terrain?:TerrainPointScreen
}

export interface ReplanInput {
  eph: Ephemeris
  anchor: SiteRecord
  originalUnix: number
  delayDays: number
  candidates: SiteRecord[]
  trackFor: (site: SiteRecord) => Track
  len: number
  observerM: number
  req: Requirements
  power: PowerSystem
  radio: Radio
  searchDays?: number
  terrainCheck?:TerrainCheck
}

export interface ReplanResult {
  idealPower: boolean
  stationGeometry: boolean
  storage: StorageModel
  trafficActive: boolean
  thermalActive: boolean
  relayActive: boolean
  before: LandingOption | null
  delayed: LandingOption | null
  changeSite: LandingOption | null
  alternatives: LandingOption[]
  waitHere: LandingOption | null
  checkedSites: number
  passingSites: number
  searchedDays: number
  powerAdjustment: { fromWh: number; batteryWh: number; option: LandingOption } | null
}

export const DECISION_GOALS = {
  earth: 'Earth link', slope: 'Gentler ground', delay: 'More delay', battery: 'Less battery',
} as const
export type DecisionGoal = keyof typeof DECISION_GOALS

export function delayLabel(option: LandingOption): string {
  const d = option.furtherDelay
  return d ? `${d.openEnded ? '≥' : ''}${d.days} more day${d.days === 1 ? '' : 's'}` : 'not screened'
}

/** Each sort has one visible objective, with deterministic name ties. No aggregate safety score. */
export function rankDecision(result: ReplanResult, goal: DecisionGoal): ReplanResult {
  const score = (o: LandingOption) => goal === 'slope' ? -o.site.slope_deg!
    : goal === 'delay' ? o.furtherDelay?.days ?? -1
      : goal === 'battery' ? -o.batteryNeededWh : o.stats.earthHours
  const alternatives = [...result.alternatives].sort((a, b) => score(b) - score(a) || a.site.name.localeCompare(b.site.name, 'en'))
  return { ...result, alternatives, changeSite: alternatives[0] ?? null }
}

const rulesPass = (stats: WindowStats, site: SiteRecord, req: Requirements) => {
  const p = checkWindow(stats, req)
  return p.daylight && p.dark && p.earth && slopeOk(site, req.maxSlopeDeg)
}

export type EvaluationInput = Pick<ReplanInput, 'eph' | 'trackFor' | 'len' | 'observerM' | 'req' | 'power' | 'radio' | 'terrainCheck'>

/** One nominal / raised-skyline evaluator shared by delay planning and general site/date search. */
export function createLandingEvaluator(input: EvaluationInput) {
  const { eph, trackFor, len, observerM, req, power, radio } = input
  const within = (u: number) => {
    const i = indexOf(eph, u)
    return Number.isInteger(i) && i >= 0 && i + len < eph.count
  }
  const cache = new Map<string, LandingOption>()
  const evaluate = (site: SiteRecord, unix: number, system = power): LandingOption | null => {
    if (!within(unix)) return null
    const key = `${site.id}@${unix}@${JSON.stringify(system)}`
    const cached = cache.get(key)
    if (cached) return cached
    const i = indexOf(eph, unix), t = trackFor(site), shift = skylineErr(site)
    const stats = windowStats(t, i, len), shiftedStats = windowStats(t, i, len, shift)
    const nominal = missionBudget(eph, t, i, len, system, radio)
    // Recompute the short window with the raised horizon: raising only the rule checks would leave power
    // generation and radio duty cycle nominal. Both are screened, including joint terrain/eclipse area.
    const height = site.horizons[String(observerM)] ? observerM : 2
    const local = sliceEphemeris(eph, i, len + 1)
    const shifted = computeTrack(local, {
      lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: height,
      horizon: new Horizon(site.horizons[String(height)].map(v => v + shift * 100)),
      stationStress: true,
    }, t.earthMinClear, t.requireDsn)
    const raised = missionBudget(local, shifted, 0, len, system, radio)
    const p = checkWindow(stats, req)
    const powerPass = nominal.power.unpoweredH < 1e-6
    const shiftedPowerPass = raised.power.unpoweredH < 1e-6
    const nominalThermal = thermalPass(nominal.power), shiftedThermal = thermalPass(raised.power)
    const nominalRules = rulesPass(stats, site, req), higherRules = rulesPass(shiftedStats, site, req)
    const terrain=terrainForPoint(input.terrainCheck,site,req.maxSlopeDeg),terrainPass=!input.terrainCheck||terrain?.pass===true
    const misses = [!p.daylight && 'daylight after landing', !p.dark && 'longest darkness', !p.earth && 'Earth contact',
      !slopeOk(site, req.maxSlopeDeg) && 'slope', !powerPass && 'power supply',
      !nominal.relaySetupPass && 'relay reference / RF inputs',
      nominal.relaySetupPass && !nominal.dataPass && (radio.relay ? 'lander or relay data loss' : 'onboard data loss'),
      !nominalThermal && 'equipment temperature',
      !terrainPass && (terrain?.status==='ready'?'terrain footprint at mission point':'terrain data unavailable'),
      nominalRules && powerPass && nominal.dataPass && nominalThermal && !(higherRules && shiftedPowerPass && raised.dataPass && shiftedThermal) && 'raised-skyline screen',
    ].filter((v): v is string => !!v)
    const option: LandingOption = { site, unix, stats, shiftedStats, rulesPass: nominalRules,
      shiftedRulesPass: higherRules, powerPass, shiftedPowerPass,
      thermalPass: nominalThermal, shiftedThermalPass: shiftedThermal,
      temperatureMinK: nominal.power.thermal?.minK ?? null, temperatureMaxK: nominal.power.thermal?.maxK ?? null,
      shiftedTemperatureMinK: raised.power.thermal?.minK ?? null, shiftedTemperatureMaxK: raised.power.thermal?.maxK ?? null,
      batteryEmptyAt: nominal.power.emptyAt, shiftedBatteryEmptyAt: raised.power.emptyAt,
      powerShortfallAt: nominal.power.shortfallAt, shiftedPowerShortfallAt: raised.power.shortfallAt,
      shiftedBits: raised.returnedBits, longestPoweredGapH: nominal.link.longestPoweredGapH,
      shiftedLongestPoweredGapH: raised.link.longestPoweredGapH,
      dataPass: nominal.dataPass, shiftedDataPass: raised.dataPass,
      dataLossBits: nominal.totalLostBits, shiftedDataLossBits: raised.totalLostBits,
      bits: nominal.returnedBits, batteryNeededWh: Math.max(nominal.power.batteryNeededWh, raised.power.batteryNeededWh), furtherDelay: null,
      clearsScreen: nominalRules && higherRules && powerPass && shiftedPowerPass && nominal.dataPass && raised.dataPass && nominalThermal && shiftedThermal && terrainPass, misses,terrain }
    cache.set(key, option)
    return option
  }
  const eligible = (s: SiteRecord, u: number) => {
    if (!within(u)) return false
    if(input.terrainCheck&&!terrainForPoint(input.terrainCheck,s,req.maxSlopeDeg)?.pass)return false
    const t = trackFor(s), i = indexOf(eph, u)
    return rulesPass(windowStats(t, i, len), s, req) && rulesPass(windowStats(t, i, len, skylineErr(s)), s, req)
  }
  return { within, evaluate, eligible }
}

/** Two explicit choices: keep the delayed date, or keep the original site. No weighted "best site" score.
 * The candidate list is user-controlled: science suitability is assumed, never inferred from sunlight.
 */
export function replanLanding(input: ReplanInput): ReplanResult {
  const { anchor, originalUnix, delayDays, power } = input
  const delayedUnix = originalUnix + delayDays * 86400
  const { within, evaluate, eligible } = createLandingEvaluator(input)
  const before = evaluate(anchor, originalUnix), delayed = evaluate(anchor, delayedUnix)
  const pool = [...new Map(input.candidates.map(s => [s.id, s])).values()].filter(s => s.id !== anchor.id)
  const result: ReplanResult = { idealPower: isIdealStorage(power), stationGeometry: !!input.eph.stations, storage: storageModel(power), trafficActive: !!operationsFor(input.radio).traffic||!!input.radio.relay, thermalActive: !!power.thermal,relayActive:!!input.radio.relay,
    before, delayed, changeSite: null, alternatives: [], waitHere: null,
    checkedSites: 0, passingSites: 0, searchedDays: 0, powerAdjustment: null }

  // Cheap rule checks precede the power model during the search; never recommend nominal-only passes.
  const measureDelay = (option: LandingOption | null) => {
    if (!option?.clearsScreen || option.furtherDelay) return
    let days = 0, openEnded = true
    for (let d = 1; d <= 30; d++) {
      const u = option.unix + d * 86400
      if (!within(u)) break
      if (!eligible(option.site, u) || !evaluate(option.site, u)!.clearsScreen) { openEnded = false; break }
      days = d
    }
    option.furtherDelay = { days, openEnded }
  }
  measureDelay(before)
  measureDelay(delayed)
  if (delayed?.clearsScreen) return result // the smallest change is no replacement at all
  // Resizing power storage cannot cure a daylight, darkness, contact or slope-rule failure.
  if (delayed?.rulesPass && delayed.shiftedRulesPass && !(delayed.powerPass && delayed.shiftedPowerPass)) {
    const batteryWh = Math.ceil(delayed.batteryNeededWh + 1e-6)
    if (Number.isFinite(batteryWh) && batteryWh > power.batteryWh) {
      const option = evaluate(anchor, delayedUnix, { ...power, batteryWh })!
      if (option.clearsScreen) result.powerAdjustment = { fromWh: power.batteryWh, batteryWh, option }
    }
  }
  const alternatives: LandingOption[] = []
  for (const site of pool) {
    if (!within(delayedUnix)) break
    result.checkedSites++
    if (!eligible(site, delayedUnix)) continue
    const option = evaluate(site, delayedUnix)!
    if (option.clearsScreen) alternatives.push(option)
  }
  // This ranks one stated objective: Earth visibility on the same date. It is not science ranking or safety.
  alternatives.sort((a, b) => b.stats.earthHours - a.stats.earthHours || a.site.name.localeCompare(b.site.name))
  result.passingSites = alternatives.length
  result.alternatives = alternatives
  result.changeSite = alternatives[0] ?? null
  alternatives.forEach(measureDelay)
  const days = Math.min(365, Math.max(0, Math.floor(input.searchDays ?? 365)))
  for (let d = 1; d <= days; d++) {
    const u = delayedUnix + d * 86400
    if (!within(u)) break
    result.searchedDays++
    if (!eligible(anchor, u)) continue
    const option = evaluate(anchor, u)!
    if (option.clearsScreen) { result.waitHere = option; break }
  }
  measureDelay(result.waitHere)
  return result
}

/** Text shared by the live decision panel and its exported rationale. */
export function decisionSummary(result: ReplanResult, chosen?: LandingOption | null, goal: DecisionGoal = 'earth'): string {
  if (!result.delayed) return 'The delayed stay extends beyond the available dates.'
  if (result.delayed.clearsScreen) return `Keep the site. The delayed stay meets your rules and ${result.idealPower ? 'ideal' : 'selected'} power needs${result.trafficActive ? ', including your data-loss limit' : ''}${result.thermalActive ? ', and the selected equipment-temperature scenario' : ''}.${result.relayActive?' Conditional on the assumed relay service plan; relay geometry/RF/booking are unverified.':''}`
  const replacement = result.alternatives.find(o => o.site.id === chosen?.site.id && o.unix === chosen.unix) ?? result.changeSite
  if (goal === 'earth' && replacement && result.alternatives.length > 1 && result.alternatives.every(o => o.stats.earthHours === replacement.stats.earthHours)) {
    return `${result.alternatives.length} sites pass with equal Earth visibility. Compare slope and delay tolerance.`
  }
  if (replacement) {
    const value = goal === 'delay' ? `${delayLabel(replacement)} of delay tolerance`
      : goal === 'slope' ? `${replacement.site.slope_deg!.toFixed(1)}° slope`
        : goal === 'battery' ? `${batteryRequirement(replacement.batteryNeededWh)} of ${result.idealPower ? 'ideal usable' : 'rated'} storage needed`
          : `${Math.round(100 * replacement.stats.earthHours / replacement.stats.hours)}% Earth visibility`
    return `Best replacement: ${replacement.site.name}, with ${value}.`
  }
  if (result.powerAdjustment) return `Keep the site and date with ${result.powerAdjustment.batteryWh.toLocaleString('en-US')} Wh of ${result.idealPower ? 'ideal usable' : 'rated'} storage. Review the battery change below.`
  if (result.waitHere) return `No compared site passes on the delayed date. Next date here: ${fmtDate(result.waitHere.unix, false)}.`
  return 'No option passes. Change the requirements, hardware or compared sites.'
}

export function decisionBrief(result: ReplanResult, anchor: SiteRecord, originalUnix: number, delayDays: number, chosen?: LandingOption | null, goal: DecisionGoal = 'earth'): string {
  const replacement = result.alternatives.find(o => o.site.id === chosen?.site.id && o.unix === chosen.unix) ?? result.changeSite
  const lines = [`Original plan: ${anchor.name}, ${fmtDate(originalUnix)}; delay: ${delayDays} days.`, `Replacement priority: ${DECISION_GOALS[goal]} (name ties).`, '', decisionSummary(result, replacement, goal), '',
    '| Choice | Site | Landing (UTC) | Both rule / power screens | Nominal Earth visibility |', '|---|---|---|---|---|']
  for (const [label, option] of [['Original', result.before], ['Delayed', result.delayed], ['Keep delayed date', replacement], ['Keep original site', result.waitHere]] as const) {
    if (option) lines.push(`| ${label} | ${option.site.name} | ${fmtDate(option.unix)} | ${option.clearsScreen ? 'PASS' : `FAIL: ${option.misses.join(', ')}`} | ${Math.round(100 * option.stats.earthHours / option.stats.hours)}% |`)
  }
  const terrainOptions=[result.before,result.delayed,replacement,result.waitHere,...result.alternatives].filter((o):o is LandingOption=>!!o?.terrain)
  if(terrainOptions.length) {
    lines.push('', 'Required terrain footprint at each exact mission point (projected map metres):')
    for(const option of [...new Map(terrainOptions.map(o=>[`${o.site.id}|${o.site.lat}|${o.site.lon}`,o])).values()]) {
      const t=option.terrain!
      lines.push(`- ${option.site.name} (${t.lat.toFixed(7)}°, ${t.lon.toFixed(7)}°E): ${t.pass?'PASS':'NOT MET'}; ${t.status==='ready'?`${(2*t.radiusM!).toFixed(3)} m diameter available`:t.status}; ${t.requiredDiameterM} m required; slope ≤${t.maxSlopeDeg}° after ${t.settings.rmsMultiplier} × RMS; per-cell returns ${t.settings.requireReturns?'required':'optional'}; patch SHA-256 ${t.patchSha256??'unavailable'}${t.importId?`; local dataset ${t.importId}`:''}.${t.issue?' '+t.issue:''}`)
    }
    lines.push('The largest nearby disc is not substituted for the mission point. Missing/loading terrain cannot pass. Sun/Earth/power remain centre samples, not conditions across the entire disc. Source settings and hashes document this run; the restore URL does not pin an immutable model/data release.')
  }
  if (result.alternatives.length) {
    lines.push('', `Passing replacements at the delayed date (priority: ${DECISION_GOALS[goal]}, alphabetical ties):`, '')
    for (const option of result.alternatives) lines.push(`- ${option.site.name}: Earth ${Math.round(100 * option.stats.earthHours / option.stats.hours)}%; slope ${option.site.slope_deg!.toFixed(1)}°; additional delay ${delayLabel(option)}; ${result.idealPower ? 'ideal usable' : 'rated'} battery needed ${batteryRequirement(option.batteryNeededWh)}; nominal and raised-skyline rules / power pass${option.site.id === replacement?.site.id ? ' — replacement shown in decision panel' : ''}`)
  }
  if (result.powerAdjustment) lines.push('', `Power-only change, not yet applied: ${storageLabel({ storage: result.storage })} ${result.powerAdjustment.fromWh} → ${result.powerAdjustment.batteryWh} Wh. Recomputed at the same site and delayed date; both rule / power screens pass. Array, load, radio and requirements unchanged. Storage sizing uses the selected efficiencies, initial charge, depth of discharge, power limits, heater model and array derating. No battery mass, temperature-dependent cell properties or hardware qualification is inferred.`)
  if (result.stationGeometry) lines.push('', 'Direct-link geometry uses moving DSS-24 / DSS-54 / DSS-34 reference antennas at both ends. The raised-skyline run also applies Earth-orientation sensitivity: receiver mask +0.001° through 29 Jan 2027, +0.35° afterwards; lunar aim +0.00002° / +0.006°. One generic 34 m RF budget is used, not antenna-specific RF qualification or an actual DSN booking.')
  if (result.thermalActive) lines.push('', 'Both runs also require the selected single-node equipment-temperature scenario to remain inside its limits. Heater demand draws from the same battery/array as the radio; a fixed IR/mounting boundary is assumed. This is not a regolith-temperature forecast, multi-component thermal model or flight survival qualification.')
  if(result.relayActive) lines.push('', 'Relay mode uses an assumed two-leg provider contact plan, not a computed orbit/RF/booking verification. Actual Earth arrival is screened, with finite lander and relay queues and independent overflow limits. Access data is admitted at bin end and cannot be forwarded until the next hour. Earth-view surface rules remain direct-to-Earth rules; no requirement is relaxed automatically.')
  const m = result.storage
  lines.push('', `Stay unchanged: ${fmtHours(result.before?.stats.hours ?? result.delayed?.stats.hours ?? 0)}. The displayed replacement is user-selectable. Additional delay tests consecutive daily starts, for up to 30 days or the ephemeris boundary; ≥ marks a search limit, not unlimited tolerance. Both rules and power are checked at every tested start. Battery sizing is the larger nominal / raised-skyline rated requirement. Initial charge ${(m.initialSoc * 100).toFixed(0)}%; allowed depth ${(m.maxDod * 100).toFixed(0)}%; charge/discharge efficiencies ${(m.chargeEfficiency * 100).toFixed(0)}% / ${(m.dischargeEfficiency * 100).toFixed(0)}%; charging/discharging limits ${m.maxChargeW ?? 'uncapped'} / ${m.maxDischargeW ?? 'uncapped'} W; darkness heater ${m.darkHeaterW} W; retained array output ${(m.arrayFactor * 100).toFixed(0)}%. The later date is the earliest passing day at the original UTC time (${result.searchedDays} days searched).`,
    'Both screens require the selected Sun/Earth/slope rules and array/battery/radio model to pass nominally and with the site-specific skyline shift. Compared sites are assumed scientifically acceptable. This is a sensitivity test, not a confidence interval or landing clearance; launch/transfer constraints, thermal survival and unresolved hazards are outside the screen.')
  return lines.join('\n')
}
