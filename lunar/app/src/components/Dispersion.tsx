import { useEffect, useMemo, useState } from 'react'
import type { Requirements } from '../lib/requirements'
import { Ephemeris, Horizon, R0_KM } from '../lib/astro'
import { SiteRecord, toXY } from '../lib/data'
import { cellLatLon, touchdownCells, touchdownPass } from '../lib/touchdown'
import { METRICS, MetricKey, SKYLINE_ERR_DEG } from '../lib/metrics'
import { prep, useCanvas } from '../lib/ui'
import { fmtMetric, scaleFor } from './SlipHeatmap'

interface Props {
  eph: Ephemeris
  site: SiteRecord
  grid: Horizon[]
  sites: SiteRecord[]
  i0: number
  len: number
  metric: MetricKey
  earthMinClear: number
  req: Requirements
  requireDsn?: boolean
  skyErr?: number // skyline shift for the "if skyline higher" share
  observerM?: number // panel height the grid's horizons were computed for
  onAddSite?: (lat: number, lon: number) => void
  footprintActive?:boolean
}

const R_M = R0_KM * 1000
const D2R = Math.PI / 180
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** Compass direction from one point to another (initial great-circle bearing). */
function compass(la1: number, lo1: number, la2: number, lo2: number) {
  const [p1, p2, dl] = [la1 * D2R, la2 * D2R, (lo2 - lo1) * D2R]
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / D2R
  return COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8]
}

