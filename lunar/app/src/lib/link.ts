import { Ephemeris } from './astro'
import { Track, availableStationMask } from './metrics'
import { PowerSystem, powerStats } from './power'
import { CommOperations, DEFAULT_TRAFFIC, dataLossPass, deliveryStats, operationsFor, plannedMask } from './communications'
import { RelayPlan, relayDelivery } from './relay'
import { relayService } from './relay-service'

/**
 * Downlink from the lander to one DSN 34 m beam-waveguide antenna, hour by hour.
 * Ground antenna gain and zenith system temperature: DSN 810-005, module 104 Rev. L (S 2295 MHz, X 8425 MHz).
 * The Moon fills the beam and adds its own radio glow: 136 K at S band and 189 K at X band, measured disk-centred
 * on a 34 m antenna (Morabito 2006, IPN Progress Report 42-166), which is the conservative value it recommends.
 */
export type Band = 'S' | 'X'

export interface Radio {
  band: Band
  txW: number // transmitter RF power
  gainDbi: number // lander antenna gain toward Earth (ignored when dishM is set)
  dishM?: number // a dish of this diameter: its gain follows from the band's wavelength
  maxKbps?: number // the radio's own top data rate (0 or absent: no cap)
  operations?: CommOperations
  relay?: RelayPlan // exclusive assumed relay service route; access geometry/RF verified externally
}

export const DEFAULT_RADIO: Radio = { band: 'X', txW: 10, gainDbi: 12 }

/** Aperture efficiency of a small lander dish (typical 0.5-0.65). */
export const DISH_EFFICIENCY = 0.55
/** DC power the radio draws per watt of RF output while it transmits: a solid-state amplifier near 30% efficiency. */
export const RADIO_DC_PER_RF_W = 1 / 0.3

/** Gain of a parabolic dish: efficiency x (pi D / wavelength)^2, so it changes with frequency (about 11 dB less at S than at X). */
export const dishGainDbi = (dM: number, band: Band) => 10 * Math.log10(DISH_EFFICIENCY * ((Math.PI * dM * BANDS[band].mhz * 1e6) / 299_792_458) ** 2)

export const antennaGain = (r: Radio) => (r.dishM ? dishGainDbi(r.dishM, r.band) : r.gainDbi)

/** DC power (W) the radio takes from the bus while transmitting. */
export const radioDcW = (r: Radio) => r.txW * RADIO_DC_PER_RF_W

export const BANDS: Record<Band, { mhz: number; groundGainDbi: number; tSysK: number; tMoonK: number }> = {
  S: { mhz: 2295, groundGainDbi: 56.74, tSysK: 30, tMoonK: 136 },
  X: { mhz: 8425, groundGainDbi: 68.3, tSysK: 22, tMoonK: 189 },
}

const BOLTZMANN_DB = -228.6 // dBW/(K·Hz)
export const LINK_LOSSES_DB = 2 // pointing, polarisation, atmosphere and cabling, lumped
export const REQUIRED_EBN0_DB = 2.5 // concatenated convolutional + Reed–Solomon code near a 1e-6 bit error rate
export const MARGIN_DB = 3
export { DSN_MIN_EL_DEG } from './astro'

const db = (x: number) => 10 * Math.log10(x)

/** Receive figure of merit G/T (dB/K) of a DSN 34 m antenna, with or without the Moon in its beam. */
export const gOverT = (band: Band, moon = true) => BANDS[band].groundGainDbi - db(BANDS[band].tSysK + (moon ? BANDS[band].tMoonK : 0))

/** Highest data rate (bit/s) that closes the link with the margin above, at a given Earth distance (km); never above the radio's cap. */
export function rateBps(r: Radio, distKm: number, moon = true): number {
  const lambdaM = 299_792_458 / (BANDS[r.band].mhz * 1e6)
  const pathLoss = 20 * Math.log10((4 * Math.PI * distKm * 1000) / lambdaM)
  const cn0 = db(Math.max(r.txW, 1e-6)) + antennaGain(r) - pathLoss - LINK_LOSSES_DB + gOverT(r.band, moon) - BOLTZMANN_DB
  const link = 10 ** ((cn0 - REQUIRED_EBN0_DB - MARGIN_DB) / 10)
  return r.maxKbps ? Math.min(link, r.maxKbps * 1000) : link
}

export interface LinkStats {
  rate: Float32Array // bit/s per hour, 0 without contact
  state: Uint8Array // 0 Earth down, 1 no DSN geometry, 2 planned contact, 3 excluded complex, 4 outside planned hours
  receivingMask: Uint8Array // available planned complexes; one reference 34 m link, never their summed capacity
  chosenStation: Uint8Array // bit of the single reference antenna with the best eligible rate; 0 if no contact
  stationGeometry: boolean // false only for synthetic/historical Earth-centre estimates
  geometryContactH: number
  geometryBits: number // no station selection or schedule; still a reference-antenna upper bound
  excludedStationH: number
  unscheduledH: number
  contactH: number
  bits: number // link limit: data volume if an antenna tracked every contact hour and the radio always had power
  bitsPowered: number // the same, counting only the part of each contact hour the battery and array could power
  poweredContactH: number
  meanRate: number // over contact hours
  longestGapH: number
  longestGapStart: number // hours after the window start
  gapOpenEnded: boolean // the longest silence touches the window start or end, so it is a lower bound
  longestPoweredGapH: number // includes time without enough power to operate the radio
  longestPoweredGapStart: number
  poweredGapOpenEnded: boolean
  moonPenaltyDb: number
}

