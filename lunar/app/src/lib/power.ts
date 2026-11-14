import { AU_KM, Ephemeris } from './astro'
import { Track } from './metrics'
import { ThermalModel, ThermalStats, advanceThermal, heaterDemandW, initThermal } from './thermal'

export const SOLAR_CONSTANT = 1361 // W/m² at 1 au (Kopp & Lean 2011)

export type PanelMode = 'tracking' | 'fixed' | 'horizontal'

/** Explicit engineering assumptions, not measured battery performance or a thermal model. */
export interface StorageModel {
  maxDod: number // maximum depth of discharge, fraction of rated capacity
  initialSoc: number // state of charge at touchdown, fraction of rated capacity
  chargeEfficiency: number // stored Wh / incoming bus Wh
  dischargeEfficiency: number // outgoing bus Wh / withdrawn stored Wh
  maxChargeW: number | null // input at the bus; null means no limit
  maxDischargeW: number | null // output at the bus; null means no limit
  darkHeaterW: number // extra bus load only when the whole Sun is hidden
  arrayFactor: number // retained output after user-assumed derating, 0..1
}

export const IDEAL_STORAGE: Readonly<StorageModel> = {
  maxDod: 1, initialSoc: 1, chargeEfficiency: 1, dischargeEfficiency: 1,
  maxChargeW: null, maxDischargeW: null, darkHeaterW: 0, arrayFactor: 1,
}

// An editable example, deliberately not called a NASA battery or a flight-qualified preset.
export const LOSS_AWARE_EXAMPLE: Readonly<StorageModel> = {
  maxDod: 0.8, initialSoc: 0.9, chargeEfficiency: 0.95, dischargeEfficiency: 0.95,
  maxChargeW: 250, maxDischargeW: 250, darkHeaterW: 40, arrayFactor: 0.85,
}

export const storageModel = (p: Pick<PowerSystem, 'storage'>): StorageModel => ({ ...IDEAL_STORAGE, ...p.storage })
export const isIdealStorage = (p: Pick<PowerSystem, 'storage'>) => {
  const m = storageModel(p)
  return (Object.keys(IDEAL_STORAGE) as (keyof StorageModel)[]).every(k => m[k] === IDEAL_STORAGE[k])
}
export const storageLabel = (p: Pick<PowerSystem, 'storage'>) => isIdealStorage(p) ? 'ideal usable battery' : 'rated battery with selected losses and limits'
export const batteryRequirement = (wh: number) => Number.isFinite(wh) ? `${Math.ceil(wh).toLocaleString('en-US')} Wh` : 'capacity alone cannot fix this'

export interface PowerSystem {
  mode: PanelMode
  facingAz: number // deg, for fixed vertical panels
  areaM2: number
  efficiency: number // 0..1, cell + system
  loadW: number
  batteryWh: number // rated capacity; with ideal defaults it is all usable and starts full
  storage?: StorageModel // absent preserves legacy ideal-model links
  thermal?: ThermalModel // optional single equipment-node what-if; absent makes no temperature claim
}

export const DEFAULT_POWER: PowerSystem = { mode: 'tracking', facingAz: 0, areaM2: 2, efficiency: 0.28, loadW: 120, batteryWh: 1000 }

/** Incidence factor of sunlight on the panel (cosine of the angle of incidence, >= 0). */
export function incidence(mode: PanelMode, sunAzDeg: number, sunElDeg: number, facingAz = 0): number {
  const el = (sunElDeg * Math.PI) / 180
  switch (mode) {
    case 'horizontal':
      return Math.max(0, Math.sin(el))
    case 'tracking':
      return Math.max(0, Math.cos(el)) // vertical panel rotating to face the Sun's azimuth
    case 'fixed':
      return Math.max(0, Math.cos(el) * Math.cos(((sunAzDeg - facingAz) * Math.PI) / 180))
  }
}

export interface PowerStats {
  endStoredWh:number // double-precision state for causal sub-interval continuation
  endTemperatureK:number|null
  energyWh: number
  meanW: number
  peakW: number
  loadWh: number
  balanceWh: number
  batteryNeededWh: number // energy to carry the load through the longest stretch below the load
  hoursBelowLoad: number
  series: Float32Array // electrical power per hour (W)
  soc: Float32Array // battery charge at the end of each hour (Wh)
  emptyAt: number | null // hours after the window start when the battery first runs flat
  unpoweredH: number // hours the load could not be met
  metFrac: Float32Array // share of each hour the load was met (0..1)
  load: Float32Array // load per hour (W): the base load plus any extra, such as the radio while it transmits
  shortfallAt: number | null // first unmet bus demand; may precede depletion due to discharge-rate limits
  usableWh: number // rated capacity times allowed depth of discharge
  initialStoredWh: number // initial energy above the protected floor
  heaterWh: number
  extraWh: number
  storageLossWh: number
  curtailedWh: number
  unservedWh: number
  dischargeLimitedH: number
  sizingReason: 'discharge-limit' | 'initial-charge' | null
  thermal?: ThermalStats
}

