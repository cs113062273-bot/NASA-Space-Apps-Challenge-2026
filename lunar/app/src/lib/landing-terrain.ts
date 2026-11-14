import {toLatLon,toXY} from './data'
import {AreaResult,AreaSettings,TerrainGrid,radiusAtPoint,terrainCellAtPoint,terrainCellKnown} from './landing-area'
import type {ImportProvenance} from './terrain-import'
import type {TerrainRouteReport} from './terrain-route'
import type {TraversePacket} from './traverse-evaluation'

export interface TerrainPatchMeta {
  id:string;site:{lat:number;lon:number};region:string;rows:number;cols:number;stepM:number;x0:number;y0:number
  file:string;bytes:number;sha256:string;sourceWindow:{row:number;col:number;rows:number;cols:number}
  sourceFiles:Record<string,{url:string;bytes:number;sha256:string}>
}
export interface TerrainIndex {schema:number;frame:string;projection:string;fieldOrder:string[];productURL:string;sourceManifestSha256:string;patches:TerrainPatchMeta[];limits:string[]}
export interface TerrainAsset {meta:TerrainPatchMeta;grid:TerrainGrid;index:TerrainIndex;imported?:ImportProvenance}
export interface AreaReport {
  point:{lat:number;lon:number};maxSlopeDeg:number;settings:AreaSettings;patch:TerrainPatchMeta
  summary:{known:number;inCircle:number;eligible:number;nominal:number;directReturns:number;mapAreaM2:number;largestConnectedM2:number;components:number;fittingCentres:number;bestDiameterM:number;pointDiameterM:number;pointEligible:boolean;pointDataAvailable:boolean}
  requiredAtMissionPoint?:boolean
  imported?:ImportProvenance
  route?:TerrainRouteReport
  traverse?:TraversePacket
  candidate:{lat:number;lon:number;radiusM:number}|null;limits:string[]
}
const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)
const finite=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)
const fields=['slp','slperr','ldec','surf','toterr']
export function parseTerrainIndex(value:unknown):TerrainIndex {
  const p=value as TerrainIndex
  if(!p||p.schema!==1||p.frame!=='MOON_ME_DE421'||!Array.isArray(p.fieldOrder)||p.fieldOrder.join()!==fields.join()||!hash(p.sourceManifestSha256)
    ||p.productURL!=='https://pgda.gsfc.nasa.gov/products/78'||!Array.isArray(p.patches)||p.patches.length>200||!Array.isArray(p.limits))throw new Error('Invalid high-resolution terrain index')
  const ids=new Set<string>()
  for(const m of p.patches) {
    if(!m||typeof m.id!=='string'||ids.has(m.id)||!/^[a-z0-9-]+\.f32$/.test(m.file)||!hash(m.sha256)||m.stepM!==5
      ||![m.rows,m.cols].every(n=>Number.isInteger(n)&&n>=1&&n<=512)||m.bytes!==m.rows*m.cols*20||![m.x0,m.y0,m.site?.lat,m.site?.lon].every(finite)
      ||m.site.lat> -80||m.site.lat< -90||!m.sourceFiles||fields.some(f=>!hash(m.sourceFiles[f]?.sha256)||!m.sourceFiles[f].url.startsWith('https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/')))throw new Error('Invalid terrain patch provenance or grid')
    ids.add(m.id)
  }
  return p
}

const indexes=new Map<string,Promise<TerrainIndex>>(),assets=new Map<string,Promise<TerrainAsset>>()
export async function loadTerrain(lat:number,lon:number,siteId:string,base='./data/landing-terrain/',importId?:string):Promise<TerrainAsset|null> {
  if(importId) {const {restoreTerrainImport,importedTerrainAt}=await import('./terrain-import');return importedTerrainAt(await restoreTerrainImport(importId),lat,lon)}
  let pending=indexes.get(base)
  if(!pending) {
    pending=fetch(base+'index.json').then(r=>{if(!r.ok)throw new Error(`Terrain index HTTP ${r.status}`);return r.json()}).then(parseTerrainIndex)
    indexes.set(base,pending);pending.catch(()=>indexes.delete(base))
  }
  const index=await pending,[x,y]=toXY(lat,lon)
  const margin=(m:TerrainPatchMeta)=>Math.min(x-(m.x0-2.5),m.x0+(m.cols-.5)*5-x,m.y0+2.5-y,y-(m.y0-(m.rows-.5)*5))
  const meta=index.patches.filter(m=>margin(m)>=0).sort((a,b)=>margin(b)-margin(a)||(a.id===siteId?-1:b.id===siteId?1:a.id.localeCompare(b.id)))[0]
  if(!meta)return null
  const key=base+meta.file+'#'+meta.sha256
  let asset=assets.get(key)
  if(!asset) {
    asset=(async()=>{
      const response=await fetch(base+meta.file)
      if(!response.ok)throw new Error(`Terrain patch HTTP ${response.status}`)
      const bytes=await response.arrayBuffer()
      if(bytes.byteLength!==meta.bytes)throw new Error('Terrain patch byte count differs from source index')
      const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')
      if(sha!==meta.sha256)throw new Error('Terrain patch checksum differs from source index')
      const view=new DataView(bytes),n=meta.rows*meta.cols
      const arrays=fields.map((_,field)=>Float32Array.from({length:n},(_,k)=>view.getFloat32((field*n+k)*4,true)))
      return {meta,index,grid:{...meta,slope:arrays[0],slopeRms:arrays[1],returns:arrays[2],height:arrays[3],heightRms:arrays[4]}}
    })()
    assets.set(key,asset);asset.catch(()=>assets.delete(key))
  }
  return asset
}

export function areaReport(asset:TerrainAsset,result:AreaResult,point:{lat:number;lon:number},maxSlopeDeg:number,settings:AreaSettings):AreaReport {
  const best=result.best,latlon=best?toLatLon(best.x,best.y):null
  const [x,y]=toXY(point.lat,point.lon),atPoint=radiusAtPoint(asset.grid,result.mask,x,y)
  const cell=terrainCellAtPoint(asset.grid,x,y)
  return {point,maxSlopeDeg,settings:{...settings},patch:asset.meta,imported:asset.imported,
    summary:{known:result.known,inCircle:result.inCircle,eligible:result.eligible,nominal:result.nominal,directReturns:result.directReturns,
      mapAreaM2:result.mapAreaM2,largestConnectedM2:result.largestConnectedM2,components:result.components,fittingCentres:result.fittingCentres,bestDiameterM:best?best.radiusM*2:0,pointDiameterM:atPoint.radiusM*2,pointEligible:atPoint.eligible,pointDataAvailable:cell!==null&&terrainCellKnown(asset.grid,cell,settings)},
    candidate:best&&latlon?{lat:latlon[0],lon:latlon[1],radiusM:best.radiusM}:null,limits:asset.index.limits}
}
export const areaScope=(lat:number,lon:number,slope:number,s:AreaSettings)=>[lat,lon,slope,s.diameterM,s.rmsMultiplier,s.requireReturns].join('|')
