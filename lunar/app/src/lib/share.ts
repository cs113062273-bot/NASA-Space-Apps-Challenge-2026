// The shareable URL: everything that changes a PASS / FAIL, so a link reopens the same analysis.
import { DEFAULT_RADIO, Radio } from './link'
import { DEFAULT_POWER, IDEAL_STORAGE, PowerSystem, StorageModel, isIdealStorage, storageModel } from './power'
import { DEFAULT_REQ, Requirements, sameReq } from './requirements'
import { fromInputValue } from './ui'
import type { DecisionGoal } from './decision'
import { SearchSettings, validSearchSettings } from './search'
import { DEFAULT_OPERATIONS, operationsFor, validOperations } from './communications'
import { validThermal } from './thermal'
import { validRelay } from './relay'
import { AreaSettings, DEFAULT_AREA, validAreaSettings } from './landing-area'
import {LocalSkyConfig,parseSkyCode,skyCode} from './local-sky'
import {RouteSettings,DEFAULT_ROUTE,validRouteSettings} from './terrain-route'
import {TraverseSettings,validTraverseSettings} from './traverse'

export const DEFAULT_PINS = ['c1', 'shackleton', 'nobile-dm2', 'im2-actual']
/** The site a fresh visit opens on: Haworth, an Artemis III region whose one-week delay sensitivity shows what the tool is for */
export const DEFAULT_SITE = 'a3-haworth'
const POWER_KEYS = ['mode', 'facingAz', 'areaM2', 'efficiency', 'loadW', 'batteryWh'] as const
const MODES: PowerSystem['mode'][] = ['tracking', 'fixed', 'horizontal']
const STORAGE_KEYS = Object.keys(IDEAL_STORAGE) as (keyof StorageModel)[]

export interface ShareState {
  site?: string
  sky?:LocalSkyConfig
  cmpDetail?:string[] // source-specific custom-point references, including full source/result identity
  add?: [number, number] // a custom site travels as coordinates; the receiving browser recomputes its horizon
  date?: number // unix s
  days?: number
  req?: Requirements
  h?: number // panel height (m)
  ec?: number // Earth clearance (deg)
  dsn?: boolean // Earth counts only while a DSN antenna also sees the Moon
  cmp?: string[] // compared curated sites
  cmpAdd?: [number, number][] // compared sites you added, as coordinates
  pairs?: [string, number][] // site + landing date pairs to compare (curated site id, unix s)
  compareMode?: 'same' | 'pairs'
  plan?: [string, number, number] // original site (or pt:lat:lon), landing time, delay in days
  goal?: DecisionGoal
  /** replacement proposed on the Delays page, which is not applied to the mission until chosen */
  rep?: string
  pw?: PowerSystem
  rd?: Radio // the lander radio behind the downlink numbers
  search?: SearchSettings
  area?: AreaSettings
  areaRequired?:boolean
  terrainImport?:string
  route?:RouteSettings
  traverse?:TraverseSettings
  traverseRaw?:string // invalid/unsupported shared settings remain explicit, not silently defaulted
}

