import { SiteRecord } from './data'
import { EvaluationInput, LandingOption, createLandingEvaluator } from './decision'

export interface SearchSettings {
  startUnix: number
  days: number // calendar span; starts at offsets 0 <= d < days
  stepDays: number
  minDataGb: number // decimal GB, using the smaller nominal / raised-skyline powered volume
  maxSilenceH: number | null // longest within-stay powered gap; null disables this filter
}

export interface SearchRow {
  option: LandingOption
  dataGb: number
  silenceH: number
  pass: boolean
  misses: string[]
}
export interface SearchResult {
  settings: SearchSettings
  rows: SearchRow[]
  passing: SearchRow[]
  frontier: SearchRow[]
  attempted: number
  unavailable: number
  reasons: Record<string, number> // overlaps are intentional: a row can miss several conditions
  siteCount: number
}

export function validSearchSettings(s: SearchSettings): boolean {
  return Number.isFinite(s.startUnix) && Number.isInteger(s.days) && s.days >= 1 && s.days <= 365 &&
    [1, 3, 7].includes(s.stepDays) && Number.isFinite(s.minDataGb) && s.minDataGb >= 0 &&
    (s.maxSilenceH === null || (Number.isFinite(s.maxSilenceH) && s.maxSilenceH >= 0))
}

export function serviceRow(option: LandingOption, settings: SearchSettings): SearchRow {
  const dataGb = Math.min(option.bits, option.shiftedBits) / 8e9
  const silenceH = Math.max(option.longestPoweredGapH, option.shiftedLongestPoweredGapH)
  const misses = [...option.misses,
    ...(dataGb + 1e-9 < settings.minDataGb ? ['data return'] : []),
    ...(settings.maxSilenceH !== null && silenceH > settings.maxSilenceH + 1e-9 ? ['powered silence'] : [])]
  return { option, dataGb, silenceH, pass: option.clearsScreen && misses.length === 0, misses }
}

/** Exact Pareto dominance on the sampled candidates, without weights or an aggregate safety score. */
export function dominates(a: SearchRow, b: SearchRow): boolean {
  const av = [a.option.unix, a.option.site.slope_deg!, a.option.batteryNeededWh, a.silenceH, -a.dataGb]
  const bv = [b.option.unix, b.option.site.slope_deg!, b.option.batteryNeededWh, b.silenceH, -b.dataGb]
  return av.every((v, i) => v <= bv[i]) && av.some((v, i) => v < bv[i])
}

export function paretoFrontier(rows: SearchRow[]): SearchRow[] {
  let frontier: SearchRow[] = []
  for (const row of rows) {
    if (!row.pass || frontier.some(other => dominates(other, row))) continue
    frontier = frontier.filter(other => !dominates(row, other))
    frontier.push(row)
  }
  return frontier
}

/** Cooperative chunks permit cancellation and leave the interface responsive during the discrete search. */
export async function searchMissions(input: EvaluationInput & { candidates: SiteRecord[]; settings: SearchSettings },
  control: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; yieldTask?: () => Promise<void> } = {}): Promise<SearchResult> {
  const { settings } = input
  if (!validSearchSettings(settings)) throw new Error('Invalid search dates, span or service requirements.')
  const sites = [...new Map(input.candidates.map(s => [s.id, s])).values()]
  if (!sites.length) throw new Error('Choose at least one site to search.')
  const { evaluate, within } = createLandingEvaluator(input)
  const total = sites.length * Math.ceil(settings.days / settings.stepDays)
  const result: SearchResult = { settings: { ...settings }, rows: [], passing: [], frontier: [], attempted: 0,
    unavailable: 0, reasons: {}, siteCount: sites.length }
  const abort = () => { if (control.signal?.aborted) throw new DOMException('Search cancelled', 'AbortError') }
  abort()
  for (let d = 0; d < settings.days; d += settings.stepDays) for (const site of sites) {
    abort()
    const unix = settings.startUnix + d * 86400
    if (!within(unix)) result.unavailable++
    else {
      const row = serviceRow(evaluate(site, unix)!, settings)
      result.rows.push(row)
      if (row.pass) result.passing.push(row)
      for (const reason of row.misses) result.reasons[reason] = (result.reasons[reason] ?? 0) + 1
    }
    result.attempted++
    if (result.attempted % 8 === 0 || result.attempted === total) {
      control.onProgress?.(result.attempted, total)
      await (control.yieldTask?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)))
      abort()
    }
  }
  result.frontier = paretoFrontier(result.passing)
  return result
}

export function searchCsv(result: SearchResult, metadata: { restoreUrl: string; assumptions: unknown }): string {
  const quote = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`
  const front = new Set(result.frontier)
  const rows = ['site,latitude_deg,longitude_deg,landing_utc,pass,pareto,smaller_powered_data_gb,longer_powered_silence_h,slope_deg,rated_battery_needed_wh,larger_payload_overflow_gb,nominal_equipment_min_k,nominal_equipment_max_k,raised_equipment_min_k,raised_equipment_max_k,misses,terrain_status,terrain_point_disc_diameter_m,terrain_required_diameter_m,terrain_patch_sha256,terrain_import_id']
  for (const row of result.rows) {
    const o = row.option
    rows.push([quote(o.site.name), o.site.lat, o.site.lon, new Date(o.unix * 1000).toISOString(), row.pass ? 1 : 0,
      front.has(row) ? 1 : 0, row.dataGb, row.silenceH, o.site.slope_deg ?? '',
      Number.isFinite(o.batteryNeededWh) ? o.batteryNeededWh : '', Math.max(o.dataLossBits, o.shiftedDataLossBits) / 8e9,
      o.temperatureMinK ?? '', o.temperatureMaxK ?? '', o.shiftedTemperatureMinK ?? '', o.shiftedTemperatureMaxK ?? '', quote(row.misses.join('; ')),
      o.terrain?.status??'',o.terrain?.radiusM!=null?o.terrain.radiusM*2:'',o.terrain?.requiredDiameterM??'',o.terrain?.patchSha256??'',o.terrain?.importId??''].join(','))
  }
  return [`# LUNORIZON discrete site/date search; surface conditions only; no launch, transfer or thermal clearance`,
    `# settings: ${JSON.stringify(result.settings)}; attempted ${result.attempted}; out of range ${result.unavailable}; sites ${result.siteCount}`,
    `# assumptions: ${JSON.stringify(metadata.assumptions)}`, `# restore_url: ${metadata.restoreUrl}`,
    '# data is modeled Earth arrival for assumed relay scenarios, modeled payload delivery for direct traffic, otherwise powered direct link capacity; allocations assumed available; smaller/larger compare nominal and raised skyline, not a probability bound',
    '# relay scenarios: geometry/orbit/RF/booking unverified; two independent queue overflow limits; larger_payload_overflow_gb aggregates lander and relay losses for reporting only, not a pooled allowance; silence is actual modeled Earth-forwarding gap, not command availability; contacts are absolute UTC',
    ...rows].join('\n') + '\n'
}
