/** Single isothermal equipment node in vacuum. Engineering what-if inputs, not lunar ground temperatures. */
export interface ThermalModel {
  initialK: number
  minK: number
  maxK: number
  setpointK: number
  heatCapacityJPerK: number
  solarAbsorptivity: number
  solarAreaM2: number // effective Sun-facing projected area, held fixed while any Sun is visible
  emissivity: number
  radiatingAreaM2: number
  groundViewFactor: number
  groundK: number // fixed IR boundary scenario; not a prediction of the local surface
  conductanceWPerK: number
  baseK: number // fixed conductive mounting boundary
  wasteHeatFraction: number // retained share of base + radio DC minus outgoing RF power dissipated in this node
  maxHeaterW: number
}

export const SIGMA = 5.670374419e-8 // Stefan–Boltzmann constant, W m^-2 K^-4 (SI)
export const SPACE_K = 3
export const THERMAL_STEP_S = 300
export const THERMAL_EXAMPLE: Readonly<ThermalModel> = {
  initialK: 283, minK: 253, maxK: 323, setpointK: 273,
  heatCapacityJPerK: 50000, solarAbsorptivity: 0.2, solarAreaM2: 0.25,
  emissivity: 0.8, radiatingAreaM2: 1, groundViewFactor: 0.5, groundK: 100,
  conductanceWPerK: 0, baseK: 100, wasteHeatFraction: 0.8, maxHeaterW: 200,
}

export const THERMAL_FIELDS = Object.keys(THERMAL_EXAMPLE) as (keyof ThermalModel)[]
export function validThermal(x: unknown): x is ThermalModel {
  if (!x || typeof x !== 'object') return false
  const m = x as ThermalModel
  if (!THERMAL_FIELDS.every(k => typeof m[k] === 'number' && Number.isFinite(m[k]))) return false
  const temp = (n: number) => n >= 3 && n <= 1000
  const unit = (n: number) => n >= 0 && n <= 1
  return temp(m.initialK) && temp(m.minK) && temp(m.maxK) && temp(m.setpointK) && temp(m.groundK) && temp(m.baseK)
    && m.minK < m.maxK && m.setpointK >= m.minK && m.setpointK <= m.maxK
    && m.heatCapacityJPerK >= 1000 && m.heatCapacityJPerK <= 1e9
    && unit(m.solarAbsorptivity) && unit(m.emissivity) && unit(m.groundViewFactor) && unit(m.wasteHeatFraction)
    && m.solarAreaM2 >= 0 && m.solarAreaM2 <= 100 && m.radiatingAreaM2 >= 0 && m.radiatingAreaM2 <= 100
    && m.conductanceWPerK >= 0 && m.conductanceWPerK <= 1000 && m.maxHeaterW >= 0 && m.maxHeaterW <= 100000
}

export function thermalLossW(m: ThermalModel, temperatureK: number): number {
  const incoming4 = m.groundViewFactor * m.groundK ** 4 + (1 - m.groundViewFactor) * SPACE_K ** 4
  return m.emissivity * SIGMA * m.radiatingAreaM2 * (temperatureK ** 4 - incoming4)
    + m.conductanceWPerK * (temperatureK - m.baseK)
}

/** Hourly sample-and-hold heater controller: power needed to reach the setpoint in one implicit step.
 * Hardware control cycles, hysteresis and component gradients are deliberately not inferred.
 */
export function heaterDemandW(m: ThermalModel, temperatureK: number, solarW: number, busW: number, seconds: number): number {
  return Math.max(0, Math.min(m.maxHeaterW, m.heatCapacityJPerK * (m.setpointK - temperatureK) / seconds
    + thermalLossW(m, m.setpointK) - solarW - m.wasteHeatFraction * busW))
}

export interface ThermalSegment {
  endK: number
  minK: number
  maxK: number
  coldS: number
  hotS: number
  firstBreachS: number | null
  residualJ: number
}

/** Backward Euler with step doubling: solves C ΔT/dt = Qsolar + Qdiss + Qheater − radiation − conduction.
 * Steps shrink when the one-step/two-half-step temperature difference is too large. The accepted
 * two half steps are monotone and stable for a short thermal time constant. This controls numerical
 * integration error only; geometry, forcing/control cadence and node assumptions remain limitations.
 */
