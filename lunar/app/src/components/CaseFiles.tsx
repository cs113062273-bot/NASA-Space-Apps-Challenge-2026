import { Fragment } from 'react'
import { Ephemeris, R0_KM, eclipseContacts, indexOf, siteFrame } from '../lib/astro'
import { SiteRecord } from '../lib/data'
import { SKYLINE_ERR_DEG, Track, sunsetRange, windowStats } from '../lib/metrics'
import { fmtDate, fmtHours } from '../lib/ui'

interface Case {
  site: string
  title: string
  landed: string
  days: number
  reported: { label: string; value: string }[]
  lesson: string
  eclipse?: boolean // show the model's eclipse contacts, to the minute
  source: { label: string; url: string }[]
}

// Reported facts are quoted from the cited sources; model values are computed below, live.
const CASES: Case[] = [
  {
    site: 'im1',
    title: 'Odysseus (IM-1): predicting the dawn',
    landed: '2024-02-22T23:23:00Z',
    days: 40,
    reported: [
      { label: 'Slope at rest (reported)', value: '~12°, then tipped' },
      { label: 'Powered down', value: '29 Feb 2024' },
      { label: 'Wake-up listening began', value: '20 Mar 2024' },
    ],
    lesson: 'Model first light falls on the day operators started listening, and the touchdown slope comes out steep, as reported. Tilted panels lost useful Sun before the terrain sunset did.',
    source: [
      { label: 'NASA LRO: Odysseus landing site', url: 'https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/' },
      { label: 'Universe Today: lunar night ends Odysseus mission', url: 'https://www.universetoday.com/articles/lunar-night-permanently-ends-the-odysseus-mission' },
      { label: 'EGU25-20315: landing site on a ~12° slope', url: 'https://meetingorganizer.copernicus.org/EGU25/EGU25-20315.html' },
    ],
  },
  {
    site: 'ch3',
    title: 'Chandrayaan-3: racing the sunset',
    landed: '2023-08-23T12:33:00Z',
    days: 40,
    reported: [
      { label: 'Vikram put to sleep', value: '4 Sep 2023 ~02:30 UTC' },
      { label: 'Wake-up attempt', value: '22 Sep 2023' },
    ],
    lesson: 'ISRO parked Vikram hours before the model’s terrain sunset; it never woke. Swapping the 3 m stereo near field for 240 m terrain moves that sunset by only ten minutes.',
    source: [
      { label: 'All India Radio: Vikram in sleep mode, hopes for 22 Sep', url: 'https://www.newsonair.gov.in/vikram-lander-of-chandrayan-3-put-into-sleep-mode-hopes-for-its-awakening-on-22nd-september-isro' },
      { label: 'IAU name, Statio Shiv Shakti', url: 'https://en.wikipedia.org/wiki/Statio_Shiv_Shakti' },
      { label: 'LROC NAC DTM VIKRAMSITE1 (3 m)', url: 'https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_VIKRAMSITE1' },
    ],
  },
  {
    site: 'im2-actual',
    title: 'Athena (IM-2): what the map cannot see',
    landed: '2025-03-06T17:28:50Z',
    days: 14,
    reported: [
      { label: 'Mission ended', value: '< 13 h after touchdown' },
      { label: 'Cause (reported)', value: 'on its side, in a cold crater' },
    ],
    lesson: 'Even 4 m stereo terrain gives this point two weeks of Sun and shows no crater. Athena tipped into one not resolved in the terrain products used here, which is why LUNORIZON shows the ±500 m spread, not a single verdict.',
    source: [
      { label: 'Spaceflight Now: IM-2 ends with lander on its side', url: 'https://spaceflightnow.com/2025/03/07/intuitive-machines-im-2-mission-ends-with-lander-on-its-side-on-the-moon/' },
      { label: 'LROC: IM-2 landing region', url: 'https://www.lroc.asu.edu/images/1401' },
      { label: 'LROC NAC DTM NOBILE03 (4 m)', url: 'https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_NOBILE03' },
    ],
  },
  {
    site: 'blue-ghost',
    title: 'Blue Ghost M1: an eclipse, then the battery',
    landed: '2025-03-02T08:34:00Z',
    days: 16,
    eclipse: true,
    reported: [
      { label: 'Eclipse (reported)', value: '14 Mar 05:00–09:52 UTC, total from 06:18; “diamond ring” 08:30' },
      { label: 'Last contact', value: '16 Mar 2025 23:25 UTC' },
      { label: 'Operator’s account', value: '~5 h into the lunar night' },
    ],
    lesson: 'On 14 March Earth passed in front of the Sun and Blue Ghost photographed it: the model’s eclipse times land within 4 minutes of the reported ones, an additional check of eclipse geometry. Two days later Mare Crisium’s hills brought sunset 50 min earlier than a flat horizon. The modeled sunset precedes last contact by 3.5 hours, consistent with stored-energy operation; the ±12-minute value is a skyline sensitivity, not an uncertainty bound.',
    source: [
      { label: 'KUT: Blue Ghost watches the eclipse (Firefly images)', url: 'https://www.kut.org/science/2025-03-14/firefly-aerospace-blue-ghost-lunar-lander-total-solar-eclipse' },
      { label: 'Space.com: Blue Ghost goes dark', url: 'https://www.space.com/the-universe/moon/farewell-blue-ghost-private-moon-lander-goes-dark-to-end-record-breaking-commercial-lunar-mission' },
    ],
  },
  {
    site: 'change6',
    title: 'Chang’e 6: no line to Earth',
    landed: '2024-06-01T22:23:00Z',
    days: 3,
    reported: [
      { label: 'Communications', value: 'through the Queqiao-2 relay' },
    ],
    lesson: 'Earth never rises here, not once in 2027. Sunlight was fine; the radio link was the problem, so China put a relay in lunar orbit first. Turn on the whole-Moon map’s Earth layer to see the boundary.',
    source: [
      { label: 'NASA LRO spots Chang’e 6', url: 'https://www.nasa.gov/centers-and-facilities/goddard/nasas-lro-spots-chinas-change-6-spacecraft-on-lunar-far-side' },
    ],
  },
]

