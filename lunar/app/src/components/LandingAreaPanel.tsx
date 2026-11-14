import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {AreaSettings,terrainArea,AreaResult,terrainCellKnown,wholeCellInCircle,radiusAtPoint,terrainSourceIssue} from '../lib/landing-area'
import {AreaReport,areaReport,loadTerrain,TerrainAsset} from '../lib/landing-terrain'
import {LocalSkyConfig} from '../lib/local-sky'
import {toXY,toLatLon} from '../lib/data'
import {TERRAIN_BANDS,TerrainBand,terrainGeoTiff} from '../lib/terrain-geotiff'
import {TerrainImportPanel} from './TerrainImportPanel'
import {RouteSettings,TerrainRoute,routeReport} from '../lib/terrain-route'
import {TerrainRoutePanel,useTerrainRoute} from './TerrainRoutePanel'
import {terrainCellAtPoint} from '../lib/landing-area'
import {TerrainTraversePanel} from './TerrainTraversePanel'
import {TraverseInputs,TraverseSettings,traverseScope} from '../lib/traverse'
import {TraversePacket} from '../lib/traverse-evaluation'
import {Ephemeris} from '../lib/astro'

interface Props {
  site:{id:string;name:string;lat:number;lon:number};maxSlopeDeg:number;settings:AreaSettings;initialOpen?:boolean;active?:boolean;busy?:boolean
  onSettings:(s:AreaSettings)=>void;onSlope:(s:number)=>void;onReport:(r:AreaReport|null)=>void;onInspect:(lat:number,lon:number)=>void
  onApplySky:(sky:LocalSkyConfig)=>void;computeError?:string|null
  requirePoint:boolean;onRequirePoint:(enabled:boolean)=>void
  onRetryTerrain?:()=>void
  importId?:string;onImport:(id:string|undefined)=>void
  eph:Ephemeris;traverseInput:TraverseInputs;traverseInvalid:string|null;traverseOpen:boolean;onTraverseSettings:(p:TraverseSettings)=>void
  routeSettings:RouteSettings;onRouteSettings:(p:RouteSettings)=>void
}
const fmt=(v:number)=>v.toFixed(3)
const number=(v:number,digits=1)=>Number.isFinite(v)?v.toFixed(digits):'unknown'
function save(name:string,data:BlobPart,type:string) {
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();URL.revokeObjectURL(a.href)
}

