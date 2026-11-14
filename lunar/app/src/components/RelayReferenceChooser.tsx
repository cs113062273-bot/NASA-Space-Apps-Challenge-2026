import { useEffect,useState } from 'react'
import { RELAY_REFERENCES,ReferenceBinding,RelayReferenceCase,referenceCase,referencePackageError } from '../lib/relay-reference'
import { fmtDate } from '../lib/ui'

export const referenceName=(c:RelayReferenceCase)=>c.site.id==='c1'?'Connecting Ridge C1':c.site.id==='change6'?"Chang’e 6 (far side)":c.site.id
export function RelayReferenceChooser({active,onUse}:{active?:ReferenceBinding;onUse:(c:RelayReferenceCase)=>string|null}) {
  const [id,setId]=useState(active?.id??RELAY_REFERENCES[0]?.id??'')
  const [error,setError]=useState<string|null>(null)
  useEffect(()=>{if(active?.id)setId(active.id)},[active?.id])
  const c=RELAY_REFERENCES.find(c=>c.id===id)??RELAY_REFERENCES[0]
  if(!c)return <p className="warnnote">Reference plans unavailable: {referencePackageError()??'no packaged geometry'}. Direct and user-assumed routes remain available.</p>
  const download=()=>{
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(c,null,2)],{type:'application/json'}));a.download=`lunorizon-${c.id}-reference.json`;a.click();URL.revokeObjectURL(a.href)
  }
  const loaded=referenceCase(active)
  return <div className="relay-reference-block">
    {active&&<p className="model-note">Loaded plan: {loaded?`${referenceName(loaded)} · ${loaded.spacecraft} · 2 m · 1–8 Mar 2027`:'reference asset version unavailable'}. Actual provider service remains unverified.</p>}
    <details className="relay-reference">
    <summary>Reference orbit plans · SV-1 · 1–8 Mar 2027</summary>
    <p>Open a point and its checked reference geometry. Mission rules, hardware and payload inputs stay as you set them. Rates, provider availability and relay power remain assumptions.</p>
    <div className="relay-reference-actions">
      <label className="field"><span>Reference point</span><select className="input" aria-label="Reference relay point" value={c.id} onChange={e=>{setId(e.target.value);setError(null)}}>{RELAY_REFERENCES.map(c=><option key={c.id} value={c.id}>{referenceName(c)}</option>)}</select></label>
      <button className="btn sm" onClick={e=>{const issue=onUse(c);setError(issue);if(!issue){const details=e.currentTarget.closest('details');if(details)details.open=false}}}>Use reference point, dates & 2 m</button>
    </div>
    {error&&<p role="alert" className="bad">{error}</p>}
    <div className="relay-reference-timing" aria-label="Reference geometry contact schedule">
      <div><span>Lander → SV-1</span><span>SV-1 → Earth</span></div>
      <svg viewBox="0 0 672 66" role="img" aria-label={`${referenceName(c)}: ${c.accessHours} sampled access hours and ${c.backhaulHours} sampled backhaul hours, 1 to 8 March 2027`}>
        {[0,1].map((lane)=><g key={lane}>{c.hourly.map((h,j)=><rect key={j} x={j*4} y={lane*22} width={3.5} height={14} className={(lane===0?h.access:h.backhaul)?lane===0?'reference-access':'reference-backhaul':'reference-gap'}><title>{fmtDate(c.startUnix+j*3600)} · {lane===0?'access':'backhaul'} {(lane===0?h.access:h.backhaul)?'sampled geometry allows':'not granted'}</title></rect>)}</g>)}
        {Array.from({length:8},(_,j)=><text key={j} x={j*96} y={62} textAnchor={j===7?'end':j===0?'start':'middle'}>{j+1} Mar</text>)}
      </svg>
    </div>
    <p className="model-note">{c.accessHours} h access · {c.backhaulHours} h backhaul · every 15 s sample and both hour endpoints pass. Loaded only for this point at 2 m, {fmtDate(c.startUnix)} to {fmtDate(c.startUnix+c.hours*3600)}. Changing point, height or dates can invalidate the route.</p>
    <details className="model-details"><summary>Source, numerical checks and limits</summary>
      <p><a href={c.source.url} target="_blank" rel="noreferrer">NASA LCRNS 3.1 reference design</a>, not a provider ephemeris. {c.source.model}. Numerical 30-day cross-check difference ≤{c.numerics.maximum30DayPositionDifferenceM.toFixed(2)} m; sampled interpolation difference ≤{c.numerics.maximumHermiteMidpointDifferenceM.toFixed(2)} m. Neither figure is physical orbit accuracy.</p>
      <p>Backhaul checks the moving-Moon photon path against <a href={c.limbTerrain.url.replace('.img','.lbl')} target="_blank" rel="noreferrer">LOLA LDEM_64 terrain</a> ({c.limbTerrain.gridM.toFixed(0)} m grid, {c.limbTerrain.frame}), using at most {c.limbTerrain.stepM} m ray steps and a {c.limbTerrain.guardM} m radial engineering guard. The existing 0.1° spherical-limb guard is also retained. Smaller terrain, DEM errors and diffraction are unresolved. These margins are not uncertainty bounds.</p>
      <p>Source frame/table residuals remain unresolved. Any of DSS-24/54/34 is assumed to receive with instantaneous switching. Direct-route antenna allocations are separate. Sampling is not continuous coverage proof; no pointing, RF, booking, protocol or flight validation is inferred.</p>
      <p className="reference-fingerprint">Geometry report SHA-256: <code>{c.reportSha256}</code></p>
      <button className="btn sm ghost" onClick={download}>Export reference evidence</button>
    </details>
  </details></div>
}
