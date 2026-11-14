/** Conditional two-leg RF ceilings. These inputs are assumptions, never provider specifications. */
export interface RelayRF {
  accessMHz: number
  accessGainDbi: number
  relayGtDbK: number | null
  backhaulMHz: number
  relayEirpDbW: number | null
  groundGtDbK: number | null
  accessLossDb: number
  backhaulLossDb: number
  accessEbNoDb: number
  backhaulEbNoDb: number
  marginDb: number
}
export const DEFAULT_RELAY_RF: Readonly<RelayRF> = {
  accessMHz:2250,accessGainDbi:12,relayGtDbK:null,backhaulMHz:8425,relayEirpDbW:null,groundGtDbK:null,
  accessLossDb:14,backhaulLossDb:6,accessEbNoDb:4.1,backhaulEbNoDb:4.1,marginDb:3,
}
const bounded=(x:unknown,a:number,b:number)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b
export function validRelayRF(x:unknown):x is RelayRF {
  if(!x||typeof x!=='object')return false
  const r=x as RelayRF
  return bounded(r.accessMHz,1,100000)&&bounded(r.backhaulMHz,1,100000)&&bounded(r.accessGainDbi,-20,80)
    &&(r.relayGtDbK===null||bounded(r.relayGtDbK,-100,100))&&(r.groundGtDbK===null||bounded(r.groundGtDbK,-100,100))
    &&(r.relayEirpDbW===null||bounded(r.relayEirpDbW,-100,100))&&bounded(r.accessLossDb,0,100)&&bounded(r.backhaulLossDb,0,100)
    &&bounded(r.accessEbNoDb,-10,50)&&bounded(r.backhaulEbNoDb,-10,50)&&bounded(r.marginDb,0,50)
}
export const fsplDb=(distanceKm:number,mhz:number)=>20*Math.log10(4*Math.PI*distanceKm*1000*mhz*1e6/299792458)
// Exact SI Boltzmann constant, converted to dBW/(K Hz).
export const BOLTZMANN_DB=10*Math.log10(1.380649e-23)
export function requiredEirpPlusGtDb(rateBps:number,distanceKm:number,mhz:number,lossDb:number,ebNoDb:number,marginDb:number):number {
  if(!(rateBps>0&&distanceKm>0&&mhz>0))return Infinity
  return 10*Math.log10(rateBps)+fsplDb(distanceKm,mhz)+lossDb+ebNoDb+marginDb+BOLTZMANN_DB
}
export function rfRateBps(eirpDbW:number,gtDbK:number,distanceKm:number,mhz:number,lossDb:number,ebNoDb:number,marginDb:number):number {
  if(!(distanceKm>0&&mhz>0))return 0
  return 10**((eirpDbW+gtDbK-fsplDb(distanceKm,mhz)-lossDb-BOLTZMANN_DB-ebNoDb-marginDb)/10)
}
