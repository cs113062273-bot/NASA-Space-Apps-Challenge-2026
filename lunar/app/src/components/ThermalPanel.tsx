import { PowerStats, PowerSystem } from '../lib/power'
import { THERMAL_EXAMPLE, ThermalModel, thermalPass } from '../lib/thermal'
import { fmtHours } from '../lib/ui'

const fields: { title: string; rows: [keyof ThermalModel, string, string, number, number, number][] }[] = [
  { title: 'Temperature limits', rows: [['initialK', 'Initial equipment temperature', 'K', 3, 1000, 1], ['minK', 'Minimum equipment temperature', 'K', 3, 999, 1], ['maxK', 'Maximum equipment temperature', 'K', 4, 1000, 1], ['setpointK', 'Heater setpoint', 'K', 3, 1000, 1]] },
  { title: 'Equipment and heater', rows: [['heatCapacityJPerK', 'Equipment heat capacity', 'J/K', 1000, 1e9, 1000], ['maxHeaterW', 'Maximum thermal heater power', 'W', 0, 100000, 10], ['wasteHeatFraction', 'Bus waste heat retained in node', 'fraction', 0, 1, 0.05]] },
  { title: 'Optical surfaces', rows: [['solarAbsorptivity', 'Solar absorptivity', 'fraction', 0, 1, 0.05], ['solarAreaM2', 'Effective Sun-facing projected area', 'm²', 0, 100, 0.05], ['emissivity', 'Thermal emissivity', 'fraction', 0, 1, 0.05], ['radiatingAreaM2', 'Radiating area', 'm²', 0, 100, 0.1]] },
  { title: 'Fixed boundary scenario', rows: [['groundViewFactor', 'Ground IR view factor', 'fraction', 0, 1, 0.05], ['groundK', 'Ground IR boundary temperature', 'K', 3, 1000, 10], ['conductanceWPerK', 'Mounting thermal conductance', 'W/K', 0, 1000, 0.1], ['baseK', 'Mounting boundary temperature', 'K', 3, 1000, 10]] },
]

