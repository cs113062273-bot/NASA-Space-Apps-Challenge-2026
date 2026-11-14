import { describe, expect, it } from 'vitest'
import { AU_KM, Ephemeris } from '../src/lib/astro'
import type { Track } from '../src/lib/metrics'
import { DEFAULT_POWER, IDEAL_STORAGE, LOSS_AWARE_EXAMPLE, PowerSystem, StorageModel, powerStats } from '../src/lib/power'
import { DEFAULT_RADIO, missionBudget } from '../src/lib/link'
import { DEFAULT_REQ } from '../src/lib/requirements'
import { DEFAULT_PINS, decodeShare, encodeShare } from '../src/lib/share'
import { hourlyAnalysisCsv } from '../src/lib/export'
import type { SiteRecord } from '../src/lib/data'

function scene(sun: number[], dt = 1) {
  const n = sun.length
  const eph: Ephemeris = { startUnix: 0, stepS: dt * 3600, count: n,
    data: Float32Array.from({ length: n * 6 }, (_, k) => k % 6 === 0 ? AU_KM : k % 6 === 3 ? 384400 : 0) }
  // power/link only consume these fields; no fabricated geometry or cumulative-sum behavior is tested.
  const t = { sunFrac: Float32Array.from(sun), sunAz: new Float32Array(n), sunEl: new Float32Array(n),
    sunClear: Float32Array.from(sun, f => f > 0 ? 1 : -1), earthEl: new Float32Array(n).fill(5),
    earthClear: new Float32Array(n).fill(5), earthMinClear: 0 } as Track
  return { eph, t, n }
}
const system = (storage: Partial<StorageModel> = {}, extra: Partial<PowerSystem> = {}): PowerSystem => ({
  ...DEFAULT_POWER, areaM2: 1, efficiency: 200 / 1361, loadW: 100, batteryWh: 1000,
  storage: { ...IDEAL_STORAGE, ...storage }, ...extra,
})
function run(sun: number[], p: PowerSystem, extra?: Float32Array, dt = 1) {
  const { eph, t, n } = scene(sun, dt)
  return powerStats(eph, t, 0, n, p, extra)
}

