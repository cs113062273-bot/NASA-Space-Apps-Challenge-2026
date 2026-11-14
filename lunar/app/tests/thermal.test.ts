import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AU_KM, Ephemeris, Horizon, indexOf, sliceEphemeris } from '../src/lib/astro'
import { Track, computeTrack, skylineErr, windowStats } from '../src/lib/metrics'
import { DEFAULT_POWER, IDEAL_STORAGE, powerStats } from '../src/lib/power'
import { THERMAL_EXAMPLE, ThermalModel, advanceThermal, heaterDemandW, thermalLossW, thermalPass, validThermal } from '../src/lib/thermal'
import { DEFAULT_PINS, decodeShare, encodeShare } from '../src/lib/share'
import { DEFAULT_REQ, checkWindow } from '../src/lib/requirements'
import { DEFAULT_RADIO, missionBudget, radioDcW } from '../src/lib/link'
import { createLandingEvaluator, replanLanding } from '../src/lib/decision'
import { searchMissions } from '../src/lib/search'
import type { SiteRecord } from '../src/lib/data'

const m = (patch: Partial<ThermalModel> = {}): ThermalModel => ({ ...THERMAL_EXAMPLE, ...patch })
const raw = readFileSync(new URL('../public/data/ephemeris.f32', import.meta.url))
const meta = JSON.parse(readFileSync(new URL('../public/data/ephemeris.json', import.meta.url), 'utf8'))
const eph: Ephemeris = { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count, data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength/4) }

describe('single-node heat-balance solver, separate from ground temperature', () => {
  it('matches a separate SciPy DOP853 continuous-ODE reference and converges with shorter steps', () => {
    const ref = JSON.parse(readFileSync(new URL('../../data/validation/thermal-node-reference.json', import.meta.url), 'utf8'))
    const errors = []
    for (const c of ref.cases) {
      const base = advanceThermal(c.model, c.model.initialK, c.heat_w, c.duration_s)
      const fine = advanceThermal(c.model, c.model.initialK, c.heat_w, c.duration_s, 30)
      const err = Math.abs(base.endK-c.expected_end_k)
      errors.push({ name: c.name, errorK: err, fineK: Math.abs(fine.endK-c.expected_end_k) })
      expect(err).toBeLessThan(ref.sample_acceptance_k)
      expect(Math.abs(fine.endK-c.expected_end_k)).toBeLessThanOrEqual(err+1e-8)
      expect(Math.abs(base.residualJ)).toBeLessThan(0.01)
      expect(Math.abs(base.coldS-c.cold_s), `${c.name} cold duration`).toBeLessThan(ref.duration_acceptance_s)
      expect(Math.abs(base.hotS-c.hot_s), `${c.name} hot duration`).toBeLessThan(ref.duration_acceptance_s)
      let startK = c.model.initialK, timeS = 0
      for (const sample of c.trajectory) {
        if (sample.seconds > timeS) startK = advanceThermal(c.model, startK, c.heat_w, sample.seconds-timeS).endK
        expect(Math.abs(startK-sample.kelvin), `${c.name} at ${sample.seconds}s`).toBeLessThan(ref.sample_acceptance_k)
        timeS = sample.seconds
      }
    }
    console.log('Thermal numerical reference errors:', errors)
  })

  it('has correct signs, view factors and closed-form linear heating/conductive equilibrium', () => {
    const isolated = m({ emissivity: 0, conductanceWPerK: 0 })
    expect(advanceThermal(isolated, 250, 100, 3600).endK).toBeCloseTo(250+100*3600/50000, 8)
    expect(thermalLossW(m({ emissivity: 0, conductanceWPerK: 2, baseK: 200 }), 250)).toBe(100)
    expect(advanceThermal(m({ emissivity: 0, conductanceWPerK: 2, baseK: 200 }), 250, 100, 3600).endK).toBeCloseTo(250, 8)
    expect(thermalLossW(m({ groundViewFactor: 1, groundK: 300 }), 300)).toBeCloseTo(0, 10)
    expect(thermalLossW(m({ groundViewFactor: 0, groundK: 900 }), 300)).toBeCloseTo(thermalLossW(m({ groundViewFactor: 0, groundK: 100 }), 300), 10)
    expect(heaterDemandW(m(), 200, 0, 0, 3600)).toBe(200)
    expect(heaterDemandW(m(), 400, 1000, 120, 3600)).toBe(0)
  })

  it('counts an initial breach and interpolated limit crossings without assigning cold/hot time at a stationary limit', () => {
    const base = m({ emissivity: 0, conductanceWPerK: 0, minK: 250, maxK: 300 })
    const up = advanceThermal(base, 290, 100, 10000)
    expect(up.firstBreachS).toBeCloseTo(5000, 4)
    expect(Math.abs(up.hotS-5000)).toBeLessThan(0.001) // 1e-6 K boundary guard is 0.5 ms in this analytic case
    expect(up.coldS).toBe(0)
    const cold = advanceThermal(base, 240, 0, 3600)
    expect(cold.firstBreachS).toBe(0)
    expect(cold.coldS).toBe(3600)
    const edge = advanceThermal(base, 300, 0, 3600)
    expect(edge.firstBreachS).toBeNull()
    expect(edge.hotS).toBe(0)
  })

  it('keeps extreme allowed cold/hot node inputs positive, monotone and numerically balanced', () => {
    for (const model of [m({ initialK: 1000, heatCapacityJPerK: 1000, radiatingAreaM2: 100, emissivity: 1, groundK: 3, baseK: 3, conductanceWPerK: 1000 }),
      m({ initialK: 3, heatCapacityJPerK: 1000, radiatingAreaM2: 100, emissivity: 1, groundK: 1000, groundViewFactor: 1, baseK: 1000, conductanceWPerK: 1000 })]) {
      expect(validThermal(model)).toBe(true)
      const t = advanceThermal(model, model.initialK, 0, 3600)
      expect(t.minK).toBeGreaterThanOrEqual(3-1e-8)
      expect(t.maxK).toBeLessThanOrEqual(1000+1e-8)
      expect(t.endK).toBeCloseTo(model.initialK === 3 ? 1000 : 3, 3)
      expect(Math.abs(t.residualJ)).toBeLessThan(1)
    }
    expect(() => advanceThermal(m(),283,0,-1)).toThrow('Invalid thermal integration interval')
    expect(() => advanceThermal(m(),283,0,3600,0)).toThrow('Invalid thermal integration interval')
  })
})

