import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Basemap, SiteRecord } from '../lib/data'
import { drawDisk, fmtLat, fmtLon, prep, useCanvas, usePhotos } from '../lib/ui'
import { GROUP_COLOR, useImage } from './MapView'
import { bodyAtVector, siteFrame, stationAtVector, visibleSunFraction, DSN_MIN_EL_DEG } from '../lib/astro'

interface Props {
  basemap: Basemap
  sites: SiteRecord[]
  selectedId: string
  pinned: string[]
  onSelect: (id: string) => void
  onPickPoint?: (lat: number, lon: number) => void
  now?: { sun: number[]; earth: number[]; label: string; dsnAvailable: boolean; stations?: Float32Array; stationLabel?: string }
  observerM: number
  earthMinClear: number
  requireDsn: boolean
  modeSwitch: ReactNode
}

/**
 * Day and night, and where Earth is above the horizon, at one moment on a smooth Moon (1° grid, equirectangular),
 * plus the points under the Sun and under Earth. Terrain is left out at this scale; the site views include it.
 */
function useMoment(now: Props['now'], earthOn: boolean, observerM: number, earthMinClear: number, requireDsn: boolean) {
  return useMemo(() => {
    if (!now || typeof document === 'undefined') return null
    const R = 1737.4 + observerM / 1000
    const sl = Math.hypot(now.sun[0], now.sun[1], now.sun[2])
    const S = now.sun.map((v) => v / sl)
    const distanceEarth = Math.hypot(...now.earth)
    const eclipsePossible = now.earth.reduce((dot, value, i) => dot + value * S[i], 0) / distanceEarth > Math.cos(3 * Math.PI / 180)
    const c = document.createElement('canvas')
    c.width = 360
    c.height = 180
    const g = c.getContext('2d')!
    const im = g.createImageData(360, 180)
    for (let y = 0; y < 180; y++) {
      const la = ((89.5 - y) * Math.PI) / 180
      for (let x = 0; x < 360; x++) {
        const lo = ((x - 179.5) * Math.PI) / 180
        const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
        const sunEl = S[0] * u[0] + S[1] * u[1] + S[2] * u[2] // sine of the Sun's elevation
        const ex = now.earth[0] - R * u[0], ey = now.earth[1] - R * u[1], ez = now.earth[2] - R * u[2]
        let earthUp = (ex * u[0] + ey * u[1] + ez * u[2]) / Math.hypot(ex, ey, ez) >= Math.sin(earthMinClear * Math.PI / 180)
          && (!requireDsn || now.dsnAvailable)
        if (earthOn && requireDsn && now.stations) {
          const frame = siteFrame(89.5 - y, x - 179.5, R)
          earthUp = [0, 1, 2].some(j => {
            const s = stationAtVector(frame, now.stations!, j * 9)
            return s.el >= earthMinClear && s.receiverEl >= DSN_MIN_EL_DEG
          })
        }
        const k = 4 * (y * 360 + x)
        const blue = earthOn && earthUp
        // night: near-black (blue-black where Earth is up); day: clear, faintly blue where Earth is up
        let sunlight = sunEl >= 0 ? 1 : 0
        if (eclipsePossible && sunEl > -0.005) {
          const frame = siteFrame(89.5 - y, x - 179.5, R)
          sunlight = visibleSunFraction(bodyAtVector(frame, now.sun), 0, bodyAtVector(frame, now.earth))
        }
        const [r, gg, bb] = blue ? [10 + sunlight * 80, 24 + sunlight * 145, 48 + sunlight * 207] : [0, 0, 0]
        const a = blue ? 175 - sunlight * 137 : 170 * (1 - sunlight)
        im.data[k] = r
        im.data[k + 1] = gg
        im.data[k + 2] = bb
        im.data[k + 3] = a
      }
    }
    g.putImageData(im, 0, 0)
    const sub = (v: number[]) => {
      const l = Math.hypot(v[0], v[1], v[2])
      return { lat: (Math.asin(v[2] / l) * 180) / Math.PI, lon: (Math.atan2(v[1], v[0]) * 180) / Math.PI }
    }
    return { canvas: c, subSun: sub(now.sun), subEarth: sub(now.earth) }
  }, [now, earthOn, observerM, earthMinClear, requireDsn])
}

const KM_PER_DEG = (1737.4 * Math.PI) / 180
const HOME = { clon: 0, clat: 0, half: 90 } // the Earth-facing hemisphere fills the square
const wrap180 = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180
const shortName = (s: SiteRecord) => (s.group === 'Apollo' ? s.name.split(' ').slice(0, 2).join(' ') : s.name.split(' (')[0])

