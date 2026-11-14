import { Track, earthTransition, earthVisible, sunTransition, sunUp } from './metrics'

export interface Win {
  kind: 'sun' | 'earth'
  start: number
  end: number
  openStart: boolean
  openEnd: boolean
}

/** Visibility intervals in [a,b), using the same eclipse crossings and DSN gate as windowStats. */
export function windows(t: Track, a: number, b: number): Win[] {
  const out: Win[] = []
  for (const kind of ['sun', 'earth'] as const) {
    const on = kind === 'sun' ? (i: number) => sunUp(t, i) : (i: number) => earthVisible(t, i)
    let start: number | null = on(a) ? a : null
    let openStart = start !== null
    for (let i = a + 1; i <= b && i < t.sunFrac.length; i++) {
      const now = on(i), before = on(i - 1)
      if (now === before) continue
      const at = kind === 'sun' ? sunTransition(t, i - 1, now) : earthTransition(t, i - 1)
      if (at >= b) continue
      if (now) {
        start = at
        openStart = false
      } else if (start !== null) {
        out.push({ kind, start, end: at, openStart, openEnd: false })
        start = null
      }
    }
    if (start !== null) out.push({ kind, start, end: b, openStart, openEnd: true })
  }
  return out.sort((left, right) => left.start - right.start)
}
