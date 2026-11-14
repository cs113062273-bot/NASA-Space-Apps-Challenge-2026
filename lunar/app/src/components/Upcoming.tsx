import { useMemo } from 'react'
import { Ephemeris, indexOf } from '../lib/astro'
import { SiteRecord } from '../lib/data'
import { Track, skylineErr, windowStats } from '../lib/metrics'
import { Requirements, checkWindow, slopeOk } from '../lib/requirements'
import { fmtDate } from '../lib/ui'

/** CLPS landers so far planned for about one lunar day of surface operations. */
export const UPCOMING_STAY_DAYS = 12

// Landings planned as of November 2026. Targets are published regions, not landing points: each row is
// analysed at the nearest curated site, and says which one.
interface Mission {
  name: string
  who: string
  target: string
  planned: string // as published
  from: string // first landing day analysed (UTC)
  site: string | null // nearest analysed site, or null when no target is public
  stand: string // what the analysed site is
  src: { label: string; url: string }
}

const MISSIONS: Mission[] = [
  {
    name: 'Griffin Mission One', who: 'Astrobotic (NASA CLPS)', target: 'Nobile crater region near Mons Mouton', planned: 'late 2026 to January 2027',
    from: '2027-01-01', site: 'a3-mouton', stand: 'best point of NASA’s Mons Mouton region',
    src: { label: 'Wikipedia: Griffin Mission One', url: 'https://en.wikipedia.org/wiki/Griffin_Mission_1' },
  },
  {
    name: 'Blue Moon Pathfinder 1', who: 'Blue Origin (NASA CLPS)', target: 'Shackleton connecting ridge', planned: 'early 2027',
    from: '2027-01-01', site: 'c1', stand: 'Connecting Ridge C1 (Gläser et al. 2018)',
    src: { label: 'Wikipedia: NASA CLPS', url: 'https://en.wikipedia.org/wiki/Commercial_Lunar_Payload_Services' },
  },
  {
    name: 'IM-3', who: 'Intuitive Machines (NASA CLPS)', target: 'Reiner Gamma swirl', planned: 'first part of 2027',
    from: '2027-01-01', site: 'reiner-gamma', stand: 'IAU centre of Reiner Gamma',
    src: { label: 'Wikipedia: IM-3', url: 'https://en.wikipedia.org/wiki/IM-3' },
  },
  {
    name: 'Chang’e 7', who: 'CNSA', target: 'Shackleton crater rim region', planned: '2026 (launch not confirmed here)',
    from: '2026-11-15', site: 'shackleton', stand: 'Shackleton rim S (Gläser et al. 2018)',
    src: { label: 'CNSA via Cislunarspace', url: 'https://www.cislunarspace.cn/en/space-news/2026/04/2026-04-24-chang-e7-launch/' },
  },
  {
    name: 'Blue Ghost Mission 2', who: 'Firefly (NASA CLPS)', target: 'far side (site not public)', planned: '2027',
    from: '2027-01-01', site: 'change6', stand: 'Chang’e 6 site, as a far-side example: Earth never rises, so it relies on the Lunar Pathfinder relay',
    src: { label: 'Wikipedia: Blue Ghost Mission 2', url: 'https://en.wikipedia.org/wiki/Blue_Ghost_Mission_2' },
  },
]

export function Upcoming({ eph, sites, trackFor, req, onExplore,terrainCheck }: {
  eph: Ephemeris
  sites: SiteRecord[]
  trackFor: (s: SiteRecord) => Track
  req: Requirements
  onExplore: (siteId: string, unix: number, days: number) => void
  terrainCheck?:import('../lib/terrain-constraint').TerrainCheck
}) {
  const len = UPCOMING_STAY_DAYS * 24
  // robust pass: nominal skyline and the site's skyline raised by its uncertainty
  const passes = (s: SiteRecord, i: number) => {
    const ok = (sh: number) => {
      const c = checkWindow(windowStats(trackFor(s), i, len, sh), req)
      return c.daylight && c.dark && c.earth
    }
    return (!terrainCheck||terrainCheck(s).pass)&&slopeOk(s, req.maxSlopeDeg) && ok(0) && ok(skylineErr(s))
  }
  const rows = useMemo(() => MISSIONS.map((m) => {
    const s = m.site ? sites.find((x) => x.id === m.site) : undefined
    if (!s) return { m, s, n: 0, first: null as number | null, days: 0,terrain:undefined }
    const u0 = Date.parse(`${m.from}T00:00:00Z`) / 1000 + (Date.parse(s.date) / 1000) % 86400 // the site's default time of day
    const i0 = Math.round(indexOf(eph, u0))
    const days = Math.max(0, Math.min(365, Math.floor((eph.count - 24 * 31 - i0) / 24)))
    let n = 0
    let first: number | null = null
    for (let d = 0; d < days; d++) {
      if (passes(s, i0 + d * 24)) {
        n++
        first ??= u0 + d * 86400
      }
    }
    return { m, s, n, first, days,terrain:terrainCheck?.(s) }
  }), [eph, sites, trackFor, req,terrainCheck]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="panel">
      <div className="panel-h"><h3>Scheduled landers · {UPCOMING_STAY_DAYS}-day reference scenarios</h3><span className="aside">your rules · plans as published, November 2026</span></div>
      <div className="panel-b" style={{ overflowX: 'auto' }}>
        <table className="ctable upcoming">
          <thead><tr><th>Mission</th><th>Target</th><th>Planned</th><th>Analysed at</th><th>Landing days that pass, next year</th><th>First</th><th /></tr></thead>
          <tbody>
            {rows.map(({ m, s, n, first, days,terrain }) => (
              <tr key={m.name}>
                <td><b>{m.name}</b><div className="faint">{m.who} · <a href={m.src.url} target="_blank" rel="noreferrer">{m.src.label}</a></div></td>
                <td>{m.target}</td>
                <td>{m.planned}</td>
                <td className="stand">{m.stand}</td>
                <td className={n ? 'best' : 'failv'} title={terrain?.issue??undefined}>{terrain&&terrain.status!=='ready'?`terrain ${terrain.status==='loading'?'loading':'not verified'}`:s ? (n === 0 && m.target.startsWith('far side') ? 'No direct-Earth window; relay required' : `${n} of ${days}`) : '—'}</td>
                <td>{first !== null ? fmtDate(first).slice(0, 11) : '—'}</td>
                <td>{s && <button className="btn sm nw" title={first !== null ? 'Open the first passing date' : 'No passing date; inspect conditions at the search start'} onClick={() => onExplore(s.id, first ?? Date.parse(`${m.from}T00:00:00Z`) / 1000, UPCOMING_STAY_DAYS)}>Explore →</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Representative points, not final touchdown coordinates. Counts test a {UPCOMING_STAY_DAYS}-day stay against your rules and a raised skyline; launch and transfer constraints are excluded.
        </p>
      </div>
    </div>
  )
}
