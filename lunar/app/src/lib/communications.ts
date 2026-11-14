/** User-planned allocations, not live bookings or a claim that DSN has accepted a request. */
export interface ContactWindow { startUnix: number; endUnix: number; stationMask: number }
export interface TrafficModel {
  generatedKbps: number // payload input while the full modeled bus demand is powered
  initialGb: number // decimal GB already recorded at touchdown
  bufferGb: number // decimal GB, finite storage; overflow discards the arriving excess
  maxLossGb: number // explicit allowed loss for decision/search screens
}
export interface CommOperations {
  stationMask: number // bit 0 Goldstone, bit 1 Madrid, bit 2 Canberra; zero deliberately disables all
  schedule: 'all' | 'daily' | 'windows'
  dailyStartHour: number // UTC integer hour
  dailyHours: number // contiguous integer hours, wraps midnight
  windows: ContactWindow[] // absolute UTC, half-open, aligned to whole hours
  traffic: TrafficModel | null
}
export const COMPLEXES = [{ mask: 1, name: 'Goldstone' }, { mask: 2, name: 'Madrid' }, { mask: 4, name: 'Canberra' }] as const
export const DEFAULT_OPERATIONS: Readonly<CommOperations> = {
  stationMask: 7, schedule: 'all', dailyStartHour: 0, dailyHours: 8, windows: [], traffic: null,
}
export const DEFAULT_TRAFFIC: Readonly<TrafficModel> = { generatedKbps: 100, initialGb: 0, bufferGb: 10, maxLossGb: 0 }
export const operationsFor = (radio: { operations?: CommOperations }): CommOperations => ({ ...DEFAULT_OPERATIONS, ...radio.operations })
export const complexNames = (mask: number) => COMPLEXES.filter(s => mask & s.mask).map(s => s.name).join(', ') || 'none'

const finiteRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const maskOk = (v: unknown): v is number => finiteRange(v, 0, 7) && Number.isInteger(v)
const wholeHour = (v: unknown): v is number => finiteRange(v, 0, 7258118400) && v % 3600 === 0
export function validOperations(value: unknown): value is CommOperations {
  if (!value || typeof value !== 'object') return false
  const o = value as CommOperations
  if (!maskOk(o.stationMask) || !['all', 'daily', 'windows'].includes(o.schedule) ||
    !finiteRange(o.dailyStartHour, 0, 23) || !Number.isInteger(o.dailyStartHour) ||
    !finiteRange(o.dailyHours, 0, 24) || !Number.isInteger(o.dailyHours) ||
    !Array.isArray(o.windows) || o.windows.length > 64 || !o.windows.every(w => w &&
      wholeHour(w.startUnix) && wholeHour(w.endUnix) && w.endUnix > w.startUnix && maskOk(w.stationMask))) return false
  return o.traffic === null || (!!o.traffic && typeof o.traffic === 'object' &&
    finiteRange(o.traffic.generatedKbps, 0, 1e9) && finiteRange(o.traffic.initialGb, 0, 1e9) &&
    finiteRange(o.traffic.bufferGb, 0, 1e9) && finiteRange(o.traffic.maxLossGb, 0, 1e9))
}

/** Union overlapping passes; no summation of antenna capacities or double booking benefit. */
export function plannedMask(o: CommOperations, unix: number): number {
  if (o.schedule === 'all') return o.stationMask
  if (o.schedule === 'daily') {
    const hour = ((unix / 3600) % 24 + 24) % 24
    return ((hour - o.dailyStartHour + 24) % 24) < o.dailyHours ? o.stationMask : 0
  }
  return o.windows.reduce((mask, w) => unix >= w.startUnix && unix < w.endUnix ? mask | w.stationMask : mask, 0) & o.stationMask
}

export interface DeliveryStats {
  initialBits: number
  producedBits: number
  missedProductionBits: number
  deliveredBits: number
  lostBits: number
  pendingBits: number
  peakBits: number
  bufferNeededBits: number // no-loss backlog with the same generation, powered contacts and fixed radio reservation
  firstOverflowH: number | null
  buffer: Float64Array
  delivered: Float64Array
  lost: Float64Array
  produced: Float64Array
}

/** Fluid queue at constant rates within each sample, with generation and downlink simultaneous.
 * Both run only in the beginning powered fraction of the interval, matching the storage simulation.
 * Radio power is reserved for the full planned contact, including times when the queue is empty.
 */
