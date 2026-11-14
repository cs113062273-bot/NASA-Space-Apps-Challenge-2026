import { useMemo, useState } from 'react'
import { Ephemeris, timeOf } from '../lib/astro'
import { SiteRecord } from '../lib/data'
import { Track } from '../lib/metrics'
import { windows } from '../lib/events'
import { fmtDate, fmtHours, fmtLat, fmtLon } from '../lib/ui'
import { MissionBudget, Radio } from '../lib/link'
import { PowerSystem } from '../lib/power'
import { hourlyAnalysisCsv } from '../lib/export'
import type {TerrainPointScreen} from '../lib/terrain-constraint'

interface Props {
  eph: Ephemeris
  site: SiteRecord
  track: Track
  i0: number
  len: number
  observerM: number
  budget?: MissionBudget | null
  power?: PowerSystem
  radio?: Radio
  terrainConstraint?:TerrainPointScreen
  onSeek: (hoursFromLanding: number) => void
}

export { windows } from '../lib/events'
export type { Win } from '../lib/events'

export function EventList({ eph, site, track, i0, len, observerM, budget, power, radio, terrainConstraint, onSeek }: Props) {
  const [copied, setCopied] = useState(false)
  const a = Math.round(i0)
  const b = a + Math.round(len)
  const wins = useMemo(() => windows(track, a, b), [track, a, b])

  const csv = () => {
    const blob = new Blob([hourlyAnalysisCsv(eph, site, track, i0, len, observerM, budget, power, location.href, radio,terrainConstraint)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `lunorizon_${site.id}_${new Date(timeOf(eph, a) * 1000).toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }
  const horizonCsv = () => {
    const hz = site.horizons[String(observerM)] ?? site.horizons['2']
    const rows = ['azimuth_deg,skyline_elevation_deg']
    hz.forEach((v, k) => rows.push(`${((k + 0.5) * 360 / hz.length).toFixed(2)},${(v / 100).toFixed(2)}`))
    const header = `# LUNORIZON terrain horizon: ${site.name} ${fmtLat(site.lat)} ${fmtLon(site.lon)}, ground ${site.ground_m.toFixed(1)} m, viewpoint ${observerM} m\n# azimuth clockwise from north (bin centres); elevation includes lunar curvature; terrain: ${site.dem}\n`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([header + rows.join('\n')], { type: 'text/csv' }))
    link.download = `lunorizon_${site.id}_horizon_${observerM}m.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5 }}>{wins.filter((w) => w.kind === 'sun').length} sunlit and {wins.filter((w) => w.kind === 'earth').length} Earth-contact windows in this mission window. Click a row to jump there.</span>
        <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn sm" onClick={csv} title="Hourly Sun, Earth, array output, bus demand, storage and powered downlink for this site and window">Download CSV</button>
          <button className="btn sm" onClick={horizonCsv} title="The terrain skyline: elevation at 720 azimuths">Horizon CSV</button>
          <button className="btn sm" onClick={share}>{copied ? 'Link copied' : 'Copy link to this view'}</button>
        </span>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        <table className="ctable">
          <thead>
            <tr><th>Window</th><th>Starts</th><th>Ends</th><th>Duration</th></tr>
          </thead>
          <tbody>
            {wins.map((w, k) => (
              <tr key={k} onClick={() => onSeek(Math.max(0, w.start - a))} style={{ cursor: 'pointer' }}>
                <td><span className={w.kind === 'sun' ? 'sun' : 'earth'}>{w.kind === 'sun' ? '● Sunlight' : '● Earth in view'}</span></td>
                <td>{w.openStart ? 'before landing' : fmtDate(timeOf(eph, w.start))}</td>
                <td>{w.openEnd ? 'after window' : fmtDate(timeOf(eph, w.end))}</td>
                <td>{w.openStart || w.openEnd ? '≥ ' : ''}{fmtHours(w.end - w.start)}</td>
              </tr>
            ))}
            {!wins.length && <tr><td colSpan={4} className="muted">No Sun and no Earth in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
