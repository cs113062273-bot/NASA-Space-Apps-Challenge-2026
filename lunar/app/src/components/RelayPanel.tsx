import { useState } from 'react'
import { DEFAULT_TRAFFIC, TrafficModel, operationsFor } from '../lib/communications'
import { MissionBudget, Radio, fmtBytes, radioDcW } from '../lib/link'
import { RelayPlan, exampleRelayPlan, parseRelayCsv, relayCsv } from '../lib/relay'
import { fmtHours } from '../lib/ui'
import { RelayRFPanel } from './RelayRFPanel'

export function RelayPanel({radio,budget,startUnix,onChange}:{radio:Radio;budget:MissionBudget;startUnix:number;onChange:(r:Radio)=>void}) {
  const [error,setError]=useState<string|null>(null)
  const p=radio.relay!,r=budget.relay!,d=r.lander,o=operationsFor(radio),traffic=o.traffic??{...DEFAULT_TRAFFIC}
  const set=(patch:Partial<RelayPlan>)=>onChange({...radio,relay:{...p,...(patch.passes?{reference:undefined,rf:undefined}:{}),...patch}})
  const setTraffic=(patch:Partial<TrafficModel>)=>onChange({...radio,operations:{...o,traffic:{...traffic,...patch}}})
  const save=()=>{
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([relayCsv(p)],{type:'text/csv'}));a.download='lunorizon-relay-plan.csv';a.click();URL.revokeObjectURL(a.href)
  }
  return <div className="relay-panel">
    <div className="relay-route"><strong>Assumed relay service route</strong><button className="btn sm" onClick={()=>onChange({...radio,relay:undefined})}>Use direct-to-Earth route</button></div>
    <p className="callout">{p.reference?'Reference geometry scenario: sampled contacts are bound to the packaged point, observer height and dates. The actual provider orbit, RF closure and booking remain unverified.':'Conditional scenario: contacts/rates below are provider-plan assumptions. Relay orbit, line of sight, RF closure and booking are unverified.'} The direct Earth-view requirement remains active; set its minimum to zero only if your mission permits relay-only service.</p>
    {!!budget.relayService?.issues.length&&<div role="alert" className="relay-setup-error">{budget.relayService.issues.map(issue=><p key={issue}>{issue}</p>)}</div>}
    <div className="kpis comm-traffic-kpis">
      <div className="kpi"><div className="label">Modeled Earth arrivals</div><div className="value earth">{fmtBytes(r.deliveredBits)}</div><div className="sub">during this stay; remaining data is not counted</div></div>
      <div className="kpi"><div className="label">Sent to relay</div><div className="value">{fmtBytes(d.deliveredBits)}</div><div className="sub">not necessarily forwarded to Earth</div></div>
      <div className="kpi"><div className="label">Pending · lander / relay</div><div className="value">{fmtBytes(d.pendingBits)} / {fmtBytes(r.relayPendingBits)}</div><div className="sub">finite queues at both nodes</div></div>
      <div className={`kpi ${budget.dataLossPass?'pass':'fail'}`}><div className="label">Discarded · lander / relay</div><div className="value">{fmtBytes(d.lostBits)} / {fmtBytes(r.relayLostBits)}</div><div className="sub">limits {traffic.maxLossGb} / {p.maxLossGb} GB; both apply in search</div></div>
    </div>
    <p>Earth delivery silence: {budget.link.poweredGapOpenEnded?'≥':''}{fmtHours(budget.link.longestPoweredGapH)}. Powered reserved access: {fmtHours(budget.link.poweredContactH)}. Relay backhaul can continue after the lander loses power.</p>
    <RelayRFPanel radio={radio} budget={budget} onChange={onChange}/>
    <div className="relay-fields">
      <label className="field relay-source"><span>Plan source / assumption</span><input className="input" aria-label="Relay plan source" maxLength={160} value={p.source} onChange={e=>set({source:e.target.value.replace(/[\r\n]/g,' ')||'Unspecified user assumption'})}/></label>
      {([['bufferGb','Relay buffer (GB)'],['initialGb','Mission data initially on relay (GB)'],['maxLossGb','Allowed relay overflow (GB)']] as const).map(([key,label])=><label className="field" key={key}><span>{label}</span><input className="input num" type="number" min={0} max={1e9} step={0.1} aria-label={label} value={p[key]} onChange={e=>set({[key]:Math.min(1e9,Math.max(0,Number(e.target.value)))})}/></label>)}
      {([['generatedKbps','Payload generation (kbit/s)'],['initialGb','Mission data initially on lander (GB)'],['bufferGb','Lander buffer (GB)'],['maxLossGb','Allowed lander overflow (GB)']] as const).map(([key,label])=><label className="field" key={key}><span>{label}</span><input className="input num" type="number" min={0} max={1e9} step={0.1} aria-label={label} value={traffic[key]} onChange={e=>setTraffic({[key]:Math.min(1e9,Math.max(0,Number(e.target.value)))})}/></label>)}
      <label className="field"><span>Access transmitter RF (W)</span><input className="input num" aria-label="Relay access transmitter RF (W)" type="number" min={0.1} max={500} value={radio.txW} onChange={e=>onChange({...radio,txW:Math.min(500,Math.max(0.1,Number(e.target.value)))})}/></label>
      <label className="field"><span>Access modem cap (kbit/s)</span><input className="input num" aria-label="Relay access modem cap (kbit/s)" type="number" min={0} value={radio.maxKbps??0} onChange={e=>onChange({...radio,maxKbps:Math.max(0,Number(e.target.value))})}/></label>
    </div>
    <p className="model-note">The lander reserves {radioDcW(radio).toFixed(1)} W DC in every geometrically eligible planned access contact, even if its queue is empty or RF service is zero. Zero modem cap means uncapped. Direct-route gain/band settings do not establish relay rates. No auto-switching or parallel direct downlink is added.</p>
    <details className="relay-contacts" open>
      <summary>Two-leg contact plan · {p.passes.length} contacts</summary>
      <div className="relay-actions"><button className="btn sm" onClick={save}>Export relay contact CSV</button>
        <label className="btn sm">Import relay contact CSV<input type="file" accept=".csv,text/csv" aria-label="Import relay contact CSV" onChange={async e=>{
          const file=e.target.files?.[0];if(!file)return
          try { const passes=parseRelayCsv(await file.text());set({passes,source:`Imported ${file.name}; user contacts, geometry/RF/booking unverified`.slice(0,160)});setError(null) }catch(err){setError(err instanceof Error?err.message:String(err))}
          e.target.value=''
        }}/></label>
        <button className="btn sm ghost" onClick={()=>{const example=exampleRelayPlan(startUnix);set({passes:example.passes,source:example.source});setError(null)}}>Reset hypothetical 7-day contacts</button>
        <button className="btn sm ghost" onClick={()=>set({passes:[]})}>Clear relay contacts</button>
      </div>
      {error&&<p role="alert" className="bad">{error}</p>}
      <p className="model-note">CSV: start_utc,end_utc,leg,rate_kbps. Leg is access or backhaul; use explicit UTC whole hours and exclusive ends, up to 64 contacts. Overlaps use the largest granted rate, never their sum. Outside these absolute contacts service is unavailable. Importing, clearing or resetting contacts removes the reference binding and RF evaluation, returning to an assumed contact plan.</p>
      <div className="search-table-wrap"><table className="ctable" aria-label="Relay service contacts"><thead><tr><th>Leg</th><th>From (UTC)</th><th>To (UTC)</th><th>kbit/s</th></tr></thead><tbody>{p.passes.map((w,i)=><tr key={i}><th scope="row">{w.leg}</th><td>{new Date(w.startUnix*1000).toISOString().slice(0,16)}</td><td>{new Date(w.endUnix*1000).toISOString().slice(0,16)}</td><td>{w.kbps}</td></tr>)}</tbody></table></div>
    </details>
    <details className="model-details"><summary>Store-and-forward method and limits</summary>
      <p>Hourly model: first serve the relay backlog present at the start of an hour, then admit this hour’s access arrivals at its end. Those arrivals cannot reach Earth until a later hour, even if contacts overlap. Independent full-duplex service resources and an available/powered relay are assumed. Lander acquisition and uplink share its full-bus powered prefix; backhaul does not use lander power. Drop-tail overflow is recorded independently at each node. This is not a packet/DTN implementation, propagation-delay calculation, retransmission or relay energy budget.</p>
      <p>No-overflow relay storage for the same access stream: {fmtBytes(r.relayBufferNeededBits)}. First relay overflow: {r.firstRelayOverflowH===null?'none':`T+${fmtHours(r.firstRelayOverflowH)}`}. Data already on the relay at touchdown must belong to this mission. Earth-delivery silence measures intervals with no actual modeled forwarding, including when no payload is queued; it differs from a real-time command/control availability guarantee.</p>
      <p>These service contacts need externally established trajectory, terrain/occultation, pointing, RF and allocation evidence. The direct-route station/skyline calculations remain a separate comparison and do not validate relay contacts. <a href="https://www.nasa.gov/directorates/somd/space-communications-navigation-program/lunanet-interoperability-specification/" target="_blank" rel="noreferrer">NASA LunaNet specification</a> distinguishes link and network services. No LNIS compliance or real provider availability is claimed.</p>
    </details>
  </div>
}