describe('loss-aware lunar storage and bus demand', () => {
  it('uses discharge loss, protected capacity and initial charge at the correct side of the bus', () => {
    const p = system({ maxDod: 0.8, initialSoc: 0.7, dischargeEfficiency: 0.8 })
    const s = run([0, 0, 0, 0, 0], p)
    // 1000 * (0.7 - 0.2) stored Wh; 80% reaches the bus: 400 Wh / 100 W.
    expect(s.initialStoredWh).toBeCloseTo(500)
    expect(s.usableWh).toBe(800)
    expect(s.shortfallAt).toBeCloseTo(4)
    expect(s.batteryNeededWh).toBeCloseTo(1250)
    expect(s.storageLossWh).toBeCloseTo(100)
    expect(s.unservedWh).toBeCloseTo(100)
    expect(run([0, 0, 0, 0, 0], { ...p, batteryWh: 1250 }).shortfallAt).toBeNull()
    expect(run([0, 0, 0, 0, 0], { ...p, batteryWh: 1249 }).shortfallAt).not.toBeNull()
  })

  it('a positive energy balance can fail when recharge is inefficient or rate-limited', () => {
    // 100 W surplus for 3 h, capped at 20 W; at 50% charge efficiency only 30 Wh is stored.
    const p = system({ initialSoc: 0, chargeEfficiency: 0.5, maxChargeW: 20 }, { batteryWh: 500 })
    const s = run([1, 1, 1, 0], p)
    expect(s.balanceWh).toBeGreaterThan(0)
    expect(s.shortfallAt).toBeCloseTo(3.3)
    expect(s.soc[2]).toBeCloseTo(30)
    expect(s.curtailedWh).toBeCloseTo(240, 3)
    expect(s.sizingReason).toBe('initial-charge')
    expect(s.batteryNeededWh).toBe(Infinity)
  })

  it('discharge power limits fail before depletion and suppress powered downlink', () => {
    const p = system({ maxDischargeW: 50 })
    const s = run([0, 0], p)
    expect(s.emptyAt).toBeNull()
    expect(s.shortfallAt).toBe(0)
    expect(s.dischargeLimitedH).toBe(2)
    expect(s.sizingReason).toBe('discharge-limit')
    expect(s.batteryNeededWh).toBe(Infinity)
    expect(s.soc[1]).toBe(900)
    const { eph, t, n } = scene([0, 0])
    const b = missionBudget(eph, t, 0, n, p, DEFAULT_RADIO)
    expect(b.link.bits).toBeGreaterThan(0)
    expect(b.link.bitsPowered).toBe(0)
    expect(b.link.longestPoweredGapH).toBe(2)
  })

  it('zero discharge power disables storage without pretending the battery is empty', () => {
    const s = run([0], system({ maxDischargeW: 0 }))
    expect(s.soc[0]).toBe(1000)
    expect(s.emptyAt).toBeNull()
    expect(s.shortfallAt).toBe(0)
  })

  it('zero initial usable charge can work when sufficient sunlight arrives first', () => {
    const s = run([1, 1, 0], system({ maxDod: 0.8, initialSoc: 0.2 }))
    expect(s.shortfallAt).toBeNull()
    expect(s.batteryNeededWh).toBeCloseTo(125)
    expect(run([0, 1, 1], system({ maxDod: 0.8, initialSoc: 0.2 })).batteryNeededWh).toBe(Infinity)
  })

  it('heater applies only in total darkness; derating changes generation independently', () => {
    const s = run([1, 0.5, 0], system({ darkHeaterW: 40, arrayFactor: 0.75 }))
    expect(s.heaterWh).toBe(40)
    expect(Array.from(s.load)).toEqual([100, 100, 140])
    expect(s.energyWh).toBeCloseTo(225, 3)
    expect(s.batteryNeededWh).toBeCloseTo(165, 3)
  })

  it('conserves energy including transfer losses, unmet demand and curtailment', () => {
    const p = system({ ...LOSS_AWARE_EXAMPLE, maxChargeW: 30 }, { batteryWh: 150 })
    const s = run([0, 1, 0.2, 1, 1, 0, 0], p, new Float32Array([0, 25, 0, 25, 0, 0, 10]))
    const final = s.soc[s.soc.length - 1]
    // Available input = delivered bus energy + stored final energy + losses + unused surplus.
    expect(s.energyWh + s.initialStoredWh).toBeCloseTo(s.loadWh - s.unservedWh + final + s.storageLossWh + s.curtailedWh, 4)
    expect(s.extraWh).toBe(60)
    expect(Math.min(...s.soc)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...s.soc)).toBeLessThanOrEqual(s.usableWh)
  })

  it('integrates interval duration rather than silently assuming one hour', () => {
    const s = run([0, 0, 0, 0], system({}, { batteryWh: 150 }), undefined, 0.5)
    expect(s.loadWh).toBe(200)
    expect(s.shortfallAt).toBe(1.5)
    expect(s.unpoweredH).toBe(0.5)
    expect(s.batteryNeededWh).toBe(200)
    const { eph, t, n } = scene([0, 0, 0, 0], 0.5)
    const b = missionBudget(eph, t, 0, n, system({}, { batteryWh: 150 }), DEFAULT_RADIO)
    expect(b.link.contactH).toBe(2)
    expect(b.link.bits).toBeCloseTo(b.link.meanRate * 2 * 3600)
  })

  it('matches an independent time-stepped capacity search over varied charging histories', () => {
    // Numerical integration at 1/200 h, then bisection; no cumulative-drawdown sizing formula.
    let seed = 421
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let test = 0; test < 25; test++) {
      const sun = Array.from({ length: 12 }, () => Math.round(rnd() * 4) / 4)
      const m = { ...IDEAL_STORAGE, maxDod: 0.6 + rnd() * 0.4, initialSoc: 0.9,
        chargeEfficiency: 0.75 + rnd() * 0.25, dischargeEfficiency: 0.75 + rnd() * 0.25, maxChargeW: 20 + rnd() * 150 }
      const s = run(sun, system(m))
      const survives = (capacity: number) => {
        const floor = capacity * (1 - m.maxDod)
        let stored = capacity * m.initialSoc
        for (const fraction of sun) for (let step = 0; step < 200; step++) {
          const net = 200 * fraction - 100
          stored += (net >= 0 ? Math.min(net, m.maxChargeW) * m.chargeEfficiency : net / m.dischargeEfficiency) / 200
          if (stored < floor - 1e-7) return false
          stored = Math.min(capacity, stored)
        }
        return true
      }
      let low = 0, high = 10000
      for (let iteration = 0; iteration < 35; iteration++) {
        const mid = (low + high) / 2
        if (survives(mid)) high = mid; else low = mid
      }
      expect(s.batteryNeededWh).toBeCloseTo(high, 3)
    }
  })
})

