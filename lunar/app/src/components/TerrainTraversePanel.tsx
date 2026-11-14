import {useEffect,useMemo,useRef,useState} from 'react'
import {Ephemeris,indexOf,sliceEphemeris} from '../lib/astro'
import {TerrainAsset} from '../lib/landing-terrain'
import {TerrainRouteReport} from '../lib/terrain-route'
import {DEFAULT_TRAVERSE,TraverseInputs,TraverseSettings,traverseScope,validTraverseSettings} from '../lib/traverse'
import {TraversePacket,DepartureSearch,EvaluatedRun,traverseCsv} from '../lib/traverse-evaluation'
import {fmtDate,fmtHours} from '../lib/ui'
import {storageModel} from '../lib/power'
import {MobilityControls} from './MobilityControls'

interface Props {asset:TerrainAsset|null;route:TerrainRouteReport|null;eph:Ephemeris;input:TraverseInputs;invalid:string|null;initialOpen?:boolean;onSettings:(p:TraverseSettings)=>void;onReport:(p:TraversePacket|null)=>void}
type Progress={attempt:number;total:number;run:string}
const save=(name:string,value:string,type:string)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([value],{type}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
export function TerrainTraversePanel({asset,route,eph,input,invalid,initialOpen=false,onSettings,onReport}:Props){
  const [open,setOpen]=useState(initialOpen),[running,setRunning]=useState(false),[progress,setProgress]=useState<Progress|null>(null)
  const worker=useRef<Worker|null>(null)
  const key=asset&&route?.result.status==='found'&&invalid===null?traverseScope(asset,route.result,input,eph,{settings:route.settings,terrain:route.terrain,mission:route.mission}):''
  const [state,setState]=useState<{key:string;packet:TraversePacket|null;recommendation:TraversePacket|null;search:Omit<DepartureSearch,'found'>|null;error:string|null}>({key:'',packet:null,recommendation:null,search:null,error:null})
  const visible=state.key===key?state:null,packet=visible?.packet?.scope===key?visible.packet:null,p=input.settings,inputValid=validTraverseSettings(input.settings)
  useEffect(()=>{worker.current?.terminate();worker.current=null;setRunning(false);setProgress(null);return()=>worker.current?.terminate()},[key])
  useEffect(()=>onReport(packet),[packet,onReport])
  const set=(next:Partial<TraverseSettings>)=>onSettings({...p,...next})
  const run=(search:boolean)=>{
    if(!key||!inputValid||!asset||route?.result.status!=='found')return
    onSettings(p);worker.current?.terminate();setRunning(true);setProgress({attempt:0,total:search?p.searchMaxDelayH+1:1,run:'loading local and wide terrain'})
    setState(prev=>prev.key===key?{...prev,error:null}:{key,packet:null,recommendation:null,search:null,error:null})
    const w=new Worker(new URL('../lib/traverse.worker.ts',import.meta.url),{type:'module'});worker.current=w
    const finish=()=>{w.terminate();if(worker.current===w)worker.current=null;setRunning(false);setProgress(null)}
    w.onerror=e=>{setState(prev=>({...prev,key,error:e.message||'Moving terrain worker failed'}));finish()}
    w.onmessage=e=>{
      if(e.data.scope!==key)return
      if(e.data.progress){setProgress(e.data.progress);return}
      if(!e.data.ok)setState(prev=>({...prev,key,error:e.data.error}))
      else if(search)setState(prev=>({...prev,key,search:e.data.search,recommendation:e.data.recommendation,error:null}))
      else setState(prev=>({...prev,key,packet:e.data.packet,error:null}))
      finish()
    }
    const latest=input.startUnix+(Math.max(p.departureDelayH,search?p.searchMaxDelayH:0)+Math.min(72,route.result.mapLengthM/p.speedMps/3600)+p.goalHoldH)*3600
    const first=Math.max(0,Math.floor(indexOf(eph,input.startUnix))-2),last=Math.min(eph.count-1,Math.ceil(indexOf(eph,latest))+2)
    w.postMessage({scope:key,search,asset,route,input,eph:sliceEphemeris(eph,first,last-first+1),root:new URL('./data/terrain/',document.baseURI).href})
  }
  const apply=()=>{const next=visible?.recommendation;if(!next)return;onSettings(next.input.settings);setState({key:next.scope,packet:next,recommendation:null,search:null,error:null})}
  const rows=useMemo(()=>packet?[['Nominal',packet.evaluation.nominal],['Skyline +1°',packet.evaluation.raised],['Refined nominal',packet.evaluation.refinedNominal],['Refined +1°',packet.evaluation.refinedRaised]].filter((v):v is [string,EvaluatedRun]=>!!v[1]):[],[packet])
  const numeric=(label:string,key:keyof TraverseSettings,min:number,max:number,step:number)=> <label className="field"><span>{label}</span><input className="input num" aria-label={label} type="number" min={min} max={max} step={step} value={p[key] as number} onChange={e=>{const v=Number(e.target.value);if(Number.isFinite(v))set({[key]:Math.max(min,Math.min(max,key==='searchMaxDelayH'?Math.round(v):v))})}}/></label>
  const optional=(label:string,key:'maxDarkH'|'maxSilenceH')=><label className="field"><span>{label}</span><input className="input num" type="number" min="0" max="72" step=".25" aria-label={label} placeholder="No limit" value={p[key]??''} onChange={e=>set({[key]:e.target.value===''?null:Math.max(0,Math.min(72,Number(e.target.value)))})}/></label>
  return <details className="model-details terrain-traverse" open={open} onToggle={e=>setOpen(e.currentTarget.open)} data-testid="terrain-traverse"><summary><strong>Drive this route through time</strong> · Sun, power & contact</summary><div>
    <p>Test the screened route from {fmtDate(input.startUnix)}, including waiting at its start and a hold at the goal. Common Power and Communication settings apply. A drive stops on its first enabled wheel/soil, bus or equipment-temperature failure; later calculations stay at that stopped position.</p>
    {invalid!==null&&<p role="alert" className="bad">The shared moving settings are invalid or unsupported. No default scenario is substituted. <button className="btn sm" onClick={()=>onSettings(DEFAULT_TRAVERSE)}>Reset moving settings</button></p>}
    <div className="traverse-controls">
      {numeric('Map speed (m/s)','speedMps',.001,1,.001)}{p.mobility?<div className="field"><span>Drive DC power</span><strong>From vehicle & soil</strong></div>:numeric('Extra drive DC power (W)','driveW',0,1e6,10)}{numeric('Wait before driving (h)','departureDelayH',0,48,.25)}
      {numeric('Hold at goal (h)','goalHoldH',0,24,.25)}{numeric('Usable reserve after hold (%)','reservePct',0,100,5)}
      <label className="field"><span>Maximum time step</span><select className="input" aria-label="Traverse maximum time step" value={p.maxStepS} onChange={e=>set({maxStepS:Number(e.target.value)})}>{[15,30,60,120,300].map(s=><option key={s} value={s}>{s} seconds</option>)}</select></label>
    </div>
    <MobilityControls value={p.mobility} onChange={mobility=>set({mobility})}/>
    <details className="model-details"><summary>Drive heat, orientation & service requirements</summary><div className="traverse-controls">
      {numeric(p.mobility?'Motor loss fraction entering equipment':'Drive fraction dissipated with bus','driveBusHeatFraction',0,1,.1)}
      <label className="field"><span>Fixed panel orientation</span><select className="input" aria-label="Traverse fixed panel frame" value={p.panelFrame} onChange={e=>set({panelFrame:e.target.value as TraverseSettings['panelFrame']})}><option value="travel">Relative to travel heading</option><option value="lunar-north">Relative to lunar north</option></select></label>
      {optional('Maximum route darkness (h)','maxDarkH')}{optional('Maximum powered silence (h)','maxSilenceH')}{numeric('Minimum Earth return (GB)','minDataGb',0,1e9,.1)}{numeric('Search waits through (h)','searchMaxDelayH',0,48,1)}
    </div><p className="model-note">With the vehicle model, the selected fraction of motor loss heat enters the equipment node; brake heat stays outside and does not charge the battery. In manual mode the fraction applies to all drive DC. Drive heat joins the bus before the equipment node’s waste-heat fraction. With travel-relative orientation, the Power panel’s fixed-facing azimuth becomes an offset from travel heading. Tracking and horizontal panels keep their existing models. Thermal boundaries stay user assumptions along the route. “Reserve” is energy above the protected storage floor, as a percentage of usable capacity.</p></details>
    {input.radio.relay&&<label className="terrain-return-toggle"><input type="checkbox" checked={p.allowAssumedRelay} onChange={e=>set({allowAssumedRelay:e.target.checked})}/>Apply these unverified relay grants along the trajectory. Point-bound reference/RF plans remain unavailable for motion.</label>}
    {!key&&invalid===null&&<p className="muted">Find a source route above to run its moving scenario.</p>}
    <div className="terrain-export-row"><button className="btn sm" disabled={!key||!inputValid||running} onClick={()=>run(false)}>Run moving simulation</button><button className="btn sm" disabled={!key||!inputValid||running} onClick={()=>run(true)}>Find earliest passing departure</button>{running&&<button className="btn sm ghost" onClick={()=>{worker.current?.terminate();worker.current=null;setRunning(false);setProgress(null)}}>Cancel moving calculation</button>}</div>
    {running&&<p role="status">{progress?.run} · wait candidate {progress?.attempt??0} / {progress?.total??1}…</p>}
    {visible?.error&&<p role="alert" className="bad">Moving calculation unavailable: {visible.error}</p>}
    {visible?.search&&<div className="traverse-search"><p className={visible.recommendation?'good':'warnnote'} role="status">{visible.recommendation?`Earliest passing sampled wait: ${visible.recommendation.input.settings.departureDelayH} h.`:`No passing departure among ${visible.search.attempts.length} attempted hourly waits.`} Search checked through {visible.search.completeThroughDelayH} h; later waits and other spatial paths are not inferred.</p>
      {visible.recommendation&&<button className="btn sm" onClick={apply}>Use this departure wait</button>}<details><summary>Every attempted wait</summary><ul>{visible.search.attempts.map(a=><li key={a.delayH}>{a.delayH} h: {a.status} · {a.issue??a.misses.join(', ')}{!a.refined&&' · refinement not run'}</li>)}</ul></details><button className="btn sm ghost" onClick={()=>save('lunorizon-departure-search.json',JSON.stringify({...visible.search,recommendation:visible.recommendation,scope:key},null,2),'application/json')}>Export departure search</button></div>}
    {packet&&<div className="traverse-result">
      <p className={packet.evaluation.pass?'good':'bad'} role="status"><b>{packet.evaluation.pass?'Passes this sampled moving scenario.':'Moving scenario fails its selected screen.'}</b> The original stationary mission verdict stays separate.</p>
      <ReservePlot packet={packet}/>
      <div className="traverse-table-wrap"><table className="traverse-runs"><thead><tr><th>Run</th><th>Goal arrival</th><th>Final map progress</th><th>Usable energy left</th><th>Earth return</th><th>Equipment range</th><th>Misses</th></tr></thead><tbody>{rows.map(([name,r])=><tr key={name}><th>{name}</th><td>{r.arrivalUnix?fmtDate(r.arrivalUnix):'Not reached'}</td><td>{r.finalDistanceM.toFixed(2)} m{r.haltReason&&<small>Stopped: {r.haltReason}</small>}</td><td>{r.endStoredWh.toFixed(1)} Wh{r.endUsablePct!==null&&<small>{r.endUsablePct.toFixed(1)}% of usable</small>}</td><td>{(r.returnedBits/8e9).toFixed(3)} GB<small>Gap {fmtHours(r.maxSilenceH)}</small></td><td>{r.minK===null?'Disabled':`${r.minK.toFixed(1)}–${r.maxK!.toFixed(1)} K`}</td><td>{r.misses.join(', ')||'None in this model'}</td></tr>)}</tbody></table></div>
      {packet.evaluation.refinement&&<p className="model-note">Refinement changed final energy by {packet.evaluation.refinement.nominalReserveDifferenceWh.toFixed(3)} Wh nominally and {packet.evaluation.refinement.raisedReserveDifferenceWh.toFixed(3)} Wh with the skyline raised. Agreement is a numerical sensitivity check, not a continuous-path guarantee.</p>}
      {packet.input.settings.mobility&&<div className="mobility-results" data-testid="mobility-results"><h3>Wheel & soil screen</h3>
        <p className="model-note">Peaks describe checked segment requirements, including a rejected segment. They are not measurements or necessarily delivered motor power. Limits use your assumed vehicle and uniform soil; all four runs share those assumptions.</p>
        <div className="traverse-table-wrap"><table className="traverse-runs"><thead><tr><th>Run</th><th>Edges checked</th><th>Absolute slip / limit</th><th>Hub torque / limit</th><th>Sinkage / limit</th><th>Wheel rpm / limit</th><th>Required DC peak</th><th>First rejection</th></tr></thead><tbody>{rows.map(([name,r])=>{const m=r.mobility,v=packet.input.settings.mobility!,fmt=(x:number|null|undefined,n=3)=>x==null?'—':x.toFixed(n);return <tr key={name}><th>{name}</th><td>{m?.edgesChecked??0}</td><td>{fmt(m?.maxAbsSlip)} / {v.maxAbsSlip}</td><td>{fmt(m?.maxTorqueNm)} / {v.maxHubTorqueNm} Nm</td><td>{fmt(m?.maxSinkageM,4)} / {(v.radiusM*v.maxSinkageRatio).toFixed(4)} m</td><td>{fmt(m?.maxWheelRpm,2)} / {v.maxWheelRpm}</td><td>{fmt(m?.maxDriveDcW)} W<small>Brake {fmt(m?.maxBrakeW)} / {v.maxBrakeW} W</small></td><td>{m?.firstFailure?<>Edge {m.firstFailure.edgeIndex}<small>{m.firstFailure.result.gradeDeg.toFixed(2)}° · {m.firstFailure.result.issues.join(', ')}</small></>:m?.edgesChecked?'None in checked edges':'No driving edges checked'}</td></tr>})}</tbody></table></div>
        <p className="model-note">Rigid-wheel model adapted from <a href={packet.mobilityModel?.reference} target="_blank" rel="noopener noreferrer">RoverDevKit</a>, pinned commit <code>{packet.mobilityModel?.commit}</code>, MIT. Base/refined wheel quadrature uses 100/200 points. Complete assumptions, brake treatment and limits are in the moving report.</p>
      </div>}
      <div className="terrain-export-row"><button className="btn sm" onClick={()=>save('lunorizon-moving-route.json',JSON.stringify(packet,null,2),'application/json')}>Export moving report</button><button className="btn sm" onClick={()=>save('lunorizon-moving-route.csv',traverseCsv(packet),'text/csv')}>Export moving CSV</button></div>
      <details className="model-details"><summary>Moving source, sampling & model limits</summary><p>Body source SHA-256: <code>{packet.ephemeris.bodySha256??'not supplied'}</code>. Station source: <code>{packet.ephemeris.stationsSha256??'not supplied'}</code>.</p><p>Local source: <code>{packet.route.source.patch.sha256}</code>. Result: <code>{packet.resultSha256}</code>.</p><ul>{packet.limits.map(l=><li key={l}>{l}</li>)}</ul></details>
    </div>}
    <p className="model-note">This checks a prescribed route and searches hourly departure waits. Joint spatial/time/energy optimization, vehicle dynamics, measured soil and turning remain open. Heights and directional sightlines are resampled at each integration pose; the base/refined runs also use a +1° skyline scenario. Inputs travel in the shared link; run again after restoring, since no moving result is trusted from storage.</p>
  </div></details>
}

function ReservePlot({packet}:{packet:TraversePacket}){
  const p=packet.input,storage=storageModel(p.power),usable=p.power.batteryWh*storage.maxDod,initial=p.power.batteryWh*(storage.initialSoc-(1-storage.maxDod))
  if(!usable)return <p className="model-note">No storage installed; this scenario depends on instantaneous bus supply.</p>
  const end=packet.evaluation.nominal.endUnix,span=end-p.startUnix,X=(u:number)=>48+808*(u-p.startUnix)/span,Y=(w:number)=>148-116*Math.max(0,Math.min(1,w/usable))
  const line=(run:EvaluatedRun)=>`M${X(p.startUnix)},${Y(initial)} `+run.samples.map(s=>`L${X(s.unix+s.seconds).toFixed(2)},${Y(s.storedWh).toFixed(2)}`).join(' ')
  return <svg className="traverse-reserve" viewBox="0 0 900 208" role="img" aria-label="Usable battery along the moving schedule. Blue is nominal; orange is raised skyline. Crosses mark driving halts. Gold and blue strips show sampled nominal Sun and allocated contact.">
    <path d="M48 26V148H856" fill="none" stroke="currentColor" opacity=".3"/><text x="8" y="35">100%</text><text x="20" y="150">0%</text>
    <path d={line(packet.evaluation.nominal)} fill="none" stroke="var(--earth)" strokeWidth="2"/><path d={line(packet.evaluation.raised)} fill="none" stroke="var(--warn)" strokeWidth="2" strokeDasharray="5 3"/>
    {packet.evaluation.nominal.samples.map((s,i)=><g key={i}><rect x={X(s.unix)} y="162" width={Math.max(.1,808*s.seconds/span)} height="7" fill="var(--sun)" opacity={s.sunFraction}/><rect x={X(s.unix)} y="173" width={Math.max(.1,808*s.seconds/span)} height="7" fill="var(--earth)" opacity={p.radio.relay?s.returnedBits>0?1:0:s.receivingMask?s.poweredFraction:0}/></g>)}
    <text x="14" y="169">Sun</text><text x="12" y="180">Link</text>
    {[packet.evaluation.nominal,packet.evaluation.raised].map((r,i)=>r.haltUnix!==null?<g key={i} stroke="var(--bad)" strokeWidth="2"><path d={`M${X(r.haltUnix)-4} 140l8 8m0-8l-8 8`}/></g>:null)}
    <text x="48" y="201">Nominal Sun/link · wait → drive → hold</text><text x="856" y="201" textAnchor="end">{fmtHours(span/3600)} · blue / dashed orange +1° · × halt time</text>
  </svg>
}
