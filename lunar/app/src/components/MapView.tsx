import { ReactNode, useEffect, useRef, useState } from 'react'
import { Basemap, SiteRecord, toLatLon, toXY } from '../lib/data'
import { fitLabel, fmtLat, fmtLon, prep, useCanvas } from '../lib/ui'
import { GlobeMap } from './GlobeMap'

interface Props {
  basemap: Basemap
  sites: SiteRecord[]
  selectedId: string
  pinned: string[]
  onSelect: (id: string) => void
  onPickPoint?: (lat: number, lon: number) => void
  observerM: number
  earthMinClear: number
  requireDsn: boolean
  now?: { sun: number[]; earth: number[]; label: string; dsnAvailable: boolean; stations?: Float32Array; stationLabel?: string } // station geometry is sampled hourly
}

// ---- light and Earth view at one moment, computed in a worker of its own ----
let shadeWorker: Worker | null = null
let shadeSeq = 0
interface Shade { canvas: HTMLCanvasElement; cx: number; cy: number; half: number; body: 'sun' | 'earth'; label: string; observerM: number; clearanceDeg: number }
const SHADE_N = 320

/**
 * Throttled, not debounced: while the timeline plays, the cursor moves every frame, so a debounce would never fire.
 * One job runs at a time; the newest request waits and starts the moment the running one ends, and every image
 * carries the time it was computed for, so the map never labels an old image with the new time.
 */
function useShade(on: boolean, body: 'sun' | 'earth', cx: number, cy: number, half: number, vec: number[] | undefined, label: string, occluder: number[] | undefined, observerM: number, clearanceDeg: number, available: boolean, stations?: Float32Array) {
  const [shade, setShade] = useState<Shade | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const pending = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  const key = on && vec ? `${body}|${Math.round(cx / 2000)}|${Math.round(cy / 2000)}|${Math.round(half / 2000)}|${vec.map((v) => v.toFixed(0)).join(',')}|${observerM}|${clearanceDeg}|${available}|${stations ? label : ''}` : ''
  useEffect(() => {
    if (!key || !vec) { pending.current = null; return }
    const run = () => {
      shadeWorker ??= new Worker(new URL('../lib/horizon.worker.ts', import.meta.url), { type: 'module' })
      const w = shadeWorker
      const id = `shade-${++shadeSeq}`
      const [lat, lon] = toLatLon(cx, cy)
      running.current = true
      setBusy(true)
      const onMsg = (e: MessageEvent) => {
        if (e.data.id !== id) return
        w.removeEventListener('message', onMsg)
        running.current = false
        const next = pending.current
        pending.current = null
        if (next) next()
        else if (mounted.current) setBusy(false)
        if (!e.data.ok || !mounted.current) return
        const n = e.data.n as number
        const d = e.data.data as Uint8Array
        const c = document.createElement('canvas')
        c.width = c.height = n
        const g = c.getContext('2d')!
        const im = g.createImageData(n, n)
        // shadow: near-black; lit: warm (Sun) or blue (Earth), blended by the visible fraction of the disk
        const lit = body === 'sun' ? [255, 196, 96, 0.3] : [90, 169, 255, 0.42]
        const dark = [4, 7, 13, body === 'sun' ? 0.78 : 0.7]
        for (let k = 0; k < n * n; k++) {
          const v = d[k]
          if (v === 255) continue
          const f = v / 250
          im.data[4 * k] = dark[0] + (lit[0] - dark[0]) * f
          im.data[4 * k + 1] = dark[1] + (lit[1] - dark[1]) * f
          im.data[4 * k + 2] = dark[2] + (lit[2] - dark[2]) * f
          im.data[4 * k + 3] = 255 * (dark[3] + (lit[3] - dark[3]) * f)
        }
        g.putImageData(im, 0, 0)
        setShade({ canvas: c, cx: e.data.cx, cy: e.data.cy, half: e.data.half, body, label, observerM, clearanceDeg })
      }
      w.addEventListener('message', onMsg)
      // for sunlight, Earth is an occluder too: during an eclipse it covers part or all of the Sun
      w.postMessage({ kind: 'shade', id, lat, lon, half, n: SHADE_N, body: vec, radiusKm: body === 'sun' ? 696_000 : 0,
        occluder: body === 'sun' ? occluder : undefined, observerM, clearanceDeg, available, stations, root: new URL('./data/terrain/', document.baseURI).href })
    }
    if (running.current) pending.current = run // replaces any older waiting request
    else run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null } }, [])
  return { shade: on ? shade : null, busy: on && busy }
}

