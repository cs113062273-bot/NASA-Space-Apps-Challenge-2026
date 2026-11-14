import type {SiteRecord} from './data'
import {toXY} from './data'
import {AreaSettings,DEFAULT_AREA,validAreaSettings,radiusAtPoint,terrainArea,terrainCellAtPoint,terrainCellKnown,terrainSourceIssue} from './landing-area'
import type {TerrainAsset} from './landing-terrain'

export interface TerrainPointScreen {
  status:'ready'|'loading'|'unavailable';pass:boolean;radiusM:number|null;requiredDiameterM:number
  lat:number;lon:number;maxSlopeDeg:number;settings:AreaSettings;patchSha256?:string;importId?:string;issue:string|null
}
export type TerrainCheck=(site:SiteRecord)=>TerrainPointScreen
export function terrainForPoint(check:TerrainCheck|undefined,site:SiteRecord,slope:number):TerrainPointScreen|undefined {
  if(!check)return undefined
  const p=check(site)
  if(!p||p.lat!==site.lat||p.lon!==site.lon||p.maxSlopeDeg!==slope||!validAreaSettings(p.settings)||p.requiredDiameterM!==p.settings.diameterM
    ||!['ready','loading','unavailable'].includes(p.status)
    ||p.status==='ready'&&(p.radiusM===null||!Number.isFinite(p.radiusM)||p.radiusM<0||p.radiusM>500||!/^[a-f0-9]{64}$/.test(p.patchSha256??''))
    ||p.pass&&(p.status!=='ready'||p.radiusM===null||2*p.radiusM+1e-8<p.requiredDiameterM))
    return unavailableTerrain(site,slope,p&&validAreaSettings(p.settings)?p.settings:DEFAULT_AREA,'unavailable','Terrain inputs do not match this mission point, slope limit or source evidence.')
  return p
}
export function unavailableTerrain(site:Pick<SiteRecord,'lat'|'lon'>,maxSlopeDeg:number,settings:AreaSettings,status:'loading'|'unavailable',issue:string):TerrainPointScreen {
  return {status,pass:false,radiusM:null,requiredDiameterM:settings.diameterM,lat:site.lat,lon:site.lon,maxSlopeDeg,settings:{...settings},issue}
}
export function pointTerrainScreen(asset:TerrainAsset,site:Pick<SiteRecord,'lat'|'lon'>,maxSlopeDeg:number,settings:AreaSettings):TerrainPointScreen {
  const [x,y]=toXY(site.lat,site.lon),cell=terrainCellAtPoint(asset.grid,x,y)
  const issue=terrainSourceIssue(asset.grid,settings)
  if(issue||cell===null||!terrainCellKnown(asset.grid,cell,settings))return {...unavailableTerrain(site,maxSlopeDeg,settings,'unavailable',issue??'Terrain fields required by this screen are unavailable at this mission point.'),importId:asset.imported?.id}
  const area=terrainArea(asset.grid,x,y,maxSlopeDeg,settings),point=radiusAtPoint(asset.grid,area.mask,x,y)
  const pass=point.eligible&&2*point.radiusM+1e-8>=settings.diameterM
  return {status:'ready',pass,radiusM:point.radiusM,requiredDiameterM:settings.diameterM,lat:site.lat,lon:site.lon,maxSlopeDeg,
    settings:{...settings},patchSha256:asset.meta.sha256,importId:asset.imported?.id,
    issue:pass?null:`Terrain footprint at the mission point: ${(2*point.radiusM).toFixed(1)} m diameter available / ${settings.diameterM} m required.`}
}
