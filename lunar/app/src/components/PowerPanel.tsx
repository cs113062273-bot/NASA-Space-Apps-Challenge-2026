import { useEffect, useMemo } from 'react'
import { Ephemeris } from '../lib/astro'
import { Track } from '../lib/metrics'
import { IDEAL_STORAGE, LOSS_AWARE_EXAMPLE, PanelMode, PowerStats, PowerSystem, StorageModel, batteryRequirement, isIdealStorage, storageModel } from '../lib/power'
import { fmtDate, fmtHours, prep, useCanvas } from '../lib/ui'
import { ThermalPanel } from './ThermalPanel'

interface Props {
  eph: Ephemeris
  track: Track
  i0: number
  len: number
  cursor: number // hours since landing
  power: PowerSystem
  stats: PowerStats // computed with the radio's draw during contact (missionBudget)
  radioW: number // DC draw of the radio while it transmits
  onChange: (p: PowerSystem) => void
}

const kwh = (wh: number) => (Math.abs(wh) >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${Math.round(wh)} Wh`)

export function PowerPanel({ eph, track, i0, len, cursor, power, stats: st, radioW, onChange }: Props) {
  const radioWh = st.extraWh
  const model = storageModel(power)
  const ideal = isIdealStorage(power)
  // the last sunset before the battery runs flat: how long the battery carried the lander into the dark
  const sunsetBeforeEmpty = useMemo(() => {
    if (st.emptyAt === null) return null
    const a = Math.round(i0)
    for (let k = Math.floor(st.emptyAt); k > 0; k--) if (track.sunFrac[a + k] <= 0 && track.sunFrac[a + k - 1] > 0) return k
    return null
  }, [st.emptyAt, track, i0])
  const { ref, w, h } = useCanvas(() => 90)

  useEffect(() => {
    const ctx = prep(ref.current, w, h)
    if (!ctx) return
    const n = st.series.length
    const max = Math.max((power.loadW + radioW + (power.thermal ? 0 : model.darkHeaterW)) * 1.3, ...st.load, st.peakW * 1.05, 1)
    const X = (i: number) => (i / n) * w
    const Y = (v: number) => h - 4 - (v / max) * (h - 12)
    // area under generation, coloured by surplus / deficit
    for (let i = 0; i < n; i++) {
      const v = st.series[i]
      ctx.fillStyle = v >= st.load[i] ? 'rgba(255,194,75,0.85)' : 'rgba(255,194,75,0.35)'
      ctx.fillRect(X(i), Y(v), Math.max(1, w / n + 0.5), h - 4 - Y(v))
    }
    // battery charge, 0 at the bottom to full capacity at the top
    if (st.usableWh > 0) {
      ctx.strokeStyle = '#49d6a4'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const y = h - 4 - (st.soc[i] / st.usableWh) * (h - 12)
        if (i) ctx.lineTo(X(i + 1), y)
        else ctx.moveTo(0, y)
      }
      ctx.stroke()
      ctx.lineWidth = 1
      if (st.emptyAt !== null) {
        ctx.fillStyle = '#ff6b5b'
        ctx.beginPath()
        ctx.arc(X(st.emptyAt), h - 4, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.strokeStyle = '#ff6b5b'
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    // the load steps up while the radio transmits
    ctx.moveTo(0, Y(st.load[0] ?? power.loadW))
    for (let i = 0; i < n; i++) {
      ctx.lineTo(X(i), Y(st.load[i]))
      ctx.lineTo(X(i + 1), Y(st.load[i]))
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = '10.5px IBM Plex Mono, monospace'
    // labels on a dark tag so they stay readable over the generation area and the lines
    const tag = (text: string, x: number, y: number, color: string) => {
      const tw = ctx.measureText(text).width
      ctx.fillStyle = 'rgba(6,8,12,0.88)'
      ctx.fillRect(x - 3, y - 11, tw + 6, 15)
      ctx.fillStyle = color
      ctx.fillText(text, x, y)
    }
    tag(`base ${power.loadW} W${radioWh > 0 ? ` + radio ${Math.round(radioW)} W in contact` : ''}${power.thermal ? ' + equipment heater' : model.darkHeaterW > 0 ? ` + heater ${model.darkHeaterW} W in darkness` : ''}`, 6, Math.max(14, Y(power.loadW + (radioWh > 0 ? radioW : 0)) - 5), '#ff9a8e')
    const top = `${Math.round(max)} W`
    tag(top, w - 7 - ctx.measureText(top).width, 14, '#8a94a6')
    const cx = (cursor / len) * w
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, h)
    ctx.stroke()
    ctx.lineWidth = 1
  }, [ref, w, h, st, power.loadW, power.batteryWh, radioW, radioWh, cursor, len])

  const set = (patch: Partial<PowerSystem>) => onChange({ ...power, ...patch })
  const setStorage = (patch: Partial<StorageModel>) => {
    const next = { ...model, ...patch }
    next.initialSoc = Math.max(1 - next.maxDod, next.initialSoc)
    set({ storage: next })
  }
  const fractions: [keyof Pick<StorageModel, 'maxDod' | 'initialSoc' | 'chargeEfficiency' | 'dischargeEfficiency' | 'arrayFactor'>, string][] = [
    ['maxDod', 'Allowed depth of discharge'], ['initialSoc', 'Charge at touchdown'],
    ['chargeEfficiency', 'Charge efficiency'], ['dischargeEfficiency', 'Discharge efficiency'], ['arrayFactor', 'Retained array output'],
  ]
  const modes: [PanelMode, string, string][] = [
    ['tracking', 'Vertical, Sun-tracking', 'A vertical array that turns to face the Sun’s azimuth, as on polar rovers and NASA’s vertical solar array concepts'],
    ['fixed', 'Vertical, fixed', 'A vertical array facing one direction'],
    ['horizontal', 'Flat on the deck', 'A horizontal array: at the pole the Sun is only a degree or two high'],
  ]
  return (
    <div>
      <div className="kpis system-kpis">
        <div className={`kpi ${st.shortfallAt === null ? 'pass' : 'fail'}`}>
          <div className="label">First power shortfall</div>
          <div className="value" style={{ fontSize: 22 }}>{st.shortfallAt === null ? 'none' : `T+${fmtHours(st.shortfallAt)}`}</div>
          <div className="sub" title={st.shortfallAt === null ? undefined : `${fmtDate(eph.startUnix + (Math.round(i0) + st.shortfallAt) * eph.stepS)} · ${fmtHours(st.unpoweredH)} with unmet demand in the window`}>
            {st.shortfallAt === null
              ? `${kwh(st.usableWh)} usable storage meets the full window`
              : st.dischargeLimitedH > 0 ? `Discharge power insufficient for ${fmtHours(st.dischargeLimitedH)}` : `${sunsetBeforeEmpty !== null ? `${fmtHours(st.shortfallAt - sunsetBeforeEmpty)} after sunset · ` : ''}${fmtDate(eph.startUnix + (Math.round(i0) + st.shortfallAt) * eph.stepS)}`}
          </div>
        </div>
        <div className="kpi"><div className="label">Energy generated</div><div className="value sun" style={{ fontSize: 22 }}>{kwh(st.energyWh)}</div><div className="sub">mean {Math.round(st.meanW)} W{st.loadWh > 0 ? ` (${((100 * st.energyWh) / st.loadWh).toFixed(0)}% of total load)` : ''} · peak {Math.round(st.peakW)} W</div></div>
        <div className={`kpi ${st.balanceWh < 0 ? 'fail' : st.shortfallAt === null ? 'pass' : ''}`}><div className="label">Energy balance</div><div className="value" style={{ fontSize: 22 }}>{st.balanceWh >= 0 ? '+' : ''}{kwh(st.balanceWh)}</div><div className="sub">{st.balanceWh >= 0 && st.shortfallAt !== null ? 'Surplus overall; storage runs out before sunlight returns.' : <>after {kwh(st.loadWh)} of load{radioWh > 0 ? `, ${kwh(radioWh)} of it the radio` : ''}</>}</div></div>
        <div className="kpi"><div className="label">Rated battery needed</div><div className="value" style={{ fontSize: 22 }}>{Number.isFinite(st.batteryNeededWh) ? kwh(st.batteryNeededWh) : 'Not feasible'}</div><div className="sub">{st.sizingReason === 'discharge-limit' ? 'Increase discharge power or reduce demand' : st.sizingReason === 'initial-charge' ? 'More initial charge or earlier sunlight needed' : `with selected losses and limits; ${fmtHours(st.hoursBelowLoad)} below load`}</div></div>
      </div>
      <div className="canvasbox" style={{ marginTop: 12 }}>
        <canvas ref={ref} role="img" aria-label="Electrical power from the solar array through the mission window, against the load" />
      </div>
      <div className="legend" style={{ padding: '8px 2px 0' }}>
        <span><i style={{ background: 'rgba(255,194,75,0.85)' }} />array output above the load</span>
        <span><i style={{ background: 'rgba(255,194,75,0.35)' }} />below the load</span>
        <span><i style={{ background: '#ff6b5b', height: 2, verticalAlign: 3 }} />load{radioWh > 0 ? ' (higher while the radio transmits)' : ''}</span>
        {power.batteryWh > 0 && <span><i style={{ background: '#49d6a4', height: 2, verticalAlign: 3 }} />usable charge (protected floor at the bottom){st.emptyAt !== null && <>, <b style={{ color: '#ff6b5b' }}>●</b> reaches the floor</>}</span>}
      </div>
      <h3 className="system-inputs-h">Hardware and assumptions</h3>
      <div className="controls" style={{ padding: '0 0 12px' }}>
        <div className="field">
          <span>Solar array</span>
          <div className="seg">
            {modes.map(([m, label, tip]) => (
              <button key={m} aria-pressed={power.mode === m} title={tip} onClick={() => set({ mode: m })}>{label}</button>
            ))}
          </div>
        </div>
        {power.mode === 'fixed' && (
          <label className="field"><span>Facing azimuth</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" value={power.facingAz} onChange={(e) => set({ facingAz: ((Number(e.target.value) % 360) + 360) % 360 })} /><span className="muted">°</span></span>
          </label>
        )}
        <label className="field"><span>Array area</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={0.1} step={0.1} value={power.areaM2} onChange={(e) => set({ areaM2: Math.max(0.1, Number(e.target.value) || 0.1) })} /><span className="muted">m²</span></span>
        </label>
        <label className="field"><span>Efficiency</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={1} max={45} value={Math.round(power.efficiency * 100)} onChange={(e) => set({ efficiency: Math.min(0.45, Math.max(0.01, (Number(e.target.value) || 1) / 100)) })} /><span className="muted">%</span></span>
        </label>
        <label className="field" title="Continuous load excluding the transmitter. The radio's DC draw is added during contact."><span>Base load</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={0} value={power.loadW} onChange={(e) => set({ loadW: Math.max(0, Number(e.target.value) || 0) })} /><span className="muted">W</span></span>
        </label>
        <label className="field"><span>Battery capacity</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={0} step={100} value={power.batteryWh} onChange={(e) => set({ batteryWh: Math.max(0, Number(e.target.value) || 0) })} /><span className="muted">Wh</span></span>
        </label>
      </div>
      <details className="power-assumptions">
        <summary>Battery, losses and heating · {ideal ? 'ideal baseline' : 'custom assumptions'}</summary>
        <p>Set the rated battery capacity above, then the fraction you can use and the charge available at touchdown. Efficiencies apply only when energy enters or leaves storage.</p>
        <div className="power-model-actions">
          <button className="btn sm" onClick={() => set({ storage: { ...LOSS_AWARE_EXAMPLE } })}>Use loss-aware example</button>
          <button className="btn sm ghost" onClick={() => set({ storage: { ...IDEAL_STORAGE } })}>Use ideal baseline</button>
          <span className="muted">The example values are editable assumptions, not specifications for a NASA vehicle.</span>
        </div>
        <div className="power-assumption-fields">
          {fractions.map(([key, label]) => <label className="field" key={key}><span>{label}</span>
            <span><input className="input num" aria-label={label} type="number" min={key === 'initialSoc' ? Math.round((1 - model.maxDod) * 100) : key === 'arrayFactor' ? 0 : 1} max={100} step={1}
              value={Math.round(model[key] * 100)} onChange={e => setStorage({ [key]: Math.max(key === 'initialSoc' || key === 'arrayFactor' ? 0 : 0.01, Math.min(1, Number(e.target.value) / 100)) })} /> %</span>
          </label>)}
          {(['maxChargeW', 'maxDischargeW'] as const).map(key => <label className="field" key={key}><span>{key === 'maxChargeW' ? 'Maximum charging power' : 'Maximum discharge power'}</span>
            <span><input className="input num" aria-label={key === 'maxChargeW' ? 'Maximum charging power' : 'Maximum discharge power'} type="number" min={0} placeholder="No limit" value={model[key] ?? ''}
              onChange={e => setStorage({ [key]: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /> W</span>
          </label>)}
          <label className="field"><span>Heater load in darkness</span><span><input className="input num" aria-label="Heater load in darkness" type="number" min={0} disabled={!!power.thermal} value={model.darkHeaterW} onChange={e => setStorage({ darkHeaterW: Math.max(0, Number(e.target.value)) })} /> W</span></label>
        </div>
        <p className="model-note">{kwh(st.usableWh)} usable above the protected floor; {kwh(st.initialStoredWh)} available at touchdown. Empty power limits mean uncapped; zero means disabled. {power.thermal ? 'The equipment scenario below replaces darkness-only heating.' : 'This heater input applies only when no direct Sun is visible.'} Retained output is a constant derating assumption; temperature-dependent array efficiency and dust evolution are not calculated.</p>
        <p className="muted">Method context: <a href="https://ntrs.nasa.gov/citations/20200001622" target="_blank" rel="noreferrer">NASA solar-power sizing study</a> · <a href="https://ntrs.nasa.gov/citations/20250002164" target="_blank" rel="noreferrer">Lunar surface power and thermal design</a></p>
      </details>
      <ThermalPanel power={power} stats={st} cursor={cursor} len={len} onChange={onChange} />
      <p className="model-note">{ideal ? `Ideal storage baseline: full battery, all capacity usable, no storage losses or power limits.${power.thermal ? ' Equipment heater demand is included.' : ' No heater demand.'}` : `Custom model: ${Math.round(model.initialSoc * 100)}% charge at touchdown; ${Math.round(model.maxDod * 100)}% usable depth; ${Math.round(model.chargeEfficiency * 100)}% / ${Math.round(model.dischargeEfficiency * 100)}% charge / discharge efficiency; ${power.thermal ? 'equipment heater replaces darkness-only heating' : `${model.darkHeaterW} W in darkness`}.`}</p>
      {(!ideal || st.heaterWh > 0 || st.unservedWh > 0) && <p className="model-note">Storage losses {kwh(st.storageLossWh)} · curtailed surplus {kwh(st.curtailedWh)} · heater demand {kwh(st.heaterWh)} · unmet demand {kwh(st.unservedWh)}.</p>}
      <details className="model-details"><summary>Power model</summary>
        <p>Power = 1361 W/m² × (1 au / Sun distance)² × visible solar disk × cosine of incidence × area × efficiency × retained output, sampled hourly. Load includes the transmitter’s DC draw during contact and the selected heater model. Storage charges from surplus up to its input power limit, and discharges up to its bus-output limit. No load shedding is assumed; communication stops whenever the full combined bus demand cannot be met.</p>
        <p>Minimum rated capacity: {batteryRequirement(st.batteryNeededWh)}. Sizing includes charge rate, efficiencies, protected capacity and initial charge{power.thermal ? ', using the full-supply equipment-heater trajectory' : ''}. A larger battery cannot cure insufficient discharge power or an initial deficit when no usable charge is available. Equipment temperatures are evaluated only when the optional scenario is enabled; cell chemistry, temperature-dependent battery properties, aging, self-shadowing and hardware qualification remain outside this model.</p>
      </details>
    </div>
  )
}
