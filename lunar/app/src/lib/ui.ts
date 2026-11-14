import { useEffect, useRef, useState } from 'react'

/** Canvas sized to its CSS box at device pixel ratio; returns ref, CSS width and height. */
export function useCanvas(heightFor: (w: number) => number) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const heightRef = useRef(heightFor)
  heightRef.current = heightFor
  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth)
      setSize({ w, h: Math.round(heightRef.current(w)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // the height follows the latest rule every render, so a changed fixed height applies without a width change
  return { ref, w: size.w, h: size.w ? Math.round(heightRef.current(size.w)) : size.h }
}

export function prep(canvas: HTMLCanvasElement | null, w: number, h: number) {
  if (!canvas || !w || !h) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return ctx
}

/** Timeline position, truncated to the same minute as its UTC clock (never rounded beyond the stay). */
export function fmtElapsed(h: number): string {
  const m = Math.max(0, Math.floor(h * 60 + 1e-7))
  const hours = Math.floor(m / 60)
  return hours ? `${hours} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`
}

export function fmtHours(h: number | null | undefined, opts: { approx?: boolean } = {}): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return '—'
  const a = opts.approx ? '≈' : ''
  if (h < 1) return `${a}${Math.round(h * 60)} min`
  if (h < 48) return `${a}${h < 10 ? h.toFixed(1) : Math.round(h)} h`
  const d = Math.floor(h / 24)
  const r = Math.round(h - d * 24)
  if (r === 24) return `${a}${d + 1} d`
  return r ? `${a}${d} d ${r} h` : `${a}${d} d`
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmtDate(unix: number, withTime = true): string {
  const d = new Date(unix * 1000)
  const day = `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  if (!withTime) return day
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

export const fmtShortDate = (unix: number) => {
  const d = new Date(unix * 1000)
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`
}

export const monthLabel = (unix: number) => {
  const d = new Date(unix * 1000)
  return `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
}

export function toInputValue(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16)
}

export function fromInputValue(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null // Date.parse accepts too much (e.g. 'notadate' -> 2000)
  const t = Date.parse(`${v}:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 16) === v ? t / 1000 : null
}

export const fmtLat = (lat: number) => `${Math.abs(lat).toFixed(lat < -89 ? 3 : 2)}°${lat < 0 ? 'S' : 'N'}`
export const fmtLon = (lon: number) => `${(((lon % 360) + 360) % 360).toFixed(2)}°E`

/** Perceptual sequential ramp: night → amber → white (for sunlight). */
export function sunRamp(t: number): string {
  const stops: [number, number, number][] = [
    [14, 18, 28], [70, 44, 10], [178, 112, 24], [255, 194, 75], [255, 244, 214],
  ]
  return ramp(stops, t)
}

export function earthRamp(t: number): string {
  const stops: [number, number, number][] = [[14, 18, 28], [20, 52, 96], [44, 112, 196], [90, 169, 255], [214, 236, 255]]
  return ramp(stops, t)
}

/** For "lower is better" (darkness): white-hot good → deep red bad. */
export function darkRamp(t: number): string {
  const stops: [number, number, number][] = [[230, 246, 236], [73, 214, 164], [255, 181, 71], [255, 107, 91], [92, 20, 26]]
  return ramp(stops, t)
}

function ramp(stops: [number, number, number][], t: number): string {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1)
  const k = Math.min(stops.length - 2, Math.floor(x))
  const f = x - k
  const c = stops[k].map((v, i) => Math.round(v + (stops[k + 1][i] - v) * f))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

// ---- NASA photos of the Sun and Earth for sky charts ----
// Sun: SDO/HMI visible-light continuum, 23 Oct 2014 (NASA/SDO). Earth: "Blue Marble", Apollo 17, AS17-148-22727 (NASA).
const photos: Record<'sun' | 'earth', HTMLImageElement | null> = { sun: null, earth: null }
const photoListeners = new Set<() => void>()
function loadPhoto(k: 'sun' | 'earth') {
  if (typeof Image === 'undefined' || photos[k]) return
  const im = new Image()
  im.onload = () => photoListeners.forEach((f) => f())
  im.src = new URL(`./img/${k}.png`, document.baseURI).href
  photos[k] = im
}

/** The two photos, re-rendering the caller once they have loaded. */
export function usePhotos() {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    photoListeners.add(f)
    loadPhoto('sun')
    loadPhoto('earth')
    return () => void photoListeners.delete(f)
  }, [])
  const ok = (im: HTMLImageElement | null) => (im && im.complete && im.naturalWidth ? im : null)
  return { sun: ok(photos.sun), earth: ok(photos.earth) }
}

/**
 * A photo disk of radius r at (x, y). With `phase`, the night side is shaded: the terminator is a half-ellipse
 * whose width follows the phase angle, and the bright limb faces `phase.pa`.
 */
export function drawDisk(ctx: CanvasRenderingContext2D, im: HTMLImageElement, x: number, y: number, r: number, phase?: { cosAlpha: number; pa: number }) {
  ctx.drawImage(im, x - r, y - r, 2 * r, 2 * r)
  if (!phase) return
  const k = -phase.cosAlpha // terminator x at the equator, in disk radii, with the Sun toward +x
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(phase.pa)
  ctx.beginPath()
  ctx.arc(0, 0, r + 0.5, -Math.PI / 2, Math.PI / 2, true) // the limb away from the Sun
  ctx.ellipse(0, 0, Math.abs(k) * r, r + 0.5, 0, Math.PI / 2, -Math.PI / 2, k > 0) // back along the terminator
  ctx.closePath()
  ctx.fillStyle = 'rgba(4,6,10,0.86)'
  ctx.fill()
  ctx.restore()
}

/** A canvas label cut to fit a width: the full name, then the part before any bracket, then an ellipsis. */
export function fitLabel(ctx: CanvasRenderingContext2D, label: string, maxW: number): string {
  if (ctx.measureText(label).width <= maxW) return label
  const short = label.split(' (')[0]
  if (ctx.measureText(short).width <= maxW) return short
  let s = short
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1)
  return `${s.trimEnd()}…`
}
