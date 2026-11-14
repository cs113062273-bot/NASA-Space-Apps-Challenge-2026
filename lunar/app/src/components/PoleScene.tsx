import { useEffect, useRef, useState } from 'react'

/**
 * A schematic of the problem for people who have never thought about it: at the pole the Sun stays low, a ridge can
 * hide it, and landing later lowers its path. Two loops: the planned date (the Sun clears the ridge, the battery stays
 * full) and one week later (the Sun slips behind the ridge and the battery runs out). Illustration only; the app
 * itself uses the real NASA skyline.
 */
const W = 600, H = 360
// the blocking ridge's top edge, left to right (x, y); terrain elsewhere is lower than the Sun's path
const RIDGE: [number, number][] = [[300, 262], [340, 222], [372, 196], [404, 176], [428, 168], [452, 180], [488, 204], [530, 236], [568, 262]]
const FAR: [number, number][] = [[0, 262], [60, 250], [120, 256], [190, 244], [250, 254], [300, 262]]
const ridgeTop = (x: number) => {
  for (let i = 0; i < RIDGE.length - 1; i++) {
    const [x0, y0] = RIDGE[i], [x1, y1] = RIDGE[i + 1]
    if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return 262
}
const PHASES = [
  { label: 'Planned landing', sub: 'The Sun stays above the ridge', base: 214, lift: 92 },
  { label: 'Landing one week later', sub: 'The Sun’s path is lower', base: 240, lift: 30 },
] as const
const LOOP_S = 7
const PANEL = { x: 128, y: 252, w: 10, h: 40 }

export function PoleScene() {
  const sun = useRef<SVGGElement>(null)
  const ray = useRef<SVGLineElement>(null)
  const panel = useRef<SVGRectElement>(null)
  const fill = useRef<SVGRectElement>(null)
  const [status, setStatus] = useState({ phase: 1, lit: false, battery: 0 })

  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let battery = 100, phase = 0, last = performance.now(), start = last, raf = 0, shown = ''
    const draw = (t: number, ph: number) => {
      const p = PHASES[ph]
      const x = 40 + t * (W - 80)
      const y = p.base - p.lift * Math.sin(Math.PI * t)
      const lit = y + 4 < ridgeTop(x)
      sun.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
      if (ray.current) {
        ray.current.setAttribute('x1', x.toFixed(1)); ray.current.setAttribute('y1', y.toFixed(1))
        ray.current.style.opacity = lit ? '0.55' : '0'
      }
      panel.current?.setAttribute('fill', lit ? '#f2b53a' : '#33424f')
      return lit
    }
    if (still) {
      draw(0.72, 1)
      if (fill.current) fill.current.setAttribute('width', '0')
      setStatus({ phase: 1, lit: false, battery: 0 })
      return
    }
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      let t = (now - start) / 1000 / LOOP_S
      if (t >= 1) { start = now; t = 0; phase = (phase + 1) % 2; battery = 100 }
      const lit = draw(t, phase)
      battery = Math.max(0, Math.min(100, battery + (lit ? 6 : -46) * dt))
      if (fill.current) {
        fill.current.setAttribute('width', (1.2 * battery).toFixed(1))
        fill.current.setAttribute('fill', battery < 25 ? '#ff8a76' : '#5fd3a7')
      }
      const key = `${phase}${lit}${Math.round(battery / 5)}`
      if (key !== shown) { shown = key; setStatus({ phase, lit, battery }) }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const p = PHASES[status.phase]
  const out = status.battery < 1
  const poly = (pts: [number, number][]) => [...pts.map(([x, y]) => `${x},${y}`), `${pts[pts.length - 1][0]},${H}`, `${pts[0][0]},${H}`].join(' ')
  return (
    <figure className="pole-scene">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Illustration: on the planned date the low Sun stays above a ridge and the lander's battery stays charged; landing one week later, the Sun's path is lower, it passes behind the ridge and the battery runs out.">
        <defs>
          <linearGradient id="ps-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#081521" /><stop offset="1" stopColor="#1a3447" /></linearGradient>
          <radialGradient id="ps-glow"><stop offset="0" stopColor="#fff6d6" /><stop offset="0.25" stopColor="#ffd77a" stopOpacity="0.9" /><stop offset="1" stopColor="#ffb43a" stopOpacity="0" /></radialGradient>
          <linearGradient id="ps-ridge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6b747c" /><stop offset="1" stopColor="#2b3238" /></linearGradient>
          <linearGradient id="ps-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4c545b" /><stop offset="1" stopColor="#1d2227" /></linearGradient>
        </defs>
        <rect width={W} height={H} fill="url(#ps-sky)" />
        {[[70, 40], [150, 90], [240, 30], [330, 70], [520, 50], [560, 110], [460, 24], [30, 120]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="#c8d4ff" opacity="0.6" />)}
        <path d={`M40 ${PHASES[status.phase].base} Q ${W / 2} ${PHASES[status.phase].base - 2 * PHASES[status.phase].lift} ${W - 40} ${PHASES[status.phase].base}`} fill="none" stroke="#ffd17b" strokeOpacity="0.35" strokeDasharray="4 6" />
        <g ref={sun}>
          <circle r="34" fill="url(#ps-glow)" />
          <circle r="9" fill="#fffaf0" />
        </g>
        <polygon points={poly(FAR)} fill="#3b434a" />
        <polygon points={poly(RIDGE)} fill="url(#ps-ridge)" />
        <text x="430" y="216" textAnchor="middle" className="ps-tag">Ridge</text>
        <rect x="0" y="262" width={W} height={H - 262} fill="url(#ps-ground)" />
        <line ref={ray} x1="0" y1="0" x2={PANEL.x + PANEL.w} y2={PANEL.y + 10} stroke="#ffd17b" strokeWidth="2" strokeDasharray="3 5" />
        <g className="ps-lander">
          <line x1="100" y1="300" x2="88" y2="318" /><line x1="140" y1="300" x2="152" y2="318" />
          <rect x="96" y="276" width="48" height="26" rx="3" fill="#c9d1d8" />
          <rect x="112" y="262" width="16" height="14" rx="2" fill="#9aa6b1" />
          <rect ref={panel} x={PANEL.x} y={PANEL.y} width={PANEL.w} height={PANEL.h} rx="1.5" fill="#33424f" stroke="#0b1015" />
        </g>
        <text x="120" y="340" textAnchor="middle" className="ps-tag">Lander</text>
        <g transform="translate(22 22)">
          <text className="ps-label" x="0" y="12">Battery</text>
          <rect x="0" y="20" width="124" height="14" rx="4" fill="none" stroke="#9fb3c2" strokeOpacity="0.7" />
          <rect ref={fill} x="2" y="22" width="120" height="10" rx="2" fill="#5fd3a7" />
        </g>
      </svg>
      <figcaption>
        <span className={`ps-phase ${status.phase ? 'late' : ''}`}>{p.label}</span>
        <span className={`ps-state ${out ? 'bad' : status.lit ? 'good' : 'warn'}`}>{out ? 'Power out: the Sun is behind the ridge' : status.lit ? 'In sunlight: charging' : 'Behind the ridge: battery draining'}</span>
        <small>Illustration. LUNORIZON computes the real skyline from NASA terrain.</small>
      </figcaption>
    </figure>
  )
}
