import { useEffect, useMemo, useRef, useState } from 'react'
import { EvaluationInput, LandingOption } from '../lib/decision'
import { SiteRecord } from '../lib/data'
import { SearchResult, SearchSettings, searchCsv, searchMissions } from '../lib/search'
import { batteryRequirement } from '../lib/power'
import { operationsFor } from '../lib/communications'
import { fmtDate, fmtHours } from '../lib/ui'
import {UtcDateTime} from './UtcDateTime'

interface Props extends EvaluationInput {
  active?:boolean
  candidates: SiteRecord[]
  settings: SearchSettings
  onSettings: (s: SearchSettings) => void
  currentUnix: number
  earthMinClear: number
  requireDsn: boolean
  onUse: (o: LandingOption) => void
}
type Sort = 'date' | 'data' | 'gap' | 'slope' | 'battery'

export function MissionSearch(props: Props) {
  const { settings, onSettings, candidates } = props
  const [snapshot, setSnapshot] = useState<{ key: string; result: SearchResult; url: string; assumptions: unknown } | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<'frontier' | 'all'>('frontier')
  const [sort, setSort] = useState<Sort>('date')
  const [count, setCount] = useState(20)
  const task = useRef<AbortController | null>(null)
  const started=useRef(false)
  const assumptions = { requirements: props.req, power: props.power, radio: props.radio,
    terrain:props.terrainCheck?candidates.map(s=>({id:s.id,...props.terrainCheck!(s)})):null,
    referenceStations: props.eph.stations ? { antennas: ['DSS-24', 'DSS-54', 'DSS-34'], assetSha256: props.eph.stations.sha256, earthOrientation: props.eph.stations.orientation } : 'Earth-centre estimate',
    stayHours: props.len, observerM: props.observerM, earthMinClear: props.earthMinClear, requireDsn: props.requireDsn,
    ephemeris: { start: props.eph.startUnix, step: props.eph.stepS, count: props.eph.count, dsnMaskAvailable: !!props.eph.dsn },
    sites: candidates.map(s => ({ id: s.id, lat: s.lat, lon: s.lon, dem: s.dem, ...(s.localSky?{localSky:s.localSky}: {}) })) }
  const key = JSON.stringify({ settings, ...assumptions })
  const stale = snapshot !== null && snapshot.key !== key
  const relayActive = !!props.radio.relay
  const terrainLoading=!!props.terrainCheck&&candidates.some(s=>props.terrainCheck!(s).status==='loading')
  const trafficActive = !!operationsFor(props.radio).traffic || relayActive
  useEffect(() => {
    task.current?.abort()
    setRunning(false)
    setProgress(null)
    return () => task.current?.abort()
  }, [key])
  useEffect(() => setCount(20), [scope, sort, snapshot])
  const set = (s: Partial<SearchSettings>) => onSettings({ ...settings, ...s })
  const run = async () => {
    started.current=true
    task.current?.abort()
    const controller = new AbortController()
    task.current = controller
    setRunning(true); setError(null); setProgress([0, candidates.length * Math.ceil(settings.days / settings.stepDays)])
    const url = location.href
    try {
      const result = await searchMissions(props, { signal: controller.signal, onProgress: (done, total) => setProgress([done, total]) })
      if (!controller.signal.aborted) setSnapshot({ key, result, url, assumptions })
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (task.current === controller) setRunning(false)
    }
  }
  useEffect(()=>{
    if(props.active&&!started.current&&!terrainLoading&&candidates.length)void run()
  },[props.active,key,terrainLoading])
  const result = snapshot?.result
  const data = useMemo(() => {
    const source = result ? scope === 'frontier' ? result.frontier : result.passing : []
    const value = (r: typeof source[number]) => sort === 'data' ? -r.dataGb : sort === 'gap' ? r.silenceH
      : sort === 'slope' ? r.option.site.slope_deg! : sort === 'battery' ? r.option.batteryNeededWh : r.option.unix
    return [...source].sort((a, b) => value(a) - value(b) || a.option.unix - b.option.unix || a.option.site.name.localeCompare(b.option.site.name, 'en'))
  }, [result, scope, sort])
  const download = () => {
    if (!snapshot) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([searchCsv(snapshot.result, { restoreUrl: snapshot.url, assumptions: snapshot.assumptions })], { type: 'text/csv' }))
    a.download = 'lunorizon-site-date-search.csv'; a.click(); URL.revokeObjectURL(a.href)
  }
  return <section className="block" id="search" aria-labelledby="search-title">
    <header><div><h2 id="search-title">Find a site and date that meet your mission</h2>
      <p>Searches your {candidates.length} candidate sites with the current stay, rules and hardware.</p></div></header>
    <div className="panel"><div className="panel-b">
      {props.terrainCheck&&<p className="callout">Required terrain footprint is checked at each exact mission point. {terrainLoading?'Source terrain is loading; unknown points receive no pass credit.':'Unavailable coverage and undersized point-centred discs are rejected.'} Sun/Earth/power are evaluated at the centre; conditions across the entire disc are not resolved.</p>}
      {relayActive && <p className="callout">Conditional relay scenario: data home counts only modeled Earth arrivals through your assumed two-leg plan. Orbit, line of sight, RF closure and provider booking are unverified. Both queue overflow limits apply; direct Earth-view rules remain active. Absolute contact dates do not move with a candidate landing date.</p>}
      {props.radio.relay?.reference&&<p className="model-note">The reference binding covers only its packaged point, observer height and absolute interval. Other pairs are rejected rather than borrowing that point’s service. Enabled RF limits use your provider assumptions and the sampled reference ranges; missing inputs are a separate failure from payload overflow.</p>}
      <div className="search-controls">
        <label className="field"><span>Search from (UTC · 24 h)</span><UtcDateTime label="Search from (UTC)" value={settings.startUnix} min={props.eph.startUnix} max={props.eph.startUnix+(props.eph.count-1)*props.eph.stepS} onChange={startUnix=>set({startUnix})}/></label>
        <label className="field"><span>Calendar span</span><select className="input" aria-label="Search calendar span" value={settings.days} onChange={e => set({ days: Number(e.target.value) })}>
          {[7, 30, 90, 180, 365].map(d => <option key={d} value={d}>{d} days</option>)}
          {![7, 30, 90, 180, 365].includes(settings.days) && <option value={settings.days}>{settings.days} days</option>}
        </select></label>
        <label className="field"><span>Landing-day spacing</span><select className="input" aria-label="Landing-day spacing" value={settings.stepDays} onChange={e => set({ stepDays: Number(e.target.value) })}>
          {[1, 3, 7].map(d => <option key={d} value={d}>{d === 1 ? 'Every day' : `Every ${d} days`}</option>)}
        </select></label>
        <label className="field"><span>Minimum data home (GB)</span><input className="input num" type="number" aria-label="Minimum data home (GB)" min={0} step={1} value={settings.minDataGb} onChange={e => set({ minDataGb: Math.max(0, Number(e.target.value)) })} /></label>
        <label className="field"><span>Longest gap without a powered downlink (h)</span><input className="input num" type="number" aria-label="Longest gap without a powered downlink (h)" min={0} placeholder="No limit" value={settings.maxSilenceH ?? ''} onChange={e => set({ maxSilenceH: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></label>
      </div>
      <div className="search-actions">
        <button className="btn primary" disabled={running||terrainLoading} onClick={run}>Search sites and dates</button>
        <button className="btn sm ghost" onClick={() => set({ startUnix: props.currentUnix })}>Start at current landing date</button>
        {running && <button className="btn sm" onClick={() => { task.current?.abort(); setRunning(false) }}>Cancel search</button>}
        <span className="muted" role="status">{running && progress ? `Screening ${progress[0]} / ${progress[1]} site-date pairs…` : error ?? (stale ? 'Settings changed. Run the search again before applying a result.' : result ? `${result.passing.length === 1 ? '1 site-and-date plan passes' : `${result.passing.length} site-and-date plans pass`}${result.passing.length ? `. ${result.frontier.length} option${result.frontier.length === 1 ? '' : 's'} balance landing date, slope, storage and data return.` : '.'}` : 'Run a search to compare feasible dates and their trade-offs.')}</span>
      </div>
      {running && progress && <progress aria-label="Site-date search progress" max={progress[1]} value={progress[0]} />}
      {result && <div className={stale ? 'search-results stale' : 'search-results'} aria-label="Site-date search results">
        <p>{result.rows.length.toLocaleString('en-US')} evaluated pairs across {result.siteCount} points · {result.unavailable} outside the available dates.
          {' '}Data uses the smaller {relayActive ? 'modeled Earth arrival' : 'powered return'}, and silence the longer gap, from the nominal and raised-skyline runs.{relayActive && ' Relay silence means no actual forwarding; it is not real-time command availability.'}</p>
        <div className="search-actions"><label className="field"><span>Show</span><select className="input" aria-label="Search result set" value={scope} onChange={e => setScope(e.target.value as 'frontier' | 'all')}>
          <option value="frontier">Trade-off options ({result.frontier.length})</option><option value="all">All passing plans ({result.passing.length})</option></select></label>
          <label className="field"><span>Sort by</span><select className="input" aria-label="Sort search results" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="date">Earliest landing</option><option value="data">More data home</option><option value="gap">Shorter silence</option><option value="slope">Gentler slope</option><option value="battery">Less battery needed</option>
          </select></label>
          <button className="btn sm" onClick={download}>Export all evaluated pairs</button>
        </div>
        {data.length > 0 ? <><div className="search-table-wrap"><table className="ctable search-table" aria-label="Feasible site-date pairs">
          <thead><tr><th>Point</th><th>Landing (UTC)</th><th>Data home</th><th>Longest silence</th><th>Slope</th><th>Rated battery needed</th><th>Inspect</th></tr></thead>
          <tbody>{data.slice(0, count).map(row => <tr key={`${row.option.site.id}@${row.option.unix}`}>
            <th scope="row">{row.option.site.name}</th><td>{fmtDate(row.option.unix)}</td><td>{row.dataGb.toFixed(1)} GB</td>
            <td>{fmtHours(row.silenceH)}</td><td>{row.option.site.slope_deg!.toFixed(1)}°</td><td>{batteryRequirement(row.option.batteryNeededWh)}</td>
            <td><button className="btn sm" disabled={stale || running} aria-label={`Inspect ${row.option.site.name} on ${fmtDate(row.option.unix)}`} onClick={() => props.onUse(row.option)}>Use site & date</button></td>
          </tr>)}</tbody></table></div>
          {count < data.length && <button className="btn sm" onClick={() => setCount(n => n + 50)}>Show more ({data.length - count} remaining)</button>}</>
          : <p className="search-empty">No sampled pair meets all conditions. Review the failure counts below, change your service targets or hardware, or pin more candidate points.</p>}
        <details className="model-details"><summary>Why pairs failed and what the search covers</summary>
          <p>Counts can overlap because one pair may fail several conditions.</p>
          <ul>{Object.entries(result.reasons).map(([name, total]) => <li key={name}>{name}: {total} pairs</li>)}</ul>
          <p>Trade-off options are the exact nondominated set within this sampled search: no other passing pair is at least as good in landing date, slope, required battery, silence and returned data, and strictly better in one. There is no combined safety score. Equivalent options remain listed.</p>
          <p>The search tests every {result.settings.stepDays} day(s) at the same UTC hour, within {result.settings.days} calendar days starting {fmtDate(result.settings.startUnix)}. Each stay must fit the ephemeris. Both the mission rules and full bus demand must pass nominally and with the site-specific skyline shift. Reference-station runs also apply Earth-orientation sensitivity (receiver mask +0.001° through 29 Jan 2027, +0.35° afterwards; lunar aim +0.00002° / +0.006°). No conditions after the stay are inferred.</p>
        </details>
      </div>}
      <details className="model-details"><summary>Data and model limits</summary><p>{relayActive ?'Data uses your assumed access/backhaul rates and finite queues at the lander and relay; new access data cannot be forwarded until a later hourly bin. The relay is assumed powered and available.' : trafficActive ? 'Data is modeled payload delivery using your input rate, finite buffer, overflow limit and contact plan. The selected antenna allocation is assumed available.' : 'Data is a powered link-capacity upper bound; enable payload traffic in Communication to model actual input and finite storage. The selected antenna allocation is assumed available.'} {props.power.thermal ? 'Both runs also enforce your single-node equipment-temperature scenario; fixed thermal boundaries are assumptions.' : 'Equipment temperature is not evaluated; enable a scenario in Power to include it.'} No relay service, launch/transfer feasibility, unresolved landing hazards or flight thermal survival is certified. Pin only points compatible with your science objectives.</p></details>
    </div></div>
  </section>
}
