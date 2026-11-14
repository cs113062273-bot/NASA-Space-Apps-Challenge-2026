import { useEffect, useMemo, useState } from 'react'
import { Ephemeris, indexOf, timeOf } from '../lib/astro'
import { METRICS, MetricKey, Track, dailyMetric } from '../lib/metrics'
import { darkRamp, earthRamp, fitLabel, fmtDate, fmtHours, monthLabel, prep, sunRamp, useCanvas } from '../lib/ui'

export interface SlipRow {
  id: string
  label: string
  track: Track
}

interface Props {
  eph: Ephemeris
  rows: SlipRow[]
  landingUnix: number
  windowHours: number
  metric: MetricKey
  days?: number
  selectedId: string
  passes?: (id: string, dayStartIndex: number, robust?: boolean) => boolean
  raised?: string // what "robust" means, e.g. "the skyline 0.1° higher"
  onPickDate: (unix: number, id: string) => void
}

const LABEL_W = 184
const PASS = '#49d6a4'
const FRAGILE = '#e0913a'

export function scaleFor(metric: MetricKey, windowHours: number) {
  if (metric === 'longestDark') return { max: Math.min(windowHours, 24 * 15), color: (v: number, max: number) => darkRamp(v / max) }
  if (metric === 'firstSunset') return { max: windowHours, color: (v: number, max: number) => sunRamp(v / max) }
  if (metric === 'earth') return { max: 100, color: (v: number) => earthRamp(v / 100) }
  return { max: 100, color: (v: number) => sunRamp(v / 100) }
}

export function fmtMetric(metric: MetricKey, v: number, windowHours?: number) {
  if (!Number.isFinite(v)) return '—'
  if (METRICS[metric].unit === '%') return `${v.toFixed(0)}%`
  if (metric === 'firstSunset' && windowHours && v >= windowHours) return `≥ ${fmtHours(windowHours)}`
  return fmtHours(v)
}

