import type { Track } from './metrics'
import { RelayPlan, relayRate } from './relay'
import { referenceScope } from './relay-reference'
import { requiredEirpPlusGtDb, rfRateBps, validRelayRF } from './relay-rf'

/** Every selected run resolves the bound point, dates, horizon and RF assumptions anew. */
export function relayService(p:RelayPlan,t:Track,startUnix:number,n:number,stepS:number,txW:number,modemKbps=0) {
  const scope=referenceScope(p,t,startUnix,n),issues:string[]=[]
  if(scope.issue)issues.push(scope.issue)
  if(p.reference&&stepS!==3600)issues.push('Reference plans require the hourly mission grid.')
  if(p.rf&&!scope.value)issues.push('RF-constrained service needs matching reference range geometry.')
  const rf=p.rf
  if(rf&&!validRelayRF(rf))issues.push('Invalid relay RF assumptions.')
  const scopeBlocked=issues.length>0
  if(rf&&validRelayRF(rf)) {
    if(rf.relayGtDbK===null)issues.push('Enter relay receiver G/T before access service can be credited.')
    if(rf.relayEirpDbW===null)issues.push('Enter relay transmitter EIRP before Earth backhaul can be credited.')
    if(rf.groundGtDbK===null)issues.push('Enter ground receiver G/T before Earth backhaul can be credited.')
  }
  const plannedAccess=new Float32Array(n),access=new Float32Array(n),backhaul=new Float32Array(n)
  let accessGtNeeded:number|null=null,backhaulEirpPlusGtNeeded:number|null=null,accessRangeKm:number|null=null,backhaulRangeKm:number|null=null
  const eirp=rf?10*Math.log10(txW)+rf.accessGainDbi:0
  for(let j=0;j<n;j++) {
    const u=startUnix+j*stepS,c=scope.value,h=c?.hourly[Math.round((u-c.startUnix)/3600)]
    if(scopeBlocked)continue
    const a=(!p.reference||h&&h.access&&h.access_clearance_min_deg-scope.shiftDeg>=.1-1e-6)?relayRate(p,'access',u):0
    const b=(!p.reference||h?.backhaul)?relayRate(p,'backhaul',u):0
    plannedAccess[j]=a
    let ar=Math.min(a,modemKbps?modemKbps*1000:Infinity),br=b
    if(rf&&h) {
      if(ar>0) {
        accessRangeKm=Math.max(accessRangeKm??0,h.access_range_max_km)
        const required=requiredEirpPlusGtDb(ar,h.access_range_max_km,rf.accessMHz,rf.accessLossDb,rf.accessEbNoDb,rf.marginDb)-eirp
        accessGtNeeded=Math.max(accessGtNeeded??-Infinity,required)
        ar=rf.relayGtDbK===null?0:Math.min(ar,rfRateBps(eirp,rf.relayGtDbK,h.access_range_max_km,rf.accessMHz,rf.accessLossDb,rf.accessEbNoDb,rf.marginDb))
      }
      if(br>0&&h.backhaul_range_max_km!==null) {
        backhaulRangeKm=Math.max(backhaulRangeKm??0,h.backhaul_range_max_km)
        backhaulEirpPlusGtNeeded=Math.max(backhaulEirpPlusGtNeeded??-Infinity,requiredEirpPlusGtDb(br,h.backhaul_range_max_km,rf.backhaulMHz,rf.backhaulLossDb,rf.backhaulEbNoDb,rf.marginDb))
        br=rf.relayEirpDbW===null||rf.groundGtDbK===null?0:Math.min(br,rfRateBps(rf.relayEirpDbW,rf.groundGtDbK,h.backhaul_range_max_km,rf.backhaulMHz,rf.backhaulLossDb,rf.backhaulEbNoDb,rf.marginDb))
      }else br=0
    }
    access[j]=ar;backhaul[j]=br
  }
  return {plannedAccess,access,backhaul,issues,setupPass:issues.length===0,reference:scope.value??null,binding:p.reference??null,rfAssumptions:p.rf??null,skylineShiftDeg:scope.shiftDeg,
    rfMode:!rf?'assumed' as const:issues.length?'blocked' as const:'evaluated' as const,
    requirements:{accessGtDbK:accessGtNeeded,backhaulEirpPlusGtDb:backhaulEirpPlusGtNeeded,accessRangeKm,backhaulRangeKm}}
}