describe('power assumptions in portable analyses', () => {
  const share = { site: 'c1', date: Date.parse('2027-01-01T00:00:00Z') / 1000, days: 7,
    req: DEFAULT_REQ, h: 2, ec: 0, cmp: DEFAULT_PINS, pw: DEFAULT_POWER }
  it('restores every storage assumption and keeps old six-field links compatible', () => {
    const p = system({ ...LOSS_AWARE_EXAMPLE, maxChargeW: null, maxDischargeW: 0 })
    const q = encodeShare({ ...share, pw: p })
    expect(decodeShare(q.toString()).pw).toEqual(p)
    expect(encodeShare(share).has('storage')).toBe(false)
    expect(decodeShare('pw=tracking,0,2,0.28,120,1000').pw).toEqual(DEFAULT_POWER)
    const storageOnly = encodeShare({ ...share, pw: { ...DEFAULT_POWER, storage: { ...LOSS_AWARE_EXAMPLE } } })
    expect(storageOnly.has('pw')).toBe(false)
    expect(decodeShare(storageOnly.toString()).pw?.storage).toEqual(LOSS_AWARE_EXAMPLE)
  })
  it('rejects malformed efficiencies, rates, and charge below the protected floor', () => {
    for (const v of ['0.8,0.9,0,1,,,40,0.85', '0.8,0.1,1,1,,,0,1', '0.8,0.9,1,1,-1,,0,1', '1,1,1,1,,,0,NaN', '1,1,1,1,,,0,1,2', '1,1,,1,,,0,1']) {
      expect(decodeShare(`storage=${v}`).pw).toBeUndefined()
    }
  })
  it('CSV preserves the assumptions and sums to the same bus energy and downlink volume', () => {
    const { eph, t, n } = scene([1, 0, 0, 1, 1, 0])
    const p = system({ ...LOSS_AWARE_EXAMPLE })
    const budget = missionBudget(eph, t, 0, n, p, DEFAULT_RADIO)
    const site = { name: 'Synthetic, audit site', lat: -89, lon: 20, dem: 'test terrain' } as SiteRecord
    const csv = hourlyAnalysisCsv(eph, site, t, 0, n, 2, budget, p, 'https://example.invalid/?storage=test')
    const lines = csv.trim().split('\n').filter(line => !line.startsWith('#'))
    const columns = lines[0].split(',')
    const rows = lines.slice(1).map(line => line.split(','))
    const sum = (key: string) => rows.reduce((s, r) => s + Number(r[columns.indexOf(key)]), 0)
    expect(rows.length).toBe(n)
    expect(sum('array_power_w')).toBeCloseTo(budget.power.energyWh, 4)
    expect(sum('bus_demand_w')).toBeCloseTo(budget.power.loadWh, 4)
    expect(sum('downlink_bits')).toBeCloseTo(budget.link.bitsPowered, 2)
    expect(csv).toContain('"initialSoc":0.9')
    expect(csv).toContain('# restore_url: https://example.invalid/')
  })
})