export function SlipHeatmap({ eph, rows, landingUnix, windowHours, metric, days = 365, selectedId, passes, raised = 'the skyline raised', onPickDate }: Props) {
  const rowH = rows.length > 6 ? 28 : 40
  const combined = !!passes && rows.length > 1
  const H = 30 + rows.length * rowH + (combined ? rowH + 8 : 0) + 4
  const { ref, w } = useCanvas(() => H)
  const [hover, setHover] = useState<{ x: number; y: number; r: number; d: number } | null>(null)

  // start at the first midnight 30 days before the chosen landing so the past month is visible
  const landingDayUnix = Math.floor(landingUnix / 86400) * 86400
  const timeOfDay = landingUnix - landingDayUnix
  const startUnix = Math.max(eph.startUnix, landingDayUnix - 30 * 86400)
  const maxDays = Math.floor((timeOf(eph, eph.count - 1) - windowHours * 3600 - startUnix) / 86400)
  const nDays = Math.max(0, Math.min(days, maxDays))
  const firstIndex = Math.round(indexOf(eph, startUnix + timeOfDay))

  const values = useMemo(
    () => rows.map((r) => dailyMetric(r.track, firstIndex, nDays, windowHours, metric)),
    [rows, firstIndex, nDays, windowHours, metric],
  )
  const ok = useMemo(
    // 0 fails, 1 passes only with the nominal skyline (fragile), 2 passes even with the site's skyline raised by its uncertainty
    () => (passes ? rows.map((r) => Array.from({ length: nDays }, (_, d) => (passes(r.id, firstIndex + d * 24) ? (passes(r.id, firstIndex + d * 24, true) ? 2 : 1) : 0))) : null),
    [rows, passes, firstIndex, nDays],
  )
  const sc = scaleFor(metric, windowHours)

  useEffect(() => {
    const ctx = prep(ref.current, w, H)
    if (!ctx) return
    const pw = w - LABEL_W - 8
    const cw = pw / nDays
    ctx.font = '10.5px IBM Plex Mono, monospace'
    ctx.textBaseline = 'top'
    // month ticks
    for (let d = 0; d < nDays; d++) {
      const u = startUnix + d * 86400
      if (new Date(u * 1000).getUTCDate() === 1) {
        const x = LABEL_W + d * cw
        ctx.fillStyle = '#5b6678'
        if (x + 2 + ctx.measureText(monthLabel(u)).width <= w) ctx.fillText(monthLabel(u), x + 2, 6)
        ctx.fillStyle = 'rgba(139,151,170,0.25)'
        ctx.fillRect(x, 20, 1, H - 20)
      }
    }
    rows.forEach((row, r) => {
      const y = 26 + r * rowH
      ctx.textBaseline = 'middle'
      ctx.fillStyle = row.id === selectedId ? '#e9eef6' : '#8b97aa'
      ctx.font = `${row.id === selectedId ? 600 : 500} 12px Manrope, sans-serif`
      const lab = fitLabel(ctx, row.label, LABEL_W - 14)
      ctx.fillText(lab, 8, y + rowH / 2)
      for (let d = 0; d < nDays; d++) {
        const v = values[r][d]
        ctx.fillStyle = Number.isFinite(v) ? sc.color(v, sc.max) : '#0e131c'
        ctx.fillRect(LABEL_W + d * cw, y + 3, Math.ceil(cw), rowH - 6)
      }
      if (ok) {
        // feasible days: thin bright line under the row
        for (let d = 0; d < nDays; d++) {
          if (ok[r][d]) {
            ctx.fillStyle = ok[r][d] === 2 ? PASS : FRAGILE
            ctx.fillRect(LABEL_W + d * cw, y + rowH - 3, Math.ceil(cw), 2)
          }
        }
      }
    })
    if (combined && ok) {
      // NASA keeps several regions open: a day is available if any compared site passes
      const y = 26 + rows.length * rowH + 8
      ctx.fillStyle = '#e9eef6'
      ctx.font = '600 12px Manrope, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText('Any of these sites', 8, y + rowH / 2)
      for (let d = 0; d < nDays; d++) {
        const best = Math.max(...ok.map((row) => row[d]))
        ctx.fillStyle = best === 2 ? PASS : best === 1 ? FRAGILE : '#1a212d'
        ctx.fillRect(LABEL_W + d * cw, y + 3, Math.ceil(cw), rowH - 6)
      }
    }
    // chosen landing day
    const dl = Math.round((landingDayUnix - startUnix) / 86400)
    if (dl >= 0 && dl < nDays) {
      const x = LABEL_W + (dl + 0.5) * cw
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, 20)
      ctx.lineTo(x, H - 2)
      ctx.stroke()
      ctx.lineWidth = 1
    }
    if (hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.strokeRect(LABEL_W + hover.d * cw - 0.5, 26 + hover.r * rowH + 2.5, Math.max(2, cw) + 1, rowH - 5)
    }
  }, [ref, w, H, rows, values, ok, nDays, startUnix, landingDayUnix, selectedId, hover, sc])

  const cell = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const pw = w - LABEL_W - 8
    const d = Math.floor(((x - LABEL_W) / pw) * nDays)
    const r = Math.floor((y - 26) / rowH)
    if (d < 0 || d >= nDays || r < 0 || r >= rows.length) return null // the combined row is not a site
    return { x, y, r, d }
  }

  const hv = hover ? values[hover.r][hover.d] : NaN
  return (
    <div className="canvasbox" onPointerMove={(e) => setHover(cell(e))} onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        const c = cell(e)
        if (c) onPickDate(startUnix + c.d * 86400 + timeOfDay, rows[c.r].id)
      }}
      style={{ cursor: 'pointer' }}>
      <canvas ref={ref} role="img" aria-label={`${METRICS[metric].label} for each landing date over the next year, per site`} />
      {hover && (
        <div className="tip" style={{ left: Math.min(hover.x + 12, w - 240), top: hover.y + 14 }}>
          <div style={{ fontWeight: 600 }}>{rows[hover.r].label}</div>
          <div className="muted mono">land {fmtDate(startUnix + hover.d * 86400 + timeOfDay)}</div>
          <div className="mono">{METRICS[metric].short}: {fmtMetric(metric, hv, windowHours)}</div>
          {ok && <div className={ok[hover.r][hover.d] ? 'good' : 'bad'}>{ok[hover.r][hover.d] === 2 ? 'meets Sun/Earth/slope rules' : ok[hover.r][hover.d] === 1 ? `meets them, but not with ${raised}` : 'misses a surface rule'}</div>}
          <div className="faint">click to land on this date</div>
        </div>
      )}
    </div>
  )
}