export function advanceThermal(m: ThermalModel, startK: number, heatW: number, seconds: number, stepS = THERMAL_STEP_S): ThermalSegment {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(stepS) || stepS <= 0) throw new Error('Invalid thermal integration interval')
  let t = startK, minK = t, maxK = t, coldS = 0, hotS = 0, residualJ = 0
  let firstBreachS: number | null = t < m.minK - 1e-6 || t > m.maxK + 1e-6 ? 0 : null
  if (!seconds) return { endK: t, minK, maxK, coldS, hotS, firstBreachS, residualJ }
  const a = m.emissivity * SIGMA * m.radiatingAreaM2
  const implicit = (old: number, dt: number) => {
    let value = old
    for (let j = 0; j < 30; j++) {
      const residual = m.heatCapacityJPerK * (value - old) / dt - heatW + thermalLossW(m, value)
      const delta = residual / (m.heatCapacityJPerK / dt + 4 * a * value ** 3 + m.conductanceWPerK)
      const next = value - delta > 0 ? value - delta : value / 2
      if (Math.abs(next - value) < 1e-10) return next
      value = next
    }
    throw new Error('Thermal heat-balance solve did not converge')
  }
  const record = (old: number, end: number, elapsed: number, dt: number) => {
    t = end
    residualJ += m.heatCapacityJPerK * (t - old) - dt * (heatW - thermalLossW(m, t))
    minK = Math.min(minK, t); maxK = Math.max(maxK, t)
    const fractionBelow = (limit: number) => {
      if (old >= limit && t >= limit) return 0
      if (old < limit && t < limit) return 1
      const cross = (limit - old) / (t - old)
      return t < old ? 1 - cross : cross
    }
    coldS += dt * fractionBelow(m.minK - 1e-6)
    hotS += dt * (1 - fractionBelow(m.maxK + 1e-6))
    if (firstBreachS === null && (t < m.minK - 1e-6 || t > m.maxK + 1e-6)) {
      const limit = t < m.minK ? m.minK : m.maxK
      firstBreachS = elapsed + dt * Math.max(0, Math.min(1, (limit - old) / (t - old)))
    }
  }
  let elapsed = 0, dt = Math.min(stepS, seconds), attempts = 0
  while (elapsed < seconds - 1e-10) {
    if (++attempts > 100000) throw new Error('Thermal integration exceeded its work limit')
    dt = Math.min(dt, seconds - elapsed)
    const old = t, coarse = implicit(old, dt), mid = implicit(old, dt / 2), fine = implicit(mid, dt / 2)
    const error = Math.abs(fine - coarse), tolerance = 0.00001 + 0.0000001 * Math.max(old, fine)
    if (error > tolerance) {
      dt *= Math.max(0.1, 0.8 * Math.sqrt(tolerance / error))
      if (dt < 1e-8) throw new Error('Thermal integration step became too small')
      continue
    }
    record(old, mid, elapsed, dt / 2)
    record(mid, fine, elapsed + dt / 2, dt / 2)
    elapsed += dt
    dt = Math.min(stepS, dt * (error > 0 ? Math.min(2, Math.max(0.5, 0.9 * Math.sqrt(tolerance / error))) : 2))
  }
  return { endK: t, minK, maxK, coldS, hotS, firstBreachS, residualJ }
}

export interface ThermalStats {
  temperatureK: Float32Array // initial value plus each hour end
  fullPowerK: Float32Array // counterfactual unlimited-supply controlled trajectory for storage sizing
  heaterW: Float32Array // requested hourly heater load, replacing the legacy darkness-only input
  deliveredHeaterWh: Float32Array
  minK: number
  maxK: number
  coldH: number
  hotH: number
  firstBreachH: number | null
  fullPowerPass: boolean
  residualJ: number
}

export function initThermal(m: ThermalModel, n: number): ThermalStats {
  const temperatureK = new Float32Array(n + 1), fullPowerK = new Float32Array(n + 1)
  temperatureK[0] = fullPowerK[0] = m.initialK
  return { temperatureK, fullPowerK, heaterW: new Float32Array(n), deliveredHeaterWh: new Float32Array(n),
    minK: m.initialK, maxK: m.initialK, coldH: 0, hotH: 0, firstBreachH: m.initialK < m.minK - 1e-6 || m.initialK > m.maxK + 1e-6 ? 0 : null,
    fullPowerPass: m.initialK >= m.minK && m.initialK <= m.maxK, residualJ: 0 }
}

export const thermalPass = (stats: { thermal?: ThermalStats }) => !stats.thermal
  || (stats.thermal.firstBreachH === null && stats.thermal.coldH < 1e-6 && stats.thermal.hotH < 1e-6)