/** Read back the share of 2027 with Earth up from the overlay's alpha (see build_globe.colour). */
function useEarthLookup(img: HTMLImageElement | null) {
  return useMemo(() => {
    if (!img) return null
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    return (lat: number, lon: number) => {
      const x = Math.min(width - 1, Math.max(0, Math.floor(((wrap180(lon) + 180) / 360) * width)))
      const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)))
      const a = data[(y * width + x) * 4 + 3]
      return Math.pow(a / 150, 1 / 0.8)
    }
  }, [img])
}

export function GlobeMap({ basemap, sites, selectedId, pinned, onSelect, onPickPoint, now, modeSwitch, observerM, earthMinClear, requireDsn }: Props) {
  const g = basemap.globe!
  const { ref, w } = useCanvas((cw) => cw)
  // wheel zooms the map: React wheel handlers are passive, so stop the page scrolling with a native listener
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const stop = (e: WheelEvent) => e.preventDefault()
    c.addEventListener("wheel", stop, { passive: false })
    return () => c.removeEventListener("wheel", stop)
  }, [ref])
  const relief = useImage(`./data/${g.relief}`)
  const earthImg = useImage(`./data/${g.earthvis}`)
  const earthAt = useEarthLookup(earthImg)
  const [showEarth, setShowEarth] = useState(true)
  const [instant, setInstant] = useState(true) // the moment on the timeline instead of the 2027 average
  const moment = useMoment(instant ? now : undefined, showEarth, observerM, earthMinClear, requireDsn)
  const photo = usePhotos()
  const [view, setView] = useState(HOME)
  const [hover, setHover] = useState<{ lat: number; lon: number } | null>(null)
  const drag = useRef<{ x: number; y: number; clon: number; clat: number; moved: boolean } | null>(null)

  const clampLat = (clat: number, half: number) => (half >= 90 ? 0 : Math.max(-90 + half, Math.min(90 - half, clat)))

  // follow the selected site when it is off-screen
  useEffect(() => {
    const s = sites.find((x) => x.id === selectedId)
    if (!s) return
    setView((v) => {
      const dx = Math.abs(wrap180(s.lon - v.clon))
      const inside = dx < v.half * 0.85 && Math.abs(s.lat - v.clat) < v.half * 0.85
      return inside ? v : { ...v, clon: wrap180(s.lon), clat: clampLat(s.lat, v.half) }
    })
  }, [selectedId, sites])

  useEffect(() => {
    const ctx = prep(ref.current, w, w)
    if (!ctx) return
    const s = w / (2 * view.half)
    const px = (lon: number) => w / 2 + wrap180(lon - view.clon) * s
    const py = (lat: number) => w / 2 - (lat - view.clat) * s
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, w)
    ctx.imageSmoothingQuality = 'high'
    // the image spans -180..180; draw the copies that overlap the view
    const draw = (img: HTMLImageElement | null) => {
      if (!img) return
      const left = w / 2 + (-180 - view.clon) * s
      for (const k of [-1, 0, 1]) ctx.drawImage(img, left + k * 360 * s, py(90), 360 * s, 180 * s)
    }
    draw(relief)
    if (moment) {
      const left = w / 2 + (-180 - view.clon) * s
      ctx.imageSmoothingEnabled = true
      for (const k of [-1, 0, 1]) ctx.drawImage(moment.canvas, left + k * 360 * s, py(90), 360 * s, 180 * s)
    } else if (showEarth) draw(earthImg)

    // graticule
    const step = view.half > 45 ? 30 : view.half > 15 ? 10 : view.half > 5 ? 5 : 1
    ctx.strokeStyle = 'rgba(233,238,246,0.13)'
    ctx.fillStyle = 'rgba(233,238,246,0.5)'
    ctx.font = '10px IBM Plex Mono, monospace'
    ctx.lineWidth = 1
    for (let lat = -90 + step; lat < 90; lat += step) {
      const y = py(lat)
      if (y < 0 || y > w) continue
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      ctx.fillText(lat === 0 ? '0°' : `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`, 4, y - 3)
    }
    const lon0 = Math.ceil((view.clon - view.half) / step) * step
    for (let lon = lon0; lon <= view.clon + view.half; lon += step) {
      const x = px(lon)
      const L = wrap180(lon)
      ctx.strokeStyle = L === 0 ? 'rgba(90,169,255,0.4)' : 'rgba(233,238,246,0.13)'
      ctx.setLineDash(L === 0 ? [4, 6] : [])
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, w)
      ctx.stroke()
      ctx.setLineDash([])
      if (x > 24 && x < w - 40) ctx.fillText(L === 0 ? '0°' : `${Math.abs(L)}°${L > 0 ? 'E' : 'W'}`, x + 3, w - 30)
    }
    // sites: south-polar sites collapse at this scale, so they get dots but no labels
    const shown = sites
      .map((site) => ({ site, X: px(site.lon), Y: py(site.lat), sel: site.id === selectedId, polar: site.lat < -80 }))
      .filter(({ X, Y }) => X > -20 && Y > -20 && X < w + 20 && Y < w + 20)
    for (const { site, X, Y, sel, polar } of shown) {
      ctx.fillStyle = GROUP_COLOR[site.group] ?? '#fff'
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(X, Y, sel ? 6 : polar && view.half > 30 ? 3 : 4.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fill()
      if (pinned.includes(site.id)) {
        ctx.strokeStyle = 'rgba(90,169,255,0.9)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(X, Y, 9, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (sel) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(X, Y, 13, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    // labels: selected first; right of the dot, else left; skipped if both would cover another label or dot
    const boxes: number[][] = []
    const dotBox = (X: number, Y: number) => [X - 5, Y - 5, X + 5, Y + 5]
    for (const { site, X, Y, sel, polar } of [...shown].sort((a, b) => Number(b.sel) - Number(a.sel))) {
      if (polar && !sel && view.half > 8) continue
      const label = shortName(site)
      ctx.font = `${sel ? 600 : 500} 11.5px Manrope, sans-serif`
      const tw = ctx.measureText(label).width
      const hits = (b: number[]) =>
        b[0] < 4 || b[2] > w - 4 ||
        [...boxes, ...shown.filter((o) => o.site !== site).map((o) => dotBox(o.X, o.Y))].some((o) => o[0] < b[2] && b[0] < o[2] && o[1] < b[3] && b[1] < o[3])
      const right = [X + 10, Y - 8, X + 14 + tw, Y + 6]
      const left = [X - 14 - tw, Y - 8, X - 10, Y + 6]
      const box = !hits(right) ? right : !hits(left) ? left : sel ? (right[2] < w - 4 ? right : left) : null
      if (!box) continue
      boxes.push(box)
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'
      ctx.strokeText(label, box[0] + 2, Y + 4)
      ctx.fillStyle = sel ? '#fff' : 'rgba(233,238,246,0.88)'
      ctx.fillText(label, box[0] + 2, Y + 4)
    }
    ctx.lineWidth = 1

    // scale bar along a meridian (east-west distances shrink with cos(latitude))
    const nice = [10, 20, 50, 100, 200, 500, 1000].find((km) => (km / KM_PER_DEG) * s > w * 0.16) ?? 1000
    const bw = (nice / KM_PER_DEG) * s
    ctx.fillStyle = 'rgba(233,238,246,0.85)'
    ctx.fillRect(w - bw - 14, w - 18, bw, 3)
    ctx.font = '10.5px IBM Plex Mono, monospace'
    ctx.textAlign = 'right'
    ctx.fillText(`${nice} km N–S`, w - 14, w - 24)
    ctx.textAlign = 'left'
    // the points directly under the Sun and under Earth
    if (moment) {
      const mark = (p: { lat: number; lon: number }, im: HTMLImageElement | null, color: string, label: string) => {
        const x = px(p.lon)
        const y = py(p.lat)
        if (x < -20 || x > w + 20 || y < -20 || y > w + 20) return
        if (im) drawDisk(ctx, im, x, y, 9)
        else {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x, y, 7, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.font = '600 11px Manrope, sans-serif'
        const flip = x + 14 + ctx.measureText(label).width > w - 56 // keep clear of the right edge and the tool buttons
        ctx.textAlign = flip ? 'right' : 'left'
        const tx = flip ? x - 12 : x + 12
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(6,8,12,0.9)'
        ctx.strokeText(label, tx, y + 4)
        ctx.fillStyle = color
        ctx.fillText(label, tx, y + 4)
        ctx.textAlign = 'left'
        ctx.lineWidth = 1
      }
      mark(moment.subSun, photo.sun, '#ffc24b', 'Sun overhead')
      mark(moment.subEarth, photo.earth, '#5aa9ff', 'Earth overhead')
    }
  }, [ref, w, view, relief, earthImg, showEarth, sites, selectedId, pinned, moment, photo.sun, photo.earth])

  const toLL = (e: { clientX: number; clientY: number }, el: HTMLElement): [number, number] => {
    const r = el.getBoundingClientRect()
    const s = w / (2 * view.half)
    return [view.clat - (e.clientY - r.top - w / 2) / s, wrap180(view.clon + (e.clientX - r.left - w / 2) / s)]
  }

  const nearestSite = (e: React.PointerEvent) => {
    const s = w / (2 * view.half)
    const [la, lo] = toLL(e, e.currentTarget as HTMLElement)
    let best: SiteRecord | null = null
    let bd = 12
    for (const site of sites) {
      const d = Math.hypot(wrap180(site.lon - lo), site.lat - la) * s
      if (d < bd) {
        bd = d
        best = site
      }
    }
    return best
  }

  const zoom = (f: number, at?: [number, number]) =>
    setView((v) => {
      const half = Math.max(3, Math.min(90, v.half * f))
      const [la, lo] = at ?? [v.clat, v.clon]
      const k = half / v.half
      return { half, clon: wrap180(lo - wrap180(lo - v.clon) * k), clat: clampLat(la - (la - v.clat) * k, half) }
    })

  const earth = hover && earthAt ? earthAt(hover.lat, hover.lon) : null
  return (
    <div className="mapcard">
    <div className="mapwrap">
      <canvas
        ref={ref}
        role="img"
        aria-label="Map of the whole Moon with Apollo and other landing sites, shaded by how often Earth is in view"
        onWheel={(e) => zoom(e.deltaY > 0 ? 1.25 : 0.8, toLL(e, e.currentTarget))}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, clon: view.clon, clat: view.clat, moved: false }
        }}
        onPointerMove={(e) => {
          const [lat, lon] = toLL(e, e.currentTarget)
          setHover({ lat, lon })
          const d = drag.current
          if (d) {
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (Math.hypot(dx, dy) > 3) d.moved = true
            const s = w / (2 * view.half)
            setView((v) => ({ ...v, clon: wrap180(d.clon - dx / s), clat: clampLat(d.clat + dy / s, v.half) }))
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (d && !d.moved) {
            const site = nearestSite(e)
            if (site) onSelect(site.id)
            else if (onPickPoint) {
              const [lat, lon] = toLL(e, e.currentTarget)
              onPickPoint(lat, (lon + 360) % 360)
            }
          }
        }}
        onPointerLeave={() => setHover(null)}
      />
      <div className="map-tools">
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.6)}>+</button>
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1 / 0.6)}>−</button>
        <button className="icon-btn" title="Show the near side" aria-label="Reset view" onClick={() => setView(HOME)}>⌂</button>
      </div>
    </div>
    <div className="map-below">
      <div className="map-controls">
        {modeSwitch}
        <button className="btn sm map-layer" title="Toggle Earth-visibility layer" aria-pressed={showEarth} aria-label="Toggle Earth visibility layer" onClick={() => setShowEarth((x) => !x)} style={{ color: showEarth ? 'var(--earth)' : undefined }}>◐ Earth view</button>
        {now && <button className="btn sm map-layer" title={instant ? 'Showing the moment on the timeline: switch to the 2027 average' : 'Show day, night and Earth view at the moment on the timeline'}
          aria-pressed={instant} aria-label="Toggle between this moment and the 2027 average" onClick={() => setInstant((v) => !v)} style={{ color: instant ? 'var(--text)' : undefined }}>◷ This moment</button>}
      </div>
      {moment && now && (
        <div className="map-legend br" title="Smooth-Moon geometry at this scale; the site views add the terrain">
          At {now.label} · smooth Moon
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <span><i className="sw night" />night / eclipse</span>{showEarth && <span><i className="sw earthup" />{requireDsn ? 'DSN antenna' : 'Earth centre'} ≥{earthMinClear}°</span>}
            {showEarth && requireDsn && <span>{now?.stationLabel}</span>}
          </div>
        </div>
      )}
      {showEarth && !moment && (
        <div className="map-legend br" title={`Share of ${g.earthvis_period} with Earth's centre above the horizon`}>
          Earth above the horizon, 2027
          <div className="ramp earthglobe" />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>never</span><span>always</span></div>
        </div>
      )}
      <div className="map-hud">
        {hover
          ? `${fmtLat(hover.lat)} ${fmtLon((hover.lon + 360) % 360)}${earth !== null ? ` · Earth up ${Math.round(Math.max(0, Math.min(1, earth)) * 100)}% of 2027` : ''}`
          : 'Click anywhere to add a site · scroll to zoom'}
      </div>
    </div>
    </div>
  )
}