export function LandingAreaPanel({site,maxSlopeDeg,settings,initialOpen=false,active=false,busy=false,onSettings,onSlope,onReport,onInspect,onApplySky,computeError,requirePoint,onRequirePoint,onRetryTerrain,importId,onImport,routeSettings,onRouteSettings,eph,traverseInput,traverseInvalid,traverseOpen,onTraverseSettings}:Props) {
  const [open,setOpen]=useState(initialOpen),[retry,setRetry]=useState(0),[band,setBand]=useState<TerrainBand>('footprintRadius'),[exportError,setExportError]=useState<string|null>(null)
  const visited=useRef(false)
  useEffect(()=>{if(active&&!visited.current){visited.current=true;setOpen(true)}},[active])
  const [state,setState]=useState<{key:string;asset:TerrainAsset|null;error:string|null;done:boolean}>({key:'',asset:null,error:null,done:false})
  const [pick,setPick]=useState<'start'|'goal'|null>(null)
  const key=[site.id,site.lat,site.lon,importId].join('|'),asset=state.key===key?state.asset:null
  useEffect(()=>{
    if(!open)return
    let live=true
    setState({key,asset:null,error:null,done:false})
    loadTerrain(site.lat,site.lon,site.id,undefined,importId).then(asset=>{if(live)setState({key,asset,error:null,done:true})},e=>{if(live)setState({key,asset:null,error:e instanceof Error?e.message:String(e),done:true})})
    return()=>{live=false}
  },[open,key,site.lat,site.lon,site.id,retry,importId])
  const [x,y]=toXY(site.lat,site.lon)
  const invalidSlope=!Number.isFinite(maxSlopeDeg)||maxSlopeDeg<0||maxSlopeDeg>90
  const result=useMemo(()=>asset&&!invalidSlope?terrainArea(asset.grid,x,y,maxSlopeDeg,settings):null,[asset,x,y,maxSlopeDeg,settings,invalidSlope])
  const routeState=useTerrainRoute(asset,result,site,settings,maxSlopeDeg,routeSettings)
  const staticRoute=useMemo(()=>asset&&result&&routeState.result?routeReport(asset,settings,maxSlopeDeg,{lat:site.lat,lon:site.lon},routeSettings,routeState.result):null,[asset,result,site.lat,site.lon,maxSlopeDeg,settings,routeSettings,routeState.result])
  const [moving,setMoving]=useState<TraversePacket|null>(null),onMoving=useCallback((p:TraversePacket|null)=>setMoving(p),[])
  const movingKey=asset&&staticRoute?.result.status==='found'&&traverseInvalid===null?traverseScope(asset,staticRoute.result,traverseInput,eph,{settings:staticRoute.settings,terrain:staticRoute.terrain,mission:staticRoute.mission}):''
  const report=useMemo(()=>asset&&result?{...areaReport(asset,result,{lat:site.lat,lon:site.lon},maxSlopeDeg,settings),requiredAtMissionPoint:requirePoint,route:staticRoute??undefined,traverse:moving?.scope===movingKey?moving:undefined}:null,[asset,result,site.lat,site.lon,maxSlopeDeg,settings,requirePoint,staticRoute,moving,movingKey])
  const atPoint=useMemo(()=>asset&&result?radiusAtPoint(asset.grid,result.mask,x,y):null,[asset,result,x,y])
  useEffect(()=>onReport(report),[report,onReport])
  const fits=!!result?.fittingCentres
  const exportTiff=async()=>{
    if(!asset||!result||!report)return
    setExportError(null)
    try {save(`lunorizon-${site.id}-${band}.tif`,await terrainGeoTiff(asset,result,report,band),'image/tiff')}
    catch(e) {setExportError(e instanceof Error?e.message:String(e))}
  }
  return <details className="panel terrain-area" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary><strong>High-resolution terrain & footprint</strong><span className="aside">{importId?asset?`${asset.grid.stepM} m imported cells`:'Imported source selected':'5 m source cells'} · terrain-only screen</span></summary>
    <div className="panel-b">
      <p className="model-note">Where a lander of the chosen size fits within 500 m of {site.name}, from {importId?'your local terrain (mission calculations keep their sources until you create a mixed-terrain point below)':'5 m NASA LOLA slope and roughness'}.</p>
      <TerrainImportPanel importId={importId} onSelect={id=>{onImport(id);setRetry(v=>v+1);onRetryTerrain?.()}}/>
      <div className="terrain-area-controls">
        <label className="field"><span>Terrain slope limit (°)</span><input className="input num" type="number" min="0" max="90" step=".5" value={maxSlopeDeg} onChange={e=>onSlope(Math.max(0,Math.min(90,Number(e.target.value))))}/></label>
        <label className="field"><span>Required footprint diameter (m)</span><input className="input num" type="number" min="0" max="1000" step="5" value={settings.diameterM} onChange={e=>onSettings({...settings,diameterM:Math.max(0,Math.min(1000,Number(e.target.value)))})}/></label>
        <label className="field"><span>Slope sensitivity</span><select className="input" aria-label="Slope sensitivity" value={settings.rmsMultiplier} onChange={e=>onSettings({...settings,rmsMultiplier:Number(e.target.value)})}><option value="0">Nominal slope</option><option value="1">Slope + 1 × RMS error</option><option value="2">Slope + 2 × RMS error</option></select></label>
        <label className="terrain-return-toggle"><input type="checkbox" checked={settings.requireReturns} onChange={e=>onSettings({...settings,requireReturns:e.target.checked})}/>{importId?'Require a return in every cell':'Require a LOLA return in every cell'}</label>
        <label className="terrain-return-toggle"><input type="checkbox" checked={requirePoint} onChange={e=>onRequirePoint(e.target.checked)}/>Require footprint at mission point in planning</label>
      </div>
      {!asset&&state.key===key&&state.error?<p role="alert" className="warnnote">High-resolution terrain unavailable: {state.error}. <button className="btn sm" onClick={()=>{setRetry(v=>v+1);onRetryTerrain?.()}}>Retry terrain</button></p>:!asset&&state.key===key&&state.done?<p className="muted">{importId?'The selected imported DEM does not cover this point. No NASA terrain is substituted.':'No retained 5 m PGDA patch covers this point. Choose a covered point such as Connecting Ridge C1 or Shackleton Rim; nearby points can reuse a retained patch.'} No terrain footprint is inferred. Existing mission calculations remain available.</p>:!asset?<p role="status" className="muted">Loading and checking the source terrain patch…</p>:null}
      {asset&&<div className="terrain-candidate"><span>Recompute this point’s skyline and mission systems from these local heights. The original point stays available.</span><button className="btn sm" disabled={busy} onClick={()=>onApplySky({sourceId:importId??'nasa',patchSha256:asset.meta.sha256})}>{busy?'Computing skyline…':'Create mixed-terrain mission point'}</button></div>}
      {computeError&&<p role="alert" className="bad">Mission-point calculation failed: {computeError}</p>}
      {asset&&terrainSourceIssue(asset.grid,settings)&&<p role="alert" className="warnnote">{terrainSourceIssue(asset.grid,settings)} {asset.grid.available?.slopeRms===false&&settings.rmsMultiplier!==0&&<button className="btn sm" onClick={()=>onSettings({...settings,rmsMultiplier:0})}>Use nominal slope</button>}</p>}
      {asset&&invalidSlope&&<p role="alert" className="warnnote">Set the terrain slope limit between 0° and 90° to calculate a footprint. The existing mission inputs remain available.</p>}
      {asset&&result&&report&&<>
        <div className="terrain-area-layout">
          <TerrainMap asset={asset} result={result} targetX={x} targetY={y} diameterM={settings.diameterM} settings={settings} route={routeState.result} routeWidthM={routeSettings.widthM} pick={pick} onCancel={()=>setPick(null)} onPick={(lat,lon)=>{if(pick)onRouteSettings({...routeSettings,[pick]:[lat,lon]});setPick(null)}}/>
          <div>
            {(()=>{const known=report.summary.pointDataAvailable;const d=(atPoint?.radiusM??0)*2;const pointFits=known&&d>=settings.diameterM
              return <p className={`terrain-point ${!known?'':pointFits?'good':'bad'}`} role="status">{!known?'No terrain data at the selected point.':pointFits?<>The selected point fits the requested {settings.diameterM} m footprint ({d.toFixed(1)} m available).</>:<>The selected point fits {d.toFixed(1)} m; it does not fit the requested {settings.diameterM} m footprint.</>}
                <small>{requirePoint?' Required in planning; Sun, Earth and power are still sampled at the centre.':' Not required in planning.'}</small></p>})()}
            <p className={`terrain-verdict ${fits?'good':'bad'}`}>{!fits?`No ${settings.diameterM} m footprint fits this terrain screen.`:report.summary.pointDataAvailable&&(atPoint?.radiusM??0)*2>=settings.diameterM?`${settings.diameterM} m footprint fits this terrain screen.`:`A ${settings.diameterM} m footprint fits elsewhere within the analysis area. Inspect that centre to evaluate it.`}</p>
            <div className="terrain-area-kpis">
              <div className="kpi"><div className="label">Largest centred disc</div><div className="value">{(report.summary.bestDiameterM).toFixed(1)}<small> m</small></div><div className="sub">Diameter at a source-cell centre</div></div>
              <div className="kpi"><div className="label">Largest connected patch</div><div className="value">{fmt(result.largestConnectedM2/1e6)}<small> km²</small></div><div className="sub">{result.components} edge-connected patches</div></div>
              <div className="kpi"><div className="label">All eligible map area</div><div className="value">{fmt(result.mapAreaM2/1e6)}<small> km²</small></div><div className="sub">{result.fittingCentres.toLocaleString()} centres fit the requested disc</div></div>
            </div>
            <p className="model-note">{result.inCircle?number(100*result.known/result.inCircle):'0'}% of whole cells in the analysis circle have {asset.imported?'the fields required by this screen':'all five source fields'}; {asset.grid.available?.returns===false?'return coverage is unknown.':`${result.known?number(100*result.directReturns/result.known):'0'}% of those cells contain a return.${asset.imported?'':' The rest are interpolated.'}`} Nominal slope admits {fmt(result.nominal*asset.grid.stepM**2/1e6)} km² before RMS/return screening.</p>
            {asset.imported&&<p className="model-note">{asset.imported.slopeMethod}. Slope RMS: {asset.grid.available?.slopeRms?'supplied':'unknown'}; height RMS: {asset.grid.available?.heightRms?'supplied':'unknown'}. User-declared frame; source accuracy and registration are unverified. Horn slopes use map-plane distances, not vehicle tilt qualification.</p>}
            {asset.imported&&Math.min(asset.grid.rows,asset.grid.cols)*asset.grid.stepM<1000&&<p className="warnnote">The 512-cell import window is smaller than the 500 m analysis circle at this source resolution. Outside cells remain unknown and constrain the footprint; the source is not downsampled to hide this limit.</p>}
            {report.candidate&&<div className="terrain-candidate"><span>Largest-disc centre: <b className="mono">{report.candidate.lat.toFixed(7)}°, {report.candidate.lon.toFixed(7)}°E</b>.</span><button className="btn sm" disabled={busy} onClick={()=>onInspect(report.candidate!.lat,report.candidate!.lon)}>{busy?'Computing point…':'Inspect footprint centre'}</button></div>}
            <details className="model-details"><summary>Terrain resolution & interpretation</summary><p>A {asset.grid.stepM} m grid screens terrain at its source resolution. Smaller rocks and craters, vehicle stability, exhaust and flight registration need additional assessment. RMS multipliers test sensitivity; they do not express a safety probability.</p></details>
          </div>
        </div>
        <div className="terrain-export-row"><button className="btn sm" onClick={()=>save(`lunorizon-${site.id}-terrain-report.json`,JSON.stringify(report,null,2),'application/json')}>Export terrain report</button><label className="field"><span>GeoTIFF layer</span><select className="input" aria-label="GeoTIFF terrain layer" value={band} onChange={e=>setBand(e.target.value as TerrainBand)}>{(Object.keys(TERRAIN_BANDS) as TerrainBand[]).map(b=><option key={b} value={b}>{asset.imported&&b==='returns'?'Returns per cell (imported)':TERRAIN_BANDS[b]}</option>)}</select></label><button className="btn sm" onClick={exportTiff}>Export terrain GeoTIFF</button></div>
        {exportError&&<p role="alert" className="bad">GeoTIFF export failed: {exportError}</p>}
        <details className="model-details"><summary>Terrain source and geometry limits</summary><p>{asset.imported?'User-imported source (declared ME421 frame)':<a href={asset.index.productURL} target="_blank" rel="noreferrer">NASA PGDA 5 m terrain products</a>} · {asset.meta.region} · MOON_ME_DE421 south-polar stereographic. Areas are projected map areas. Discs are exact within the admitted source-cell squares at the sampled centres; diagonal corner contact does not join patches. Partial boundary cells and missing/outside data are excluded. The best continuous centre between pixels could differ. These results do not qualify touchdown accuracy or a traversable route.</p><p>The slope limit is shared with mission requirements; the RMS, return and footprint settings enter mission planning only when the point constraint is enabled. That constraint checks the exact mission centre, not the largest nearby disc; it does not establish Sun/Earth/power conditions across the disc. The selected mission horizon keeps its own source until you explicitly create and select a mixed-terrain mission point. That scenario uses the local slope cell; footprint and route screening remain separate. Coordinate registration here is nominal, not metre-level flight registration.</p>{asset.imported&&<ul>{asset.index.limits.map(l=><li key={l}>{l}</li>)}</ul>}<p className="reference-fingerprint">Patch SHA-256: <code>{asset.meta.sha256}</code></p></details>
      </>}
      <TerrainRoutePanel asset={asset} screen={result} mission={site} area={settings} maxSlope={maxSlopeDeg} settings={routeSettings} onSettings={onRouteSettings} state={routeState} pick={pick} onPick={p=>{setPick(p);if(p)requestAnimationFrame(()=>{const map=document.querySelector<HTMLElement>('.terrain-map');map?.focus({preventScroll:true});map?.scrollIntoView({block:'center',behavior:'instant'})})}} onInspect={onInspect} busy={busy}/>
      <TerrainTraversePanel asset={asset} route={staticRoute} eph={eph} input={traverseInput} invalid={traverseInvalid} initialOpen={traverseOpen} onSettings={onTraverseSettings} onReport={onMoving}/>
    </div>
  </details>
}