function nextSunrise(t: Track, from: number, to: number): number | null {
  for (let i = Math.max(from, 1); i < to; i++) if (t.sunFrac[i] > 0 && t.sunFrac[i - 1] <= 0) return i
  return null
}

const eclipseCache = new Map<string, ReturnType<typeof eclipseContacts>>()
/** Minute-level eclipse contacts in a case window (cached: the scan covers every minute of the window). */
function eclipseFor(eph: Ephemeris, site: SiteRecord, landed: number, days: number) {
  let c = eclipseCache.get(site.id)
  if (!c) {
    const f = siteFrame(site.lat, site.lon, R0_KM + (site.ground_m + 2) / 1000)
    const i0 = indexOf(eph, landed)
    c = eclipseContacts(eph, f, i0, i0 + days * 24)
    eclipseCache.set(site.id, c)
  }
  return c
}

export function CaseFiles({ eph, sites, trackFor, onOpen }: {
  eph: Ephemeris
  sites: SiteRecord[]
  trackFor: (s: SiteRecord) => Track
  onOpen: (siteId: string, unix: number, days: number) => void
}) {
  return (
    <div className="cases">
      {CASES.map((c) => {
        const site = sites.find((s) => s.id === c.site)
        if (!site) return null
        const landed = Date.parse(c.landed) / 1000
        const t = trackFor(site)
        const i0 = Math.round(indexOf(eph, landed))
        const st = windowStats(t, i0, c.days * 24)
        const sunsetIdx = st.firstSunset !== null ? i0 + st.firstSunset : null
        const r = sunsetRange(t, i0, c.days * 24)
        const halfSpread = st.firstSunset !== null && r.early !== null && r.late !== null ? (r.late - r.early) / 2 : null
        const sunrise = sunsetIdx !== null ? nextSunrise(t, Math.ceil(sunsetIdx), i0 + c.days * 24) : null
        const unixAt = (idx: number) => eph.startUnix + idx * eph.stepS
        const ecl = c.eclipse ? eclipseFor(eph, site, landed, c.days) : null
        const hm = (u: number | null) => (u === null ? '—' : new Date(u * 1000).toISOString().slice(11, 16))
        return (
          <article key={c.site} className="panel case">
            <h3>{c.title}</h3>
            <div className="muted" style={{ fontSize: 12.5 }}>Landed {fmtDate(landed)}</div>
            <dl className="facts">
              <dt>Model sunset</dt>
              <dd className="sun" title={`± shows how sunset moves with a skyline ${SKYLINE_ERR_DEG}° higher or lower, using the LOLA vs LROC stereo comparison at two flown sites.`}>{sunsetIdx !== null ? <><span className="nw">{fmtDate(unixAt(sunsetIdx))}</span>{halfSpread !== null && <span className="nw"> ± {fmtHours(halfSpread)}</span>} <span className="nw faint">T+{fmtHours(st.firstSunset)}</span></> : `none in ${c.days} d`}</dd>
              {sunrise !== null && (<><dt>Model next sunrise</dt><dd className="sun">{fmtDate(unixAt(sunrise))}</dd></>)}
              {ecl?.start != null && (<><dt>Model eclipse</dt><dd className="sun">{fmtDate(ecl.start).slice(0, 6)} {hm(ecl.start)}–{hm(ecl.end)} UTC, total {hm(ecl.totalStart)}–{hm(ecl.totalEnd)}</dd></>)}
              <dt>Model Earth in view</dt><dd className="earth">{Math.round((100 * st.earthHours) / st.hours)}% of {c.days} d</dd>
              {c.site === 'im1' && site.slope_deg != null && (<><dt>Model slope (40 m)</dt><dd>{site.slope_deg.toFixed(0)}°</dd></>)}
              {c.reported.map((r) => (<Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>))}
            </dl>
            <p style={{ margin: 0, fontSize: 13.5 }}>{c.lesson}</p>
            <div className="src">{c.source.map((s, k) => <span key={s.url}>{k ? ' · ' : 'Sources: '}<a href={s.url} target="_blank" rel="noreferrer">{s.label}</a></span>)}</div>
            <div><button className="btn sm" onClick={() => onOpen(c.site, landed, Math.min(c.days, 30))}>Open this landing →</button></div>
          </article>
        )
      })}
    </div>
  )
}
