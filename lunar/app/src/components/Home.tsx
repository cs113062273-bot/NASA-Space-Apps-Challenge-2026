import { useEffect, useMemo, useState } from 'react'
import horizons from '../../../data/validation/horizons-crosscheck.json'
import pgda from '../../../data/validation/pgda-avgvisib-crosscheck.json'
import { Ephemeris, Horizon } from '../lib/astro'
import { SiteRecord } from '../lib/data'
import { Track, computeTrack } from '../lib/metrics'
import { DEFAULT_POWER } from '../lib/power'
import { DEFAULT_RADIO } from '../lib/link'
import { LandingOption, rankDecision, replanLanding } from '../lib/decision'
import { fmtDate } from '../lib/ui'
import { Icon } from './Icon'
import { PoleScene } from './PoleScene'

/** The Artemis III crew screen the "7 days late" story uses: about 6.25 days in continuous sunlight. */
const CREW = { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }
const ORIGINAL = Date.parse('2027-01-11T00:00:00Z') / 1000
const DELAY_DAYS = 7
const STAY_H = 150

interface Stories { onRecover: () => void; onArtemis: () => void; onContrast: () => void; onFarSide: () => void }

/** Landing page: the problem, one real case computed live, what is real versus assumed, and where to start. */
export function Home({ eph, sites, stories, onOpen }: { eph: Ephemeris; sites: SiteRecord[]; stories: Stories; onOpen: (target: string) => void }) {
  // the story's own settings (2 m panels, Earth centre above the skyline), independent of the workspace inputs
  const result = useMemo(() => {
    const anchor = sites.find((s) => s.id === 'a3-haworth')
    if (!anchor) return null
    const cache = new Map<string, Track>()
    const trackFor = (s: SiteRecord) => {
      let t = cache.get(s.id)
      if (!t) { t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0, false); cache.set(s.id, t) }
      return t
    }
    const raw = replanLanding({ eph, anchor, originalUnix: ORIGINAL, delayDays: DELAY_DAYS, candidates: sites.filter((s) => s.id.startsWith('a3-')),
      trackFor, len: STAY_H, observerM: 2, req: CREW, power: DEFAULT_POWER, radio: DEFAULT_RADIO })
    return rankDecision(raw, 'earth')
  }, [eph, sites])
  const [grown, setGrown] = useState(false)
  useEffect(() => { const t = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(t) }, [])

  const daylight = (o: LandingOption | null | undefined) => !o ? 0 : o.stats.startsDark ? 0 : o.stats.firstSunset ?? o.stats.hours
  const before = result?.before, late = result?.delayed, wait = result?.waitHere, swap = result?.changeSite
  const waitDays = late && wait ? Math.round((wait.unix - late.unix) / 86400) : null
  const bar = (h: number) => `${Math.max(2, Math.min(100, (100 * h) / STAY_H))}%`

  // plain-language durations: whole days when long, hours when short
  const plain = (h: number, open = false) => h >= 48 ? `${Math.floor(h / 24)}${open ? '+' : ''} days` : `${Math.round(h)} hours`

  return (
    <div className="home">
      <section className="hero" aria-labelledby="home-title">
        <div className="hero-copy">
          <p className="eyebrow">Lunar south pole landing planner</p>
          <h1 id="home-title">Moon landers run on sunlight. <em>At the south pole, one ridge can switch it off.</em></h1>
          <p className="lede">The Sun never climbs high there. It circles just above the horizon, so nearby mountains decide when a lander has power, and landing a week later moves the shadows. LUNORIZON checks the sunlight before you land, and finds another site or date when a delay breaks the plan.</p>
          <div className="hero-actions">
            <button className="btn-cta" onClick={stories.onRecover}>Recover a delayed landing <Icon name="arrow" /></button>
            <button className="btn-link" onClick={() => onOpen('explore')}>Plan your own landing</button>
          </div>
          <p className="hero-cost">Compare sunlight and terrain at the Odysseus, Chandrayaan-3 and Athena landing sites. <button className="btn-link" onClick={() => onOpen('cases')}>See what happened</button></p>
        </div>
        <PoleScene />
      </section>

      <article className="case-card case-wide" aria-label="Haworth, seven days late">
        <div className="case-head">
          <p className="eyebrow">Haworth · Artemis III candidate region · 150-hour planning scenario</p>
          <h2>A crew needs about 6 days of unbroken sunlight. Here is what one week of delay does.</h2>
        </div>
        <div className="case-bars">
          {[['Planned', ORIGINAL, before], [`${DELAY_DAYS} days late`, ORIGINAL + DELAY_DAYS * 86400, late]].map(([label, unix, o]) => {
            const opt = o as LandingOption | null | undefined
            const h = daylight(opt)
            const open = !!opt && opt.stats.firstSunset === null && !opt.stats.startsDark
            return (
              <div className="case-bar" key={label as string}>
                <span className="case-bar-label"><b>{label as string}</b>{fmtDate(unix as number, false)}</span>
                <span className="case-bar-track"><i className={opt?.clearsScreen ? 'ok' : 'bad'} style={{ width: grown ? bar(h) : '0%' }} /><em style={{ left: '100%' }} /></span>
                <span className={`case-bar-value ${opt?.clearsScreen ? 'ok' : 'bad'}`}>{opt ? `${plain(open ? opt.stats.hours : h, open)} of sunlight` : '—'}</span>
              </div>
            )
          })}
          <p className="case-need">The line marks the whole {plain(STAY_H)} stay</p>
        </div>
        <div className="case-outcome">
          {late && <p className="case-text">One week late, the Sun drops behind the terrain after <b>{plain(daylight(late))}</b>{late.powerShortfallAt !== null ? <> and the battery runs out <b>{plain(late.powerShortfallAt)} after landing</b></> : null}. LUNORIZON finds two ways out:</p>}
          <ul className="case-options">
            {swap && <li><Icon name="arrow" /><span><b>Land somewhere else that day:</b> {swap.site.name}{result && result.passingSites > 1 ? ` (one of ${result.passingSites} sites that still work)` : ''}</span></li>}
            {wait && <li><Icon name="delay" /><span><b>Or keep Haworth and wait</b> until {fmtDate(wait.unix, false)}{waitDays !== null ? `, ${waitDays} days later` : ''}</span></li>}
          </ul>
          <button className="btn-link case-link" onClick={stories.onRecover}>Try it yourself <Icon name="arrow" /></button>
          <p className="case-fine">Same hardware and mission rules for every option.</p>
        </div>
      </article>

      <section className="provenance" aria-label="What is real, checked, modelled and set by you">
        <div><p className="eyebrow good">Real data</p><p>NASA’s laser-measured lunar terrain and JPL’s Sun and Earth positions, for {sites.length} sites including the Artemis III regions and landers that flew.</p></div>
        <div><p className="eyebrow good">Checked</p><p>Sun and Earth positions match JPL Horizons to {(horizons.max_abs_elevation_error_deg as number).toFixed(5)}°; sunlight agrees with NASA Goddard’s map ({pgda.summary.rmse_pp}-point RMS difference); Blue Ghost’s real eclipse matches within 4 minutes. <button className="btn-link" onClick={() => onOpen('evidence')}>See the checks</button></p></div>
        <div><p className="eyebrow">Modelled</p><p>Battery charge and radio contact with Earth, hour by hour, from the same sunlight and Earth view.</p></div>
        <div><p className="eyebrow">You set</p><p>Panel height, battery, radio and the mission rules. Every result names its assumptions.</p></div>
      </section>

      <section className="home-section" aria-labelledby="cases-title">
        <h2 id="cases-title">Or start from a real case</h2>
        <div className="start-cards">
          <button className="start-card" onClick={stories.onArtemis}><b>Artemis III <Icon name="arrow" /></b><span>Why NASA keeps nine candidate regions instead of one.</span></button>
          <button className="start-card" onClick={stories.onContrast}><b>Pole vs Apollo 11 <Icon name="arrow" /></b><span>Why a polar landing is so much harder than the equator.</span></button>
          <button className="start-card" onClick={stories.onFarSide}><b>Chang’e 6 <Icon name="arrow" /></b><span>Why the far side has no line to Earth, and needs a relay.</span></button>
        </div>
      </section>

      <section className="home-section" aria-labelledby="how-title">
        <p className="eyebrow">How it works</p>
        <h2 id="how-title">Choose a site and a date. See what the terrain does to the mission.</h2>
        <ol className="how-steps">
          <li><span className="step-num">1</span><div><h3>Choose</h3><p>Pick a site and a landing date. Its 360° skyline and the Sun and Earth paths compute in your browser.</p><button className="btn-link" onClick={() => onOpen('explore')}>Open Plan</button></div></li>
          <li><span className="step-num">2</span><div><h3>Read the verdict</h3><p>Sunlight, battery power and Earth contact each pass or fail against your mission needs.</p></div></li>
          <li><span className="step-num">3</span><div><h3>Test a delay</h3><p>Slip the landing by days or weeks and see which sites, and which dates, still work.</p><button className="btn-link" onClick={() => onOpen('whatif')}>Open Delays</button></div></li>
          <li><span className="step-num">4</span><div><h3>Export the brief</h3><p>Download the decision with its reasoning, data sources and assumptions.</p></div></li>
        </ol>
      </section>

    </div>
  )
}
