import {memo,useEffect,useState} from 'react'
import type {TerrainAsset} from '../lib/landing-terrain'
import type {AreaResult,AreaSettings} from '../lib/landing-area'
import {RouteSettings,TerrainRoute,planTerrainRoute,routeReport,routeCsv} from '../lib/terrain-route'

export function useTerrainRoute(asset:TerrainAsset|null,screen:AreaResult|null,mission:{lat:number;lon:number},area:AreaSettings,maxSlope:number,settings:RouteSettings) {
  const key=JSON.stringify([asset?.meta.sha256,asset?.imported?.id,mission.lat,mission.lon,area,maxSlope,settings])
  const [state,setState]=useState<{key:string;result:TerrainRoute|null;error:string|null}>({key:'',result:null,error:null})
  useEffect(()=>{
    if(!asset||!screen||!settings.goal)return
    const controller=new AbortController();setState({key,result:null,error:null})
    planTerrainRoute(asset.grid,screen,mission,settings,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setState({key,result,error:null})},e=>{if(!controller.signal.aborted)setState({key,result:null,error:e instanceof Error?e.message:String(e)})})
    return()=>controller.abort()
  },[key,asset,screen,mission.lat,mission.lon,settings])
  return {result:state.key===key?state.result:null,error:state.key===key?state.error:null,
    loading:!!settings.goal&&!!asset&&!!screen&&(state.key!==key||!state.result&&!state.error)}
}
const save=(name:string,text:string,type:string)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
export function TerrainRoutePanel({asset,screen,mission,area,maxSlope,settings,onSettings,state,pick,onPick,onInspect,busy=false}:{
  asset:TerrainAsset|null;screen:AreaResult|null;mission:{lat:number;lon:number};area:AreaSettings;maxSlope:number;settings:RouteSettings;onSettings:(p:RouteSettings)=>void
  state:ReturnType<typeof useTerrainRoute>;pick:'start'|'goal'|null;onPick:(p:'start'|'goal'|null)=>void;onInspect:(lat:number,lon:number)=>void;busy?:boolean
}) {
  const set=(v:Partial<RouteSettings>)=>onSettings({...settings,...v}),result=state.result
  const report=asset&&result?routeReport(asset,area,maxSlope,mission,settings,result):null
  const endpoint=(which:'start'|'goal',axis:0|1,value:string)=>{
    if(value==='')return
    const n=Number(value);if(!Number.isFinite(n)||n<(axis===0?-90:-180)||n>(axis===0?90:360))return
    const next:[number,number]=[...(settings[which]??[mission.lat,mission.lon])];next[axis]=n;set({[which]:next})
  }
  const inspect=()=>{if(!result?.goal||!result.start)return;set({start:result.start.requested});onInspect(...result.goal.snapped)}
  return <section className="terrain-route" aria-labelledby="terrain-route-title">
    <div className="terrain-route-heading"><h3 id="terrain-route-title">Plan a terrain route</h3><span className="aside">Static grid route · width & grade screen</span></div>
    <p className="model-note">Lowest-cost grid route inside the 500 m circle under the selected width, grade and climb-penalty settings; unknown ground blocks it. “Drive this route through time” adds Sun, power and contact along the way.</p>
    <div className="terrain-route-endpoints">
      {(['start','goal'] as const).map(which=><div key={which}><b>{which==='start'?'Start':'Destination'}</b><div className="terrain-route-coordinates">
        <label className="field"><span>Latitude (°)</span><input className="input num" type="number" step="any" min="-90" max="90" aria-label={`Route ${which} latitude`} value={settings[which]?.[0]??(which==='start'?mission.lat:'')} onChange={e=>endpoint(which,0,e.target.value)}/></label>
        <label className="field"><span>Longitude (°E)</span><input className="input num" type="number" step="any" min="-180" max="360" aria-label={`Route ${which} longitude`} value={settings[which]?.[1]??(which==='start'?mission.lon:'')} onChange={e=>endpoint(which,1,e.target.value)}/></label>
        <button className="btn sm" disabled={!asset||!screen} aria-pressed={pick===which} onClick={()=>onPick(pick===which?null:which)}>{which==='start'?'Pick start on map':'Pick destination on map'}</button>
      </div></div>)}
    </div>
    <div className="terrain-area-controls">
      <label className="field"><span>Swept width (m)</span><input className="input num" type="number" min="0" max="100" step="1" aria-label="Route swept width" value={settings.widthM} onChange={e=>set({widthM:Math.max(0,Math.min(100,Number(e.target.value)))})}/></label>
      <label className="field"><span>Maximum route grade (°)</span><input className="input num" type="number" min="0" max="90" step="1" aria-label="Maximum route grade" value={settings.maxGradeDeg} onChange={e=>set({maxGradeDeg:Math.max(0,Math.min(90,Number(e.target.value)))})}/></label>
      <label className="field"><span>Height-error sensitivity</span><select className="input" aria-label="Route height-error sensitivity" value={settings.heightRmsMultiplier} onChange={e=>set({heightRmsMultiplier:Number(e.target.value)})}><option value="0">Nominal grades</option><option value="1">Grade stress: 1 × height RMS</option><option value="2">Grade stress: 2 × height RMS</option></select></label>
      <label className="field"><span>Climb penalty (m cost / m ascent)</span><input className="input num" type="number" min="0" max="100" step="1" aria-label="Route climb penalty" value={settings.ascentCost} onChange={e=>set({ascentCost:Math.max(0,Math.min(100,Number(e.target.value)))})}/></label>
    </div>
    <div className="terrain-export-row"><button className="btn sm" onClick={()=>set({start:null})}>Start from mission cell</button><button className="btn sm" onClick={()=>{set({start:null,goal:null});onPick(null)}}>Clear route</button></div>
    {pick&&<p role="status" className="callout">Choose the route {pick==='start'?'start':'destination'} on the terrain map. With the map focused, arrow keys move by one source cell; Enter selects and Escape cancels. Coordinates snap to that cell centre.</p>}
    {(!asset||!screen)&&settings.goal&&<p role="status" className="warnnote">No verified terrain screen is loaded for this route. Restore source data or correct the terrain criteria.</p>}
    {state.loading&&<p role="status">Computing a route under the current source and criteria…</p>}
    {state.error&&<p role="alert" className="bad">Route calculation failed: {state.error}</p>}
    {result&&<div className="terrain-route-result">
      <p role="status" className={result.status==='found'?'good':'bad'}>{result.status==='found'?'Route found in this terrain screen.':result.issue}</p>
      {result.start&&result.goal&&<p className="model-note">Start snapped {result.start.snapDistanceM.toFixed(3)} m; destination snapped {result.goal.snapDistanceM.toFixed(3)} m. These are source-cell centres, not exact touchdown or science-target positions.</p>}
      {result.status==='found'&&<>
        <dl className="terrain-route-metrics"><div><dt>Map distance</dt><dd>{result.mapLengthM.toFixed(1)} m</dd></div><div><dt>Ascent / descent</dt><dd>{result.ascentM.toFixed(1)} / {result.descentM.toFixed(1)} m</dd></div><div><dt>Maximum nominal / stressed grade</dt><dd>{result.maxNominalGradeDeg.toFixed(1)}° / {result.maxStressedGradeDeg.toFixed(1)}°</dd></div></dl>
        <RouteProfile nodes={result.nodes}/>
        <button className="btn sm" disabled={busy} onClick={inspect}>{busy?'Computing mission point…':'Inspect destination cell as mission point'}</button>
      </>}
      {report&&<div className="terrain-export-row"><button className="btn sm" onClick={()=>save('lunorizon-terrain-route.json',JSON.stringify(report,null,2),'application/json')}>Export route report</button>{result.status==='found'&&<button className="btn sm" onClick={()=>save('lunorizon-terrain-route.csv',routeCsv(report),'text/csv')}>Export route CSV</button>}</div>}
    </div>}
    <details className="model-details"><summary>Route cost & geometric assumptions</summary><p>Cost = map distance + climb penalty × accumulated ascent. The result minimizes this cost on the screened eight-neighbour graph. Grade stress adds the selected multiple of both endpoint height RMS values to |Δheight|. Turning, soil traction and smaller obstacles require the separate vehicle assessment and finer data; the RMS setting is a sensitivity test.</p></details>
  </section>
}
const RouteProfile=memo(function RouteProfile({nodes}:{nodes:TerrainRoute['nodes']}) {
  const length=nodes.at(-1)?.distanceM??0
  let low=Infinity,high=-Infinity;for(const n of nodes){low=Math.min(low,n.heightM);high=Math.max(high,n.heightM)}
  const span=Math.max(1,high-low)
  const points=nodes.map(n=>`${40+640*(length?n.distanceM/length:0)},${90-70*(n.heightM-low)/span}`).join(' ')
  return <><svg className="terrain-route-profile" viewBox="0 0 720 120" role="img" aria-label={`Source height along route: ${low.toFixed(1)} to ${high.toFixed(1)} metres; ${length.toFixed(1)} map metres. Vertical scale adjusted; not power or sunlight along the route.`}><path d="M40 10V90H680" fill="none" stroke="currentColor" opacity=".3"/><polyline points={points} fill="none" stroke="var(--earth)" strokeWidth="2"/><text x="40" y="110">0 m</text><text x="680" y="110" textAnchor="end">{length.toFixed(1)} m</text><text x="40" y="10">Height {low.toFixed(1)}–{high.toFixed(1)} m</text></svg><p className="model-note">Source-height profile; vertical scale is adjusted to show relief. This is not a rover energy or sunlight profile.</p></>
})
