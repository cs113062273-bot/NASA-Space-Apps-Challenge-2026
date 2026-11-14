import type { ReactNode } from 'react'
import type { SiteRecord } from '../lib/data'
import { Requirements, checkWindow, slopeKnown, slopeOk } from '../lib/requirements'
import { skylineErr } from '../lib/metrics'
import { DECISION_GOALS, DecisionGoal, LandingOption, ReplanResult, decisionSummary, delayLabel } from '../lib/decision'
import { fmtDate, fmtHours } from '../lib/ui'
import { batteryRequirement } from '../lib/power'
import { fmtBytes } from '../lib/link'

export function LandingDecision({ anchor, originalUnix, delayDays, len, req, result, currentSite, currentUnix, replacement, goal, onGoal, onPowerAdjustment, onChoose, onDelay, onUse, onCompare, onReset, onClose, candidates, onEditCandidates }: {
  anchor: SiteRecord | null
  originalUnix: number
  delayDays: number
  len: number
  req: Requirements
  result: ReplanResult | null
  currentSite: SiteRecord
  currentUnix: number
  replacement: LandingOption | null
  goal: DecisionGoal
  onGoal: (goal: DecisionGoal) => void
  onPowerAdjustment: () => void
  onChoose: (option: LandingOption) => void
  onDelay: (days: number) => void
  onUse: (option: LandingOption) => void
  onCompare: () => void
  onReset: () => void
  onClose?: () => void
  candidates: number
  onEditCandidates: () => void
}) {
  const waitDays = result?.waitHere ? Math.round((result.waitHere.unix - originalUnix) / 86400) - delayDays : null
  const title = result?.delayed?.clearsScreen ? 'This delay still fits. Keep the site.'
    : result?.powerAdjustment ? 'This delay fits the sky. The battery does not.'
      : result?.changeSite && waitDays !== null ? `${delayDays} days late. Wait ${waitDays} more here — or change sites.`
      : 'Your landing slipped. What now?'
  const viewing = (option: LandingOption | null) => !!option && option.site.id === currentSite.id && option.unix === currentUnix
  const hasCurrent = !!result && [result.before, result.delayed, replacement, result.waitHere].some(viewing)
  const optionProps = { req, onUse, trafficActive: result?.trafficActive ?? false, thermalActive: result?.thermalActive ?? false }
  return <section className="landing-decision" id="decision" aria-labelledby="decision-title">
    <header className="decision-heading">
      <div>
        <h2 id="decision-title">{title}</h2>
      </div>
      <label className="decision-delay">Delay
        <select aria-label="Replanning delay" className="input" value={delayDays} onChange={e => onDelay(Number(e.target.value))}>
          {[1, 3, 7, 14, 30].map(d => <option value={d} key={d}>{d} day{d === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <button className="btn sm ghost" onClick={onReset}>Use current site & date</button>
      {onClose && <button className="icon-btn sm" aria-label="Close landing decision" onClick={onClose}>×</button>}
    </header>
    {!anchor || !result ? <p>Recomputing the shared site’s horizon…</p> : <>
      <p className="decision-context">{anchor.name} · planned {fmtDate(originalUnix, false)} · {fmtHours(len)} stay. Need: daylight ≥{Math.min(req.minDaylightH, len)} h; dark ≤{req.maxDarkH} h; Earth ≥{req.minEarthPct}%; slope ≤{req.maxSlopeDeg}°{result.before?.terrain?`; point footprint ≥${result.before.terrain.requiredDiameterM} m`:''}.</p>
      <p className={`decision-answer ${result.delayed?.clearsScreen || result.changeSite || result.waitHere || result.powerAdjustment ? '' : 'bad'}`} role="status">{decisionSummary(result, replacement, goal)}</p>
      <div className="decision-options">
        <Option {...optionProps} step="01 · Planned" option={result.before} current={viewing(result.before)} empty="Original stay is outside the bundled dates." action="Inspect original plan" />
        <Option {...optionProps} step={`02 · ${delayDays} days late`} option={result.delayed} current={viewing(result.delayed)} empty="Delayed stay is outside the bundled dates." action="Inspect delayed plan" />
        {result.delayed?.clearsScreen ? <div className="decision-nochange">
          <h3>No replacement needed</h3>
          <p>The {delayDays}-day-late stay still meets every rule and the power needs, so the site can stay. Choose a longer delay above to see when it stops working.</p>
          <button className="btn primary sm" onClick={() => onUse(result.delayed!)}>Use delayed date →</button>
        </div> : <>
          <Option {...optionProps} step="03 A · Keep the delayed date" option={replacement} current={viewing(replacement)}
            picker={result.alternatives.length > 1 && replacement ? <select className="decision-site-select" aria-label="Replacement site" title={`Choose a proposed replacement (priority: ${DECISION_GOALS[goal]}). Use this site applies it to the mission.`} value={replacement.site.id}
              onChange={e => { const chosen = result.alternatives.find(o => o.site.id === e.target.value); if (chosen) onChoose(chosen) }}>
              {result.alternatives.map(o => <option key={o.site.id} value={o.site.id}>{o.site.name} · {goal === 'delay' ? delayLabel(o) : goal === 'slope' ? `${o.site.slope_deg!.toFixed(1)}° slope` : goal === 'battery' ? `${Math.ceil(o.batteryNeededWh)} Wh needed` : `${Math.round(100 * o.stats.earthHours / o.stats.hours)}% Earth`}</option>)}
            </select> : undefined}
            empty={`No replacement passes among ${result.checkedSites} other compared sites. Pin more sites to widen the search.`} action={viewing(replacement) ? 'Open this plan →' : 'Use this site →'} />
          <Option {...optionProps} step="03 B · Keep the original site" option={result.waitHere} current={viewing(result.waitHere)}
            empty={`No passing later date in the ${result.searchedDays} days searched.`} action={viewing(result.waitHere) ? 'Open this plan →' : 'Use this date →'} />
        </>}
      </div>
      <div className="decision-footer">
        <span>{!hasCurrent ? <span className="decision-view-warning">The Mission page still shows {currentSite.name}, {fmtDate(currentUnix, false)}. Choose an option to update it.</span>
          : <>Replacement sites come from your {candidates} candidate sites. <button className="linkish" onClick={onEditCandidates}>Edit list →</button></>}</span>
        {result.alternatives.length > 1 && <label className="decision-priority">Prioritize
          <select className="input" aria-label="Prioritize replacements" title="Rank proposed replacements. The current mission stays unchanged until you apply one." value={goal} onChange={e => onGoal(e.target.value as DecisionGoal)}>
            {Object.entries(DECISION_GOALS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>}
        <button className="btn sm" onClick={onCompare}>Compare these options →</button>
      </div>
      {result.powerAdjustment && <details className="decision-adjustment">
        <summary>Keep this site and date: test a battery change</summary>
        <p>{result.idealPower ? 'Ideal usable battery' : 'Rated battery capacity'}: <strong>{result.powerAdjustment.fromWh.toLocaleString('en-US')} → {result.powerAdjustment.batteryWh.toLocaleString('en-US')} Wh</strong>. At {anchor.name} on {fmtDate(result.powerAdjustment.option.unix, false)}, this capacity passes both power screens. Array, radio, stay and mission rules stay the same.</p>
        <p>{result.idealPower ? `Ideal storage baseline: full battery at touchdown, no storage losses.${result.thermalActive ? ' Equipment heater demand is included.' : ' No heater demand.'}` : 'Uses the initial charge, protected capacity, efficiencies, power limits, selected heater model and array derating in Power.'} No battery mass, temperature-dependent cell properties or aging is calculated. This is storage sizing to explore.</p>
        <button className="btn sm" onClick={onPowerAdjustment}>Apply modeled battery size →</button>
      </details>}
      {result.relayActive&&<p className="warnnote">Conditional on your assumed relay service contacts; relay orbit, geometry, RF and booking are unverified. Earth-view rules still require direct visibility unless you explicitly change them.</p>}
      {result.alternatives.length > 1 && <details className="decision-alternatives"><summary>Compare all {result.alternatives.length} passing sites</summary>
        <div className="decision-tradeoffs"><table aria-label="Passing replacement trade-offs">
          <thead><tr><th>Representative point</th><th>Earth</th><th>Slope</th><th>More delay</th><th>Rated battery needed</th><th>Inspect</th></tr></thead>
          <tbody>{result.alternatives.map(o => <tr key={o.site.id} aria-current={viewing(o) ? 'true' : undefined}>
            <th scope="row">{o.site.name}</th><td>{Math.round(100 * o.stats.earthHours / o.stats.hours)}%</td><td>{o.site.slope_deg!.toFixed(1)}°</td><td>{delayLabel(o)}</td><td>{Math.ceil(o.batteryNeededWh)} Wh</td>
            <td><button className="btn sm" aria-label={`Inspect ${o.site.name} replacement`} aria-pressed={o.site.id === replacement?.site.id} onClick={() => onChoose(o)}>{viewing(o) ? 'In use' : o.site.id === replacement?.site.id ? 'Shown above' : 'Show above'}</button></td>
          </tr>)}</tbody>
        </table></div>
      </details>}
      <details className="decision-limits"><summary>Model limits</summary>
        <p>Pass requires your daylight, darkness, Earth-view, slope, selected power and any enabled data-loss conditions to hold at both the nominal skyline and with it raised by 0.1° (1° for coarse custom terrain). The contact allocation plan applies to both runs. {result.before?.terrain?'The exact mission point must also fit the selected footprint in projected map metres; missing terrain cannot pass, and the larger nearby disc cannot substitute for that point. Sun/Earth/power remain centre samples. ':''}This is a sensitivity test, not a confidence interval or landing clearance.</p>
        <p>Delay tolerance tests consecutive daily starts at the same UTC hour, up to 30 days or the data boundary; ≥ marks a search limit. Battery needed is the larger nominal / raised-skyline rated capacity using your Power settings. Extra storage cannot restore lost daylight, Earth contact or insufficient discharge power.</p>
        {result.stationGeometry && <p>Communication checks the same reference antenna at both ends (DSS-24 / DSS-54 / DSS-34). The raised-skyline run also adds Earth-orientation sensitivity: receiving mask +0.001° through 29 Jan 2027, +0.35° afterwards; lunar aim +0.00002° / +0.006°. These are sensitivity inputs, not accuracy guarantees.</p>}
        {result.thermalActive && <p>The enabled equipment-temperature scenario must stay inside its selected limits in both runs. Heater demand shares the bus; fixed IR/mounting boundaries and a single isothermal node are assumed. This does not certify flight thermal survival.</p>}
        <p>Ranking uses one priority, then alphabetical ties. Pin only points that serve your science objectives; a representative point does not certify its whole region. Launch and transfer feasibility, unresolved hazards, thermal survival and actual DSN booking conflicts are excluded.</p>
        <p><a href="#evidence">Data and validation</a> · <a href="https://ntrs.nasa.gov/citations/20250011660" target="_blank" rel="noreferrer">NASA site-selection study</a></p>
      </details>
    </>}
  </section>
}

function Option({ step, option, empty, onUse, action, req, current, picker, trafficActive, thermalActive }: {
  step: string; option: LandingOption | null; empty: string; onUse: (option: LandingOption) => void; action: string
  req: Requirements; current: boolean; picker?: ReactNode
  trafficActive: boolean
  thermalActive: boolean
}) {
  const checks = option ? checkWindow(option.stats, req) : null
  const status = option?.clearsScreen ? option.terrain?'Rules + power + point footprint pass':thermalActive ? 'Rules + power + temperature pass' : trafficActive ? 'Rules + power + data pass' : 'Rules + power pass'
    : option?.terrain&&!option.terrain.pass?option.terrain.status==='ready'?'Point footprint is too small':'Terrain data unavailable'
    : option && !option.thermalPass ? 'Equipment temperature fails'
    : option?.rulesPass && option.powerPass && option.dataPass ? thermalActive ? 'Fails sensitivity screen' : `Fails skyline +${skylineErr(option.site)}°`
      : trafficActive ? 'Rules, power or data fail' : 'Rules + power fail'
  return <article className={`decision-option ${option ? option.clearsScreen ? 'passes' : 'misses' : 'empty'}`} aria-current={current ? 'true' : undefined}>
    <div className="decision-step">{step}{current && <span className="decision-current" title="The main analysis and Mission brief currently use this option">Viewing</span>}</div>
    {option ? <>
      <h3 title={option.site.name}>{picker ?? option.site.name}</h3>
      <div className="decision-date"><span>{fmtDate(option.unix, false)}</span>{slopeKnown(option.site) && <span className="decision-slope" title={`Slope over a ${option.site.slope_baseline_m ?? 40} m baseline`}>{option.site.slope_deg!.toFixed(1)}° slope</span>}</div>
      <div className={`decision-state ${option.clearsScreen ? 'good' : 'bad'}`} title={option.clearsScreen ? 'Selected rules and power, nominally and with the skyline raised' : `Misses: ${option.misses.join(', ')}`}>{status}</div>
      <dl>
        <div><dt>Daylight left</dt><dd className={!checks?.daylight ? 'bad' : undefined}>{option.stats.startsDark ? 'lands in darkness' : `${option.stats.firstSunset === null ? '≥' : ''}${fmtHours(option.stats.firstSunset ?? option.stats.hours)}`}{!checks?.daylight && !option.stats.startsDark && <> / {fmtHours(Math.min(req.minDaylightH, option.stats.hours))} needed</>}</dd></div>
        {!checks?.dark && <div><dt>Longest dark</dt><dd className="bad">{option.stats.darkOpenEnded ? '≥' : ''}{fmtHours(option.stats.longestDark)} / {fmtHours(req.maxDarkH)} limit</dd></div>}
        <div><dt>Earth in view</dt><dd className={!checks?.earth ? 'bad' : undefined}>{Math.round(100 * option.stats.earthHours / option.stats.hours)}%{!checks?.earth && <> / {req.minEarthPct}% needed</>}</dd></div>
        {option.furtherDelay && <div title="Consecutive additional daily starts passing both rule and power screens; maximum 30 days or data boundary"><dt>Delay tolerance</dt><dd>{delayLabel(option)}</dd></div>}
        {!slopeOk(option.site, req.maxSlopeDeg) && <div><dt>Slope</dt><dd className="bad">{slopeKnown(option.site) ? `${option.site.slope_deg!.toFixed(1)}° / ${req.maxSlopeDeg}° limit` : 'not measured'}</dd></div>}
        {option.terrain&&<div title={option.terrain.issue??'Terrain footprint at the exact mission point; centre-only mission conditions'}><dt>Point footprint</dt><dd className={option.terrain.pass?'':'bad'}>{option.terrain.status==='ready'?`${(2*option.terrain.radiusM!).toFixed(1)} / ${option.terrain.requiredDiameterM} m`:option.terrain.status}</dd></div>}
        <div title={`Rated storage needed, larger of nominal / raised skyline: ${batteryRequirement(option.batteryNeededWh)}; uses your Power settings`}><dt>Power</dt><dd className={!(option.powerPass && option.shiftedPowerPass) ? 'bad' : undefined}>{option.powerPass && !option.shiftedPowerPass ? 'fails raised skyline' : option.powerShortfallAt === null ? `lasts · ${batteryRequirement(option.batteryNeededWh)} needed` : `shortfall T+${fmtHours(option.powerShortfallAt)}`}</dd></div>
        {trafficActive && <div><dt>Data discarded</dt><dd className={!(option.dataPass && option.shiftedDataPass) ? 'bad' : undefined}>{fmtBytes(Math.max(option.dataLossBits, option.shiftedDataLossBits))}</dd></div>}
        {thermalActive && <div><dt>Temperature</dt><dd className={option.thermalPass && option.shiftedThermalPass ? '' : 'bad'}>{option.thermalPass && option.shiftedThermalPass ? 'both scenarios hold' : 'outside limits'}</dd></div>}
      </dl>
      <button className={`btn sm ${option.clearsScreen && step.startsWith('03') ? 'primary' : ''}`} onClick={() => onUse(option)}>{action}</button>
    </> : <p>{empty}</p>}
  </article>
}