/** Availability occupies the beginning of each hourly interval, as in the battery model. */
function longestGap(n: number, fractionAt: (i: number) => number) {
  let lastContactEnd: number | null = null
  let hours = 0, start = 0, openEnded = false
  const record = (gapStart: number, gapEnd: number, open: boolean) => {
    const length = gapEnd - gapStart
    if (length > hours || (length === hours && open)) {
      hours = length
      start = gapStart
      openEnded = open && length > 0
    }
  }
  for (let i = 0; i < n; i++) {
    const available = Math.max(0, Math.min(1, fractionAt(i)))
    if (available <= 0) continue
    record(lastContactEnd ?? 0, i, lastContactEnd === null)
    lastContactEnd = i + available
  }
  record(lastContactEnd ?? 0, n, true)
  return { hours, start, openEnded }
}

/**
 * Contact = Earth above the skyline by the chosen clearance and a DSN complex sees the Moon at 10° or more.
 * `powered` (0..1 per hour, from the power model) limits the volume to the hours the radio has power.
 */
export function linkStats(eph: Ephemeris, t: Track, i0: number, len: number, r: Radio, powered?: Float32Array): LinkStats {
  const a = Math.round(i0)
  const n = Math.round(len)
  const dt = eph.stepS / 3600
  const rate = new Float32Array(n)
  const state = new Uint8Array(n)
  const receivingMask = new Uint8Array(n)
  const chosenStation = new Uint8Array(n)
  const operations = operationsFor(r)
  let geometryContactH = 0, geometryBits = 0, excludedStationH = 0, unscheduledH = 0
  let contactH = 0
  let bits = 0
  let bitsPowered = 0
  let poweredContactH = 0
  for (let j = 0; j < n; j++) {
    const i = a + j
    const up = t.stations ? t.stations.clear.subarray(i * 3, i * 3 + 3).some(v => v >= t.earthMinClear) : t.earthClear[i] >= t.earthMinClear
    const visible = t.stations ? availableStationMask(t, i) : up ? eph.dsn?.[i] ?? 7 : 0
    const selected = visible & operations.stationMask
    const allocated = visible & plannedMask(operations, eph.startUnix + i * eph.stepS)
    state[j] = !up ? 0 : !visible ? 1 : !selected ? 3 : !allocated ? 4 : 2
    receivingMask[j] = up ? allocated : 0
    const bestRate = (mask: number) => {
      if (!t.stations) {
        const k = i * 6 + 3
        return { rate: Math.fround(rateBps(r, Math.hypot(eph.data[k], eph.data[k + 1], eph.data[k + 2]))), bit: mask & -mask }
      }
      let rate = 0, bit = 0
      for (let j = 0; j < 3; j++) if (mask & (1 << j)) {
        const candidate = Math.fround(rateBps(r, t.stations.distance[i * 3 + j]))
        if (candidate > rate) { rate = candidate; bit = 1 << j }
      }
      return { rate, bit }
    }
    if (visible) {
      const possibleRate = bestRate(visible).rate
      geometryBits += possibleRate * eph.stepS
      geometryContactH += dt
      if (state[j] === 3) excludedStationH += dt
      if (state[j] === 4) unscheduledH += dt
    }
    if (state[j] === 2) {
      const chosen = bestRate(allocated)
      rate[j] = chosen.rate
      chosenStation[j] = chosen.bit
      bits += rate[j] * eph.stepS
      const on = powered ? Math.max(0, Math.min(1, powered[j])) : 1
      bitsPowered += rate[j] * eph.stepS * on
      poweredContactH += on * dt
      contactH += dt
    }
  }
  const geometricGap = longestGap(n, (i) => state[i] === 2 ? 1 : 0)
  const poweredGap = powered ? longestGap(n, (i) => state[i] === 2 ? powered[i] : 0) : geometricGap
  return {
    rate, state, receivingMask, chosenStation, stationGeometry: !!t.stations, geometryContactH, geometryBits, excludedStationH, unscheduledH,
    contactH, bits, bitsPowered, poweredContactH, meanRate: contactH ? bits / 3600 / contactH : 0,
    longestGapH: geometricGap.hours * dt, longestGapStart: geometricGap.start * dt, gapOpenEnded: geometricGap.openEnded,
    longestPoweredGapH: poweredGap.hours * dt, longestPoweredGapStart: poweredGap.start * dt, poweredGapOpenEnded: poweredGap.openEnded,
    moonPenaltyDb: gOverT(r.band, false) - gOverT(r.band, true),
  }
}

