import { useEffect, useMemo, useState } from 'react'
import { Horizon, earthPhase } from '../lib/astro'
import { Track, earthVisible } from '../lib/metrics'
import { drawDisk, fmtDate, fmtShortDate, prep, useCanvas, usePhotos } from '../lib/ui'
import { skylineSample, skylineWindow } from '../lib/skyline'

interface Props {
  horizon: Horizon
  track: Track
  i0: number
  len: number
  cursor: number // absolute fractional ephemeris index
  observerM: number
  landingUnix: number
  /** fixed plot height (px), to line up with a neighbouring view */
  height?: number
}

const PAD = { l: 40, r: 12, t: 16, b: 28 }

export function Skyline({ horizon, track, i0, len, cursor, observerM, landingUnix, height }: Props) {
  const { ref, w, h } = useCanvas((cw) => height ?? Math.max(220, Math.min(300, cw * 0.27)))
  const [hover, setHover] = useState<{ x: number; az: number; el: number } | null>(null)
  const photo = usePhotos()

  const view = useMemo(() => {
    const { a, b } = skylineWindow(track.sunFrac.length, i0, len)
    // centre the panorama on the Earth's mean direction: on the near side it barely moves
    let sx = 0
    let sy = 0
    let maxEl = horizon.max()
    for (let i = a; i <= b; i++) {
      const az = (track.earthAz[i] * Math.PI) / 180
      sx += Math.sin(az)
      sy += Math.cos(az)
      maxEl = Math.max(maxEl, track.sunEl[i], track.earthEl[i])
    }
    const centre = Math.round(((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360 / 5) * 5
    let minEl = 0
    for (const v of horizon.elev) minEl = Math.min(minEl, v)
    const lo = Math.floor(Math.max(-8, minEl) - 0.5)
    const hi = Math.ceil(Math.min(90, maxEl + 1.5))
    return { a, b, centre, lo, hi }
  }, [horizon, track, i0, len])

  const sample = skylineSample(track.sunFrac.length, view.a, view.b, cursor)

  useEffect(() => {
    const ctx = prep(ref.current, w, h)
    if (!ctx) return
    const { a, b, centre, lo, hi } = view
    const pw = w - PAD.l - PAD.r
    const ph = h - PAD.t - PAD.b
    const X = (az: number) => PAD.l + ((((az - centre + 540) % 360) - 180 + 180) / 360) * pw
    const Y = (el: number) => PAD.t + ((hi - el) / (hi - lo)) * ph

    // sky
    const sky = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + ph)
    sky.addColorStop(0, '#05070b')
    sky.addColorStop(1, '#0b1018')
    ctx.fillStyle = sky
    ctx.fillRect(PAD.l, PAD.t, pw, ph)

    // grid
    ctx.font = '10.5px IBM Plex Mono, monospace'
    ctx.textBaseline = 'middle'
    const step = hi - lo > 20 ? 5 : hi - lo > 8 ? 2 : 1
    for (let e = Math.ceil(lo / step) * step; e <= hi; e += step) {
      const y = Y(e)
      ctx.strokeStyle = e === 0 ? 'rgba(139,151,170,0.45)' : 'rgba(139,151,170,0.12)'
      ctx.setLineDash(e === 0 ? [4, 4] : [])
      ctx.beginPath()
      ctx.moveTo(PAD.l, y)
      ctx.lineTo(PAD.l + pw, y)
      ctx.stroke()
      ctx.fillStyle = '#5b6678'
      ctx.textAlign = 'right'
      ctx.fillText(`${e}°`, PAD.l - 6, y)
    }
    ctx.setLineDash([])

    // tracks behind terrain first (dim), so terrain occludes them visually
    const drawTrack = (azArr: Float32Array, elArr: Float32Array, visible: (i: number) => boolean, color: string) => {
      for (let i = a; i <= b; i += 1) {
        const x = X(azArr[i])
        const y = Y(elArr[i])
        const vis = visible(i)
        ctx.fillStyle = vis ? color : 'rgba(139,151,170,0.35)'
        ctx.globalAlpha = vis ? 0.85 : 0.5
        ctx.beginPath()
        ctx.arc(x, y, vis ? 1.7 : 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(PAD.l, PAD.t, pw, ph)
    ctx.clip()
    drawTrack(track.earthAz, track.earthEl, (i) => earthVisible(track, i), '#5aa9ff')
    drawTrack(track.sunAz, track.sunEl, (i) => track.sunFrac[i] > 0, '#ffc24b')
    ctx.restore()

    // terrain silhouette
    const n = horizon.bins
    const pts: [number, number][] = []
    for (let k = 0; k <= n; k++) {
      const az = centre - 180 + (k / n) * 360
      pts.push([PAD.l + (k / n) * pw, Y(horizon.at(az))])
    }
    const g = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + ph)
    g.addColorStop(0, '#3a4252')
    g.addColorStop(0.55, '#1c222d')
    g.addColorStop(1, '#0e1219')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(PAD.l, PAD.t + ph)
    for (const [x, y] of pts) ctx.lineTo(x, y)
    ctx.lineTo(PAD.l + pw, PAD.t + ph)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(214,224,238,0.75)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.stroke()
    ctx.lineWidth = 1

    // current bodies
    const { index: ci, k0, t } = sample
    const lerpAz = (arr: Float32Array) => {
      const d = ((arr[k0 + 1] - arr[k0] + 540) % 360) - 180
      return arr[k0] + d * t
    }
    const lerp = (arr: Float32Array) => arr[k0] * (1 - t) + arr[k0 + 1] * t
    const bodyBounds: { left: number; right: number; top: number; bottom: number }[] = []
    const body = (az: number, el: number, vis: boolean, color: string, r: number, label: string, im: HTMLImageElement | null, phase?: { cosAlpha: number; pa: number }, hiddenReason = 'behind terrain') => {
      const x = X(az)
      // a body below the plotted range sits on the bottom edge, labelled with its elevation
      const below = Y(el) > PAD.t + ph - r
      const y = Math.max(PAD.t + r, Math.min(PAD.t + ph - r, Y(el)))
      ctx.save()
      if (!vis) ctx.globalAlpha = 0.35
      if (im) drawDisk(ctx, im, x, y, r, phase)
      else {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
      if (!vis) {
        // behind the terrain: a dashed ring marks where it is
        ctx.strokeStyle = color
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.arc(x, y, r + 1.5, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.font = '600 11px Manrope, sans-serif'
      ctx.textAlign = 'center'
      const text = below ? `${label} ${Math.round(el)}° ↓` : vis ? label : `${label} · ${hiddenReason}`
      const ty = Math.max(PAD.t + 8, y - r - 9)
      // dark halo so the label stays readable where it crosses the other body's path
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(6,8,12,0.9)'
      ctx.strokeText(text, x, ty)
      ctx.lineWidth = 1
      ctx.fillStyle = vis ? color : '#8b97aa'
      ctx.fillText(text, x, ty)
      const halfLabel = ctx.measureText(text).width / 2
      bodyBounds.push(
        { left: x - r - 8, right: x + r + 8, top: y - r - 8, bottom: y + r + 8 },
        { left: x - halfLabel - 8, right: x + halfLabel + 8, top: ty - 8, bottom: ty + 8 },
      )
    }
    const sunFraction = track.visibleAt ? track.visibleAt(ci, 0) : lerp(track.sunFrac)
    const sunVis = sunFraction > 0
    const dsn = !track.requireDsn || !!track.dsn?.[k0]
    const earthVis = lerp(track.earthClear) >= track.earthMinClear && dsn
    const sAz = lerpAz(track.sunAz)
    const sEl = lerp(track.sunEl)
    const eAz = lerpAz(track.earthAz)
    const eEl = lerp(track.earthEl)
    const phase = earthPhase(sAz, sEl, eAz, eEl)
    const earthReason = lerp(track.earthClear) < 0 ? 'behind terrain' : lerp(track.earthClear) < track.earthMinClear ? 'below clearance' : 'no DSN'
    body(eAz, eEl, earthVis, '#5aa9ff', 16, `Earth · ${Math.round(phase.lit * 100)}% lit`, photo.earth, phase, earthReason)
    body(sAz, sEl, sunVis, '#ffc24b', 11, sunFraction > 0 && sunFraction < 0.99 ? `Sun · ${Math.round(sunFraction * 100)}% visible` : 'Sun', photo.sun, undefined,
      track.partialEclipse?.[k0] ? 'eclipsed / terrain' : 'behind terrain')

    // Keep endpoint labels in the legend, clear of the current Sun and Earth labels.
    ctx.save()
    for (const [k, label] of [[a, 'Start'], [b, 'End']] as const) {
      const x = X(track.sunAz[k]), y = Y(track.sunEl[k])
      if (y < PAD.t + 5 || y > PAD.t + ph - 5) continue
      const color = track.sunFrac[k] > 0 ? '#ffc24b' : '#8b97aa'
      if (!bodyBounds.some(box => x + 5 >= box.left && x - 5 <= box.right && y + 5 >= box.top && y - 5 <= box.bottom)) {
        ctx.strokeStyle = color
        ctx.fillStyle = '#080c12'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        if (label === 'Start') ctx.arc(x, y, 3.5, 0, Math.PI * 2)
        else ctx.rect(x - 3.5, y - 3.5, 7, 7)
        ctx.fill()
        ctx.stroke()
      }
    }
    ctx.restore()

    // compass
    ctx.font = '10.5px IBM Plex Mono, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let az = 0; az < 360; az += 30) {
      const x = X(az)
      const card = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[az]
      ctx.fillStyle = card ? '#e9eef6' : '#5b6678'
      ctx.fillText(card ?? `${az}°`, x, PAD.t + ph + 8)
      ctx.strokeStyle = 'rgba(139,151,170,0.25)'
      ctx.beginPath()
      ctx.moveTo(x, PAD.t + ph)
      ctx.lineTo(x, PAD.t + ph + 4)
      ctx.stroke()
    }
    if (hover) {
      ctx.strokeStyle = 'rgba(233,238,246,0.35)'
      ctx.beginPath()
      ctx.moveTo(hover.x, PAD.t)
      ctx.lineTo(hover.x, PAD.t + ph)
      ctx.stroke()
    }
  }, [ref, w, h, view, horizon, track, sample.index, sample.k0, sample.t, hover, photo.sun, photo.earth])

  const exaggeration = useMemo(() => {
    if (!w) return 1
    const pw = w - PAD.l - PAD.r
    const ph = h - PAD.t - PAD.b
    return ph / (view.hi - view.lo) / (pw / 360)
  }, [w, h, view])

  const onMove = (e: React.PointerEvent) => {
    const r = (e.target as HTMLElement).getBoundingClientRect()
    const x = e.clientX - r.left
    const pw = w - PAD.l - PAD.r
    if (x < PAD.l || x > PAD.l + pw) return setHover(null)
    const az = (((view.centre - 180 + ((x - PAD.l) / pw) * 360) % 360) + 360) % 360
    setHover({ x, az, el: horizon.at(az) })
  }

  return (
    <>
    <div className="canvasbox" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={ref} role="img" aria-label="360-degree terrain skyline with the paths of the Sun and Earth during the mission window" aria-describedby="skyline-range" data-sample-index={sample.index} />
      {hover && (
        <div className="tip mono" style={{ left: Math.min(hover.x + 10, w - 170), top: 8 }}>
          az {hover.az.toFixed(1)}° · skyline {hover.el.toFixed(2)}°
        </div>
      )}
    </div>
      <div className="legend view-legend">
        <span><i style={{ background: 'var(--sun)' }} />Sun path (visible)</span>
        <span><i style={{ background: 'var(--earth)' }} />Earth path (visible)</span>
        <span><i style={{ background: '#5b6678' }} />behind terrain</span>
        <span className="faint" id="skyline-range" title={`${fmtDate(landingUnix)} → ${fmtDate(landingUnix + len * 3600)}. Sun photos: NASA/SDO; Earth: NASA/Apollo 17, shaded to its computed phase.`}>Sun path ○ {fmtShortDate(landingUnix)} → □ {fmtShortDate(landingUnix + len * 3600)} · panels {observerM} m · heights ×{exaggeration.toFixed(0)}</span>
      </div>
    </>
  )
}
