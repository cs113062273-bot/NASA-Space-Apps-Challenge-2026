import { useEffect } from 'react'
import { Ephemeris } from '../lib/astro'
import { BANDS, Band, DISH_EFFICIENCY, DSN_MIN_EL_DEG, LINK_LOSSES_DB, MARGIN_DB, MissionBudget, RADIO_DC_PER_RF_W, Radio, REQUIRED_EBN0_DB, antennaGain, dishGainDbi, fmtBytes, fmtRate, gOverT } from '../lib/link'
import { Track } from '../lib/metrics'
import { fmtDate, fmtHours, prep, useCanvas } from '../lib/ui'
import { CommOperationsPanel } from './CommOperationsPanel'
import { operationsFor } from '../lib/communications'
import { DEFAULT_TRAFFIC } from '../lib/communications'
import { exampleRelayPlan } from '../lib/relay'
import { RelayPanel } from './RelayPanel'
import { RelayReferenceChooser } from './RelayReferenceChooser'
import type { RelayReferenceCase } from '../lib/relay-reference'

interface Props {
  eph: Ephemeris
  track: Track
  i0: number
  len: number
  cursor: number // hours since landing
  radio: Radio
  budget: MissionBudget // power and downlink computed together
  onChange: (r: Radio) => void
  onReference: (c:RelayReferenceCase)=>string|null
}

// fixed-gain antennas keep their gain on either band; a dish's gain follows the wavelength
const ANTENNAS: { label: string; patch: Partial<Radio>; tip: string }[] = [
  { label: 'Omni', patch: { gainDbi: 0, dishM: undefined }, tip: 'A low-gain antenna that needs no pointing · 0 dBi' },
  { label: 'Patch', patch: { gainDbi: 12, dishM: undefined }, tip: 'A medium-gain patch or helix, roughly pointed at Earth · 12 dBi' },
  { label: '0.5 m dish', patch: { dishM: 0.5 }, tip: `A small steerable dish, ${Math.round(DISH_EFFICIENCY * 100)}% efficient: ${dishGainDbi(0.5, 'X').toFixed(1)} dBi at X band, ${dishGainDbi(0.5, 'S').toFixed(1)} dBi at S band` },
]

const fmtPower = (w: number) => `${w.toFixed(w < 10 ? 1 : 0)} W`

