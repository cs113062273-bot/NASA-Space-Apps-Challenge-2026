import { useState } from 'react'
import { COMPLEXES, CommOperations, DEFAULT_TRAFFIC, complexNames, contactPlanCsv, operationsFor, parseContactPlanCsv } from '../lib/communications'
import { MissionBudget, Radio, fmtBytes } from '../lib/link'
import { fmtHours } from '../lib/ui'
import {UtcDateTime} from './UtcDateTime'

export function CommOperationsPanel({ radio, budget, landingUnix, onChange }: {
  radio: Radio; budget: MissionBudget; landingUnix: number; onChange: (r: Radio) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const o = operationsFor(radio), d = budget.delivery
  const set = (patch: Partial<CommOperations>) => { setError(null); onChange({ ...radio, operations: { ...o, ...patch } }) }
  const changeWindow = (index: number, patch: Partial<CommOperations['windows'][number]>) => {
    const windows = o.windows.map((w, k) => k === index ? { ...w, ...patch } : w)
    if (patch.startUnix !== undefined && windows[index].endUnix <= patch.startUnix) windows[index].endUnix = patch.startUnix + 3600
    if (windows[index].endUnix <= windows[index].startUnix) { setError('A pass must end after its start.'); return }
    set({ windows })
  }
  const exportPlan = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([contactPlanCsv(o.windows)], { type: 'text/csv' }))
    a.download = 'lunorizon-contact-plan.csv'; a.click(); URL.revokeObjectURL(a.href)
  }
  return <details className="comm-operations">
    <summary>Contact plan and onboard data · {o.schedule === 'all' ? 'all eligible hours' : o.schedule === 'daily' ? `${o.dailyHours} h daily` : `${o.windows.length} UTC passes`}{o.traffic ? ' · finite buffer' : ''}</summary>
    <fieldset className="comm-complexes"><legend>Eligible DSN complexes</legend>
      {COMPLEXES.map(s => <label key={s.mask}><input type="checkbox" aria-label={`Use ${s.name} complex`} checked={!!(o.stationMask & s.mask)} onChange={() => set({ stationMask: o.stationMask ^ s.mask })} />{s.name}</label>)}
    </fieldset>
    <div className="comm-plan-controls">
      <label className="field"><span>Assumed antenna allocation</span><select className="input" aria-label="Assumed antenna allocation" value={o.schedule} onChange={e => set({ schedule: e.target.value as CommOperations['schedule'] })}>
        <option value="all">All visible hours (upper bound)</option><option value="daily">Daily UTC slot</option><option value="windows">Explicit UTC passes</option>
      </select></label>
      {o.schedule === 'daily' && <>
        <label className="field"><span>Daily start (UTC)</span><select className="input" aria-label="Daily contact start (UTC)" value={o.dailyStartHour} onChange={e => set({ dailyStartHour: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
        </select></label>
        <label className="field"><span>Hours per day</span><input className="input num" aria-label="Contact hours per day" type="number" min={0} max={24} step={1} value={o.dailyHours} onChange={e => set({ dailyHours: Math.max(0, Math.min(24, Math.round(Number(e.target.value)))) })} /></label>
      </>}
    </div>
    {o.schedule === 'windows' && <div className="comm-pass-plan">
      <p>Passes use absolute UTC whole hours, including across search dates. End times are exclusive; overlaps form a union. These are your assumed allocations, not DSN bookings.</p>
      <div className="comm-pass-list">{o.windows.map((w, i) => <div className="comm-pass" key={i}>
        <label className="field"><span>Start UTC</span><UtcDateTime label={`Pass ${i + 1} start UTC`} value={w.startUnix} snap="floor" onChange={value=>changeWindow(i,{startUnix:value})}/></label>
        <label className="field"><span>End UTC</span><UtcDateTime label={`Pass ${i + 1} end UTC`} value={w.endUnix} snap="floor" onChange={value=>changeWindow(i,{endUnix:value})}/></label>
        <label className="field"><span>Complexes</span><select className="input" aria-label={`Pass ${i + 1} complexes`} value={w.stationMask} onChange={e => changeWindow(i, { stationMask: Number(e.target.value) })}>
          {[7, 1, 2, 4, 3, 5, 6, 0].map(mask => <option key={mask} value={mask}>{complexNames(mask)}</option>)}
        </select></label>
        <button className="icon-btn sm" aria-label={`Remove pass ${i + 1}`} onClick={() => set({ windows: o.windows.filter((_, k) => k !== i) })}>×</button>
      </div>)}</div>
      <div className="comm-plan-actions">
        <button className="btn sm" disabled={o.windows.length >= 64} onClick={() => { const startUnix = Math.floor(landingUnix / 3600) * 3600; set({ windows: [...o.windows, { startUnix, endUnix: startUnix + 3600, stationMask: o.stationMask }] }) }}>Add UTC pass</button>
        <button className="btn sm" onClick={exportPlan}>Export contact plan</button>
        <label className="comm-import">Import CSV<input type="file" aria-label="Import contact plan CSV" accept=".csv,text/csv" onChange={async e => {
          const input = e.currentTarget, file = input.files?.[0]
          if (!file) return
          try { set({ windows: parseContactPlanCsv(await file.text()) }) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
          input.value = ''
        }} /></label>
      </div>
      <p className="model-note">CSV columns: start_utc,end_utc,complexes. Use UTC dates such as 2027-01-18T00:00Z and complex names joined with |. Up to 64 passes; invalid imports leave the current plan intact.</p>
    </div>}
    {error && <p className="bad" role="alert">{error}</p>}
    <p className="model-note">{fmtHours(budget.link.geometryContactH)} visible before selection/allocation; {fmtHours(budget.link.excludedStationH)} excluded by complex selection; {fmtHours(budget.link.unscheduledH)} outside the plan; {fmtHours(budget.link.contactH)} planned contact. Selecting overlapping complexes never multiplies the data rate.</p>
    <label className="comm-traffic-toggle"><input type="checkbox" aria-label="Model payload traffic and buffer" checked={!!o.traffic} onChange={e => set({ traffic: e.target.checked ? { ...DEFAULT_TRAFFIC } : null })} />Model payload traffic and finite onboard storage</label>
    {o.traffic && d && <>
      <div className="comm-traffic-fields">{([
        ['generatedKbps', 'Payload input (kbit/s)'], ['initialGb', 'Already recorded (GB)'],
        ['bufferGb', 'Onboard storage (GB)'], ['maxLossGb', 'Allowed overflow (GB)'],
      ] as const).map(([key, label]) => <label className="field" key={key}><span>{label}</span><input className="input num" type="number" aria-label={label} min={0} max={1e9} step={key === 'generatedKbps' ? 10 : 0.1} value={o.traffic![key]}
        onChange={e => set({ traffic: { ...o.traffic!, [key]: Math.max(0, Math.min(1e9, Number(e.target.value))) } })} /></label>)}</div>
      <div className="kpis comm-traffic-kpis">
        <div className="kpi"><div className="label">Payload delivered</div><div className="value">{fmtBytes(d.deliveredBits)}</div><div className="sub">{fmtBytes(d.producedBits)} produced; {fmtBytes(d.initialBits)} initially recorded</div></div>
        <div className="kpi"><div className="label">Still onboard</div><div className="value">{fmtBytes(d.pendingBits)}</div><div className="sub">at the end of this stay; later delivery not assumed</div></div>
        <div className={`kpi ${budget.dataPass ? 'pass' : 'fail'}`}><div className="label">Discarded overflow</div><div className="value">{fmtBytes(d.lostBits)}</div><div className="sub">{budget.dataPass ? 'within' : 'exceeds'} {o.traffic.maxLossGb} GB limit{d.firstOverflowH !== null ? ` · first at T+${fmtHours(d.firstOverflowH)}` : ''}</div></div>
        <div className="kpi"><div className="label">Storage to avoid overflow</div><div className="value">{fmtBytes(d.bufferNeededBits)}</div><div className="sub">same powered input and contact reservation</div></div>
      </div>
      <p className="model-note">Payload input and transmission occur together while the full modeled bus demand is met; {fmtBytes(d.missedProductionBits)} of commanded input is not produced during power loss. Overflow discards incoming excess. The data-loss limit is included in delay and site/date screens.</p>
    </>}
    <p className="model-note">Radio power is reserved throughout every planned contact, even with an empty queue. Geometry uses DSS-24 / DSS-54 / DSS-34, one reference 34 m antenna per complex; gain/noise remains a generic 34 m budget. Actual bookings, antenna-specific RF configurations, weather and relay links are not included.</p>
    <p className="model-note"><a href="https://www.mdscc.nasa.gov/index.php/en/mdscc-antennas-weekly-schedule/" target="_blank" rel="noreferrer">How DSN passes are scheduled</a> · <a href="https://ntrs.nasa.gov/citations/20240012437" target="_blank" rel="noreferrer">NASA store-and-forward study</a></p>
  </details>
}