export function Dispersion({ eph, site, grid, sites, i0, len, metric, earthMinClear, req, requireDsn = false, skyErr = SKYLINE_ERR_DEG, observerM = 2, onAddSite,footprintActive=false }: Props) {
  const d = site.dispersion!
  const { ref, w } = useCanvas((cw) => Math.min(cw, 360))
  const [hover, setHover] = useState<number | null>(null)
  const enu = d.frame === 'enu'
  const [cx, cy] = toXY(site.lat, site.lon)
  const half = ((d.n - 1) / 2) * d.step_m
  const mid = (d.n - 1) / 2
  // lat/lon -> grid offsets (m), for other sites drawn on the grid
  const offsetOf = (lat: number, lon: number): [number, number] => {
    if (!enu) {
      const [x, y] = toXY(lat, lon)
      return [x - cx, y - cy]
    }
    const dlon = ((((lon - site.lon) % 360) + 540) % 360) - 180
    return [dlon * D2R * R_M * Math.cos(site.lat * D2R), (lat - site.lat) * D2R * R_M]
  }
  const cellLL = (k: number) => cellLatLon(site, k)

  const cells = useMemo(
    () => touchdownCells(eph, site, grid, i0, len, { earthMinClear, skyErr, requireDsn, observerM }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eph, grid, d, site.lat, site.lon, i0, len, earthMinClear, skyErr, requireDsn, observerM],
  )
  const { pass, ok, okHi } = useMemo(() => touchdownPass(site, cells, req, len), [site, cells, req, len])

  const summary = useMemo(() => {
    const centre = cells[mid * d.n + mid][metric]
    const better = METRICS[metric].better
    let worst500 = centre
    let best500 = centre
    let n500 = 0
    let ok500 = 0
    let ok500Hi = 0
    let steep500 = 0
    // best point in the circle: one that meets every requirement if any, then strictly better than the target
    let bestK = mid * d.n + mid
    for (let r = 0; r < d.n; r++) {
      for (let c = 0; c < d.n; c++) {
        const k = r * d.n + c
        if (Math.hypot(r - mid, c - mid) * d.step_m > 500 + 1) continue
        const v = cells[k][metric]
        worst500 = better === 'high' ? Math.min(worst500, v) : Math.max(worst500, v)
        best500 = better === 'high' ? Math.max(best500, v) : Math.min(best500, v)
        n500++
        if (ok[k]) ok500++
        if (okHi[k]) ok500Hi++
        if (!pass[k].slope) steep500++
        const nicer = better === 'high' ? v > cells[bestK][metric] + 1e-6 : v < cells[bestK][metric] - 1e-6
        if (Number(ok[k]) > Number(ok[bestK]) || (ok[k] === ok[bestK] && nicer)) bestK = k
      }
    }
    return { centre, worst500, best500, okPct: (100 * ok500) / n500, okPctHi: (100 * ok500Hi) / n500, steepPct: (100 * steep500) / n500, bestK }
  }, [cells, ok, okHi, pass, d, mid, metric])

  const others = useMemo(
    () =>
      sites
        .filter((s) => s.id !== site.id && (enu || s.lat < -60))
        .map((s) => {
          const [dx, dy] = offsetOf(s.lat, s.lon)
          return { s, dx, dy }
        })
        .filter((o) => Math.abs(o.dx) <= half && Math.abs(o.dy) <= half),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sites, site, half, enu],
  )

  const sc = scaleFor(metric, len)
  const size = Math.min(w, 360)

  useEffect(() => {
    const ctx = prep(ref.current, w, size)
    if (!ctx) return
    const ox = (w - size) / 2
    const cell = size / d.n
    const n = d.n
    // one pixel per touchdown point, drawn up with bilinear smoothing: pixel centres land on the point centres
    const grid = (fill: (k: number) => string | null) => {
      const c = document.createElement('canvas')
      c.width = c.height = n
      const g = c.getContext('2d')!
      for (let k = 0; k < n * n; k++) {
        const f = fill(k)
        if (f) {
          g.fillStyle = f
          g.fillRect(k % n, Math.floor(k / n), 1, 1)
        }
      }
      return c
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(grid((k) => sc.color(cells[k][metric], sc.max)), ox, 0, size, size)
    // dim and hatch ground that misses a requirement; cross-hatch ground too steep to land on
    const hatch = (cross: boolean) => {
      const p = document.createElement('canvas')
      p.width = p.height = 7
      const g = p.getContext('2d')!
      g.strokeStyle = 'rgba(0,0,0,0.7)'
      g.beginPath()
      g.moveTo(-1, 8)
      g.lineTo(8, -1)
      if (cross) {
        g.moveTo(-1, -1)
        g.lineTo(8, 8)
      }
      g.stroke()
      return ctx.createPattern(p, 'repeat')!
    }
    for (const steep of [false, true]) {
      const h = document.createElement('canvas')
      h.width = h.height = size
      const g = h.getContext('2d')!
      g.fillStyle = steep ? hatch(true) : 'rgba(4,7,13,0.42)'
      g.fillRect(0, 0, size, size)
      if (!steep) {
        g.fillStyle = hatch(false)
        g.fillRect(0, 0, size, size)
      }
      g.globalCompositeOperation = 'destination-in'
      g.imageSmoothingEnabled = true
      g.drawImage(grid((k) => (steep ? !pass[k].slope : !ok[k]) ? '#000' : null), 0, 0, size, size)
      ctx.drawImage(h, ox, 0)
    }
    // the edge of the safe area: marching squares on the pass / fail field, between point centres
    ctx.strokeStyle = '#49d6a4'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const at = (r: number, c: number): [number, number] => [ox + (c + 0.5) * cell, (r + 0.5) * cell]
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const tl = ok[r * n + c], tr = ok[r * n + c + 1], br = ok[(r + 1) * n + c + 1], bl = ok[(r + 1) * n + c]
        const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
        if (code === 0 || code === 15) continue
        const T = at(r, c + 0.5), R = at(r + 0.5, c + 1), B = at(r + 1, c + 0.5), L = at(r + 0.5, c)
        const segs: [number, number][][] = ({
          1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[T, R]], 5: [[L, T], [B, R]], 6: [[T, B]], 7: [[L, T]],
          8: [[L, T]], 9: [[T, B]], 10: [[T, R], [L, B]], 11: [[T, R]], 12: [[L, R]], 13: [[B, R]], 14: [[L, B]],
        } as Record<number, [number, number][][]>)[code]
        for (const [a, b] of segs) {
          ctx.moveTo(a[0], a[1])
          ctx.lineTo(b[0], b[1])
        }
      }
    }
    ctx.stroke()
    ctx.lineWidth = 1
    // the 500 m circle is what the numbers below count; dim the corners outside it
    const r500 = (500 / (2 * half + d.step_m)) * size
    ctx.fillStyle = 'rgba(6,8,12,0.55)'
    ctx.beginPath()
    ctx.rect(ox, 0, size, size)
    ctx.arc(ox + size / 2, size / 2, r500, 0, Math.PI * 2, true)
    ctx.fill()
    const P = (dx: number, dy: number): [number, number] => [ox + size / 2 + (dx / (2 * half + d.step_m)) * size, size / 2 - (dy / (2 * half + d.step_m)) * size]
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    for (const rr of [250, 500]) {
      const rpx = (rr / (2 * half + d.step_m)) * size
      ctx.beginPath()
      ctx.arc(ox + size / 2, size / 2, rpx, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
    const mark = (x: number, y: number, label: string, main: boolean) => {
      ctx.lineWidth = 2
      ctx.strokeStyle = '#000'
      ctx.fillStyle = main ? '#ffffff' : '#ff7a6b'
      ctx.beginPath()
      ctx.arc(x, y, main ? 5 : 4.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fill()
      ctx.font = '600 11px Manrope, sans-serif'
      ctx.lineWidth = 3
      ctx.strokeText(label, x + 9, y - 6)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 9, y - 6)
      ctx.lineWidth = 1
    }
    for (const o of others) {
      const [x, y] = P(o.dx, o.dy)
      mark(x, y, o.s.name, false)
    }
    mark(ox + size / 2, size / 2, 'target', true)
    const bk = summary.bestK
    if (bk >= 0 && bk !== mid * d.n + mid) {
      ctx.strokeStyle = '#49d6a4'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(ox + ((bk % d.n) + 0.5) * cell, (Math.floor(bk / d.n) + 0.5) * cell, Math.max(6, cell * 0.38), 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = 1
    }
    if (hover !== null) {
      const r = Math.floor(hover / d.n)
      const c = hover % d.n
      ctx.strokeStyle = '#fff'
      ctx.strokeRect(ox + c * cell + 0.5, r * cell + 0.5, cell - 1, cell - 1)
    }
  }, [ref, w, size, cells, ok, pass, metric, d, sc, others, hover, half, summary.bestK, mid])

  const cellAt = (e: React.PointerEvent) => {
    const r0 = e.currentTarget.getBoundingClientRect()
    const ox = (w - size) / 2
    const c = Math.floor(((e.clientX - r0.left - ox) / size) * d.n)
    const r = Math.floor(((e.clientY - r0.top) / size) * d.n)
    return c >= 0 && r >= 0 && c < d.n && r < d.n ? r * d.n + c : null
  }

  const better = METRICS[metric].better
  const best = (() => {
    const k = summary.bestK
    if (k < 0 || k === mid * d.n + mid) return null
    const [lat, lon] = cellLL(k)
    return { lat, lon, dist: Math.round(Math.hypot((k % d.n) - mid, Math.floor(k / d.n) - mid) * d.step_m), dir: compass(site.lat, site.lon, lat, lon) }
  })()
  const loss = (v: number) => (better === 'high' ? summary.centre - v : v - summary.centre)
  return (
    <div>
      <p className="model-note">Scope: sunlight, Earth-view and point-slope rules at each touchdown point. Power, data delivery{footprintActive ? ' and the footprint constraint' : ' and footprint fit'} are evaluated separately; inspect a point to see them.</p>
      <div className="canvasbox" onPointerMove={(e) => setHover(cellAt(e))} onPointerLeave={() => setHover(null)}>
        <canvas ref={ref} role="img" aria-label={`${METRICS[metric].label} for touchdown points within 500 metres of the target, hatched where a sunlight, Earth or slope rule fails`} />
        {hover !== null && (
          <div className="tip" style={{ left: 8, top: 8 }}>
            {(() => {
              const r = Math.floor(hover / d.n)
              const c = hover % d.n
              const dist = Math.round(Math.hypot(c - mid, r - mid) * d.step_m)
              const p = pass[hover]
              const fails = [!p.daylight && 'daylight', !p.dark && 'darkness', !p.earth && 'Earth', !p.slope && 'slope'].filter(Boolean)
              return (
                <>
                  <div className="mono">{dist} m from target · ground {d.ground_m[hover].toFixed(0)} m · slope {d.slope_deg[hover].toFixed(0)}°</div>
                  <div className="mono">{METRICS[metric].short}: {fmtMetric(metric, cells[hover][metric], len)}</div>
                  <div className={fails.length ? 'bad' : 'good'}>{fails.length ? `misses: ${fails.join(', ')}` : 'meets the sunlight, Earth and slope rules'}</div>
                </>
              )
            })()}
          </div>
        )}
      </div>
      <div className={`callout ${summary.okPct < 50 ? 'bad' : ''}`} style={{ marginTop: 12 }}>
        {summary.okPct >= 99.5 ? <>All</> : summary.okPct < 0.5 ? <>None</> : <>Only <b>{summary.okPct.toFixed(0)}%</b></>} of the 500 m circle around {site.name} meets the sunlight, Earth-view and point-slope rules on this date.
        {' '}Within that circle, {METRICS[metric].short.toLowerCase()} ranges from <b className="mono">{fmtMetric(metric, summary.worst500, len)}</b> to <b className="mono">{fmtMetric(metric, summary.best500, len)}</b>.
      </div>
      {best && (
        <div className="callout earth" style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>
            <b style={{ color: '#49d6a4' }}>Best point in the circle</b> (green ring): {best.dist} m {best.dir} of the target · {METRICS[metric].short.toLowerCase()}{' '}
            <b className="mono">{fmtMetric(metric, cells[summary.bestK][metric], len)}</b> · slope {d.slope_deg[summary.bestK].toFixed(0)}°
            {' '}({better === 'high' ? '+' : '−'}{fmtMetric(metric, Math.abs(cells[summary.bestK][metric] - summary.centre))} vs the target)
            {ok[summary.bestK] ? ' · meets the sunlight, Earth and slope rules' : ' · still misses a sunlight, Earth or slope rule'}
          </span>
          {onAddSite && <button className="btn sm" onClick={() => onAddSite(best.lat, best.lon)}>Add it as my site</button>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
        <div className="kpi"><div className="label">At the target</div><div className="value" style={{ fontSize: 20 }}>{fmtMetric(metric, summary.centre, len)}</div></div>
        <div className={`kpi ${loss(summary.worst500) > 0.5 ? 'fail' : ''}`}><div className="label">Worst within 500 m</div><div className="value" style={{ fontSize: 20 }}>{fmtMetric(metric, summary.worst500, len)}</div></div>
        <div className={`kpi ${summary.okPct < 50 ? 'fail' : 'pass'}`}><div className="label" title="Share of the 500 m circle that meets the sunlight, Earth-view and point-slope rules. Power and data are evaluated separately. Boulders and craters below the terrain grid require finer data.">Area passing Sun, Earth, slope</div><div className="value" style={{ fontSize: 20 }}>{summary.okPct.toFixed(0)}<small>%</small></div><div className="sub" title={`Rechecks the same sampled area with the skyline raised by ${skyErr}° to show sensitivity to terrain height.`}>{summary.okPctHi.toFixed(0)}% if skyline +{skyErr}°</div></div>
      </div>
      <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
        Green line: edge of the ground that meets the sunlight, Earth and slope rules. Hatched: misses one of them. Cross-hatch: steeper than {req.maxSlopeDeg}° ({summary.steepPct.toFixed(0)}% of the circle). Map up = {enu ? 'north' : 'toward 0°E'}.
      </p>
      <details className="model-details"><summary>How this map is made</summary>
        <p>{d.n}×{d.n} touchdown points every {d.step_m} m, each with its own 360° horizon at {observerM} m panel height and {d.slope_baseline_m ?? 40} m-baseline slope ({site.dem.split(' near field')[0]} near field). Not a hazard map: boulders and craters smaller than about twice the terrain grid are not resolved.
        {d.browser && <> Computed in your browser. The longer slope baseline smooths short steep patches: at five curated sites it finds about half as many points steeper than 10° as the 40 m pipeline slope, with the same median.</>}</p>
      </details>
    </div>
  )
}
