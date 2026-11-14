import { useEffect, useState } from 'react'
import { Ephemeris, timeOf } from '../lib/astro'
import { Track, earthVisible } from '../lib/metrics'
import { fitLabel, fmtDate, fmtHours, fmtShortDate, prep, useCanvas } from '../lib/ui'

export interface Row {
  id: string
  label: string
  track: Track
  highlight?: boolean
}

interface Props {
  eph: Ephemeris
  rows: Row[]
  i0: number
  len: number
  cursor: number
  onCursor: (absIndex: number) => void
  onPick?: (id: string) => void
  detailed?: boolean // full Sun / Earth / both bands with annotations for the first row
}

const LABEL_W = 184

/** Darkness intervals inside the window: [start, end) absolute indices. */
function darkRuns(t: Track, a: number, b: number) {
  const runs: [number, number][] = []
  let s = -1
  for (let i = a; i < b; i++) {
    const dark = t.sunFrac[i] <= 0
    if (dark && s < 0) s = i
    if (!dark && s >= 0) {
      runs.push([s, i])
      s = -1
    }
  }
  if (s >= 0) runs.push([s, b])
  return runs
}

export function Timeline({ eph, rows, i0, len, cursor, onCursor, onPick, detailed }: Props) {
  const bandH = detailed ? 22 : 16
  const rowH = detailed ? bandH * 3 + 30 : bandH * 2 + 12
  const extra = detailed && rows.length > 1 ? (rows.length - 1) * (16 * 2 + 12) : 0
  const totalH = 26 + (detailed ? rowH + extra : rows.length * rowH) + 8
  const { ref, w } = useCanvas(() => totalH)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const a = Math.round(i0)
  const b = a + Math.round(len)

  useEffect(() => {
    const ctx = prep(ref.current, w, totalH)
    if (!ctx) return
    const x0 = LABEL_W
    const pw = w - x0 - 8
    const X = (i: number) => x0 + ((i - a) / (b - a)) * pw

    // day ticks
    ctx.font = '10.5px IBM Plex Mono, monospace'
    ctx.textBaseline = 'top'
    const startUnix = timeOf(eph, a)
    const firstMidnight = Math.ceil(startUnix / 86400) * 86400
    const days = (b - a) / 24
    const every = days > 40 ? 7 : days > 16 ? 2 : 1
    let dayIdx = 0
    for (let tu = firstMidnight; tu < timeOf(eph, b); tu += 86400, dayIdx++) {
      const i = a + (tu - startUnix) / eph.stepS
      const x = X(i)
      ctx.strokeStyle = 'rgba(139,151,170,0.1)'
      ctx.beginPath()
      ctx.moveTo(x, 20)
      ctx.lineTo(x, totalH - 4)
      ctx.stroke()
      if (dayIdx % every === 0) {
        ctx.fillStyle = '#5b6678'
        ctx.textAlign = 'left'
        ctx.fillText(fmtShortDate(tu), x + 3, 4)
      }
    }

    let y = 26
    rows.forEach((row, ri) => {
      const t = row.track
      const full = detailed && ri === 0
      const bh = full ? bandH : 16
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      if (full) {
        const labels = [['Sunlight', '#ffc24b'], ['Earth in view', '#5aa9ff'], ['Sun + Earth', '#49d6a4']]
        labels.forEach(([lab, col], k) => {
          ctx.fillStyle = col
          ctx.font = '600 12px Manrope, sans-serif'
          ctx.fillText(lab, 8, y + k * (bh + 4) + bh / 2)
        })
      } else {
        ctx.fillStyle = row.highlight ? '#e9eef6' : '#8b97aa'
        ctx.font = `${row.highlight ? 600 : 500} 12px Manrope, sans-serif`
        const lab = fitLabel(ctx, row.label, LABEL_W - 14)
        ctx.fillText(lab, 8, y + bh)
      }
      // backgrounds
      const bands = full ? 3 : 2
      for (let k = 0; k < bands; k++) {
        ctx.fillStyle = '#0e131c'
        ctx.fillRect(x0, y + k * (bh + 4), pw, bh)
      }
      const cw = Math.max(1, pw / (b - a))
      for (let i = a; i < b; i++) {
        const x = X(i)
        const f = t.sunFrac[i]
        if (f > 0) {
          ctx.globalAlpha = 0.25 + 0.75 * f
          ctx.fillStyle = '#ffc24b'
          ctx.fillRect(x, y, cw + 0.5, bh)
        }
        const ev = earthVisible(t, i)
        if (ev) {
          ctx.globalAlpha = 0.9
          ctx.fillStyle = '#5aa9ff'
          ctx.fillRect(x, y + bh + 4, cw + 0.5, bh)
        }
        if (full && ev && f > 0) {
          ctx.globalAlpha = 0.9
          ctx.fillStyle = '#49d6a4'
          ctx.fillRect(x, y + 2 * (bh + 4), cw + 0.5, bh)
        }
      }
      ctx.globalAlpha = 1
      if (full) {
        // annotate darkness
        ctx.font = '600 11px Manrope, sans-serif'
        ctx.textAlign = 'center'
        for (const [s, e] of darkRuns(t, a, b)) {
          const xa = X(s)
          const xb = X(e)
          if (xb - xa > 56) {
            ctx.fillStyle = '#ff9a8e'
            ctx.fillText(`dark ${fmtHours(e - s)}${e === b ? '+' : ''}`, (xa + xb) / 2, y + bh / 2)
          }
        }
        y += 3 * (bh + 4) + 26
      } else {
        y += bh * 2 + 12
      }
    })

    // landing marker
    ctx.strokeStyle = '#e9eef6'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(X(a) + 0.5, 20)
    ctx.lineTo(X(a) + 0.5, totalH - 4)
    ctx.stroke()
    ctx.setLineDash([])

    // cursor
    const cx = X(Math.max(a, Math.min(b, cursor)))
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, 18)
    ctx.lineTo(cx, totalH - 2)
    ctx.stroke()
    ctx.lineWidth = 1
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(cx - 5, 16)
    ctx.lineTo(cx + 5, 16)
    ctx.lineTo(cx, 22)
    ctx.fill()
    if (hoverX !== null) {
      ctx.strokeStyle = 'rgba(233,238,246,0.3)'
      ctx.beginPath()
      ctx.moveTo(hoverX, 20)
      ctx.lineTo(hoverX, totalH - 4)
      ctx.stroke()
    }
  }, [ref, w, totalH, rows, a, b, cursor, hoverX, eph, bandH, detailed])

  const idxAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    const pw = w - LABEL_W - 8
    return { x, i: a + ((x - LABEL_W) / pw) * (b - a) }
  }

  return (
    <div
      className="canvasbox"
      onPointerMove={(e) => {
        const { x } = idxAt(e.clientX, e.currentTarget)
        setHoverX(x > LABEL_W ? x : null)
        if (e.buttons === 1 && x > LABEL_W) onCursor(Math.max(a, Math.min(b - 0.01, idxAt(e.clientX, e.currentTarget).i)))
      }}
      onPointerLeave={() => setHoverX(null)}
      onPointerDown={(e) => {
        const { x, i } = idxAt(e.clientX, e.currentTarget)
        if (x > LABEL_W) onCursor(Math.max(a, Math.min(b - 0.01, i)))
        else if (onPick && !detailed) {
          const r = e.currentTarget.getBoundingClientRect()
          const k = Math.floor((e.clientY - r.top - 26) / (16 * 2 + 12))
          if (rows[k]) onPick(rows[k].id)
        }
      }}
    >
      <canvas ref={ref} role="img" aria-label={`Sunlight and Earth visibility timeline from ${fmtDate(timeOf(eph, a))}`} />
    </div>
  )
}