export function deliveryStats(model: TrafficModel, rates: Float32Array, powered: Float32Array, stepS: number): DeliveryStats {
  const n = rates.length, capacity = model.bufferGb * 8e9, inputRate = model.generatedKbps * 1000
  const initialBits = model.initialGb * 8e9
  let queue = Math.min(capacity, initialBits), shadow = initialBits, peakBits = queue, bufferNeededBits = shadow
  let lostBits = Math.max(0, initialBits - capacity), producedBits = 0, deliveredBits = 0, missedProductionBits = 0
  let firstOverflowH: number | null = lostBits > 0 ? 0 : null
  const buffer = new Float64Array(n), delivered = new Float64Array(n), lost = new Float64Array(n), produced = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const seconds = stepS * Math.max(0, Math.min(1, powered[i]))
    const incoming = inputRate * seconds, outgoing = Math.min(queue + incoming, rates[i] * seconds)
    const next = queue + incoming - outgoing
    const dropped = Math.max(0, next - capacity)
    if (dropped > 1e-6 && firstOverflowH === null) {
      firstOverflowH = i * stepS / 3600 + (capacity - queue) / (inputRate - rates[i]) / 3600
    }
    queue = Math.min(capacity, Math.max(0, next))
    shadow = Math.max(0, shadow + incoming - rates[i] * seconds)
    bufferNeededBits = Math.max(bufferNeededBits, shadow)
    peakBits = Math.max(peakBits, queue)
    producedBits += incoming; deliveredBits += outgoing; lostBits += dropped
    missedProductionBits += inputRate * (stepS - seconds)
    buffer[i] = queue; delivered[i] = outgoing; lost[i] = dropped; produced[i] = incoming
  }
  return { initialBits, producedBits, missedProductionBits, deliveredBits, lostBits, pendingBits: queue,
    peakBits, bufferNeededBits, firstOverflowH, buffer, delivered, lost, produced }
}

export const dataLossPass = (d: DeliveryStats | null, o: CommOperations) => !d || !o.traffic || d.lostBits <= o.traffic.maxLossGb * 8e9 + 1

export function contactPlanCsv(windows: ContactWindow[]): string {
  return ['start_utc,end_utc,complexes', ...windows.map(w => [new Date(w.startUnix * 1000).toISOString(),
    new Date(w.endUnix * 1000).toISOString(), COMPLEXES.filter(s => w.stationMask & s.mask).map(s => s.name).join('|') || 'none'].join(','))].join('\n') + '\n'
}

/** Strict all-or-nothing import. Explicit UTC and whole-hour boundaries match the hourly mask/model. */
export function parseContactPlanCsv(text: string): ContactWindow[] {
  if (text.length > 100_000) throw new Error('Contact plan is too large; use at most 64 passes.')
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))
  if (lines.shift()?.trim().toLowerCase() !== 'start_utc,end_utc,complexes') throw new Error('Use the header start_utc,end_utc,complexes.')
  if (lines.length > 64) throw new Error('Use at most 64 passes.')
  return lines.map((line, index) => {
    const values = line.split(',').map(v => v.trim().replace(/^"([^"]*)"$/, '$1'))
    const utc = (v: string) => {
      if (!/^\d{4}-\d\d-\d\dT\d\d:00(?::00(?:\.000)?)?Z$/.test(v)) return NaN
      const u = Date.parse(v) / 1000
      return Number.isFinite(u) && new Date(u * 1000).toISOString().slice(0, 16) === v.slice(0, 16) ? u : NaN
    }
    const startUnix = utc(values[0] ?? ''), endUnix = utc(values[1] ?? '')
    const names = (values[2] ?? '').split('|').map(v => v.trim().toLowerCase())
    const known = names.every(name => name === 'none' || COMPLEXES.some(s => s.name.toLowerCase() === name))
    const stationMask = COMPLEXES.reduce((mask, s) => names.includes(s.name.toLowerCase()) ? mask | s.mask : mask, 0)
    if (values.length !== 3 || !known || !wholeHour(startUnix) || !wholeHour(endUnix) || endUnix <= startUnix) {
      throw new Error(`Pass ${index + 1}: use valid UTC whole hours, an end after the start, and Goldstone|Madrid|Canberra (or none).`)
    }
    return { startUnix, endUnix, stationMask }
  })
}