function synthetic(n: number, solar = 0) {
  const data = Float32Array.from({ length: n*6 }, (_, k) => k%6 === 0 ? AU_KM : k%6 === 3 ? 384400 : 0)
  const e: Ephemeris = { ...eph, count: n, data }
  const t = { sunFrac: new Float32Array(n).fill(solar), sunEl: new Float32Array(n), sunAz: new Float32Array(n), earthClear: new Float32Array(n).fill(5), earthMinClear: 0 } as Track
  return { e, t }
}

describe('coupled equipment heat, shared power and capacity sizing', () => {
  it('replaces darkness-only heating and preserves energy accounting', () => {
    const { e, t } = synthetic(24)
    const p = { ...DEFAULT_POWER, loadW: 0, batteryWh: 100000, storage: { ...IDEAL_STORAGE, darkHeaterW: 1000 }, thermal: m({ initialK: 273 }) }
    const s = powerStats(e,t,0,24,p)
    expect(s.thermal!.heaterW[0]).toBeGreaterThan(100)
    expect(s.thermal!.heaterW[0]).toBeLessThanOrEqual(200)
    expect(s.loadWh).toBeCloseTo(s.heaterWh, 7)
    expect(s.initialStoredWh-s.soc.at(-1)!).toBeCloseTo(s.loadWh, 1)
    expect(s.unpoweredH).toBe(0)
    expect(thermalPass(s)).toBe(true)
  })

  it('loses heater/internal heat after bus depletion, and verifies the full-supply sizing remedy', () => {
    const { e, t } = synthetic(48)
    const p = { ...DEFAULT_POWER, loadW: 0, batteryWh: 100, thermal: m({ initialK: 273 }) }
    const s = powerStats(e,t,0,48,p)
    expect(s.unpoweredH).toBeGreaterThan(40)
    expect(s.thermal!.minK).toBeLessThan(p.thermal.minK)
    expect(s.thermal!.fullPowerPass).toBe(true)
    expect(thermalPass(s)).toBe(false)
    const fixed = powerStats(e,t,0,48,{ ...p, batteryWh: Math.ceil(s.batteryNeededWh) })
    expect(fixed.unpoweredH).toBe(0)
    expect(thermalPass(fixed)).toBe(true)
    const below = powerStats(e,t,0,48,{ ...p, batteryWh: s.batteryNeededWh-0.01 })
    expect(below.unpoweredH).toBeGreaterThan(0)
    expect(Array.from(fixed.thermal!.temperatureK)).toEqual(Array.from(fixed.thermal!.fullPowerK))
  })

  it('can miss equipment limits with every watt supplied; extra battery is not a thermal remedy', () => {
    const { e, t } = synthetic(24)
    const s = powerStats(e,t,0,24,{ ...DEFAULT_POWER, batteryWh: 1e7, loadW: 0, thermal: m({ maxHeaterW: 0 }) })
    expect(s.unpoweredH).toBe(0)
    expect(s.thermal!.fullPowerPass).toBe(false)
    expect(thermalPass(s)).toBe(false)
    const hot = powerStats(e,t,0,24,{ ...DEFAULT_POWER, batteryWh: 1e7, thermal: m({ groundK: 500, groundViewFactor: 1 }) })
    expect(hot.thermal!.hotH).toBeGreaterThan(0)
    expect(thermalPass(hot)).toBe(false)
  })

  it('matches an independent bisection capacity search with thermal feedback, losses and partial initial charge', () => {
    const { e,t } = synthetic(48)
    const p = { ...DEFAULT_POWER, loadW: 10, thermal: m(), storage: { ...IDEAL_STORAGE,
      maxDod: 0.8, initialSoc: 0.85, chargeEfficiency: 0.9, dischargeEfficiency: 0.9, maxDischargeW: 500 } }
    const need = powerStats(e,t,0,48,p).batteryNeededWh
    let lo = 0, hi = 1e6
    for (let k = 0; k < 35; k++) {
      const mid = (lo+hi)/2
      if (powerStats(e,t,0,48,{ ...p,batteryWh: mid }).unpoweredH < 1e-8) hi = mid
      else lo = mid
    }
    expect(Math.abs(need-hi)).toBeLessThan(0.001)
  })

  it('includes heater demand in discharge-rate constraints and does not transmit without full bus supply', () => {
    const { e,t } = synthetic(8)
    const p = { ...DEFAULT_POWER, loadW: 0, batteryWh: 1e6, storage: { ...IDEAL_STORAGE, maxDischargeW: 10 }, thermal: m({ initialK: 273 }) }
    const s = missionBudget(e,t,0,8,p,DEFAULT_RADIO)
    expect(s.power.sizingReason).toBe('discharge-limit')
    expect(s.power.batteryNeededWh).toBe(Infinity)
    expect(s.link.bitsPowered).toBe(0)
    expect(s.power.thermal!.deliveredHeaterWh.every(v => v === 0)).toBe(true)
  })

  it('excludes outgoing RF energy before crediting internally retained transmitter heat', () => {
    const { e,t } = synthetic(1)
    const thermal = m({ emissivity: 0, conductanceWPerK: 0, maxHeaterW: 0, wasteHeatFraction: 1 })
    const p = { ...DEFAULT_POWER, loadW: 0, batteryWh: 100000, thermal }
    const b = missionBudget(e,t,0,1,p,DEFAULT_RADIO)
    const dc = Math.fround(radioDcW(DEFAULT_RADIO))
    expect(b.power.thermal!.temperatureK[1]).toBeCloseTo(thermal.initialK + (dc-DEFAULT_RADIO.txW)*3600/thermal.heatCapacityJPerK, 4)
    expect(b.power.loadWh).toBeCloseTo(dc, 5)
    expect(b.link.contactH).toBe(1)
  })
})

