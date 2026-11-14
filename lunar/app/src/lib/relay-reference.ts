import raw from '../../public/data/relay-reference.json'
import { Horizon } from './astro'
import type { Track } from './metrics'
import type { RelayPass, RelayPlan } from './relay'

export interface ReferenceBinding { id:string; reportSha256:string }
export interface ReferenceHour {
  access:boolean;backhaul:boolean;access_clearance_min_deg:number;access_range_max_km:number;backhaul_range_max_km:number|null
}
export interface RelayReferenceCase {
  id:string;site:{id:string;lat:number;lon:number;ground_m:number;observer_m:number};spacecraft:string
  startUnix:number;hours:number;cadenceS:number;reportSha256:string;csvSha256:string;orbitChecksSha256:string
  horizonCentideg:number[];hourly:ReferenceHour[];passes:RelayPass[];accessChecks:{azDeg:number;elDeg:number;clearanceDeg:number}[]
  accessKbps:number;backhaulKbps:number;accessHours:number;backhaulHours:number;limitations:string[]
  numerics:{maximum30DayPositionDifferenceM:number;maximumHermiteMidpointDifferenceM:number}
  limbTerrain:{product:string;url:string;sha256:string;validationSha256:string;frame:string;gridM:number;stepM:number;guardM:number;maximumStressMovingFrameCheckErrorM:number;maximumRefinementDifferenceM:number;removedStationSamples:number}
  source:{url:string;sha256:string;epochUtc:string;model:string;terrainFrame:string;forceFrame:string;horizonConvention:string}
}
const finite=(x:unknown,a:number,b:number)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b
const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)
export function validReferenceBinding(x:unknown):x is ReferenceBinding {
  return !!x&&typeof x==='object'&&typeof (x as ReferenceBinding).id==='string'&&/^[a-z0-9-]{1,60}$/.test((x as ReferenceBinding).id)&&hash((x as ReferenceBinding).reportSha256)
}
export function parseReferencePackage(value:unknown):RelayReferenceCase[] {
  const p=value as {schema:number;cases:RelayReferenceCase[]}
  if(!p||p.schema!==1||!Array.isArray(p.cases)||!p.cases.length||p.cases.length>50)throw new Error('Invalid reference package')
  const ids=new Set<string>()
  for(const c of p.cases) {
    if(!c||!validReferenceBinding(c)||ids.has(c.id)||!hash(c.csvSha256)||!hash(c.orbitChecksSha256)
      ||!c.site||!finite(c.site.lat,-90,90)||!finite(c.site.lon,-360,360)||!finite(c.site.ground_m,-20000,20000)||c.site.observer_m!==2
      ||!finite(c.startUnix,0,7258118400)||c.startUnix%3600!==0||!Number.isInteger(c.hours)||c.hours<1||c.hours>744
      ||!finite(c.cadenceS,5,30)||3600%c.cadenceS!==0||!Array.isArray(c.horizonCentideg)||c.horizonCentideg.length!==720||!c.horizonCentideg.every(v=>finite(v,-9000,9000))
      ||!Array.isArray(c.hourly)||c.hourly.length!==c.hours||!finite(c.accessKbps,0.001,1e9)||!finite(c.backhaulKbps,0.001,1e9)
      ||!Array.isArray(c.passes)||c.passes.length>64||!Array.isArray(c.limitations)||!c.limitations.every(v=>typeof v==='string')
      ||!c.source||!hash(c.source.sha256)||!c.source.url.startsWith('https://www.nasa.gov/')||c.source.terrainFrame!=='MOON_ME_DE440_ME421'
      ||!c.numerics||!finite(c.numerics.maximum30DayPositionDifferenceM,0,20)||!finite(c.numerics.maximumHermiteMidpointDifferenceM,0,50)
      ||!c.limbTerrain||c.limbTerrain.product!=='LDEM_64'||c.limbTerrain.frame!=='MOON_ME_DE421'||!hash(c.limbTerrain.sha256)||!hash(c.limbTerrain.validationSha256)
      ||!c.limbTerrain.url.startsWith('https://pds-geosciences.wustl.edu/')||c.limbTerrain.gridM!==473.802||c.limbTerrain.stepM!==12.5||c.limbTerrain.guardM!==100
      ||!finite(c.limbTerrain.maximumStressMovingFrameCheckErrorM,0,1)||!finite(c.limbTerrain.maximumRefinementDifferenceM,0,100)
      ||!Number.isInteger(c.limbTerrain.removedStationSamples)||c.limbTerrain.removedStationSamples<0)throw new Error('Invalid reference geometry or provenance')
    for(const w of c.passes)if(!w||!['access','backhaul'].includes(w.leg)||!finite(w.startUnix,c.startUnix,c.startUnix+c.hours*3600)||!finite(w.endUnix,c.startUnix,c.startUnix+c.hours*3600)||w.startUnix%3600||w.endUnix%3600||w.endUnix<=w.startUnix||w.kbps!==(w.leg==='access'?c.accessKbps:c.backhaulKbps))throw new Error('Reference contacts do not match their coverage')
    c.hourly.forEach((h,j)=>{
      const u=c.startUnix+j*3600
      if(typeof h.access!=='boolean'||typeof h.backhaul!=='boolean'||!finite(h.access_clearance_min_deg,-180,180)||!finite(h.access_range_max_km,1,100000)
        ||(h.backhaul_range_max_km!==null&&!finite(h.backhaul_range_max_km,100000,1000000))||h.backhaul&&h.backhaul_range_max_km===null
        ||h.access!==(h.access_clearance_min_deg>=.1)||(['access','backhaul'] as const).some(leg=>c.passes.some(w=>w.leg===leg&&u>=w.startUnix&&u<w.endUnix)!==h[leg]))throw new Error('Reference hourly geometry/contact mismatch')
    })
    const horizon=new Horizon(c.horizonCentideg)
    if(!Array.isArray(c.accessChecks)||c.accessChecks.length<12||c.accessChecks.some(v=>!finite(v.azDeg,0,360)||!finite(v.elDeg,-90,90)||!finite(v.clearanceDeg,-180,180)||Math.abs(v.elDeg-horizon.at(v.azDeg)-v.clearanceDeg)>1e-5))throw new Error('Reference horizon interpolation is inconsistent')
    if(c.accessHours!==c.hourly.filter(h=>h.access).length||c.backhaulHours!==c.hourly.filter(h=>h.backhaul).length)throw new Error('Reference contact totals mismatch')
    ids.add(c.id)
  }
  return p.cases
}
let referenceError:string|null=null
export const RELAY_REFERENCES=(()=>{try{return parseReferencePackage(raw)}catch(e){referenceError=e instanceof Error?e.message:String(e);return []}})()
export const referencePackageError=()=>referenceError
export const referenceCase=(b:ReferenceBinding|undefined)=>b?RELAY_REFERENCES.find(c=>c.id===b.id&&c.reportSha256===b.reportSha256):undefined
export function referenceScope(p:RelayPlan,t:Track,startUnix:number,len:number):{value?:RelayReferenceCase;shiftDeg:number;issue:string|null} {
  if(!p.reference)return {shiftDeg:0,issue:null}
  const c=referenceCase(p.reference),g=t.geometry
  if(!c)return {shiftDeg:0,issue:'Reference asset is unavailable or changed. Reload the reference plan.'}
  if(!g||!g.horizon.elev||Math.abs(g.lat-c.site.lat)>1e-7||Math.abs(g.lon-c.site.lon)>1e-7||Math.abs(g.groundM-c.site.ground_m)>.01||g.observerM!==c.site.observer_m||g.horizon.bins!==c.horizonCentideg.length)return {value:c,shiftDeg:0,issue:'Reference plan does not cover this point or observer height.'}
  if(startUnix<c.startUnix||startUnix+len*3600>c.startUnix+c.hours*3600)return {value:c,shiftDeg:0,issue:'Stay extends outside this absolute reference coverage. Choose dates inside its published interval.'}
  const elevations=g.horizon.elev,shiftDeg=Math.max(0,...c.horizonCentideg.map((v,j)=>elevations[j]-v/100))
  return {value:c,shiftDeg,issue:null}
}
