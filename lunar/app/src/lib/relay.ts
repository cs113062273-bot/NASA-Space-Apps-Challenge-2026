import { DeliveryStats, TrafficModel, deliveryStats } from './communications'
import { ReferenceBinding, validReferenceBinding } from './relay-reference'
import { RelayRF, validRelayRF } from './relay-rf'

/** Assumed provider service contacts. Geometry/RF/booking must be established externally. */
export interface RelayPass { startUnix: number; endUnix: number; leg: 'access' | 'backhaul'; kbps: number }
export interface RelayPlan {
  source: string
  bufferGb: number
  initialGb: number // mission data already on the relay at touchdown
  maxLossGb: number
  passes: RelayPass[]
  reference?: ReferenceBinding
  rf?: RelayRF
}
const finite = (x: unknown, max: number) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max
export function validRelay(x: unknown): x is RelayPlan {
  if (!x || typeof x !== 'object') return false
  const p = x as RelayPlan
  return typeof p.source === 'string' && p.source.length >= 1 && p.source.length <= 160 && !/[\r\n]/.test(p.source)
    && finite(p.bufferGb,1e9) && finite(p.initialGb,1e9) && finite(p.maxLossGb,1e9)
    && (p.reference===undefined||validReferenceBinding(p.reference)) && (p.rf===undefined||validRelayRF(p.rf))
    && Array.isArray(p.passes) && p.passes.length <= 64 && p.passes.every(w => w && ['access','backhaul'].includes(w.leg)
      && finite(w.startUnix,7258118400) && finite(w.endUnix,7258118400) && w.startUnix % 3600 === 0 && w.endUnix % 3600 === 0
      && w.endUnix > w.startUnix && finite(w.kbps,1e9))
}

/** Overlaps never multiply a radio's service capacity: use the highest granted rate. */
export function relayRate(p: RelayPlan, leg: RelayPass['leg'], unix: number): number {
  let rate = 0
  for (const w of p.passes) if (w.leg === leg && unix >= w.startUnix && unix < w.endUnix) rate = Math.max(rate,w.kbps*1000)
  return rate
}

export function exampleRelayPlan(startUnix: number): RelayPlan {
  const start = Math.floor(startUnix/3600)*3600, passes: RelayPass[] = []
  for (let d = 0; d < 7; d++) {
    passes.push({startUnix:start+d*86400,endUnix:start+d*86400+4*3600,leg:'access',kbps:512},
      {startUnix:start+d*86400+6*3600,endUnix:start+d*86400+8*3600,leg:'backhaul',kbps:2048})
  }
  return { source:'Editable hypothetical 7-day service plan; geometry, RF and booking unverified',bufferGb:5,initialGb:0,maxLossGb:0,passes }
}

export interface RelayDelivery {
  lander: DeliveryStats
  relayInitialBits: number
  deliveredBits: number // arrived at Earth during the stay, not merely received by the relay
  relayLostBits: number
  relayPendingBits: number
  relayBufferNeededBits: number // no-overflow backlog under this same access stream
  firstRelayOverflowH: number | null
  buffer: Float64Array
  delivered: Float64Array
  lost: Float64Array
  received: Float64Array
  earthActiveFrac: Float32Array
}

/** Hourly store-and-forward: relay serves start-of-bin backlog, then admits access arrivals at bin end.
 * New access data is quarantined until the next bin. It cannot be credited at Earth in the access bin,
 * even when both legs overlap. The two legs use independent full-duplex service resources. Backhaul
 * runs independently of lander power. No packet routing/retransmissions or actual provider compliance.
 */
export function relayDelivery(p: RelayPlan, traffic: TrafficModel, access: Float32Array, backhaul: Float32Array,
  powered: Float32Array, stepS: number): RelayDelivery {
  if (access.length !== backhaul.length || access.length !== powered.length || !Number.isFinite(stepS) || stepS <= 0) throw new Error('Relay stream alignment mismatch')
  const lander = deliveryStats(traffic,access,powered,stepS), n = access.length
  const capacity = p.bufferGb*8e9, initial = p.initialGb*8e9
  let queue = Math.min(capacity,initial), shadow = initial, needed = initial
  let lostBits = Math.max(0,initial-capacity), deliveredBits = 0, firstRelayOverflowH = lostBits > 1 ? 0 : null
  const buffer = new Float64Array(n), delivered = new Float64Array(n), lost = new Float64Array(n)
  const received = new Float64Array(n), earthActiveFrac = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const service = Math.max(0,backhaul[i])*stepS
    const sent = Math.min(queue,service)
    queue -= sent; shadow = Math.max(0,shadow-service)
    const incoming = lander.delivered[i]
    const dropped = Math.max(0,queue+incoming-capacity)
    queue = Math.min(capacity,queue+incoming)
    shadow += incoming; needed = Math.max(needed,shadow)
    if (dropped > 1 && firstRelayOverflowH === null) firstRelayOverflowH = (i+1)*stepS/3600
    deliveredBits += sent; lostBits += dropped
    buffer[i]=queue;delivered[i]=sent;lost[i]=dropped;received[i]=incoming
    earthActiveFrac[i]=service > 0 ? sent/service : 0
  }
  return { lander,relayInitialBits:initial,deliveredBits,relayLostBits:lostBits,relayPendingBits:queue,relayBufferNeededBits:needed,
    firstRelayOverflowH,buffer,delivered,lost,received,earthActiveFrac }
}

export function relayCsv(p: RelayPlan): string {
  return ['start_utc,end_utc,leg,rate_kbps',...p.passes.map(w => `${new Date(w.startUnix*1000).toISOString()},${new Date(w.endUnix*1000).toISOString()},${w.leg},${w.kbps}`)].join('\n')+'\n'
}
export function parseRelayCsv(csv: string): RelayPass[] {
  if(csv.length>100000) throw new Error('Relay plan is too large; use at most 64 contacts.')
  const rows=csv.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.trim()&&!l.trim().startsWith('#'))
  if(rows.shift()?.trim().toLowerCase()!=='start_utc,end_utc,leg,rate_kbps') throw new Error('Use start_utc,end_utc,leg,rate_kbps.')
  const passes=rows.map((row,i)=>{
    const f=row.split(',').map(v=>v.trim())
    const date=(s:string)=>/^\d{4}-\d\d-\d\dT\d\d:00(?::00(?:\.000)?)?Z$/.test(s)?Date.parse(s)/1000:NaN
    const a=date(f[0]??''),b=date(f[1]??'')
    if(f.length!==4||!Number.isFinite(a)||!Number.isFinite(b)||new Date(a*1000).toISOString().slice(0,13)!==f[0].slice(0,13)
      ||new Date(b*1000).toISOString().slice(0,13)!==f[1].slice(0,13)||!['access','backhaul'].includes(f[2])||f[3]==='') throw new Error(`Invalid relay contact on row ${i+2}. Use explicit UTC whole hours.`)
    return {startUnix:a,endUnix:b,leg:f[2] as RelayPass['leg'],kbps:Number(f[3])}
  })
  if(!validRelay({source:'Imported plan',bufferGb:0,initialGb:0,maxLossGb:0,passes})) throw new Error('Invalid relay contacts, rates or count (maximum 64).')
  return passes
}
