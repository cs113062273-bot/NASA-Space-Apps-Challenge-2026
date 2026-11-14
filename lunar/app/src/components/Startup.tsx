import { useEffect, useState } from 'react'

/**
 * The first-load screen: a self-running preview while the mission data arrives. It opens with the problem, then shows
 * what the tool does with it. Slides advance on their own, sliding left; there are no controls to learn.
 */
const SLIDES = [
  { src: 'img/preview/1-problem.webp', text: 'At the Moon’s south pole, one ridge can hide the Sun and cut a lander’s power.' },
  { src: 'img/preview/2-decision.webp', text: 'One week late, Haworth fails. LUNORIZON finds another site that day, or the next good date.' },
  { src: 'img/preview/3-plan.webp', text: 'Apply the fix and watch the stay hour by hour: sunlight, battery and Earth contact.' },
  { src: 'img/preview/4-year.webp', text: 'See which landing days work across a whole year, for all nine Artemis III regions.' },
  { src: 'img/preview/5-evidence.webp', text: 'Checked against NASA data and the landers that flew.' },
] as const
const SLIDE_MS = 2000

export function Startup({ bytes, total, known, done }: { bytes: number; total: number; known: boolean; done: boolean }) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setShown((n) => (n + 1) % SLIDES.length), SLIDE_MS)
    return () => clearInterval(t)
  }, [])
  const left = (shown + SLIDES.length - 1) % SLIDES.length
  const mb = (n: number) => (n / 1e6).toFixed(1)
  const status = done ? 'Mission data ready' : !bytes ? 'Connecting to the mission data…'
    : known && bytes >= total ? 'Checking the mission data…' : `Loading NASA and JPL mission data · ${mb(bytes)}${known ? ` of ${mb(total)}` : ''} MB`
  return (
    <main className="startup-preview" aria-busy={!done}>
      <div className="startup-slides">
        {SLIDES.map((s, i) => (
          <figure key={s.src} className={i === shown ? 'is-shown' : i === left ? 'is-left' : undefined} aria-hidden={i !== shown}>
            <figcaption>{s.text}</figcaption>
            <div className="startup-shot"><img src={s.src} alt="" decoding="async" /></div>
          </figure>
        ))}
      </div>
      <div className="startup-dots" aria-hidden="true">{SLIDES.map((s, i) => <i key={s.src} className={i === shown ? 'on' : undefined} />)}</div>
      <div className="startup-load">
        <progress aria-label="Downloading mission data" max={done ? 1 : known ? total : undefined} value={done ? 1 : known ? bytes : undefined} />
        <p className="startup-transfer" role="status">{status}</p>
      </div>
    </main>
  )
}
