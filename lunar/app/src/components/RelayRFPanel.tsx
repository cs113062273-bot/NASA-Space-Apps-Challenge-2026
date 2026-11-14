import { MissionBudget,Radio } from '../lib/link'
import { DEFAULT_RELAY_RF,RelayRF } from '../lib/relay-rf'

const fields:[keyof RelayRF,string,number,number][]=[
  ['accessMHz','Access frequency (MHz)',1,100000],['accessGainDbi','Lander access gain (dBi)',-20,80],
  ['backhaulMHz','Backhaul frequency (MHz)',1,100000],['accessLossDb','Access extra losses (dB)',0,100],['backhaulLossDb','Backhaul extra losses (dB)',0,100],
  ['accessEbNoDb','Access required Eb/N0 (dB)',-10,50],['backhaulEbNoDb','Backhaul required Eb/N0 (dB)',-10,50],['marginDb','RF design margin (dB)',0,50],
]
export function RelayRFPanel({radio,budget,onChange}:{radio:Radio;budget:MissionBudget;onChange:(r:Radio)=>void}) {
  const p=radio.relay!,rf=p.rf,needs=budget.relayService?.requirements
  const set=(patch:Partial<RelayRF>)=>onChange({...radio,relay:{...p,rf:{...DEFAULT_RELAY_RF,...rf,...patch}}})
  return <details className="relay-rf" open={!!rf}>
    <summary>RF requirements and rate limits · {rf?'scenario enabled':'not evaluated'}</summary>
    <label className="comm-traffic-toggle"><input type="checkbox" aria-label="Apply relay RF limits" checked={!!rf} disabled={!p.reference&&!rf}
      onChange={e=>onChange({...radio,relay:{...p,rf:e.target.checked?{...DEFAULT_RELAY_RF}:undefined}})}/> Apply RF limits to this reference route</label>
    {!p.reference&&<p className="model-note">Load a reference orbit plan above to use its sampled ranges. A contact CSV alone does not establish the path distance or RF link.</p>}
    {rf&&<>
      <p>Unknown receiver/transmitter inputs receive no service credit. Entered values are your scenario assumptions; contact grants and modem limits still cap the rate.</p>
      <div className="relay-fields">
        {([['relayGtDbK','Relay receiver G/T (dB/K)'],['relayEirpDbW','Relay transmitter EIRP (dBW)'],['groundGtDbK','Ground receiver G/T (dB/K)']] as const).map(([key,label])=><label className="field" key={key}><span>{label}</span><input className="input num" type="number" aria-label={label} min={-100} max={100} step={.1} placeholder="Unknown" value={rf[key]??''} onChange={e=>set({[key]:e.target.value===''?null:Math.max(-100,Math.min(100,Number(e.target.value)))})}/></label>)}
      </div>
      <dl className="relay-rf-needs">
        <div><dt>Relay G/T needed for the access grant</dt><dd>{needs?.accessGtDbK!=null?`≥ ${needs.accessGtDbK.toFixed(1)} dB/K`:'No usable access range'}</dd></div>
        <div><dt>Backhaul EIRP + ground G/T needed</dt><dd>{needs?.backhaulEirpPlusGtDb!=null?`≥ ${needs.backhaulEirpPlusGtDb.toFixed(1)} dBW + dB/K`:'No usable backhaul range'}</dd></div>
      </dl>
      <p className="model-note">For the current stay and grant ceilings, using the worst sampled range in each granted hour. RF limits reduce modeled delivery; they do not validate a real provider, an assigned channel or equipment performance. Radio DC remains reserved during geometrically eligible planned access, even with no data service.</p>
      <div className="relay-actions"><button className="btn sm" onClick={()=>set({relayGtDbK:15,relayEirpDbW:30,groundGtDbK:45})}>Try editable RF example</button><button className="btn sm ghost" onClick={()=>set({relayGtDbK:null,relayEirpDbW:null,groundGtDbK:null})}>Clear provider RF inputs</button></div>
      <details className="model-details"><summary>Frequency, loss and coding assumptions</summary>
        <div className="relay-fields">{fields.map(([key,label,min,max])=><label className="field" key={key}><span>{label}</span><input className="input num" type="number" step={.1} min={min} max={max} aria-label={label} value={rf[key]??0} onChange={e=>set({[key]:Math.max(min,Math.min(max,Number(e.target.value)))})}/></label>)}</div>
        <p>Defaults: 2250 MHz access and 8425 MHz backhaul are frequency scenarios. Access losses of 14 dB combine 8 dB multipath and 3 dB implementation from the public SRD notes, plus our illustrative 3 dB reserve. Backhaul 6 dB loss, 4.1 dB Eb/N0 and 3 dB margin are editable assumptions. Ground G/T is assumed common to all three reference antennas, with instantaneous switching. No packet/framing overhead, interference, bandwidth allocation, antenna pattern or relay power model is inferred. Lander gain here applies at the access frequency; direct-route band/dish settings are separate.</p>
        <p><a href="https://www.nasa.gov/wp-content/uploads/2025/08/lunar-relay-services-requirements-document-srd.pdf?emrc=68cc4848682bc" target="_blank" rel="noreferrer">NASA public SRD, Table 3-6</a> lists user-terminal parameters. Its G/T column is not the relay receiver’s G/T. The editable 15 / 30 / 45 example is not a provider specification.</p>
      </details>
    </>}
  </details>
}