export function ThermalPanel({ power, stats, cursor, len, onChange }: { power: PowerSystem; stats: PowerStats; cursor: number; len: number; onChange: (p: PowerSystem) => void }) {
  const m = power.thermal, t = stats.thermal
  const set = (key: keyof ThermalModel, value: number) => {
    if (!m) return
    const next = { ...m, [key]: value }
    if (key === 'minK') next.minK = Math.min(next.minK, next.maxK - 1)
    if (key === 'maxK') next.maxK = Math.max(next.maxK, next.minK + 1)
    next.setpointK = Math.max(next.minK, Math.min(next.maxK, next.setpointK))
    onChange({ ...power, thermal: next })
  }
  return <details className="thermal-assumptions">
    <summary>Equipment temperature · {m ? thermalPass(stats) ? 'within selected limits' : 'outside selected limits' : 'not evaluated'}</summary>
    <p>Test one equipment node with your heat capacity, surfaces, boundaries and temperature limits. Heater demand shares the array and battery with the radio. These editable example values are not NASA vehicle specifications.</p>
    <label className="thermal-enable"><input type="checkbox" checked={!!m} onChange={e => onChange({ ...power, thermal: e.target.checked ? { ...THERMAL_EXAMPLE } : undefined })} /> Enable equipment temperature scenario</label>
    {m && <>
      <div className="thermal-field-groups">{fields.map(group => <fieldset key={group.title}><legend>{group.title}</legend>
        <div className="power-assumption-fields">{group.rows.map(([key, label, unit, low, high, step]) => <label className="field" key={key}>
          <span>{label}</span><span><input className="input num" type="number" aria-label={label} min={low} max={high} step={step} value={m[key]}
            onChange={e => set(key, Math.max(low, Math.min(high, Number(e.target.value) || low)))} /> {unit}</span>
        </label>)}</div>
      </fieldset>)}</div>
      <p className="model-note">Boundary temperatures stay fixed throughout the stay. They are your test scenario, not date-specific Diviner measurements or a regolith forecast. Effective solar area is the projected area facing the Sun whenever it is visible. View factor is an assumed geometric input.</p>
      {t && <>
        <div className={`callout ${thermalPass(stats) ? '' : 'bad'}`} role="status">
          <strong>{thermalPass(stats) ? 'Equipment node stays inside the selected limits.' : 'Equipment temperature misses a selected limit.'}</strong>
          {' '}{t.minK.toFixed(1)}–{t.maxK.toFixed(1)} K ({(t.minK - 273.15).toFixed(1)}–{(t.maxK - 273.15).toFixed(1)} °C); limits {m.minK}–{m.maxK} K.
          {t.firstBreachH !== null && <> First breach T+{fmtHours(t.firstBreachH)}; cold {fmtHours(t.coldH)}, hot {fmtHours(t.hotH)}.</>}
        </div>
        <TemperaturePlot actual={t.temperatureK} full={t.fullPowerK} min={m.minK} max={m.maxK} cursor={cursor} len={len} />
        <p className="model-note">Requested heater energy {stats.heaterWh.toFixed(1)} Wh; delivered {Array.from(t.deliveredHeaterWh).reduce((a,b) => a + b, 0).toFixed(1)} Wh. Full-supply temperature scenario {t.fullPowerPass ? 'holds' : 'also fails'}; {t.fullPowerPass ? 'storage sizing uses that controlled demand and verifies any remedy again.' : 'extra battery capacity alone does not resolve that temperature failure.'}</p>
      </>}
      <p className="model-note">This replaces the darkness-only heater input. Both nominal and raised-skyline decision/search runs must meet these limits. Annual surface-rule counts do not include equipment temperature.</p>
      <details className="model-details"><summary>Thermal method, assumptions and sources</summary>
        <p>C dT/dt = absorbed sunlight + powered internal dissipation + powered heater − thermal radiation − mounting conduction. Radiation uses εσA[T⁴ − F Tground⁴ − (1−F) Tspace⁴], with a 3 K space boundary. Heater commands update hourly and are held constant. Implicit heat-balance steps are capped at 5 min and shrink automatically when one-step and two-half-step temperatures disagree. The displayed trajectory samples hour boundaries; limit-breach times use the integration steps.</p>
        <p>Outgoing RF power is subtracted from radio DC demand before applying the retained waste-heat fraction. Base load is assumed to dissipate inside the equipment; represent unmodeled external work through a lower retained fraction. Only full-bus powered intervals credit internal dissipation and heater output. Partial-bus heating, load shedding, reflected sunlight, mutual terrain heating, attitude/self-shadowing, multi-component gradients, temperature-dependent storage/solar efficiency and active cooling are omitted. A passing scenario is not a flight survival qualification.</p>
        <p><a href="https://ntrs.nasa.gov/citations/20220006584" target="_blank" rel="noreferrer">NASA thermal guidebook, v5.1</a> explains radiation, view factors and model correlation. <a href="https://www.diviner.ucla.edu/data" target="_blank" rel="noreferrer">LRO Diviner surface datasets</a> describe the external environment; they do not supply this equipment model’s parameters. <a href="https://arxiv.org/abs/1711.00977" target="_blank" rel="noreferrer">Hayne et al. (2017)</a> shows why a regolith forecast requires a separate subsurface model.</p>
      </details>
    </>}
  </details>
}

function TemperaturePlot({ actual, full, min, max, cursor, len }: { actual: Float32Array; full: Float32Array; min: number; max: number; cursor: number; len: number }) {
  const lo = Math.min(min, ...actual, ...full) - 5, hi = Math.max(max, ...actual, ...full) + 5
  const y = (v: number) => 140 - 120 * (v - lo) / (hi - lo)
  const path = (a: Float32Array) => Array.from(a, (v, i) => `${i ? 'L' : 'M'}${40 + 740 * i / (a.length - 1)},${y(v)}`).join(' ')
  return <div className="temperature-plot">
    <svg viewBox="0 0 800 170" role="img" aria-label="Equipment temperature through the stay: actual powered node and full-supply reference">
      <path d={`M40,${y(min)}H780M40,${y(max)}H780`} fill="none" stroke="var(--bad)" strokeDasharray="4 4" />
      <text x="2" y={y(max) + 4}>{max} K</text><text x="2" y={y(min) + 4}>{min} K</text>
      <path d={path(full)} fill="none" stroke="var(--earth)" strokeWidth="1.5" strokeDasharray="5 4" />
      <path d={path(actual)} fill="none" stroke="var(--text)" strokeWidth="2" />
      <path d={`M${40 + 740 * cursor / len},14V145`} stroke="var(--sun)" />
      <text x="40" y="163">Touchdown</text><text x="780" y="163" textAnchor="end">T+{fmtHours(len)}</text>
    </svg>
    <p className="model-note">Solid: modeled equipment · dashed: full-supply reference · red: selected limits</p>
  </div>
}
