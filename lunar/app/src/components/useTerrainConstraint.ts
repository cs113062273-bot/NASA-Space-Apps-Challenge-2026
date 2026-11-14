import {useEffect,useMemo,useState} from 'react'
import type {SiteRecord} from '../lib/data'
import type {AreaSettings} from '../lib/landing-area'
import {loadTerrain} from '../lib/landing-terrain'
import {pointTerrainScreen,TerrainCheck,TerrainPointScreen,unavailableTerrain} from '../lib/terrain-constraint'

/** Preload point-specific constraints cooperatively. Stale/unknown sources never
 * grant service; scope changes invalidate results synchronously before effects.
 */
export function useTerrainConstraint(sites:SiteRecord[],slope:number,settings:AreaSettings,enabled:boolean,revision=0,importId?:string):TerrainCheck|undefined {
  const key=JSON.stringify([enabled,slope,settings,revision,importId,sites.map(s=>[s.id,s.lat,s.lon])])
  const [state,setState]=useState<{key:string;values:Map<string,TerrainPointScreen>}>({key:'',values:new Map()})
  useEffect(()=>{
    if(!enabled)return
    let live=true,index=0
    const values=new Map<string,TerrainPointScreen>()
    const worker=async()=>{
      while(live&&index<sites.length) {
        const site=sites[index++]
        try {
          const asset=await loadTerrain(site.lat,site.lon,site.id,undefined,importId)
          values.set(site.id,asset?pointTerrainScreen(asset,site,slope,settings):{...unavailableTerrain(site,slope,settings,'unavailable',importId?'The selected imported DEM does not cover this mission point.':'No retained high-resolution terrain covers this mission point.'),importId})
        } catch(e) {values.set(site.id,{...unavailableTerrain(site,slope,settings,'unavailable',e instanceof Error?e.message:String(e)),importId})}
        await new Promise<void>(resolve=>setTimeout(resolve,0))
      }
    }
    Promise.all([worker(),worker()]).then(()=>{if(live)setState({key,values})})
    return()=>{live=false}
  },[key,sites,slope,settings,enabled,importId])
  return useMemo(()=>enabled?(site:SiteRecord)=>state.key===key&&state.values.has(site.id)&&state.values.get(site.id)!.lat===site.lat&&state.values.get(site.id)!.lon===site.lon?state.values.get(site.id)!:
    unavailableTerrain(site,slope,settings,'loading','High-resolution terrain constraints are loading.') :undefined,[enabled,key,state,slope,settings])
}