/** Query string for a state; settings at their default are left out to keep links short. */
export function encodeShare(s:ShareState&Required<Pick<ShareState,'date'|'days'|'req'|'h'|'ec'|'cmp'|'pw'>>): URLSearchParams {
  const q = new URLSearchParams()
  if(s.traverseRaw!==undefined)q.set('trip',s.traverseRaw)
  else if(s.traverse)q.set('trip',JSON.stringify(s.traverse))
  if (s.add) q.set('add', s.sky?`${s.add[0]},${s.add[1]}`:`${s.add[0].toFixed(7)},${s.add[1].toFixed(7)}`)
  if(s.sky)q.set('sky',skyCode(s.sky))
  if (!s.add&&s.site) q.set('site', s.site)
  q.set('date', new Date(s.date * 1000).toISOString().slice(0, 16))
  q.set('days', String(s.days))
  if (!sameReq(s.req, DEFAULT_REQ)) q.set('req', [s.req.minDaylightH, s.req.maxDarkH, s.req.minEarthPct, s.req.maxSlopeDeg].join(','))
  if (s.h !== 2) q.set('h', String(s.h))
  if (s.ec !== 0) q.set('ec', String(s.ec))
  if (s.dsn) q.set('dsn', '1')
  if (s.pairs?.length) q.set('pairs', s.pairs.map(([id, u]) => `${id}@${new Date(u * 1000).toISOString().slice(0, 16)}`).join(','))
  if (s.compareMode) q.set('cm', s.compareMode)
  if (s.plan) q.set('plan', `${s.plan[0]}@${new Date(s.plan[1] * 1000).toISOString().slice(0, 16)}@${s.plan[2]}`)
  if (s.goal && s.goal !== 'earth') q.set('goal', s.goal)
  if (s.rep) q.set('rep', s.rep)
  if (s.search && validSearchSettings(s.search)) q.set('find', [new Date(s.search.startUnix * 1000).toISOString().slice(0, 16), s.search.days, s.search.stepDays, s.search.minDataGb, s.search.maxSilenceH ?? ''].join(','))
  if (s.cmp.join() !== DEFAULT_PINS.join() || s.cmpAdd?.length) q.set('cmp', s.cmp.join(','))
  if(s.cmpDetail?.length)q.set('cmpdetail',s.cmpDetail.join(';'))
  if (s.cmpAdd?.length) q.set('cmpadd', s.cmpAdd.map(([la, lo]) => `${la.toFixed(7)},${lo.toFixed(7)}`).join(';'))
  if (POWER_KEYS.some((k) => s.pw[k] !== DEFAULT_POWER[k])) q.set('pw', POWER_KEYS.map((k) => s.pw[k]).join(','))
  if (!isIdealStorage(s.pw)) {
    const m = storageModel(s.pw)
    q.set('storage', STORAGE_KEYS.map(k => m[k] ?? '').join(','))
  }
  if (s.pw.thermal) q.set('thermal', JSON.stringify(s.pw.thermal))
  if (s.rd && (s.rd.band !== DEFAULT_RADIO.band || s.rd.txW !== DEFAULT_RADIO.txW || s.rd.gainDbi !== DEFAULT_RADIO.gainDbi || s.rd.dishM || s.rd.maxKbps)) {
    // a dish travels as its diameter (d0.5), so its gain is recomputed for the band
    q.set('rd', [s.rd.band, s.rd.txW, s.rd.dishM ? `d${s.rd.dishM}` : s.rd.gainDbi, ...(s.rd.maxKbps ? [s.rd.maxKbps] : [])].join(','))
  }
  if (s.rd?.operations && JSON.stringify(operationsFor(s.rd)) !== JSON.stringify(DEFAULT_OPERATIONS)) q.set('ops', JSON.stringify(operationsFor(s.rd)))
  if(s.rd?.relay) q.set('relay',JSON.stringify(s.rd.relay))
  if(s.areaRequired)q.set('groundcheck','1')
  if(s.terrainImport)q.set('groundsrc',s.terrainImport)
  if(s.route&&validRouteSettings(s.route)&&JSON.stringify(s.route)!==JSON.stringify(DEFAULT_ROUTE))q.set('route',JSON.stringify(s.route))
  if(s.area&&validAreaSettings(s.area)&&JSON.stringify(s.area)!==JSON.stringify(DEFAULT_AREA))q.set('ground',[s.area.diameterM,s.area.rmsMultiplier,Number(s.area.requireReturns)].join(','))
  return q
}