/**
 * Power and downlink together: the radio's DC draw joins the load while it transmits, and data only flows
 * while the battery and array can power it.
 */
export function missionBudget(eph: Ephemeris, t: Track, i0: number, len: number, p: PowerSystem, r: Radio, external?:{loadW:Float32Array;escapedW?:Float32Array}) {
  if(external&&(external.loadW.length!==Math.round(len)||external.escapedW&&external.escapedW.length!==Math.round(len)))throw new Error('External bus stream alignment mismatch')
  if(external&&(external.loadW.some(v=>!Number.isFinite(v)||v<0)||external.escapedW?.some((v,j)=>!Number.isFinite(v)||v<0||v>external.loadW[j]+1e-6)))throw new Error('Invalid external bus/work power')
  const direct = linkStats(eph,t,i0,len,r)
  const service=r.relay?relayService(r.relay,t,eph.startUnix+Math.round(i0)*eph.stepS,Math.round(len),eph.stepS,r.txW,r.maxKbps):null
  const access=service?.access??null,backhaul=service?.backhaul??null
  const geometric = service ? { ...direct,state:Uint8Array.from(service.plannedAccess,v=>v>0?2:4) } : direct
  const dc = radioDcW(r)
  const extra = Float32Array.from(geometric.state, (v,j) => (v === 2 ? dc : 0)+(external?.loadW[j]??0))
  const rfOut = p.thermal ? Float32Array.from(geometric.state, (v,j) => (v === 2 ? r.txW : 0)+(external?.escapedW?.[j]??0)) : undefined
  const power = powerStats(eph, t, i0, len, p, extra, rfOut)
  let link = linkStats(eph, t, i0, len, r, power.metFrac)
  const operations = operationsFor(r)
  const relay = r.relay && access && backhaul ? relayDelivery(r.relay,operations.traffic??DEFAULT_TRAFFIC,access,backhaul,power.metFrac,eph.stepS) : null
  if(relay && access && backhaul) {
    const dt=eph.stepS/3600
    const contactH=Array.from(service!.plannedAccess).filter(v=>v>0).length*dt
    const bits=Array.from(access).reduce((sum,v)=>sum+v*eph.stepS,0)
    const bitsPowered=Array.from(access).reduce((sum,v,j)=>sum+v*eph.stepS*power.metFrac[j],0)
    const gap=longestGap(access.length,j=>relay.earthActiveFrac[j])
    const accessGap=longestGap(access.length,j=>access[j]>0?1:0)
    link={ ...link,rate:access,state:geometric.state,receivingMask:new Uint8Array(access.length),chosenStation:new Uint8Array(access.length),stationGeometry:false,
      geometryContactH:contactH,geometryBits:bits,excludedStationH:0,unscheduledH:access.length*dt-contactH,contactH,bits,bitsPowered,
      poweredContactH:Array.from(service!.plannedAccess).reduce((sum,v,j)=>sum+(v>0?power.metFrac[j]*dt:0),0),meanRate:contactH?bits/contactH/3600:0,
      longestGapH:accessGap.hours*dt,longestGapStart:accessGap.start*dt,gapOpenEnded:accessGap.openEnded,
      longestPoweredGapH:gap.hours*dt,longestPoweredGapStart:gap.start*dt,poweredGapOpenEnded:gap.openEnded }
  }
  const delivery = relay?.lander ?? (operations.traffic ? deliveryStats(operations.traffic, link.rate, power.metFrac, eph.stepS) : null)
  const lossPass=dataLossPass(delivery,{...operations,traffic:relay?(operations.traffic??DEFAULT_TRAFFIC):operations.traffic}) && (!relay||relay.relayLostBits<=r.relay!.maxLossGb*8e9+1)
  return { power, link, directLink:direct, relay,relayService:service,relaySetupPass:service?.setupPass??true, radioW: dc, delivery,totalLostBits:(delivery?.lostBits??0)+(relay?.relayLostBits??0),returnedBits:relay?.deliveredBits??delivery?.deliveredBits??link.bitsPowered,
    dataLossPass:lossPass,dataPass:(service?.setupPass??true)&&lossPass }
}
export type MissionBudget = ReturnType<typeof missionBudget>

export function fmtRate(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbit/s`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(bps >= 1e4 ? 0 : 1)} kbit/s`
  return `${Math.round(bps)} bit/s`
}

export function fmtBytes(bits: number): string {
  const B = bits / 8
  if (B >= 1e12) return `${(B / 1e12).toFixed(1)} TB`
  if (B >= 1e9) return `${(B / 1e9).toFixed(B >= 1e10 ? 0 : 1)} GB`
  if (B >= 1e6) return `${(B / 1e6).toFixed(B >= 1e7 ? 0 : 1)} MB`
  return `${Math.round(B / 1e3)} kB`
}