function TerrainMap({asset,result,targetX,targetY,diameterM,settings,route,routeWidthM,pick,onPick,onCancel}:{asset:TerrainAsset;result:AreaResult;targetX:number;targetY:number;diameterM:number;settings:AreaSettings;route:TerrainRoute|null;routeWidthM:number;pick:'start'|'goal'|null;onPick:(lat:number,lon:number)=>void;onCancel:()=>void}) {
  const ref=useRef<HTMLCanvasElement>(null),[hover,setHover]=useState<number|null>(null)
  const g=asset.grid
  const pickHover=pick?hover:null
  useEffect(()=>{if(pick)setHover(null)},[pick])
  useEffect(()=>{
    const canvas=ref.current;if(!canvas)return
    const ctx=canvas.getContext('2d')!,small=document.createElement('canvas');small.width=g.cols;small.height=g.rows
    const paint=small.getContext('2d')!,pixels=paint.createImageData(g.cols,g.rows)
    for(let k=0;k<g.rows*g.cols;k++) {
      const x=g.x0+k%g.cols*g.stepM,y=g.y0-Math.floor(k/g.cols)*g.stepM
      const inCircle=wholeCellInCircle(x,y,g.stepM,targetX,targetY),known=terrainCellKnown(g,k,settings)
      const colour=!inCircle?[243,242,238]:!known?[90,100,109]:result.mask[k]?2*result.radiusM[k]>=diameterM?[88,176,147]:[40,116,91]:[211,196,178]
      pixels.data.set([...colour,255],k*4)
    }
    paint.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(small,0,0,512,512)
    const point=(x:number,y:number)=>[(x-(g.x0-g.stepM/2))/(g.cols*g.stepM)*512,((g.y0+g.stepM/2)-y)/(g.rows*g.stepM)*512]
    const [tx,ty]=point(targetX,targetY);ctx.strokeStyle='#246b9f';ctx.lineWidth=2;ctx.setLineDash([5,5]);ctx.beginPath();ctx.arc(tx,ty,500/(g.cols*g.stepM)*512,0,2*Math.PI);ctx.stroke();ctx.setLineDash([])
    ctx.beginPath();ctx.moveTo(tx-7,ty);ctx.lineTo(tx+7,ty);ctx.moveTo(tx,ty-7);ctx.lineTo(tx,ty+7);ctx.stroke()
    if(result.best) {
      const b=result.best,[x,y]=point(b.x,b.y);ctx.strokeStyle='#fff';ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(x,y,b.radiusM/(g.cols*g.stepM)*512,0,2*Math.PI);ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y,3,0,2*Math.PI);ctx.fill()
    }
    if(route?.status==='found'&&route.nodes.length>1) {
      const trace=()=>{ctx.beginPath();for(const [i,n] of route.nodes.entries()){const [x,y]=point(n.x,n.y);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y)}}
      ctx.lineCap='round';ctx.lineJoin='round';trace();ctx.strokeStyle='rgba(235,184,74,.3)';ctx.lineWidth=routeWidthM/(g.cols*g.stepM)*512;ctx.stroke()
      trace();ctx.strokeStyle='#ebb84a';ctx.lineWidth=2.5;ctx.stroke()
    }
    for(const [end,label] of [[route?.start,'S'],[route?.goal,'G']] as const)if(end) {
      const [x,y]=point(g.x0+end.index%g.cols*g.stepM,g.y0-Math.floor(end.index/g.cols)*g.stepM)
      ctx.fillStyle='#163b52';ctx.beginPath();ctx.arc(x,y,7,0,2*Math.PI);ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,x,y)
    }
    if(pickHover!==null) {const [x,y]=point(g.x0+pickHover%g.cols*g.stepM,g.y0-Math.floor(pickHover/g.cols)*g.stepM);ctx.strokeStyle='#d56637';ctx.lineWidth=2;ctx.strokeRect(x-5,y-5,10,10)}
  },[g,result,targetX,targetY,diameterM,settings,route,routeWidthM,pickHover])
  const select=(k:number)=>onPick(...toLatLon(g.x0+k%g.cols*g.stepM,g.y0-Math.floor(k/g.cols)*g.stepM))
  const pointerIndex=(x:number,y:number)=>{const canvas=ref.current!;const r=canvas.getBoundingClientRect(),c=Math.floor((x-r.left-canvas.clientLeft)/canvas.clientWidth*g.cols),row=Math.floor((y-r.top-canvas.clientTop)/canvas.clientHeight*g.rows);return row>=0&&row<g.rows&&c>=0&&c<g.cols?row*g.cols+c:null}
  return <div className="terrain-map-wrap"><div className="terrain-map" role={pick?'button':undefined} tabIndex={pick?0:undefined} aria-label={pick?`Choose route ${pick} cell. Arrow keys move, Enter selects, Escape cancels.`:undefined} onClick={e=>{if(!pick)return;const k=pointerIndex(e.clientX,e.clientY);if(k!==null)select(k)}} onKeyDown={e=>{
    if(!pick)return
    const k=hover??(pick==='start'?route?.start?.index:route?.goal?.index)??terrainCellAtPoint(g,targetX,targetY)??Math.floor(g.rows/2)*g.cols+Math.floor(g.cols/2),r=Math.floor(k/g.cols),c=k%g.cols
    if(e.key==='Escape'){onCancel();e.preventDefault()}else if(e.key==='Enter'||e.key===' '){select(k);e.preventDefault()}else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){setHover(Math.max(0,Math.min(g.rows-1,r+(e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0)))*g.cols+Math.max(0,Math.min(g.cols-1,c+(e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0))));e.preventDefault()}
  }} onPointerMove={e=>setHover(pointerIndex(e.clientX,e.clientY))} onPointerLeave={()=>{if(!pick)setHover(null)}}>
    <canvas ref={ref} width={512} height={512} role="img" aria-label={`${g.stepM} metre terrain screen. ${result.eligible} eligible cells; largest disc diameter ${((result.best?.radiusM??0)*2).toFixed(1)} metres. White circle: largest disc; blue cross: selected target.`}/>
    {hover!==null&&<div className="tip">Slope {number(g.slope[hover])}° · RMS {number(g.slopeRms[hover])}°<br/>{asset.imported?'Returns':'LOLA returns'} {number(g.returns[hover],0)} · height RMS {number(g.heightRms[hover],2)} m</div>}
  </div><p className="terrain-map-legend"><span><i className="admitted"/>Slope screen</span><span><i className="fitting"/>Fits requested disc</span><span><i className="excluded"/>Excluded</span><span><i className="unknown"/>Unknown</span></p><p className="faint">Blue: 500 m circle and target. White: largest centred disc. {route?'Gold: static route; S/G: snapped start/destination. ':''}Map up is toward 0°E.</p></div>
}