export function CommPanel({ eph, track, i0, len, cursor, radio, budget, onChange,onReference }: Props) {
  const st = budget.link
  const { ref, w, h } = useCanvas(() => 74)

  useEffect(() => {
    const ctx = prep(ref.current, w, h)
    if (!ctx) return
    const n = st.rate.length
    const X = (i: number) => (i / n) * w
    const max = Math.max(...st.rate, 1)
    const top = 14
    const base = h - 4
    for (let i = 0; i < n; i++) {
      if (st.state[i] === 2) {
        // full colour while the radio has power, dim while the battery is flat
        const on = budget.power.metFrac[i]
        const y = base - (0.55 + (0.45 * st.rate[i]) / max) * (base - top)
        ctx.fillStyle = 'rgba(90,169,255,0.22)'
        ctx.fillRect(X(i), y, Math.max(1, w / n + 0.5), base - y)
        if (on > 0) {
          ctx.fillStyle = 'rgba(90,169,255,0.85)'
          ctx.fillRect(X(i), y, Math.max(1, (w / n) * on + 0.5), base - y)
        }
      } else if (st.state[i] >= 1) {
        ctx.fillStyle = st.state[i] >= 3 ? 'rgba(215,157,41,0.45)' : 'rgba(90,169,255,0.18)'
        ctx.fillRect(X(i), base - 10, Math.max(1, w / n + 0.5), 10)
      }
    }
    // data home so far with the power the radio actually had, 0 at the bottom to the link limit at the top
    if (st.bits > 0) {
      ctx.strokeStyle = '#49d6a4'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      let sum = 0
      ctx.moveTo(0, base)
      for (let i = 0; i < n; i++) {
        sum += budget.delivery ? budget.delivery.delivered[i] : st.rate[i] * eph.stepS * budget.power.metFrac[i]
        ctx.lineTo(X(i + 1), base - (sum / st.bits) * (base - top))
      }
      ctx.stroke()
      ctx.lineWidth = 1
    }
    const cx = (cursor / len) * w
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, h)
    ctx.stroke()
    ctx.lineWidth = 1
  }, [ref, w, h, st, budget, cursor, len, eph.stepS])

  const set = (patch: Partial<Radio>) => onChange({ ...radio, ...patch })
  const noDsn = !st.stationGeometry
  const maxClear = Math.max(...track.earthClear.subarray(Math.round(i0), Math.round(i0 + len)))
  const references=<RelayReferenceChooser active={radio.relay?.reference} onUse={onReference}/>
  if(radio.relay && budget.relay) return <div>{references}<RelayPanel radio={radio} budget={budget} startUnix={eph.startUnix+Math.round(i0)*eph.stepS} onChange={onChange}/></div>
  return (
    <div>
      {references}
      <div className="relay-route"><strong>Direct-to-Earth route</strong><button className="btn sm" onClick={()=>set({relay:exampleRelayPlan(eph.startUnix+Math.round(i0)*eph.stepS),operations:{...operationsFor(radio),traffic:operationsFor(radio).traffic??{...DEFAULT_TRAFFIC}}})}>Explore assumed relay service</button></div>
      <div className="controls" style={{ padding: '0 0 12px' }}>
        <div className="field">
          <span>Band</span>
          <div className="seg">
            {(['S', 'X'] as Band[]).map((b) => (
              <button key={b} aria-pressed={radio.band === b} title={`${BANDS[b].mhz} MHz downlink`} onClick={() => set({ band: b })}>{b} band</button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Lander antenna</span>
          <div className="seg">
            {ANTENNAS.map((a) => (
              <button key={a.label} aria-pressed={a.patch.dishM ? radio.dishM === a.patch.dishM : !radio.dishM && radio.gainDbi === a.patch.gainDbi} title={a.tip} onClick={() => set(a.patch)}>{a.label}</button>
            ))}
          </div>
        </div>
        <label className="field" title={radio.dishM ? `${radio.dishM} m dish at ${BANDS[radio.band].mhz} MHz, ${Math.round(DISH_EFFICIENCY * 100)}% aperture efficiency; type a gain to use a fixed-gain antenna instead` : 'Antenna gain toward Earth'}><span>Gain</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={-5} max={45} step={0.1} value={Math.round(antennaGain(radio) * 10) / 10} onChange={(e) => set({ dishM: undefined, gainDbi: Math.min(45, Math.max(-5, Number(e.target.value) || 0)) })} /><span className="muted">dBi</span></span>
        </label>
        <label className="field" title={`RF output. While it transmits the radio draws ${RADIO_DC_PER_RF_W.toFixed(1)} W from the bus per RF watt, added to the Power panel's load`}><span>Transmitter</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={0.1} step={1} value={radio.txW} onChange={(e) => set({ txW: Math.min(500, Math.max(0.1, Number(e.target.value) || 0.1)) })} /><span className="muted">W</span></span>
        </label>
        <label className="field" title="The radio's own top data rate, set by its modem and the bandwidth it is allowed; 0 = no cap, the link budget alone"><span>Max rate</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input num" type="number" min={0} step={100} value={radio.maxKbps ?? 0} onChange={(e) => { const v = Math.max(0, Number(e.target.value) || 0); set({ maxKbps: v || undefined }) }} /><span className="muted">kbit/s</span></span>
        </label>
      </div>
      <div className="kpis system-kpis">
        <div className="kpi"><div className="label">Data rate in contact</div><div className="value earth" style={{ fontSize: 22 }}>{st.contactH ? fmtRate(st.meanRate) : '—'}</div><div className="sub">to one DSN 34 m antenna, {MARGIN_DB} dB margin</div></div>
        <div className={`kpi ${budget.returnedBits > 0 ? 'pass' : 'fail'}`} title="With payload traffic enabled this is modeled delivery; otherwise it is powered link capacity. The battery and array carry the load plus reserved radio power.">
          <div className="label">{budget.delivery ? 'Payload data home' : 'Data home, with power'}</div>
          <div className="value" style={{ fontSize: 22 }}>{budget.returnedBits > 0 ? fmtBytes(budget.returnedBits) : 'none'}</div>
          <div className="sub">{st.contactH ? <>link limit {fmtBytes(st.bits)}{st.poweredContactH < st.contactH - 0.05 ? ` · full power unavailable for ${fmtHours(st.contactH - st.poweredContactH)} of ${fmtHours(st.contactH)} contact` : ` · ${fmtHours(st.contactH)} of contact, all powered`}</> : 'no contact in the window'}</div>
        </div>
        <div className={`kpi ${st.longestPoweredGapH > 72 ? 'fail' : ''}`}>
          <div className="label">Longest silence, with power</div>
          <div className="value" style={{ fontSize: 22 }}>{st.poweredGapOpenEnded ? '≥' : ''}{fmtHours(st.longestPoweredGapH)}</div>
          <div className="sub">{st.longestPoweredGapH ? `from ${fmtDate(eph.startUnix + (Math.round(i0) + st.longestPoweredGapStart) * eph.stepS)}${st.poweredGapOpenEnded ? ' · reaches the window edge' : ''}` : 'always powered and in contact'}
            {st.longestPoweredGapH > st.longestGapH + 0.05 && <> · without power loss: {st.gapOpenEnded ? '≥' : ''}{fmtHours(st.longestGapH)}</>}
          </div>
        </div>
        <div className="kpi" title={`G/T of a 34 m antenna: ${gOverT(radio.band, false).toFixed(1)} dB/K on cold sky, ${gOverT(radio.band, true).toFixed(1)} dB/K on the Moon`}>
          <div className="label">The Moon’s own radio glow</div>
          <div className="value" style={{ fontSize: 22 }}>−{st.moonPenaltyDb.toFixed(1)} dB</div>
          <div className="sub">it adds {BANDS[radio.band].tMoonK} K to the antenna: the rate drops {Math.round(10 ** (st.moonPenaltyDb / 10))}×</div>
        </div>
      </div>
      {!st.contactH && (
        <div className="callout bad" style={{ marginTop: 12 }}>
          {st.excludedStationH + st.unscheduledH > 0 ? 'Geometric contact exists, but your complex selection or allocation plan excludes every contact. Change the contact plan below.' : st.stationGeometry ? 'No reference antenna clears both the lunar terrain and its receiving mask during this stay. Try another site/date or evaluate a relay separately.' : st.state.some((v) => v === 1)
            ? 'Earth rises here, but never while a DSN complex sees the Moon in this window.'
            : maxClear >= 0
              ? <>Earth clears the skyline by at most {maxClear.toFixed(1)}°, below the {track.earthMinClear}° margin selected. There is no contact meeting that margin in this window.</>
              : <>Earth stays below the skyline for the whole window, so there is no direct link home. Landers here need a relay in lunar orbit, as Chang’e 4 and 6 used Queqiao and Queqiao-2.</>}
        </div>
      )}
      <div className="canvasbox" style={{ marginTop: 12, display: st.contactH ? undefined : 'none' }}>
        <canvas ref={ref} role="img" aria-label="Downlink data rate through the mission window and the data sent home so far" />
      </div>
      <div className="legend" style={{ padding: '8px 2px 0', display: st.contactH ? undefined : 'none' }}>
        <span><i style={{ background: 'rgba(90,169,255,0.85)' }} />contact with power (bar height: data rate)</span>
        {st.poweredContactH < st.contactH - 0.05 && <span><i style={{ background: 'rgba(90,169,255,0.22)' }} />contact, but full bus power is unavailable</span>}
        <span><i style={{ background: 'rgba(90,169,255,0.25)' }} />lunar path clears, receiving mask blocks contact</span>
        {st.excludedStationH + st.unscheduledH > 0 && <span><i style={{ background: 'rgba(215,157,41,0.45)' }} />excluded complex or outside planned hours</span>}
        <span><i style={{ background: '#49d6a4', height: 2, verticalAlign: 3 }} />data home so far, with power (top: link limit {st.contactH ? fmtBytes(st.bits) : '0'})</span>
      </div>
      <p className="model-note">{operationsFor(radio).schedule === 'all' ? 'Capacity upper bounds assume continuous DSN tracking.' : 'Capacity and payload delivery assume your planned antenna allocation is available.'} Weather is omitted. Data stops when power fails.{noDsn && <span className="bad"> Reference-station data unavailable: Earth-centre estimate.</span>}</p>

      <CommOperationsPanel radio={radio} budget={budget} landingUnix={eph.startUnix + Math.round(i0) * eph.stepS} onChange={onChange} />
      <details className="model-details"><summary>Link model and sources</summary>
      {eph.stations && eph.startUnix + (i0 + len) * eph.stepS > eph.stations.orientation.recent_kernel_until_unix && <p className="model-note">This stay reaches the low-accuracy Earth-rotation prediction interval (from 30 Jan 2027). Decision/search sensitivity runs raise the receiving mask by 0.35° as well as testing lunar terrain.</p>}
        <p>Contact requires the same reference antenna—DSS-24 (Goldstone), DSS-54 (Madrid) or DSS-34 (Canberra)—to clear lunar terrain{track.earthMinClear ? ` by ${track.earthMinClear}°` : ''} and receive the lander at ≥{DSN_MIN_EL_DEG}° elevation. Targets include transmission light time and stellar aberration. The best eligible single link is used; capacities are never added.</p>
        <p>Station positions and drift: <a href="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/stations/earthstns_itrf93_260814.cmt" target="_blank" rel="noreferrer">NAIF ITRF93 station kernel</a>. Earth rotation uses a recent kernel through 29 Jan 2027, then <a href="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/earth_1962_260806_2126_combined.cmt" target="_blank" rel="noreferrer">low-accuracy long-term prediction</a>. Raised-skyline decision/search runs also raise the receiving mask by 0.001° in the recent interval or 0.35° afterwards, and add 0.00002° / 0.006° to lunar aim clearance. These are sensitivity inputs, not confidence bounds. Hourly samples can miss short contacts; local azimuth masks and cable wraps are omitted.</p>
        <p>Rate = 10<sup>(C/N₀ − {REQUIRED_EBN0_DB} − {MARGIN_DB})/10</sup> bit/s, with C/N₀ in dB-Hz. The budget uses transmitter power, lander gain, free-space loss at the hourly Earth distance, DSN 34 m G/T, Boltzmann’s constant and {LINK_LOSSES_DB} dB of other losses. The thresholds are {REQUIRED_EBN0_DB} dB E<sub>b</sub>/N<sub>0</sub> and {MARGIN_DB} dB margin.</p>
        <p>Ground antenna parameters: DSN 810-005 module 104. Lunar noise: Morabito 2006, IPN PR 42-166, disk-centred measurements on a 34 m antenna; these slightly overstate noise near the lunar limb.</p>
        <p>Transmitter DC draw: {fmtPower(budget.radioW)} ({RADIO_DC_PER_RF_W.toFixed(1)} W per RF watt), included in the power budget. {radio.maxKbps ? `Radio cap: ${fmtRate(radio.maxKbps * 1000)}.` : 'No modem rate cap is set; real hardware or allocated bandwidth may limit the rate.'}</p>
      </details>
    </div>
  )
}