export const GROUP_COLOR: Record<string, string> = {
  Flown: '#ff7a6b',
  'Best-lit': '#ffc24b',
  'Artemis III region': '#5aa9ff',
  Reference: '#b9c3d3',
  'My sites': '#49d6a4',
  Apollo: '#e9eef6',
  'Other landers': '#d59bff',
  Upcoming: '#5fe3d0',
}

/** Sites north of this latitude are only on the whole-Moon map. */
const POLAR_MAP_LIMIT = -60

const loaded = new Map<string, HTMLImageElement>()
/** Raw sunlight and Earth-in-view shares behind the polar layers, for the hover readout. */
let layerValues: Promise<Uint8Array | null> | null = null
function useLayerValues(file?: string) {
  const [v, setV] = useState<Uint8Array | null>(null)
  useEffect(() => {
    if (!file) return
    layerValues ??= fetch(`./data/${file}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null)
    layerValues.then(setV)
  }, [file])
  return v
}

export function useImage(src: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(loaded.get(src) ?? null)
  useEffect(() => {
    if (!src) return setImg(null) // an empty src would make the browser re-request the page
    if (loaded.has(src)) return setImg(loaded.get(src)!)
    const im = new Image()
    im.onload = () => {
      loaded.set(src, im)
      setImg(im)
    }
    im.src = src
  }, [src])
  return img
}

type Mode = 'pole' | 'globe'
const modeFor = (s?: SiteRecord): Mode => (s && s.lat > POLAR_MAP_LIMIT ? 'globe' : 'pole')

/** South-pole map or whole-Moon map; follows the selected site to the map that shows it. */
export function MapView(props: Props) {
  const selected = props.sites.find((s) => s.id === props.selectedId)
  const [mode, setMode] = useState<Mode>(() => modeFor(selected))
  useEffect(() => {
    if (selected) setMode(modeFor(selected))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId])
  const modeSwitch = props.basemap.globe ? (
    <div className="seg map-mode" role="tablist" aria-label="Map">
      <button role="tab" aria-pressed={mode === 'pole'} onClick={() => setMode('pole')}>South pole</button>
      <button role="tab" aria-pressed={mode === 'globe'} onClick={() => setMode('globe')}>Whole Moon</button>
    </div>
  ) : null
  return mode === 'globe' && props.basemap.globe ? <GlobeMap {...props} modeSwitch={modeSwitch} /> : <PolarMap {...props} modeSwitch={modeSwitch} />
}

function PolarMap({ basemap, sites, selectedId, pinned, onSelect, onPickPoint, now, modeSwitch, observerM, earthMinClear, requireDsn }: Props & { modeSwitch: ReactNode }) {
  const { ref, w } = useCanvas((cw) => cw)
  // wheel zooms the map: React wheel handlers are passive, so stop the page scrolling with a native listener
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const stop = (e: WheelEvent) => e.preventDefault()
    c.addEventListener("wheel", stop, { passive: false })
    return () => c.removeEventListener("wheel", stop)
  }, [ref])
  const overview = useImage(`./data/${basemap.overview.file}`)
  const detail = useImage(`./data/${basemap.detail.file}`)
  // one computed layer at a time over the relief: average sunlight or Earth in view
  const [layer, setLayer] = useState<'sun' | 'earth' | null>('sun')
  const [earthWanted, setEarthWanted] = useState(false) // fetch the Earth layer only once it is asked for
  useEffect(() => { if (layer === 'earth') setEarthWanted(true) }, [layer])
  const earthImg = useImage(basemap.earthvis_polar && earthWanted ? `./data/${basemap.earthvis_polar.file}` : '')
  // view: centre (m) and half-extent (m)
  const [view, setView] = useState({ cx: 0, cy: 0, half: 90_000 })
  // the layer at the timeline's moment instead of the 2027 average, over the square in view (up to ±120 km)
  const [instant, setInstant] = useState(true)
  const shadeHalf = Math.max(8_000, Math.min(120_000, view.half))
  const nativeDsn = layer === 'earth' && requireDsn ? now?.stations : undefined
  const { shade, busy: shadeBusy } = useShade(instant && !!layer && !!now, layer === 'earth' ? 'earth' : 'sun', view.cx, view.cy, shadeHalf, layer === 'earth' ? now?.earth : now?.sun, (nativeDsn ? now?.stationLabel : now?.label) ?? '', now?.earth,
    observerM, layer === 'earth' ? earthMinClear : 0, !!nativeDsn || layer !== 'earth' || !requireDsn || !!now?.dsnAvailable, nativeDsn)
  const showIllum = layer === 'sun' && !instant
  const [illumWanted, setIllumWanted] = useState(false) // the 2027 average layer loads once it is shown
  useEffect(() => { if (showIllum) setIllumWanted(true) }, [showIllum])
  const illum = useImage(basemap.illumination && illumWanted ? `./data/${basemap.illumination.file}` : '')
  const [hover, setHover] = useState<{ lat: number; lon: number; x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null)
  const lv = basemap.layer_values
  const [hovered, setHovered] = useState(false) // the readout grid loads on the first hover
  const values = useLayerValues(hovered ? lv?.file : undefined)
  const [suggestion, setSuggestion] = useState<{ x: number; y: number; sun: number; earth: number } | null>(null)
  const [suggestWanted, setSuggestWanted] = useState(false)
  const valueAt = (x: number, y: number) => {
    if (!values || !lv) return null
    const c = Math.round((x + lv.half_extent_m) / lv.step_m)
    const r = Math.round((lv.half_extent_m - y) / lv.step_m)
    if (c < 0 || r < 0 || c >= lv.n || r >= lv.n) return null
    const k = r * lv.n + c
    const [sun, earth] = [values[k], values[lv.n * lv.n + k]]
    return sun === 255 || earth === 255 ? null : { sun: (100 * sun) / lv.scale, earth: (100 * earth) / lv.scale }
  }

  // follow the selected site when it is off-screen
  useEffect(() => {
    const s = sites.find((x) => x.id === selectedId)
    if (!s || s.lat > POLAR_MAP_LIMIT) return
    const [x, y] = toXY(s.lat, s.lon)
    setView((v) => {
      const inside = Math.abs(x - v.cx) < v.half * 0.85 && Math.abs(y - v.cy) < v.half * 0.85
      if (inside) return v
      const half = Math.hypot(x, y) > 200_000 ? Math.max(v.half, 120_000) : v.half
      return { cx: x, cy: y, half }
    })
  }, [selectedId, sites])

  useEffect(() => {
    const ctx = prep(ref.current, w, w)
    if (!ctx) return
    const s = w / (2 * view.half)
    const px = (x: number) => w / 2 + (x - view.cx) * s
    const py = (y: number) => w / 2 - (y - view.cy) * s
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, w)
    ctx.imageSmoothingQuality = 'high'
    const drawLayer = (img: HTMLImageElement | null, half: number, alpha = 1) => {
      if (!img) return
      ctx.globalAlpha = alpha
      ctx.drawImage(img, px(-half), py(half), 2 * half * s, 2 * half * s)
      ctx.globalAlpha = 1
    }
    drawLayer(overview, basemap.overview.half_extent_m)
    if (view.half < 400_000) drawLayer(detail, basemap.detail.half_extent_m)
    const overlay = instant ? null : layer === 'sun' ? basemap.illumination && { img: illum, half: basemap.illumination.half_extent_m } : layer === 'earth' ? basemap.earthvis_polar && { img: earthImg, half: basemap.earthvis_polar.half_extent_m } : null
    if (instant && shade) {
      // outside the computed square the relief is dimmed; inside, shadow and light at the moment
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, w, w)
      const x0 = px(shade.cx - shade.half)
      const y0 = py(shade.cy + shade.half)
      const side = 2 * shade.half * s
      ctx.clearRect(x0, y0, side, side)
      drawLayer(overview, basemap.overview.half_extent_m)
      if (view.half < 400_000) drawLayer(detail, basemap.detail.half_extent_m)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, y0, side, side)
      ctx.clip()
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(shade.canvas, x0, y0, side, side)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, w, Math.max(0, y0))
      ctx.fillRect(0, y0 + side, w, w)
      ctx.fillRect(0, y0, Math.max(0, x0), side)
      ctx.fillRect(x0 + side, y0, w, side)
      ctx.strokeStyle = 'rgba(233,238,246,0.25)'
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, side - 1, side - 1)
    }
    if (overlay) {
      // dim the relief so the layer glows and ground with none of it reads as black
      ctx.fillStyle = 'rgba(0,0,0,0.42)'
      ctx.fillRect(0, 0, w, w)
      ctx.globalCompositeOperation = 'screen'
      drawLayer(overlay.img, overlay.half, 1)
      ctx.globalCompositeOperation = 'source-over'
    }

    // latitude rings
    ctx.strokeStyle = 'rgba(233,238,246,0.14)'
    ctx.fillStyle = 'rgba(233,238,246,0.45)'
    ctx.font = '10px IBM Plex Mono, monospace'
    for (const lat of [-89, -88, -87, -86, -85, -84, -82, -80, -75, -70]) {
      const r = Math.hypot(...toXY(lat, 0)) * s
      if (r < 6 || r > w * 3) continue
      ctx.beginPath()
      ctx.arc(px(0), py(0), r, 0, Math.PI * 2)
      ctx.stroke()
      const ly = py(0) - r
      if (ly > 4 && ly < w - 4) ctx.fillText(`${-lat}°S`, px(0) + 4, ly + 10)
    }
    // Earth-facing meridian
    ctx.strokeStyle = 'rgba(90,169,255,0.35)'
    ctx.setLineDash([4, 6])
    ctx.beginPath()
    ctx.moveTo(px(0), py(0))
    ctx.lineTo(px(0), py(2_000_000))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(90,169,255,0.8)'
    ctx.fillText('0°E · toward Earth ↑', Math.min(w - 130, px(0) + 6), 14)

    // Artemis III candidate region boxes (digitised from NASA's 2024 map)
    for (const site of sites) {
      if (!site.region_xy) continue
      const [x1, x2, y1, y2] = site.region_xy
      const sel = site.id === selectedId
      ctx.strokeStyle = sel ? 'rgba(90,169,255,0.95)' : 'rgba(90,169,255,0.55)'
      ctx.lineWidth = sel ? 1.8 : 1.1
      ctx.setLineDash(sel ? [] : [4, 3])
      ctx.strokeRect(px(x1), py(y2), (x2 - x1) * s, (y2 - y1) * s)
      ctx.setLineDash([])
      if (view.half < 140_000) {
        ctx.font = '600 10.5px Manrope, sans-serif'
        ctx.fillStyle = sel ? '#cfe4ff' : 'rgba(150,196,255,0.8)'
        ctx.fillText(site.name, px(x1) + 3, py(y2) - 4)
      }
      ctx.lineWidth = 1
    }

    // sites
    for (const site of sites) {
      if (site.lat > POLAR_MAP_LIMIT) continue // outside the south-polar projection
      const [x, y] = toXY(site.lat, site.lon)
      const X = px(x)
      const Y = py(y)
      if (X < -20 || Y < -20 || X > w + 20 || Y > w + 20) continue
      const sel = site.id === selectedId
      const col = GROUP_COLOR[site.group] ?? '#fff'
      ctx.fillStyle = col
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(X, Y, sel ? 6 : 4.5, 0, Math.PI * 2)
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
      ctx.lineWidth = 1
      if (sel || view.half < 60_000) {
        ctx.font = `${sel ? 600 : 500} 11.5px Manrope, sans-serif`
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(0,0,0,0.8)'
        const label = fitLabel(ctx, site.name, w - 54)
        const labelWidth = ctx.measureText(label).width
        const labelX = X + 12 + labelWidth < w - 40 ? X + 12 : Math.max(5, X - labelWidth - 16)
        ctx.strokeText(label, labelX, Y + 4)
        ctx.fillStyle = sel ? '#fff' : 'rgba(233,238,246,0.85)'
        ctx.fillText(label, labelX, Y + 4)
        ctx.lineWidth = 1
      }
    }
    if (suggestion) {
      const X = px(suggestion.x)
      const Y = py(suggestion.y)
      ctx.strokeStyle = '#49d6a4'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(X, Y, 10, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = '#49d6a4'
      ctx.font = '600 13px Manrope, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('★', X, Y + 4.5)
      ctx.textAlign = 'left'
      ctx.lineWidth = 1
    }
    // scale bar
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((km) => km * 1000 * s > w * 0.18) ?? 500
    const bw = nice * 1000 * s
    ctx.fillStyle = 'rgba(233,238,246,0.85)'
    ctx.fillRect(w - bw - 14, w - 18, bw, 3)
    ctx.font = '10.5px IBM Plex Mono, monospace'
    ctx.textAlign = 'right'
    ctx.fillText(`${nice} km`, w - 14, w - 24)
    ctx.textAlign = 'left'
  }, [ref, w, view, overview, detail, illum, earthImg, layer, basemap, sites, selectedId, pinned, suggestion, instant, shade])

  // suggest the point in view where the weaker of sunlight and Earth-in-view is strongest
  useEffect(() => {
    if (!suggestWanted || !values || !lv) return
    setSuggestWanted(false)
    let best: { x: number; y: number; sun: number; earth: number } | null = null
    const n = lv.n
    for (let r = 0; r < n; r++) {
      const y = lv.half_extent_m - r * lv.step_m
      if (Math.abs(y - view.cy) > view.half * 0.9) continue
      for (let c = 0; c < n; c++) {
        const x = -lv.half_extent_m + c * lv.step_m
        if (Math.abs(x - view.cx) > view.half * 0.9) continue
        const sun = values[r * n + c]
        const earth = values[n * n + r * n + c]
        if (sun === 255 || earth === 255) continue
        if (!best || Math.min(sun, earth) > Math.min(best.sun, best.earth)) best = { x, y, sun, earth }
      }
    }
    setSuggestion(best && { ...best, sun: (100 * best.sun) / lv.scale, earth: (100 * best.earth) / lv.scale })
  }, [suggestWanted, values, lv, view])

  const toWorld = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const s = w / (2 * view.half)
    return [view.cx + (e.clientX - r.left - w / 2) / s, view.cy - (e.clientY - r.top - w / 2) / s]
  }

  const nearestSite = (e: React.PointerEvent) => {
    const s = w / (2 * view.half)
    const [wx, wy] = toWorld(e, e.currentTarget as HTMLElement)
    let best: SiteRecord | null = null
    let bd = 14
    for (const site of sites) {
      if (site.lat > POLAR_MAP_LIMIT) continue
      const [x, y] = toXY(site.lat, site.lon)
      const d = Math.hypot(x - wx, y - wy) * s
      if (d < bd) {
        bd = d
        best = site
      }
    }
    return best
  }

  return (
    <div className="mapcard">
    <div className="mapwrap">
      <canvas
        ref={ref}
        role="img"
        aria-label="Map of the lunar south pole with candidate and flown landing sites"
        onWheel={(e) => {
          const f = e.deltaY > 0 ? 1.25 : 0.8
          const [wx, wy] = toWorld(e, e.currentTarget)
          setView((v) => {
            const half = Math.max(3_000, Math.min(700_000, v.half * f))
            const k = half / v.half
            return { half, cx: wx - (wx - v.cx) * k, cy: wy - (wy - v.cy) * k }
          })
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false }
        }}
        onPointerMove={(e) => {
          const [wx, wy] = toWorld(e, e.currentTarget)
          const [lat, lon] = toLatLon(wx, wy)
          setHover({ lat, lon, x: wx, y: wy })
          setHovered(true)
          const d = drag.current
          if (d) {
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (Math.hypot(dx, dy) > 3) d.moved = true
            const s = w / (2 * view.half)
            setView((v) => ({ ...v, cx: d.cx - dx / s, cy: d.cy + dy / s }))
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (d && !d.moved) {
            const site = nearestSite(e)
            if (site) onSelect(site.id)
            else if (onPickPoint) {
              const [wx, wy] = toWorld(e, e.currentTarget)
              const [lat, lon] = toLatLon(wx, wy)
              onPickPoint(lat, lon)
            }
          }
        }}
        onPointerLeave={() => setHover(null)}
      />
      <div className="map-tools">
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => setView((v) => ({ ...v, half: Math.max(3_000, v.half * 0.6) }))}>+</button>
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => setView((v) => ({ ...v, half: Math.min(700_000, v.half / 0.6) }))}>−</button>
        <button className="icon-btn" title="Reset view" aria-label="Reset view" onClick={() => setView({ cx: 0, cy: 0, half: 90_000 })}>⌂</button>
      </div>
      {suggestion && (
        <div className="map-suggest">
          <b>★ Suggested spot in view</b> {fmtLat(toLatLon(suggestion.x, suggestion.y)[0])} {fmtLon(toLatLon(suggestion.x, suggestion.y)[1])}
          <div className="muted">map cell, 2027: Sun {suggestion.sun.toFixed(0)}% · Earth {suggestion.earth.toFixed(0)}%</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {onPickPoint && <button className="btn sm" onClick={() => { const [la, lo] = toLatLon(suggestion.x, suggestion.y); onPickPoint(la, lo); setSuggestion(null) }}>Add as my site</button>}
            <button className="btn sm ghost" onClick={() => setSuggestion(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
    <div className="map-below">
      <div className="map-controls">
        {modeSwitch}
        {basemap.illumination && (
          <button className="btn sm map-layer" title="Average-sunlight layer" aria-pressed={layer === 'sun'} aria-label="Toggle average sunlight layer" onClick={() => setLayer((x) => (x === 'sun' ? null : 'sun'))} style={{ color: layer === 'sun' ? 'var(--sun)' : undefined }}>☀ Avg sunlight</button>
        )}
        {basemap.earthvis_polar && (
          <button className="btn sm map-layer" title="Earth-in-view layer: share of 2027 with Earth above the terrain skyline" aria-pressed={layer === 'earth'} aria-label="Toggle Earth in view layer" onClick={() => setLayer((x) => (x === 'earth' ? null : 'earth'))} style={{ color: layer === 'earth' ? 'var(--earth)' : undefined }}>◐ Earth view</button>
        )}
        {now && (
          <button className="btn sm map-layer" title={instant ? 'Showing the moment on the timeline: switch to the 2027 average' : 'Show light and shadow (or Earth view) at the moment on the timeline'}
            aria-pressed={instant} aria-label="Toggle the layer between this moment and the 2027 average" onClick={() => setInstant((v) => !v)} style={{ color: instant ? 'var(--text)' : undefined }}>◷ This moment</button>
        )}
        {lv && (
          <button className="btn sm map-layer" title="Suggest the spot in view with the most Sun and Earth together (the weaker of the two map layers, 2027)" aria-label="Suggest a spot in view"
            onClick={() => { setHovered(true); setSuggestWanted(true) }} style={{ color: suggestion ? '#49d6a4' : undefined }}>★ Suggest a spot</button>
        )}
      </div>
      {basemap.illumination && showIllum && (
        <div className="map-legend">
          Average sunlight, {basemap.illumination.period} · 2 m
          <div className="ramp" />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>0%</span><span>{basemap.illumination.top_pct ?? 85}%{basemap.illumination.max_pct != null && ` (peak ${basemap.illumination.max_pct.toFixed(0)}%)`}</span></div>
        </div>
      )}
      {instant && layer && now && (
        <div className="map-legend" data-completed-time={shade?.label ?? ''}>
          {layer === 'sun' ? 'Sunlight' : 'Earth contact geometry'} at {shade && shade.body === (layer === 'earth' ? 'earth' : 'sun') ? shade.label : now.label}{shadeBusy ? ' · updating…' : ''}
          <div>{shade?.observerM ?? observerM} m above ground{layer === 'earth' ? ` · ${requireDsn ? 'antenna' : 'centre'} ≥${shade?.clearanceDeg ?? earthMinClear}°${requireDsn ? ' · +DSN' : ''}` : ' · eclipses included'}</div>
          <div className={`ramp ${layer === 'sun' ? 'now' : 'nowearth'}`} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{layer === 'sun' ? 'shadow' : 'hidden'}</span><span>{layer === 'sun' ? 'full Sun' : 'in view'}</span></div>
        </div>
      )}
      {basemap.earthvis_polar && layer === 'earth' && !instant && (
        <div className="map-legend">
          Earth centre above skyline, {basemap.earthvis_polar.period} · 2 m
          <div className="ramp earthpolar" />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>0%</span><span>85%+</span></div>
        </div>
      )}
      <div className="map-hud">
        {hover
          ? (() => {
              const v = valueAt(hover.x, hover.y)
              return `${fmtLat(hover.lat)} ${fmtLon(hover.lon)}${v ? ` · 2027: Sun ${v.sun.toFixed(0)}% · Earth ${v.earth.toFixed(0)}%` : ''}`
            })()
          : 'Click terrain to add a site · scroll to zoom'}
      </div>
    </div>
    </div>
  )
}