/** Parse a query string; anything malformed is dropped, so the app falls back to its default. */
export function decodeShare(search: string): ShareState {
  const q = new URLSearchParams(search)
  const out: ShareState = {}
  if(q.has('trip')){
    const raw=q.get('trip')!
    try{const value=raw.length<=16000?JSON.parse(raw):null;if(validTraverseSettings(value))out.traverse=value;else out.traverseRaw=raw.length<=16000?raw:'invalid-too-large'}catch{out.traverseRaw=raw.length<=16000?raw:'invalid-too-large'}
  }
  if(q.has('sky'))out.sky=parseSkyCode(q.get('sky')!)
  if(q.has('cmpdetail'))out.cmpDetail=q.get('cmpdetail')!.split(';').filter(Boolean).slice(0,10)
  if(q.has('route')){try {const route=JSON.parse(q.get('route')!);if(validRouteSettings(route))out.route=route}catch{}}
  // Preserve malformed source selections as an explicit unavailable source,
  // rather than silently changing a required imported screen to NASA data.
  if(q.has('groundsrc'))out.terrainImport=/^[a-f0-9]{64}$/.test(q.get('groundsrc')??'')?q.get('groundsrc')!:'invalid'
  if(q.get('groundcheck')==='1')out.areaRequired=true
  if(q.has('ground')) {
    const v=q.get('ground')!.split(',')
    const area={diameterM:Number(v[0]),rmsMultiplier:Number(v[1]),requireReturns:v[2]==='1'}
    if(v.length===3&&v[0].trim()&&v[1].trim()&&['0','1'].includes(v[2])&&validAreaSettings(area))out.area=area
  }
  if (['earth', 'slope', 'delay', 'battery'].includes(q.get('goal') ?? '')) out.goal = q.get('goal') as DecisionGoal
  if (/^[\w.:-]{1,80}$/.test(q.get('rep') ?? '')) out.rep = q.get('rep')!
  const nums = (k: string, n: number) => {
    const v = q.get(k)?.split(',').map(Number)
    return v && v.length === n && v.every((x) => Number.isFinite(x) && x >= 0) ? v : null
  }
  if (q.get('site')) out.site = q.get('site')!
  const d = q.get('date') ? fromInputValue(q.get('date')!) : null
  if (d) out.date = d
  const find = q.get('find')?.split(',')
  if (find?.length === 5) {
    const startUnix = fromInputValue(find[0])
    const settings: SearchSettings = { startUnix: startUnix ?? NaN, days: Number(find[1]), stepDays: Number(find[2]),
      minDataGb: find[3].trim() === '' ? NaN : Number(find[3]), maxSilenceH: find[4] === '' ? null : Number(find[4]) }
    if (validSearchSettings(settings)) out.search = settings
  }
  const n = Number(q.get('days'))
  if (n > 0 && n <= 90 && Math.round(n * 24) >= 1) out.days = Math.round(n * 24) / 24
  const add = q.get('add')?.split(',').map(Number)
  if (add && add.length === 2 && add.every(Number.isFinite)) out.add = [add[0], add[1]]
  const r = nums('req', 4)
  if (r) out.req = { minDaylightH: r[0], maxDarkH: r[1], minEarthPct: r[2], maxSlopeDeg: r[3] }
  if (q.get('h') === '10') out.h = 10
  const ec = Number(q.get('ec'))
  if (ec === 2 || ec === 5) out.ec = ec
  if (q.get('dsn') === '1') out.dsn = true
  const pairs = q.get('pairs')?.split(',').map((p) => p.split('@')).filter((p) => p.length === 2 && p[0] && fromInputValue(p[1]) !== null)
  if (pairs?.length) out.pairs = pairs.slice(0, 8).map(([id, d]) => [id, fromInputValue(d)!])
  if (q.get('cm') === 'same' || q.get('cm') === 'pairs') out.compareMode = q.get('cm') as 'same' | 'pairs'
  const plan = q.get('plan')?.split('@')
  if (plan?.length === 3 && plan[0] && fromInputValue(plan[1]) !== null && [1, 3, 7, 14, 30].includes(Number(plan[2]))) {
    out.plan = [plan[0], fromInputValue(plan[1])!, Number(plan[2])]
  }
  if (q.has('cmp')) out.cmp = q.get('cmp')!.split(',').filter(Boolean).slice(0, 10) // empty: nothing compared
  const ca = q.get('cmpadd')?.split(';').map((p) => p.split(',').map(Number))
  if (ca) {
    const ok = ca.filter((p): p is [number, number] => p.length === 2 && Math.abs(p[0]) <= 90 && Number.isFinite(p[1])).slice(0, 10)
    if (ok.length) out.cmpAdd = ok
  }
  const pw = q.get('pw')?.split(',')
  if (pw && pw.length === 6 && MODES.includes(pw[0] as PowerSystem['mode'])) {
    const v = pw.slice(1).map(Number)
    if (v.every((x) => Number.isFinite(x) && x >= 0)) {
      out.pw = { mode: pw[0] as PowerSystem['mode'], facingAz: v[0], areaM2: v[1], efficiency: Math.min(1, v[2]), loadW: v[3], batteryWh: v[4] }
    }
  }
  const storage = q.get('storage')?.split(',')
  if (storage?.length === STORAGE_KEYS.length) {
    const values = storage.map((v, i) => (i === 4 || i === 5) && v === '' ? null : v.trim() === '' ? NaN : Number(v))
    const [dod, soc, ec, ed, charge, discharge, heater, array] = values
    const unit = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 0 && v <= 1
    const rate = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1e9)
    if (unit(dod) && dod > 0 && unit(soc) && soc >= 1 - dod - 1e-12 && unit(ec) && ec > 0 && unit(ed) && ed > 0 &&
      rate(charge) && rate(discharge) && heater !== null && Number.isFinite(heater) && heater >= 0 && heater <= 1e9 && unit(array)) {
      const model = Object.fromEntries(STORAGE_KEYS.map((k, i) => [k, values[i]])) as unknown as StorageModel
      out.pw = { ...(out.pw ?? DEFAULT_POWER), storage: model }
    }
  }
  try {
    const thermal: unknown = JSON.parse(q.get('thermal') ?? 'null')
    if (validThermal(thermal)) out.pw = { ...(out.pw ?? DEFAULT_POWER), thermal }
  } catch { /* malformed optional model does not become executable configuration */ }
  const rd = q.get('rd')?.split(',')
  if (rd && (rd.length === 3 || rd.length === 4) && (rd[0] === 'S' || rd[0] === 'X')) {
    const tx = Number(rd[1])
    const dish = rd[2].startsWith('d') ? Number(rd[2].slice(1)) : null
    const g = dish === null ? Number(rd[2]) : DEFAULT_RADIO.gainDbi
    const cap = rd.length === 4 ? Number(rd[3]) : 0
    const okDish = dish === null || (dish > 0 && dish <= 5)
    if (tx > 0 && tx <= 500 && Number.isFinite(g) && g >= -5 && g <= 45 && okDish && Number.isFinite(cap) && cap >= 0) {
      out.rd = { band: rd[0], txW: tx, gainDbi: g, ...(dish ? { dishM: dish } : {}), ...(cap ? { maxKbps: cap } : {}) }
    }
  }
  if (q.has('ops') && q.get('ops')!.length <= 16000) {
    try {
      const operations: unknown = JSON.parse(q.get('ops')!)
      if (validOperations(operations)) out.rd = { ...(out.rd ?? DEFAULT_RADIO), operations }
    } catch { /* A malformed contact/traffic plan never overrides the legacy radio settings. */ }
  }
  if(q.has('relay') && q.get('relay')!.length<=16000) {
    try {
      const relay:unknown=JSON.parse(q.get('relay')!)
      if(validRelay(relay)) out.rd={...(out.rd??DEFAULT_RADIO),relay}
    } catch { /* Never replace an invalid plan by an apparently available relay. */ }
  }
  return out
}