/**
 * Electrical output hour by hour over [i0, i0 + len): S × (1 au / d)² × visible disk × incidence × area × efficiency.
 * Storage is tracked above the protected state-of-charge floor. Losses occur only on storage transfers.
 * Minimum rated capacity is the larger of (a) maximum cumulative drawdown / allowed DoD and
 * (b) initial-prefix deficit / initial available fraction. This includes charge-rate limits and losses.
 * A discharge-rate bottleneck, or an initial deficit with no initial usable charge, cannot be fixed by capacity.
 */
export function powerStats(eph: Ephemeris, t: Track, i0: number, len: number, p: PowerSystem, extraW?: Float32Array, escapedW?: Float32Array): PowerStats {
  const a = Math.round(i0)
  const b = a + Math.round(len)
  const series = new Float32Array(b - a)
  const soc = new Float32Array(b - a)
  const metFrac = new Float32Array(b - a)
  const loads = new Float32Array(b - a)
  const m = storageModel(p)
  const th = p.thermal, thermal = th ? initThermal(th, b - a) : undefined
  let actualK = th?.initialK ?? 0, plannedK = actualK, sizingRateLimited = false
  const dt = eph.stepS / 3600
  const usableWh = p.batteryWh * m.maxDod
  const availableFraction = m.initialSoc - (1 - m.maxDod)
  const initialFraction = availableFraction <= 1e-12 ? 0 : availableFraction
  const initialStoredWh = p.batteryWh * initialFraction
  let loadWh = 0
  let charge = initialStoredWh
  let emptyAt: number | null = null
  let shortfallAt: number | null = null
  let unpowered = 0
  let energy = 0
  let peak = 0
  let deficit = 0
  let worstDeficit = 0
  let below = 0
  let worstBelow = 0
  let cumulative = 0, cumulativePeak = 0, prefixDeficit = 0
  let heaterWh = 0, extraWh = 0, storageLossWh = 0, curtailedWh = 0, unservedWh = 0, dischargeLimitedH = 0
  const d = eph.data
  for (let i = a; i < b; i++) {
    const k = i * 6
    const distKm = Math.hypot(d[k], d[k + 1], d[k + 2])
    const flux = SOLAR_CONSTANT * (AU_KM / distKm) ** 2
    const w = flux * t.sunFrac[i] * incidence(p.mode, t.sunAz[i], t.sunEl[i], p.facingAz) * p.areaM2 * p.efficiency * m.arrayFactor
    series[i - a] = w
    const extra = extraW ? extraW[i - a] : 0
    // RF transmitted out of the node is not equipment heat. Other external work can
    // be supplied through this channel too; absent it, base/extra loads dissipate locally.
    const dissipatableW = Math.max(0, p.loadW + extra - (escapedW?.[i - a] ?? 0))
    const absorbedSolarW = th ? th.solarAbsorptivity * th.solarAreaM2 * flux * t.sunFrac[i] : 0
    const heater = th ? heaterDemandW(th, actualK, absorbedSolarW, dissipatableW, eph.stepS) : t.sunFrac[i] <= 0 ? m.darkHeaterW : 0
    const plannedHeater = th ? heaterDemandW(th, plannedK, absorbedSolarW, dissipatableW, eph.stepS) : heater
    const load = p.loadW + extra + heater
    loads[i - a] = load
    loadWh += load * dt
    heaterWh += heater * dt
    extraWh += extra * dt
    metFrac[i - a] = 1
    const net = w - load
    let sizingNet: number
    if (net >= 0) {
      const chargeBus = Math.min(net, m.maxChargeW ?? Infinity)
      const stored = Math.min(Math.max(0, usableWh - charge), chargeBus * m.chargeEfficiency * dt)
      const takenBusWh = stored / m.chargeEfficiency
      charge += stored
      storageLossWh += takenBusWh - stored
      curtailedWh += net * dt - takenBusWh
      sizingNet = chargeBus * m.chargeEfficiency * dt
    } else {
      const need = -net
      const rate = Math.min(need, m.maxDischargeW ?? Infinity)
      const deliveredWh = Math.min(rate * dt, charge * m.dischargeEfficiency)
      const withdrawn = deliveredWh / m.dischargeEfficiency
      const frac = rate < need - 1e-9 ? 0 : Math.min(1, deliveredWh / (need * dt))
      if (rate < need - 1e-9) dischargeLimitedH += dt
      if (frac < 1 - 1e-9) {
        if (shortfallAt === null) shortfallAt = (i - a + frac) * dt
        unpowered += (1 - frac) * dt
        metFrac[i - a] = frac
      }
      if (rate > 0 && charge * m.dischargeEfficiency < rate * dt - 1e-9 && emptyAt === null) {
        emptyAt = (i - a) * dt + charge * m.dischargeEfficiency / rate
      } else if (charge === 0 && emptyAt === null) emptyAt = (i - a) * dt
      charge = Math.max(0, charge - withdrawn)
      storageLossWh += withdrawn - deliveredWh
      unservedWh += need * dt - deliveredWh
      sizingNet = -need * dt / m.dischargeEfficiency
    }
    if (th && thermal) {
      const j = i - a, f = metFrac[j], busHeat = dissipatableW * th.wasteHeatFraction
      const plan = advanceThermal(th, plannedK, absorbedSolarW + busHeat + plannedHeater, eph.stepS)
      const on = advanceThermal(th, actualK, absorbedSolarW + busHeat + heater, eph.stepS * f)
      const off = advanceThermal(th, on.endK, absorbedSolarW, eph.stepS * (1 - f))
      plannedK = plan.endK; actualK = off.endK
      thermal.temperatureK[j + 1] = actualK; thermal.fullPowerK[j + 1] = plannedK
      thermal.heaterW[j] = heater; thermal.deliveredHeaterWh[j] = heater * dt * f
      thermal.minK = Math.min(thermal.minK, on.minK, off.minK); thermal.maxK = Math.max(thermal.maxK, on.maxK, off.maxK)
      thermal.coldH += (on.coldS + off.coldS) / 3600; thermal.hotH += (on.hotS + off.hotS) / 3600
      const breachS = on.firstBreachS ?? (off.firstBreachS === null ? null : eph.stepS * f + off.firstBreachS)
      if (thermal.firstBreachH === null && breachS !== null) thermal.firstBreachH = j * dt + breachS / 3600
      thermal.fullPowerPass &&= plan.firstBreachS === null
      thermal.residualJ += on.residualJ + off.residualJ
      // Minimum capacity is derived from the full-supply controlled trajectory, not the
      // colder failed-bus trajectory's different heater commands. Any remedy is rerun.
      const sizingNetW = w - (p.loadW + extra + plannedHeater)
      sizingRateLimited ||= -sizingNetW > (m.maxDischargeW ?? Infinity) + 1e-9
      sizingNet = sizingNetW >= 0 ? Math.min(sizingNetW, m.maxChargeW ?? Infinity) * m.chargeEfficiency * dt
        : sizingNetW * dt / m.dischargeEfficiency
    }
    soc[i - a] = charge
    energy += w * dt
    peak = Math.max(peak, w)
    cumulative += sizingNet
    cumulativePeak = Math.max(cumulativePeak, cumulative)
    deficit = cumulativePeak - cumulative
    prefixDeficit = Math.max(prefixDeficit, -cumulative)
    worstDeficit = Math.max(worstDeficit, deficit)
    if (w < load) {
      below += dt
      worstBelow = Math.max(worstBelow, below)
    } else if (deficit <= 1e-9) below = 0
  }
  const hours = (b - a) * dt
  const sizingReason = (th ? sizingRateLimited : dischargeLimitedH > 0) ? 'discharge-limit'
    : initialFraction === 0 && prefixDeficit > 1e-9 ? 'initial-charge' : null
  const batteryNeededWh = sizingReason ? Infinity : Math.max(worstDeficit / m.maxDod, initialFraction > 0 ? prefixDeficit / initialFraction : 0)
  return {
    endStoredWh:charge,endTemperatureK:th?actualK:null,
    energyWh: energy,
    meanW: energy / hours,
    peakW: peak,
    loadWh,
    balanceWh: energy - loadWh,
    batteryNeededWh,
    hoursBelowLoad: worstBelow,
    series,
    soc,
    emptyAt,
    unpoweredH: unpowered,
    metFrac,
    load: loads,
    shortfallAt, usableWh, initialStoredWh, heaterWh, extraWh, storageLossWh, curtailedWh,
    unservedWh, dischargeLimitedH, sizingReason, thermal,
  }
}