describe('temperature screening in decisions, search and shared configuration', () => {
  const sites = JSON.parse(readFileSync(new URL('../public/data/sites.json', import.meta.url), 'utf8')).sites as SiteRecord[]
  const site = sites.find(s => s.id === 'a3-degerlache-2')!
  const t = computeTrack(eph, { lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: 2, horizon: new Horizon(site.horizons['2']) })
  const unix = Date.parse('2027-01-18T00:00:00Z')/1000
  const input = { eph, trackFor: () => t, len: 150, observerM: 2, req: DEFAULT_REQ, radio: DEFAULT_RADIO,
    power: { ...DEFAULT_POWER, thermal: m({ initialK: 400, maxK: 323 }) } }
  it('rejects a power/rule pass that starts over temperature in both planning workflows', async () => {
    const option = createLandingEvaluator(input).evaluate(site,unix)!
    expect(option.powerPass && option.rulesPass).toBe(true)
    expect(option.thermalPass).toBe(false)
    expect(option.misses).toContain('equipment temperature')
    expect(option.clearsScreen).toBe(false)
    const result = replanLanding({ ...input, anchor: site, originalUnix: unix, delayDays: 0, candidates: [], searchDays: 2 })
    expect(result.powerAdjustment).toBeNull()
    expect(result.waitHere).toBeNull()
    const search = await searchMissions({ ...input, candidates: [site], settings: { startUnix: unix, days: 2, stepDays: 1, minDataGb: 0, maxSilenceH: null } }, { yieldTask: async () => {} })
    expect(search.passing).toHaveLength(0)
    expect(search.reasons['equipment temperature']).toBe(2)
  })

  it('round-trips every thermal input and rejects invalid or partial models', () => {
    const q = encodeShare({ site: site.id, date: unix, days: 7, req: DEFAULT_REQ, h: 2, ec: 0, cmp: DEFAULT_PINS, pw: input.power })
    expect(decodeShare(q.toString()).pw?.thermal).toEqual(input.power.thermal)
    expect(validThermal(m())).toBe(true)
    for (const bad of [null, {}, { ...m(), minK: 330 }, { ...m(), setpointK: 0 }, { ...m(), emissivity: -1 }, { ...m(), heatCapacityJPerK: 0 }, { ...m(), groundK: NaN }]) expect(validThermal(bad)).toBe(false)
    expect(decodeShare('?thermal='+encodeURIComponent(JSON.stringify({ initialK: 300 }))).pw?.thermal).toBeUndefined()
    expect(decodeShare('?thermal=%7Bbad').pw?.thermal).toBeUndefined()
  })

  it('screens a full year with native station geometry and retains independently recomputed temperature results', async () => {
    const stationRaw = readFileSync(new URL('../public/data/stations.f32', import.meta.url))
    const native: Ephemeris = { ...eph, stations: { data: new Float32Array(stationRaw.buffer, stationRaw.byteOffset, stationRaw.byteLength/4),
      orientation: JSON.parse(readFileSync(new URL('../public/data/stations.json', import.meta.url), 'utf8')).earth_orientation } }
    const track = computeTrack(native, { lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: 2, horizon: new Horizon(site.horizons['2']) }, 0, true)
    const power = { ...DEFAULT_POWER, thermal: m() }, started = performance.now()
    const result = await searchMissions({ ...input, eph: native, trackFor: () => track, power, candidates: [site],
      settings: { startUnix: unix, days: 365, stepDays: 1, minDataGb: 0, maxSilenceH: null } }, { yieldTask: async () => {} })
    console.log('365-day equipment + native-station search (one site, 150 h stay):', (performance.now()-started).toFixed(0), 'ms')
    expect(result.rows).toHaveLength(365)
    expect(result.passing.length).toBeGreaterThan(0)
    expect(result.passing.length).toBeLessThan(365)
    for (const k of [0, 90, 180, 270, 364]) {
      const o = result.rows[k].option, i = indexOf(native, o.unix), local = sliceEphemeris(native, i, 151)
      const shift = skylineErr(site)
      const raised = computeTrack(local, { lat: site.lat, lon: site.lon, groundM: site.ground_m, observerM: 2,
        horizon: new Horizon(site.horizons['2'].map(v => v + shift*100)), stationStress: true }, 0, true)
      const nominal = missionBudget(native,track,i,150,power,DEFAULT_RADIO), high = missionBudget(local,raised,0,150,power,DEFAULT_RADIO)
      expect(o.temperatureMinK).toBe(nominal.power.thermal!.minK)
      expect(o.shiftedTemperatureMaxK).toBe(high.power.thermal!.maxK)
      expect(o.thermalPass).toBe(thermalPass(nominal.power))
      expect(o.shiftedThermalPass).toBe(thermalPass(high.power))
      const rules = [checkWindow(windowStats(track,i,150), DEFAULT_REQ),checkWindow(windowStats(raised,0,150), DEFAULT_REQ)]
      expect(o.clearsScreen).toBe(rules.every(r => r.daylight && r.dark && r.earth) && nominal.power.unpoweredH < 1e-6 && high.power.unpoweredH < 1e-6 && thermalPass(nominal.power) && thermalPass(high.power))
    }
  }, 60000)
})
