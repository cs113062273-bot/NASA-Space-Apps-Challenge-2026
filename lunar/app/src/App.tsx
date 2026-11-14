import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ephemeris, Horizon, bodyVector, indexOf, loadEphemeris, timeOf } from './lib/astro'
import { thermalPass } from './lib/thermal'
import { SurfaceContextPanel } from './components/SurfaceContextPanel'
import {UtcDateTime} from './components/UtcDateTime'
import { Basemap, SiteRecord, gridHeights, loadBasemap, loadDispersion, loadSites } from './lib/data'
import { METRICS, MetricKey, SKYLINE_ERR_DEG, Track, WindowStats, computeTrack, raisedPhrase, skylineErr, sunsetRange, windowStats } from './lib/metrics'
import { fmtDate, fmtElapsed, fmtHours, fmtLat, fmtLon } from './lib/ui'
import { MapView, GROUP_COLOR } from './components/MapView'
import { Skyline } from './components/Skyline'
import { SitePicker } from './components/SitePicker'
import { Timeline } from './components/Timeline'
import { SlipHeatmap, fmtMetric } from './components/SlipHeatmap'
import { Dispersion } from './components/Dispersion'
import { LandingAreaPanel } from './components/LandingAreaPanel'
import { AreaSettings, DEFAULT_AREA } from './lib/landing-area'
import { AreaReport, areaScope } from './lib/landing-terrain'
import { useTerrainConstraint } from './components/useTerrainConstraint'
import {DEFAULT_ROUTE,RouteSettings} from './lib/terrain-route'
import {DEFAULT_TRAVERSE,TraverseInputs,TraverseSettings,traverseScope} from './lib/traverse'
import {WORKSPACE_PAGES,workspaceLocation} from './lib/navigation'
import type {TerrainCheck,TerrainPointScreen} from './lib/terrain-constraint'
import {terrainForPoint} from './lib/terrain-constraint'
import {LocalSkyConfig,parsePointReference,pointReference,matchesPoint} from './lib/local-sky'
import {TerrainImportPanel} from './components/TerrainImportPanel'
import {LocalSkyPanel} from './components/LocalSkyPanel'
import { CaseFiles } from './components/CaseFiles'
import { Upcoming } from './components/Upcoming'
import { Evidence } from './components/Evidence'
import { EventList } from './components/EventList'
import { CommPanel } from './components/CommPanel'
import type { RelayReferenceCase } from './lib/relay-reference'
import { PowerPanel } from './components/PowerPanel'
import { DEFAULT_RADIO, Radio, antennaGain, fmtBytes, missionBudget } from './lib/link'
import { DEFAULT_POWER, PowerStats, PowerSystem } from './lib/power'
import { missionBrief } from './lib/brief'
import { POLAR_LIMITS } from './lib/evidence'
import { DecisionGoal, LandingOption, decisionBrief, rankDecision, replanLanding } from './lib/decision'
import { LandingDecision } from './components/LandingDecision'
import { MissionSearch } from './components/MissionSearch'
import { Home } from './components/Home'
import { Startup } from './components/Startup'
import { Icon } from './components/Icon'
import { SearchSettings } from './lib/search'
import { DEFAULT_TRAFFIC,operationsFor } from './lib/communications'
import { DEFAULT_REQ, Requirements, checkWindow, sameReq, slopeKnown, slopeOk } from './lib/requirements'
import { DEFAULT_PINS, DEFAULT_SITE, decodeShare, encodeShare } from './lib/share'
import { CustomSite, GridMeta, requestGrid, useCustomSites } from './components/CustomSite'

export type { Requirements }

/** Map and skyline share one height so their dark plotting surfaces line up. */
/** Surface-view height: shorter on low desktop windows so playback stays on the first screen */
const stageHeight = () => (typeof window !== 'undefined' && window.innerHeight <= 700 ? 220 : 380)
/** Tab-sized duration: whole days when exact, otherwise hours, so it never needs truncating */
const compactHours = (h: number) => (h < 48 ? fmtHours(h) : Math.abs(h / 24 - Math.round(h / 24)) < 1e-6 ? `${Math.round(h / 24)} d` : `${Math.round(h)} h`)

/** The LUNORIZON mark: a low Sun over a ridge line. */
const BrandIcon = () => <span className="brand-icon"><svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="19" r="7" fill="#ffc24b" /><rect x="0" y="20" width="32" height="12" fill="#0d1a24" /><path d="M2 20.5 L9 17 L14 19 L20 14.5 L26 18 L30 17" stroke="#c7d0de" strokeWidth="1.6" fill="none" /></svg></span>

const Site3D = lazy(() => import('./components/Site3D').then((m) => ({ default: m.Site3D })))
/** Seconds one pass of the stay takes on the Plan view, the rest at its end, and how long a touch holds playback. */
const LOOP_S = 12, END_REST_MS = 1500, RESUME_MS = 6000
/** Keep the preview for at least five seconds overall and two seconds after the data is ready. */
const PREVIEW_HOLD_MS = 2000
const PREVIEW_MIN_MS = 5000


/** "pt:lat:lon" (a site you added, as it travels in a pair) to coordinates; null for a curated site id. */
function ptOf(id: string): [number, number] | null {
  const p=parsePointReference(id)
  return p?[p.lat,p.lon]:null
}

export function App() {
  const [previewStartedAt] = useState(() => performance.now())
  const [eph, setEph] = useState<Ephemeris | null>(null)
  const [curated, setCurated] = useState<SiteRecord[]>([])
  const [basemap, setBasemap] = useState<Basemap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloads,setDownloads]=useState<Record<string,{loaded:number;total:number|null}>>({})

  useEffect(() => {
    Promise.all([
      loadEphemeris(undefined,p=>setDownloads(v=>({...v,[p.file]:p}))),
      loadSites(),
      loadBasemap()])
      .then(([e, s, b]) => {
        setEph(e)
        setCurated(s)
        setBasemap(b)
      })
      .catch((err) => setError(String(err)))
  }, [])
  // Enter at the later of the minimum preview duration and two seconds after readiness.
  const ready = !!eph && !!basemap && curated.length > 0
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (!ready) return
    const waitMs = Math.max(PREVIEW_HOLD_MS, PREVIEW_MIN_MS - (performance.now() - previewStartedAt))
    const t = setTimeout(() => setEntered(true), waitMs)
    return () => clearTimeout(t)
  }, [ready, previewStartedAt])

  const bytes=Object.values(downloads).reduce((n,p)=>n+p.loaded,0),known=Object.values(downloads).length===2&&Object.values(downloads).every(p=>p.total!==null),total=Object.values(downloads).reduce((n,p)=>n+(p.total??0),0)
  if (error) return <div className="loading"><div className="startup"><div className="brand">LUNORIZON</div><h1>Mission data could not be loaded.</h1><p>Check your connection, then try again.</p><button className="btn primary" onClick={()=>location.reload()}>Try loading again</button><details><summary>Connection details</summary><p>{error}</p></details></div></div>
  return <>
    {!entered && <>
    <header className="appbar startup-bar"><span className="brand"><BrandIcon /><span className="brand-name">LUNORIZON<small>Lunar landing site navigator</small></span></span></header>
    <Startup bytes={bytes} total={total} known={known} done={ready} />
    </>}
    {eph && basemap && curated.length > 0 && <div hidden={!entered}><Navigator eph={eph} curated={curated} basemap={basemap} active={entered} /></div>}
  </>
}

function Navigator({ eph, curated, basemap, active }: { eph: Ephemeris; curated: SiteRecord[]; basemap: Basemap; active: boolean }) {
  const custom = useCustomSites()
  const sites = useMemo(() => [...curated, ...custom.sites], [curated, custom.sites])
  const urlState = useMemo(() => decodeShare(location.search), [])
  const [workspace,setWorkspace]=useState(()=>workspaceLocation(location.hash,urlState.route||urlState.traverse||urlState.traverseRaw||urlState.terrainImport?'engineering':location.search.length>1?'explore':'home'))
  const [pendingSky,setPendingSky]=useState<{lat:number;lon:number;sky:LocalSkyConfig}|null>(()=>urlState.sky?{lat:urlState.add?.[0]??NaN,lon:urlState.add?.[1]??NaN,sky:urlState.sky}:null)
  const [selectedId, setSelectedId] = useState(urlState.site ?? DEFAULT_SITE)
  const site = sites.find((s) => s.id === selectedId) ?? sites.find((s) => s.id === DEFAULT_SITE) ?? sites[0]
  const [pinned, setPinned] = useState<string[]>(() => urlState.cmp?.filter((id) => curated.some((s) => s.id === id)) ?? DEFAULT_PINS)
  // the ephemeris is hourly and every view computes from whole hours, so the landing time snaps to the hour:
  // what the date field and clocks show is then exactly what was computed
  const toHour = useCallback((u: number) => eph.startUnix + Math.round((u - eph.startUnix) / eph.stepS) * eph.stepS, [eph])
  const [landingUnix, setLandingRaw] = useState(() => toHour(urlState.date ?? Date.parse(site.date) / 1000))
  const setLandingUnix = useCallback((u: number | ((u: number) => number)) => setLandingRaw((prev) => toHour(typeof u === 'function' ? u(prev) : u)), [toHour])
  const [durationDays, setDurationDays] = useState(urlState.days ?? site.duration_days)
  const [observerM, setObserverM] = useState(urlState.h ?? 2)
  const [earthMinClear, setEarthMinClear] = useState(urlState.ec ?? 0)
  const [requireDsn, setRequireDsn] = useState(urlState.dsn ?? false)
  // site + landing date pairs (the challenge's "multiple site-date pairs"), compared side by side. A site you added
  // travels in a link as "pt:lat:lon" and stays that way until its horizon has been recomputed in this browser
  const [pairs, setPairs] = useState<[string, number][]>(() => urlState.pairs?.filter(([id]) => id.startsWith('pt:') || curated.some((s) => s.id === id)) ?? [])
  const [compareMode, setCompareMode] = useState<'same' | 'pairs'>(urlState.compareMode ?? (urlState.pairs?.length ? 'pairs' : 'same'))
  const [metric, setMetric] = useState<MetricKey>('firstSunset')
  const [req, setReq] = useState<Requirements>(urlState.req ?? DEFAULT_REQ)
  const [areaSettings,setAreaSettings]=useState<AreaSettings>(urlState.area??DEFAULT_AREA)
  const [areaRequired,setAreaRequired]=useState(urlState.areaRequired??false)
  const [terrainImport,setTerrainImport]=useState<string|undefined>(urlState.terrainImport)
  const [routeSettings,setRouteSettings]=useState<RouteSettings>(urlState.route??DEFAULT_ROUTE)
  const [traverseSettings,setTraverseSettings]=useState<TraverseSettings>(urlState.traverse??DEFAULT_TRAVERSE)
  const [traverseInvalid,setTraverseInvalid]=useState<string|null>(urlState.traverseRaw??null)
  const [traverseEnabled,setTraverseEnabled]=useState(urlState.traverse!==undefined||urlState.traverseRaw!==undefined)
  const onTraverseSettings=useCallback((p:TraverseSettings)=>{setTraverseSettings(p);setTraverseInvalid(null);setTraverseEnabled(true)},[])
  const [terrainRevision,setTerrainRevision]=useState(0)
  const terrainCheck=useTerrainConstraint(sites,req.maxSlopeDeg,areaSettings,areaRequired,terrainRevision,terrainImport)
  const pointTerrain=terrainForPoint(terrainCheck,site,req.maxSlopeDeg)
  const [terrainReport,setTerrainReport]=useState<AreaReport|null>(null)
  const onTerrainReport=useCallback((report:AreaReport|null)=>setTerrainReport(report),[])
  const applyPreset = (r: (typeof REQ_PRESETS)[number]) => {
    setReq(r.req)
    if (r.days) setDurationDays(r.days)
  }
  const presetName = REQ_PRESETS.find((r) => sameReq(req, r.req))?.name ?? 'Custom'
  const [cursorState, setCursor] = useState(0) // hours since landing
  // The Plan view plays the stay on a loop by itself. Touching the timeline holds it for a few seconds; Space pauses it
  // until pressed again. 0 = playing, a timestamp = held until then, Infinity = paused (also the reduced-motion default).
  const [reducedMotion] = useState(() => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const [holdUntil, setHoldUntil] = useState(() => reducedMotion ? Infinity : 0)
  const hold = useCallback(() => setHoldUntil(h => h === Infinity ? h : performance.now() + RESUME_MS), [])
  const restartPlayback = useCallback(() => setHoldUntil(reducedMotion ? Infinity : 0), [reducedMotion])
  useEffect(() => {
    if (!holdUntil || holdUntil === Infinity) return
    const t = setTimeout(() => setHoldUntil(0), Math.max(0, holdUntil - performance.now()))
    return () => clearTimeout(t)
  }, [holdUntil])
  const [view, setView] = useState<'skyline' | '3d' | 'map'>('skyline')
  useEffect(()=>{if(site.localSky)setView(v=>v==='3d'?'skyline':v)},[site.localSky])
  const [power, setPower] = useState<PowerSystem>(urlState.pw ?? DEFAULT_POWER)
  const [radio, setRadio] = useState<Radio>(urlState.rd ?? DEFAULT_RADIO)
  const traverseInput=useMemo<TraverseInputs>(()=>({startUnix:landingUnix,observerM,earthMinClear,requireDsn,power,radio,settings:traverseSettings}),[landingUnix,observerM,earthMinClear,requireDsn,power,radio,traverseSettings])
  const [decisionGoal, setDecisionGoal] = useState<DecisionGoal>(urlState.goal ?? 'earth')
  // the replacement shown on the Delays page; choosing it there is a proposal, "Use this site" applies it
  const [proposalId, setProposalId] = useState<string | null>(urlState.rep ?? null)
  const [plan, setPlan] = useState<[string, number, number] | null>(() => urlState.plan &&
    (curated.some(s => s.id === urlState.plan![0]) || ptOf(urlState.plan[0]))
    ? [urlState.plan[0], toHour(urlState.plan[1]), urlState.plan[2]] : null)
  const [searchSettings, setSearchSettings] = useState<SearchSettings>(() => urlState.search ?? {
    startUnix: landingUnix, days: 30, stepDays: 1, minDataGb: 0, maxSilenceH: null,
  })
  // the mission bar can wrap to two rows: publish where it ends, so the sticky map column and jump targets sit below it
  const barObserver = useRef<ResizeObserver | null>(null)
  const barRef = useCallback((el: HTMLDivElement | null) => {
    barObserver.current?.disconnect()
    if (!el) return
    const set = () => document.documentElement.style.setProperty('--sticky-top', `${Math.round((parseFloat(getComputedStyle(el).top) || 0) + el.offsetHeight + 12)}px`)
    barObserver.current = new ResizeObserver(set)
    barObserver.current.observe(el)
    set()
  }, [active])

  const windowHours = Math.round(durationDays * 24)
  // Native min/max attributes do not constrain typed dates or the shift buttons.
  useEffect(() => {
    setLandingRaw((u) => Math.max(eph.startUnix, Math.min(u, timeOf(eph, eph.count - 1 - windowHours))))
  }, [eph, windowHours, landingUnix])
  // every view reads the cursor through this clamp, so a shorter stay can never leave it outside the window
  const cursor = Math.max(0, Math.min(cursorState, windowHours - 0.01))
  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, windowHours - 0.01))), [windowHours])
  const i0 = Math.round(indexOf(eph, landingUnix))
  const validRange = i0 >= 0 && i0 + windowHours < eph.count
  // Sun and Earth at the timeline cursor (quarter-hour steps), for the map's light-and-shadow layer
  const mapNow = useMemo(() => {
    if (!validRange) return undefined
    // Quantizing the last minute must not advance the map beyond the mission's right edge.
    const ci = i0 + Math.min(windowHours - 0.01, Math.round(cursor * 4) / 4)
    const hour = Math.min(eph.count - 1, Math.floor(ci))
    return { sun: bodyVector(eph, ci, 'sun'), earth: bodyVector(eph, ci, 'earth'), label: fmtDate(timeOf(eph, ci)),
      dsnAvailable: !eph.dsn || eph.dsn[hour] > 0,
      stations: eph.stations?.data.slice(hour * 27, (hour + 1) * 27), stationLabel: `${fmtDate(timeOf(eph, hour))} · DSN hourly` }
  }, [eph, i0, cursor, validRange, windowHours])

  // ---- tracks (memoised per site / height / Earth clearance) ----
  const cache = useRef(new Map<string, Track>())
  const trackFor = useCallback(
    (s: SiteRecord): Track => {
      const h = s.horizons[String(observerM)] ? observerM : 2
      const key = `${s.id}|${h}|${earthMinClear}|${requireDsn}`
      let t = cache.current.get(key)
      if (!t) {
        t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: h, horizon: new Horizon(s.horizons[String(h)]) }, earthMinClear, requireDsn)
        cache.current.set(key, t)
      }
      return t
    },
    [eph, observerM, earthMinClear, requireDsn],
  )
  const track = trackFor(site)
  const horizon = useMemo(() => new Horizon(site.horizons[String(observerM)] ?? site.horizons['2']), [site, observerM])
  const stats = useMemo(() => (validRange ? windowStats(track, i0, windowHours) : null), [track, i0, windowHours, validRange])
  const skyErr = skylineErr(site)
  const sunset = useMemo(() => (validRange ? sunsetRange(track, i0, windowHours, skyErr) : null), [track, i0, windowHours, validRange, skyErr])
  // the same window with the skyline raised by the site's sensitivity shift: does the verdict survive it?
  const statsHi = useMemo(() => (validRange ? windowStats(track, i0, windowHours, skyErr) : null), [track, i0, windowHours, validRange, skyErr])
  // power and downlink together, shared by the Power and Communication panels, the brief and the Compare table
  const budget = useMemo(() => (validRange ? missionBudget(eph, track, i0, windowHours, power, radio) : null), [eph, track, i0, windowHours, validRange, power, radio])
  const errOf = useCallback((id: string) => skylineErr(sites.find((x) => x.id === id) ?? {}), [sites])

  const passes = useCallback((s: WindowStats) => checkWindow(s, req), [req])
  const passFor = useCallback(
    (id: string, dayIndex: number, robust = false) => {
      const s = sites.find((x) => x.id === id)
      if (!s) return false
      const p = passes(windowStats(trackFor(s), dayIndex, windowHours, robust ? skylineErr(s) : 0))
      return p.daylight && p.dark && p.earth && slopeOk(s, req.maxSlopeDeg) && (!terrainCheck||!!terrainForPoint(terrainCheck,s,req.maxSlopeDeg)?.pass)
    },
    [sites, passes, trackFor, windowHours, req.maxSlopeDeg,terrainCheck],
  )

  // ---- shareable URL ----
  const addedFromUrl = useRef(false)
  // compared sites you added travel as coordinates: recompute them quietly, then pin each one as it appears
  const [pendingPins, setPendingPins] = useState<[number, number][]>(urlState.cmpAdd ?? [])
  const [pendingDetail,setPendingDetail]=useState<string[]>(urlState.cmpDetail??[])
  const near=(s:SiteRecord,[lat,lon]:[number,number])=>matchesPoint(s,{lat,lon:lon<0||lon>=360?((lon%360)+360)%360:lon})
  const pointSite=(id:string)=>{const p=parsePointReference(id);return p?custom.sites.find(s=>matchesPoint(s,p)):undefined}
  useEffect(()=>{
    if(addedFromUrl.current)return
    addedFromUrl.current=true
    if(urlState.add)custom.request(...urlState.add,false,{sky:urlState.sky})
    const quiet=[...(urlState.cmpAdd??[]).map(([lat,lon]):{lat:number;lon:number;sky?:LocalSkyConfig}=>({lat,lon})),
      ...(urlState.cmpDetail??[]).map(parsePointReference),...(urlState.pairs??[]).map(([id])=>parsePointReference(id)),
      ...(urlState.plan?[parsePointReference(urlState.plan[0])]:[])].filter((p):p is NonNullable<typeof p>=>!!p)
    const asked=new Set(urlState.add?[JSON.stringify({lat:urlState.add[0],lon:urlState.add[1],...(urlState.sky?{sky:urlState.sky}:{})})]:[])
    for(const p of quiet){const key=JSON.stringify(p);if(asked.has(key))continue;asked.add(key);custom.request(p.lat,p.lon,true,{sky:p.sky})}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  useEffect(()=>{
    if(!pendingPins.length)return
    const found=pendingPins.map(p=>custom.sites.find(s=>near(s,p)))
    if(!found.some(Boolean))return
    setPinned(pp=>[...pp,...found.filter((s):s is SiteRecord=>!!s&&!pp.includes(s.id)).map(s=>s.id)].slice(-10))
    setPendingPins(pp=>pp.filter((_,k)=>!found[k]))
  },[custom.sites,pendingPins])
  useEffect(()=>{
    const found=pendingDetail.map(pointSite)
    if(!found.some(Boolean))return
    setPinned(pp=>[...pp,...found.filter((s):s is SiteRecord=>!!s&&!pp.includes(s.id)).map(s=>s.id)].slice(-10))
    setPendingDetail(pp=>pp.filter((_,k)=>!found[k]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[custom.sites,pendingDetail])
  useEffect(()=>{
    if(!pendingSky)return
    const found=custom.sites.find(s=>matchesPoint(s,pendingSky))
    if(found){setSelectedId(found.id);setPendingSky(null);setPinned(pp=>pp.includes(found.id)?pp:[...pp,found.id].slice(-10))}
  },[pendingSky,custom.sites])
  useEffect(()=>{
    if(!custom.lastCreated)return
    const id=custom.lastCreated.id
    setSelectedId(id);setPinned(pp=>pp.includes(id)?pp:[...pp,id].slice(-10))
  },[custom.lastCreated])
  // pairs whose site is still "pt:lat:lon": swap in the recomputed site once it exists
  useEffect(() => {
    if (!pairs.some(([id]) => ptOf(id))) return
    const next = pairs.map(([id, u]): [string, number] => {
      const s = pointSite(id)
      return [s ? s.id : id, u]
    })
    if (next.some(([id], k) => id !== pairs[k][0])) setPairs(next)
  }, [custom.sites, pairs])
  useEffect(() => {
    const planCustomSite = plan ? custom.sites.find(s => s.id === plan[0]) : undefined
    const q = encodeShare({
      ...(pendingSky?{add:[pendingSky.lat,pendingSky.lon] as [number,number],sky:pendingSky.sky}:site.custom?{add:[site.lat,site.lon] as [number,number],sky:site.localSky?.config}:{site:site.id}),
      date: landingUnix, days: durationDays, req, h: observerM, ec: earthMinClear, dsn: requireDsn, pw: power, rd: radio, compareMode, goal: plan ? decisionGoal : undefined, rep: plan ? proposalId ?? undefined : undefined,
      search: searchSettings,area:areaSettings,areaRequired,terrainImport,route:routeSettings,traverse:traverseEnabled?traverseSettings:undefined,traverseRaw:traverseInvalid??undefined,
      plan: plan ? [planCustomSite ? pointReference(planCustomSite) : plan[0], plan[1], plan[2]] : undefined,
      pairs: pairs.map(([id, u]): [string, number] => {
        const s = custom.sites.find((x) => x.id === id)
        return [s ? pointReference(s) : id, u]
      }),
      cmp: pinned.filter((id) => curated.some((s) => s.id === id)),
      cmpDetail:[...pinned.map(id=>custom.sites.find(s=>s.id===id)).filter((s):s is SiteRecord=>!!s?.localSky).map(pointReference),...pendingDetail],
      cmpAdd: [
        ...pinned.map((id) => custom.sites.find((s) => s.id === id)).filter((s): s is SiteRecord => !!s&&!s.localSky).map((s) => [s.lat, s.lon] as [number, number]),
        ...pendingPins, // still being recomputed: keep them in the link
      ],
    })
    const pageHash=location.hash||(workspace.page==='explore'?'':`#${workspace.section}`)
    history.replaceState(null, '', `?${q}${pageHash}`)
  }, [site, landingUnix, durationDays, req, observerM, earthMinClear, requireDsn, pinned, power, curated, custom.sites, pendingPins, pairs, radio, compareMode, plan, decisionGoal, proposalId, searchSettings,areaSettings,areaRequired,terrainImport,routeSettings,pendingSky,pendingDetail,traverseEnabled,traverseSettings,traverseInvalid,workspace])

  // ---- keyboard: space plays, arrows step 1 h (shift: 1 day) ----
  useEffect(() => {
    if(!active || workspace.page!=='explore')return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === ' ' && el?.tagName !== 'BUTTON' && el?.getAttribute('role') !== 'option') {
        e.preventDefault()
        setHoldUntil((h) => h === 0 ? Infinity : 0)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        hold()
        const step = (e.shiftKey ? 24 : 1) * (e.key === 'ArrowRight' ? 1 : -1)
        setCursor((c) => Math.max(0, Math.min(windowHours - 0.01, c + step)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active,windowHours,workspace.page,hold])

  // ---- playback ----
  useEffect(() => setCursor(0), [selectedId, landingUnix])
  const playing = active && workspace.page === 'explore' && validRange && holdUntil === 0
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = performance.now(), endedAt = 0
    const end = windowHours - 0.01
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const c = cursorRef.current
      if (c >= end) {
        // rest on the last hour so the outcome can be read, then start the stay again
        if (!endedAt) endedAt = now
        else if (now - endedAt > END_REST_MS) { endedAt = 0; setCursor(0) }
      } else setCursor(Math.min(end, c + dt * Math.max(6, windowHours / LOOP_S)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, windowHours])

  // Pages share one mission state. Hidden panes stay mounted so completed
  // terrain/search results and in-progress work survive navigation.
  const [jump,setJump]=useState<{id:string;n:number}|null>(()=>workspace.section==='decision'?{id:'decision',n:0}:null)
  const jumpTo=(id:string)=>{
    const next=workspaceLocation(id)
    setWorkspace(next)
    if(location.hash!==`#${id}`)history.pushState(null,'',`${location.pathname}${location.search}#${id}`)
    setJump(j=>({id,n:(j?.n??0)+1}))
  }
  useEffect(()=>{
    const restore=()=>{const next=workspaceLocation(location.hash);setWorkspace(next);setJump(j=>({id:next.section,n:(j?.n??0)+1}))}
    window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore)
    return()=>{window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore)}
  },[])
  useEffect(()=>{
    if(!active || !jump)return
    const raf=requestAnimationFrame(()=>{
      const target=document.getElementById(jump.id)
      // A delayed decision can appear after selecting a story; all other page
      // changes start at the main pane rather than scrolling a long document.
      if(jump.id==='decision'&&target)target.scrollIntoView({block:'start'})
      else window.scrollTo({top:0,behavior:'instant'})
      const heading=target?.querySelector<HTMLElement>('h1,h2')??document.querySelector<HTMLElement>('main')
      heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true})
    })
    return()=>cancelAnimationFrame(raf)
  },[active,jump])
  const pageLink=(id:string)=>(event:React.MouseEvent<HTMLAnchorElement>)=>{
    if(event.button||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return
    event.preventDefault();jumpTo(id)
  }

  // a curated site opens on its own default date and stay; the mission bar says so and offers an undo
  const [dateNote, setDateNote] = useState<{ name: string; unix: number; days: number } | null>(null)
  // the mission profile editor on task pages remembers whether this viewer keeps it open
  const [profileOpen, setProfileOpenRaw] = useState(() => { try { return localStorage.getItem('lastlight:profile-open') === '1' } catch { return false } })
  const setProfileOpen = (open: boolean) => { setProfileOpenRaw(open); try { localStorage.setItem('lastlight:profile-open', open ? '1' : '0') } catch { /* storage unavailable */ } }
  const [verdictTab, setVerdictTab] = useState<'sun' | 'power' | 'earth'>('sun')
  // the surface view fills whatever height its column has; the canvases follow the measured body
  const [viewBody, setViewBody] = useState({ w: 0, h: 0 })
  const viewObserver = useRef<ResizeObserver | null>(null)
  const viewBodyRef = useCallback((el: HTMLDivElement | null) => {
    viewObserver.current?.disconnect()
    if (!el) return
    viewObserver.current = new ResizeObserver(() => setViewBody({ w: el.clientWidth, h: el.clientHeight }))
    viewObserver.current.observe(el)
  }, [])
  const STAGE_H = viewBody.h ? Math.max(200, viewBody.h - 58) : stageHeight()
  useEffect(() => { if (!dateNote) return; const t = setTimeout(() => setDateNote(null), 10000); return () => clearTimeout(t) }, [dateNote])
  const selectSite = (id: string, keepDate = false) => {
    const s = sites.find((x) => x.id === id)
    if (!s) return
    setPendingSky(null)
    setSelectedId(id)
    if (!keepDate && !s.custom) {
      const unix = toHour(Date.parse(s.date) / 1000)
      setDateNote(unix !== landingUnix || s.duration_days !== durationDays ? { name: s.name, unix: landingUnix, days: durationDays } : null)
      setLandingUnix(unix)
      setDurationDays(s.duration_days)
    }
  }
  const useRelayReference=(c:RelayReferenceCase):string|null=>{
    const s=curated.find(s=>s.id===c.site.id)
    if(!s||s.lat!==c.site.lat||s.lon!==c.site.lon||s.ground_m!==c.site.ground_m||!s.horizons['2'])return 'This reference point no longer matches the site catalogue. Rebuild the reference data before using it.'
    setSelectedId(s.id);setLandingUnix(c.startUnix);setDurationDays(c.hours/24);setObserverM(2);restartPlayback();setCursor(0);setPlan(null)
    setSearchSettings(settings=>({...settings,startUnix:c.startUnix}))
    setRadio(previous=>({...previous,operations:{...operationsFor(previous),traffic:operationsFor(previous).traffic??{...DEFAULT_TRAFFIC}},
      relay:{source:`NASA LCRNS 3.1 ${c.id} reference geometry; rates, RF, energy and booking are assumptions`,
        bufferGb:previous.relay?.bufferGb??5,initialGb:previous.relay?.initialGb??0,maxLossGb:previous.relay?.maxLossGb??0,
        passes:c.passes.map(w=>({...w})),reference:{id:c.id,reportSha256:c.reportSha256},rf:previous.relay?.rf}}))
    return null
  }
  const togglePin = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-10)))

  // ---- dispersion grid ----
  // the grid at the page's panel height, like every other view (each height is its own file)
  const [grid, setGrid] = useState<{ id: string; h: number; hz: Horizon[] } | null>(null)
  const gridH = gridHeights(site).includes(observerM) ? observerM : 2
  // touchdown grids are a few hundred KB each: fetch them once the What-if section comes near the screen
  const [whatifNear, setWhatifNear] = useState(false)
  useEffect(() => {
    const el = document.getElementById('whatif')
    if (!el || whatifNear) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setWhatifNear(true), { rootMargin: '800px' })
    io.observe(el)
    return () => io.disconnect()
  }, [whatifNear])
  useEffect(() => {
    let live = true
    if (site.dispersion && whatifNear) loadDispersion(site, gridH).then((hz) => live && setGrid({ id: site.id, h: gridH, hz }), () => {})
    return () => {
      live = false
    }
  }, [site, whatifNear, gridH])

  // custom polar sites: a coarser grid computed in the browser on request, at the panel height in use
  const [customGrid, setCustomGrid] = useState<{ id: string; h: number; meta: GridMeta; hz: Horizon[] } | null>(null)
  const [gridJob, setGridJob] = useState<{ id: string; h: number; progress: number; error?: string } | null>(null)
  const startGrid = () => {
    const s = site
    const h = observerM
    setGridJob({ id: s.id, h, progress: 0 })
    requestGrid(s, h, (f) => setGridJob((j) => (j && j.id === s.id ? { ...j, progress: f } : j)))
      .then((g) => {
        setCustomGrid({ id: s.id, h, ...g })
        setGridJob(null)
      })
      .catch((err) => setGridJob({ id: s.id, h, progress: 0, error: String(err.message ?? err) }))
  }
  const customReady = customGrid?.id === site.id && customGrid.h === observerM
  const gridSite = site.dispersion ? site : customReady ? { ...site, dispersion: customGrid!.meta } : null
  const gridHz = site.dispersion ? (grid?.id === site.id && grid.h === gridH ? grid.hz : null) : customReady ? customGrid!.hz : null
  const gridObserverM = site.dispersion ? gridH : observerM

  const planPoint = plan && parsePointReference(plan[0])
  const planSite = plan ? sites.find(s => s.id === plan[0] || (planPoint && matchesPoint(s, planPoint))) ?? null : null
  const unresolvedSky=[...new Set([...pendingDetail,...pairs.map(([id])=>id),...(plan?[plan[0]]:[])])].filter(id=>{const p=parsePointReference(id);return pendingDetail.includes(id)&&!p||!!p?.sky&&!custom.sites.some(s=>matchesPoint(s,p))})
  const rawDecision = useMemo(() => !unresolvedSky.length&&plan && planSite ? replanLanding({ eph, anchor: planSite, originalUnix: plan[1], delayDays: plan[2],
    candidates: sites.filter(s => pinned.includes(s.id)), trackFor, len: windowHours, observerM, req, power, radio,terrainCheck }) : null,
    [eph, plan, planSite, sites, pinned, trackFor, windowHours, observerM, req, power, radio,terrainCheck,unresolvedSky.length])
  const decision = useMemo(() => rawDecision ? rankDecision(rawDecision, decisionGoal) : null, [rawDecision, decisionGoal])
  const decisionChoice = decision?.alternatives.find(o => o.site.id === proposalId) ?? decision?.alternatives.find(o => o.site.id === site.id && o.unix === landingUnix) ?? decision?.changeSite
  const decisionText = plan && planSite && decision ? `Current analysis: ${site.name}, ${fmtDate(landingUnix)}.\n\n${decisionBrief(decision, planSite, plan[1], plan[2], decisionChoice, decisionGoal)}` : undefined
  const decisionPairs = (options: (LandingOption | null)[]) => [...new Map(options.filter((o): o is LandingOption => !!o)
    .map(o => [`${o.site.id}@${o.unix}`, [o.site.id, o.unix] as [string, number]])).values()]
  const useDecision = (option: LandingOption, navigate = true) => {
    setPairs(decisionPairs([decision?.before ?? null, decision?.delayed ?? null, option]))
    setCompareMode('pairs')
    setSelectedId(option.site.id)
    setLandingUnix(option.unix)
    restartPlayback()
    if (navigate) jumpTo('explore')
  }
  const replanCurrent = () => { setPlan([site.id, landingUnix, 7]); jumpTo('decision') }
  // a new delay plan starts without a proposal; the first render keeps one restored from a link
  const planKey = plan ? plan.join('@') : ''
  const planKeyRef = useRef(planKey)
  useEffect(() => { if (planKeyRef.current !== planKey) { planKeyRef.current = planKey; setProposalId(null) } }, [planKey])
  // the Delays page always answers for a plan: without one, it starts from the current site and date
  useEffect(() => { if (workspace.page === 'whatif' && !plan) setPlan([site.id, landingUnix, 7]) }, [workspace.page, plan, site.id, landingUnix])

  // ---- mission brief (Markdown download) ----
  const [briefCopied, setBriefCopied] = useState(false)
  const downloadBrief = () => {
    if (!stats || !p || !budget) return
    const days = Math.max(0, Math.min(365, Math.floor((eph.count - windowHours - i0) / 24)))
    const ok = Array.from({ length: days }, (_, d) => passFor(site.id, i0 + d * 24))
    let tolerance = 0
    while (tolerance < days && ok[tolerance]) tolerance++
    const currentMoving=terrainReport?.traverse
    const movingRoute=currentMoving?.route
    const currentMovingScope=currentMoving&&movingRoute?.result.status==='found'&&traverseInvalid===null?traverseScope({meta:movingRoute.source.patch,index:{sourceManifestSha256:movingRoute.source.manifestSha256},imported:movingRoute.source.imported},movingRoute.result,traverseInput,eph,{settings:routeSettings,terrain:{maxSlopeDeg:req.maxSlopeDeg,...areaSettings},mission:{lat:site.lat,lon:site.lon}}):''
    const md = missionBrief({
      eph, site, track, landingUnix, i0, len: windowHours, stats, observerM, earthMinClear, requireDsn, req,
      pass: { ...p, slope: slopeOk(site, req.maxSlopeDeg) },
      power, powerStats: budget.power,
      radio, link: budget.link, delivery: budget.delivery,relay:budget.relay,relayService:budget.relayService, radioW: budget.radioW, robust: robustSunRules,
      slip: { days, total: ok.filter(Boolean).length, tolerance },
      url: location.href, skyErr, decision: decisionText,
      terrainArea:terrainReport&&terrainReport.imported?.id===terrainImport&&areaScope(terrainReport.point.lat,terrainReport.point.lon,terrainReport.maxSlopeDeg,terrainReport.settings)===areaScope(site.lat,site.lon,req.maxSlopeDeg,areaSettings)?{...terrainReport,route:JSON.stringify(terrainReport.route?.settings)===JSON.stringify(routeSettings)?terrainReport.route:undefined,traverse:currentMoving?.scope===currentMovingScope?currentMoving:undefined}:undefined,
      routeRequest:routeSettings.goal?routeSettings:undefined,
      traverseRequest:traverseEnabled?traverseSettings:undefined,
      terrainConstraint:pointTerrain,
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    a.download = `lunorizon-${site.id}-${new Date(landingUnix * 1000).toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
    navigator.clipboard?.writeText(md).then(() => {
      setBriefCopied(true)
      setTimeout(() => setBriefCopied(false), 2000)
    }, () => {})
  }

  const pinnedSites = pinned.map((id) => sites.find((s) => s.id === id)).filter(Boolean) as SiteRecord[]
  const compareSites = pinnedSites.some((s) => s.id === site.id) ? pinnedSites : [site, ...pinnedSites]
  const rows = compareSites.map((s) => ({ id: s.id, label: s.name, track: trackFor(s), highlight: s.id === site.id }))
  const p = stats ? passes(stats) : null
  const pHi = statsHi ? passes(statsHi) : null
  const robustSunRules = !!pHi && pHi.daylight && pHi.dark && pHi.earth && slopeOk(site, req.maxSlopeDeg)
  const robustAll = robustSunRules && (!terrainCheck||!!pointTerrain?.pass)
  const resetStory = () => {
    setPendingSky(null);setPendingDetail([])
    setTraverseSettings(DEFAULT_TRAVERSE);setTraverseInvalid(null);setTraverseEnabled(false)
    setTerrainImport(undefined)
    setRouteSettings(DEFAULT_ROUTE)
    setAreaSettings(DEFAULT_AREA)
    setAreaRequired(false)
    setPlan(null)
    setDecisionGoal('earth')
    setObserverM(2)
    setEarthMinClear(0)
    setRequireDsn(false)
    setPower(DEFAULT_POWER)
    setRadio(DEFAULT_RADIO)
    restartPlayback()
    setCursor(0)
  }

  if(pendingSky)return <><header className="topbar"><div className="brand">LUNORIZON <small>Restore mixed-terrain mission point</small></div></header><main className="page"><section className="panel"><div className="panel-h"><h1>{custom.busy?'Recomputing the shared skyline…':'Shared terrain scenario is not ready'}</h1></div><div className="panel-b">
    <p>The requested point is {pendingSky.lat}°, {pendingSky.lon}°E. Its mission results will appear only after the local source, patch checksum and recomputed skyline match. No other site’s verdict is shown.</p>
    <p className="reference-fingerprint">Source: <code>{pendingSky.sky.sourceId}</code></p>
    {custom.error&&<p className="bad" role="alert">{custom.error}</p>}
    {!custom.busy&&<p>Retry when source files are available. For a local dataset, import the same named layers and declaration below, then retry this shared scenario. Importing different files does not change the requested identity.</p>}
    <div className="controls"><button className="btn" disabled={!!custom.busy} onClick={()=>custom.request(pendingSky.lat,pendingSky.lon,false,{sky:pendingSky.sky})}>Retry shared scenario</button><button className="btn ghost" onClick={()=>{setPendingSky(null);setSelectedId('c1')}}>Choose Connecting Ridge C1 instead</button></div>
    {pendingSky.sky.sourceId!=='nasa'&&<TerrainImportPanel importId={pendingSky.sky.sourceId} onSelect={()=>{}}/>}
  </div></section></main></>
  const stories = {
    onRecover: () => {
      resetStory()
      const original = Date.parse('2027-01-11T00:00:00Z') / 1000
      setPinned(sites.filter(s => s.id.startsWith('a3-')).map(s => s.id))
      setSelectedId('a3-haworth')
      setLandingUnix(original + 7 * 86400)
      setDurationDays(6.25)
      setReq({ minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 })
      setCompareMode('same')
      setPlan(['a3-haworth', original, 7])
      jumpTo('decision')
    },
    onArtemis: () => {
      resetStory()
      const a3 = sites.filter((s) => s.id.startsWith('a3-')).map((s) => s.id)
      setPinned(a3)
      setSelectedId('a3-malapert')
      setLandingUnix(Date.parse('2027-01-07T00:00:00Z') / 1000)
      setDurationDays(6.25)
      setReq({ minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 })
      setCompareMode('same')
      jumpTo('whatif')
    },
    onContrast: () => {
      resetStory()
      // each story starts clean, so one clicked earlier does not leak its sites, rules or compare mode into the next
      setPinned(['c1', 'apollo11'])
      setReq(DEFAULT_REQ)
      setCompareMode('same')
      setSelectedId('c1')
      setLandingUnix(Date.parse('2027-01-01T00:00:00Z') / 1000)
      setDurationDays(30)
      jumpTo('compare')
    },
    onFarSide: () => {
      resetStory()
      const s = sites.find((x) => x.id === 'change6')
      if (!s) return
      selectSite('change6')
      setReq(DEFAULT_REQ)
      setCompareMode('same')
      setPinned(['change6', 'change4', 'apollo11'])
      jumpTo('explore')
    },
  }
  const stayLabel = (d: number) => d === 6.25 ? '6.25 days' : `${d} day${d > 1 ? 's' : ''}`
  const needsLabel = presetName === 'Default' ? 'General mission' : presetName

  // every mission input in one place: the Plan page shows it as a column, task pages inside the mission profile
  const missionInputs = (layout: 'column' | 'row') => (
    <div className={`mission-inputs ${layout}`} role="group" aria-label="Mission">
      <div className="mb-field mb-site-field"><span>Site</span>
        <SitePicker sites={sites} site={site} pinned={pinned} onSelect={id => selectSite(id)} onPin={togglePin}
          onRemove={id => { setPinned(pp => pp.filter(x => x !== id)); if (id === site.id) setSelectedId(DEFAULT_SITE); if (id === planSite?.id) setPlan(null); setPairs(pp => pp.filter(([x]) => x !== id)); custom.remove(id) }} />
      </div>
      <label className="mb-field" title="Landing time (UTC), in whole hours: the ephemeris and every result are hourly"><span>Landing (UTC)</span>
        <span className="mb-date"><UtcDateTime label="Landing (UTC)" value={landingUnix} min={eph.startUnix} max={timeOf(eph,eph.count-1-windowHours)} onChange={setLandingUnix}/><span aria-hidden="true" className="mb-unit">UTC</span></span>
        {dateNote && <span className="date-note" role="status">Date and stay set to {dateNote.name}’s default. <button type="button" className="linkish" onClick={(e) => { e.preventDefault(); setLandingUnix(dateNote.unix); setDurationDays(dateNote.days); setDateNote(null) }}>Undo</button></span>}
      </label>
      <label className="mb-field"><span>Stay</span>
        <select aria-label="Stay" className="input" value={durationDays} onChange={(e) => setDurationDays(Number(e.target.value))}>
          {[...new Set([1, 3, 6.25, 7, 10, 14, 30, 60, 90, durationDays])].sort((x, y) => x - y).map((d) => <option key={d} value={d}>{stayLabel(d)}</option>)}
        </select>
      </label>
      <div className="mb-field mb-needs" title="The sunlight, darkness, Earth-contact and slope requirements used to judge every plan."><span>Mission needs</span>
        <span className="mb-needs-row">
          <select aria-label="Rules" className="input" value={presetName} onChange={(e) => { const r = REQ_PRESETS.find((x) => x.name === e.target.value); if (r) applyPreset(r) }}>
            {REQ_PRESETS.map((r) => <option key={r.name} value={r.name}>{r.name==='Default'?'General mission':r.name}</option>)}
            {presetName === 'Custom' && <option value="Custom">Custom</option>}
          </select>
          <NeedsEditor>
            <h3>Mission requirements</h3>
            <p className="muted">Every page judges plans against these four rules.</p>
            <div className="needs-fields">
              <ReqField label="Daylight after landing at least" unit="h" value={req.minDaylightH} onChange={(v) => setReq({ ...req, minDaylightH: v })} />
              <ReqField label="Longest darkness at most" unit="h" value={req.maxDarkH} onChange={(v) => setReq({ ...req, maxDarkH: v })} />
              <ReqField label="Earth in view at least" unit="%" value={req.minEarthPct} onChange={(v) => setReq({ ...req, minEarthPct: v })} />
              <ReqField label="Ground slope at most" unit="°" value={req.maxSlopeDeg} onChange={(v) => setReq({ ...req, maxSlopeDeg: v })} />
            </div>
            {req.minDaylightH > windowHours && (
              <p className="warnnote">The daylight need ({fmtHours(req.minDaylightH)}) is longer than the {fmtHours(windowHours)} stay, so it is checked as Sun up for the whole stay.</p>
            )}
            <div className="field">
              <span>Presets</span>
              <div className="seg">
                {REQ_PRESETS.map((r) => (
                  <button key={r.name} aria-pressed={sameReq(req, r.req)} title={r.tip} onClick={() => applyPreset(r)}>{r.name}</button>
                ))}
              </div>
            </div>
          </NeedsEditor>
        </span>
      </div>
      <div className="mb-group-label">Hardware and line of sight</div>
      <div className="mb-field" title="Height of the solar panels and antenna above the ground. Raising them can reveal the Sun or Earth over nearby terrain."><span>Panel height</span>
        <div className="seg">
          {[2, 10].map((h) => (
            <button key={h} aria-pressed={observerM === h} onClick={() => setObserverM(h)} disabled={!site.horizons[String(h)]}>{h} m</button>
          ))}
        </div>
      </div>
      <div className="mb-field" title="How far Earth must clear the local terrain skyline. A larger angle asks for a clearer line of sight; ground-station mode checks the named antenna instead."><span>Earth clearance</span>
        <div className="seg">
          {[0, 2, 5].map((c) => (
            <button key={c} aria-pressed={earthMinClear === c} onClick={() => setEarthMinClear(c)} title={`${c} degrees above the local terrain skyline`}>{c}°</button>
          ))}
          {(eph.stations || eph.dsn) && <button aria-pressed={requireDsn} onClick={() => setRequireDsn((v) => !v)}
            title="NASA Deep Space Network (DSN): use DSS-24, DSS-54 or DSS-34: the same antenna must clear lunar terrain and receive the lander at ≥10° elevation. Use this to include ground-station visibility in the contact screen.">+ DSN</button>}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <header className="appbar" ref={barRef}>
        <a className="brand" href="#home" onClick={pageLink('home')}>
          <BrandIcon />
          <span className="brand-name">LUNORIZON<small>Lunar landing site navigator</small></span>
        </a>
        <nav className="tabs" aria-label="Workspace pages">
          {WORKSPACE_PAGES.map((p) => <a key={p.id} href={`#${p.target}`} aria-current={workspace.page===p.id?'page':undefined} onClick={pageLink(p.target)}><Icon name={p.icon} />{p.label}</a>)}
        </nav>
        <div className="appbar-actions">
          {stats && <button className="btn-secondary" onClick={downloadBrief} title="Download this site, window, requirements, events and power as a Markdown mission brief (also copied to the clipboard)"><Icon name="download" />{briefCopied ? 'Copied ✓' : 'Mission brief'}</button>}
        </div>
      </header>

      {workspace.page !== 'home' && workspace.page !== 'explore' && (
        <div className="profile-bar">
          <div className="profile-summary">
            <span className="profile-title"><Icon name="sliders" />Mission profile</span>
            <span className="profile-site"><i className="dot" style={{ background: GROUP_COLOR[site.group] }} />{site.name}</span>
            <span className="mono">{fmtDate(landingUnix)}</span>
            <span>{stayLabel(durationDays)}</span>
            <span>{needsLabel}</span>
            <span className="muted">panels {observerM} m · Earth ≥ {earthMinClear}°{requireDsn ? ' + DSN' : ''}</span>
            <button className="btn-link profile-toggle" aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}>{profileOpen ? 'Close' : 'Edit'}</button>
          </div>
          {profileOpen && missionInputs('row')}
        </div>
      )}

      <main className={`page workspace page-${workspace.page}`} tabIndex={-1}>
        {workspace.page === 'home' && <Home eph={eph} sites={curated} stories={stories} onOpen={(t) => jumpTo(t)} />}
        {unresolvedSky.length>0&&<div className="panel"><div className="panel-b"><p role="alert" className="warnnote">{unresolvedSky.length} source-specific comparison or plan point(s) are unavailable. Search and delay recommendations are paused until they are restored or explicitly removed.</p>{custom.error&&<p className="bad">{custom.error}</p>}<div className="controls"><button className="btn sm" disabled={!!custom.busy} onClick={()=>unresolvedSky.forEach(id=>{const p=parsePointReference(id);if(p)custom.request(p.lat,p.lon,true,{sky:p.sky})})}>Retry source-specific points</button><button className="btn sm ghost" onClick={()=>{setPendingDetail([]);setPairs(pp=>pp.filter(([id])=>!unresolvedSky.includes(id)));if(plan&&unresolvedSky.includes(plan[0]))setPlan(null)}}>Remove unavailable points from this analysis</button></div></div></div>}
        <div hidden={workspace.page!=='explore'} data-page="mission-detail">
        <div className="explore" id="explore">
          <aside className="inputs-panel" aria-label="Mission inputs">
            <div className="panel-title"><Icon name="sliders" /><h2>Mission inputs</h2><ExamplesMenu {...stories} /></div>
            {workspace.page === 'explore' && missionInputs('column')}
            <details className="inputs-add">
              <summary>Add a site by coordinates</summary>
              <CustomSite state={custom} onCreated={(id) => { setSelectedId(id); setPinned((pp) => (pp.includes(id) ? pp : [...pp, id].slice(-10))) }} />
            </details>
          </aside>

          <div className="plan-center">
          <section className="viewer" aria-labelledby="stage-title">
            <div className="viewer-top">
              <div>
                <p className="eyebrow">Surface view · {site.name}</p>
                <h2 id="stage-title">{view === '3d' ? 'Stand at the site' : view === 'map' ? 'Where it is' : 'What the horizon hides'}</h2>
              </div>
              <div className="seg on-dark" role="tablist" aria-label="View">
                <button role="tab" aria-pressed={view === 'skyline'} onClick={() => setView('skyline')}>360° skyline</button>
                <button role="tab" aria-pressed={view === '3d'} disabled={!!site.localSky} title={site.localSky?'No source-matched 3D surface is available for this scenario':undefined} onClick={() => setView('3d')}>3D view</button>
                <button role="tab" aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
              </div>
            </div>
            <div className="viewer-body" ref={viewBodyRef} style={{ '--view-h': `${STAGE_H}px` } as React.CSSProperties}>
              <div className="viewer-fill">
                {view === 'map' ? (
                  <div className="viewer-map">
                    <MapView basemap={basemap} sites={sites} selectedId={site.id} pinned={pinned} onSelect={(id) => selectSite(id)} now={mapNow}
                      observerM={observerM} earthMinClear={earthMinClear} requireDsn={requireDsn}
                      onPickPoint={(lat, lon) => custom.request(lat, lon)} />
                    {site.localSky&&<p className="model-note">Map shades use the background terrain, not this point’s mixed DEM. The point skyline, timeline and mission systems use the selected scenario.</p>}
                  </div>
                ) : view === 'skyline'||site.localSky ? (
                  <Skyline horizon={horizon} track={track} i0={i0} len={windowHours} cursor={i0 + cursor} observerM={observerM} landingUnix={landingUnix} height={STAGE_H} />
                ) : (
                  <Suspense fallback={<div className="muted" style={{ padding: 40 }}>Loading 3D view…</div>}>
                    <Site3D eph={eph} site={site} cursor={i0 + cursor} observerM={observerM} height={STAGE_H} />
                  </Suspense>
                )}
              </div>
            </div>
            <div className="viewer-controls playbar" role="group" aria-label="Playback controls">
              <input type="range" min={0} max={windowHours - 0.01} step={0.01} value={cursor} disabled={!validRange} onChange={(e) => { hold(); setCursor(Number(e.target.value)) }} aria-label="Mission time" title="Plays on a loop. Drag to hold a moment; Space pauses. ←/→ one hour, shift+←/→ one day" data-playing={playing ? 'true' : 'false'} />
              <span className="clock">T+{fmtElapsed(cursor)} · {fmtDate(landingUnix + cursor * 3600)}</span>
            </div>
          </section>

          <section className="timeline-panel panel" aria-labelledby="timeline-title">
            <div className="panel-h"><h2 id="timeline-title">Mission timeline</h2><span className="aside">Drag to move through the stay</span></div>
            <div className="panel-b">
              {validRange && <Timeline eph={eph} rows={[rows.find((r) => r.id === site.id)!]} i0={i0} len={windowHours} cursor={i0 + cursor} onCursor={(i) => { hold(); setCursor(i - i0) }} detailed />}
              {validRange && (
                <details className="events">
                  <summary>Sunrise, sunset and Earth-contact times · export</summary>
                  <EventList eph={eph} site={site} track={track} i0={i0} len={windowHours} observerM={observerM} budget={budget} power={power} radio={radio} terrainConstraint={pointTerrain} onSeek={(h) => { hold(); setCursor(Math.min(windowHours - 0.01, h)) }} />
                </details>
              )}
            </div>
          </section>

          </div>

          <section className="verdict-panel" aria-label="Verdict">
            <Headline site={site} stats={stats} sunset={sunset} skyErr={skyErr} landingUnix={landingUnix} windowHours={windowHours} valid={validRange} maxSlope={req.maxSlopeDeg}
              powerEmptyAt={budget?.power.shortfallAt ?? null}
              thermalBreachH={budget?.power.thermal?.firstBreachH ?? null}
              relayScenario={!!radio.relay}
              relayIssue={budget?.relayService?.issues[0]??null}
              dataOverflow={budget?.relay && budget.relay.relayLostBits>(radio.relay?.maxLossGb??0)*8e9+1
                ? {bits:budget.relay.relayLostBits,limitGb:radio.relay!.maxLossGb,where:'Relay'}
                : budget?.delivery && budget.delivery.lostBits>(operationsFor(radio).traffic?.maxLossGb??0)*8e9+1 ? { bits: budget.delivery.lostBits, limitGb: operationsFor(radio).traffic?.maxLossGb??0 } : null}
              earthMinClear={earthMinClear} requireDsn={requireDsn}
              verdict={p ? { all: p.daylight && p.dark && p.earth && slopeOk(site, req.maxSlopeDeg) && (!terrainCheck||!!pointTerrain?.pass), robust: robustAll, misses: [!p.daylight && 'daylight', !p.dark && 'darkness', !p.earth && 'Earth in view', !slopeOk(site, req.maxSlopeDeg) && (slopeKnown(site) ? 'slope' : 'slope not measured'),terrainCheck&&!pointTerrain?.pass&&(pointTerrain?.status==='ready'?'terrain footprint':'terrain data unavailable')].filter((x): x is string => !!x) } : null}
              actions={<><button className="btn sm" aria-pressed={pinned.includes(site.id)} onClick={() => togglePin(site.id)} disabled={!pinned.includes(site.id) && pinned.length >= 10} title="Candidate sites are compared, searched and offered as delay replacements">{pinned.includes(site.id) ? '✓ Candidate' : '+ Add to candidates'}</button>{site.custom && <button className="btn sm ghost" onClick={() => { const n = window.prompt('Name this site', site.name)?.trim(); if (n) custom.rename(site.id, n.slice(0, 60)) }} title="Rename this site">Rename</button>}</>} />
            {stats && p && <Kpis stats={stats} pass={p} req={req} power={budget?.power ?? null} tab={verdictTab} onTab={setVerdictTab} onPower={() => jumpTo('power')} onComms={() => jumpTo('communication')} />}
            {pointTerrain&&<p className={`model-note ${pointTerrain.pass?'good':'bad'}`}>{pointTerrain.pass?`Required terrain footprint fits at this mission point (${(2*pointTerrain.radiusM!).toFixed(1)} m available / ${pointTerrain.requiredDiameterM} m required).`:pointTerrain.issue} Sun/Earth/power are evaluated at the centre, not across the entire disc.</p>}
            {validRange && <DelayStrip site={site} i0={i0} windowHours={windowHours} eph={eph} passFor={passFor} landingUnix={landingUnix} onJump={setLandingUnix} planOpen={!!plan} onPlan={() => plan ? jumpTo('decision') : replanCurrent()} />}
          </section>

        </div>
        </div>

        <div className="page-head" hidden={workspace.page!=='compare'}>
          <p className="eyebrow">Compare</p>
          <h1>Which site, which day?</h1>
          <p>Your candidate sites side by side on the same dates or as site + date pairs, or a search across every candidate and day.</p>
        </div>
        <nav className="page-subnav" aria-label="Alternative pages" hidden={workspace.page!=='compare'}>
          <a href="#compare" aria-current={workspace.section==='compare'?'page':undefined} onClick={pageLink('compare')}>Compare sites</a>
          <a href="#search" aria-current={workspace.section==='search'?'page':undefined} onClick={pageLink('search')}>Find a plan</a>
        </nav>
        <div hidden={workspace.page!=='compare'}>
          <CandidateList sites={sites} pinned={pinned} currentId={site.id} onToggle={togglePin} onSelect={(id) => selectSite(id, true)} />
        </div>
        <section className="block" id="compare" hidden={workspace.page!=='compare'||workspace.section!=='compare'} data-page="compare">
          <header className="compare-bar">
            <div className="seg" role="tablist" aria-label="Compare">
              <button role="tab" aria-pressed={compareMode === 'same'} onClick={() => setCompareMode('same')}>Same dates</button>
              <button role="tab" aria-pressed={compareMode === 'pairs'} onClick={() => setCompareMode('pairs')}>Site + date pairs{pairs.length ? ` (${pairs.length})` : ''}</button>
            </div>
          </header>
          <div className="panel">
            <div className="panel-b">
              {compareMode === 'same' ? (<>
                <CompareTable rows={compareSites.map((s) => ({ s, i0, key: s.id }))} trackFor={trackFor} len={windowHours} selectedKey={site.id} onPick={(r) => {selectSite(r.s.id,true);jumpTo('explore')}} passes={passes} maxSlope={req.maxSlopeDeg} eph={eph} power={power} radio={radio} terrainCheck={terrainCheck} />
                {validRange && <div className="compare-timeline"><Timeline eph={eph} rows={rows} i0={i0} len={windowHours} cursor={i0 + cursor} onCursor={(i) => setCursor(i - i0)} onPick={(id) => {selectSite(id,true);jumpTo('explore')}} /></div>}
              </>) : (<>
                <div className="pairbar">
                  <button className="btn sm" disabled={pairs.some(([id, u]) => id === site.id && u === landingUnix) || pairs.length >= 8}
                    onClick={() => setPairs((pp) => [...pp, [site.id, landingUnix] as [string, number]].slice(-8))}
                    title={site.custom ? 'Add your site and the landing date shown above; a link carries it as coordinates' : 'Add the site and landing date shown above'}>
                    + Add {site.name.split(' (')[0]}, {fmtDate(landingUnix, false)}
                  </button>
                  {pairs.length > 0 && <button className="btn sm ghost" onClick={() => setPairs([])}>Clear</button>}
                  <span className="faint">Each pair keeps its own landing date; all use the {fmtHours(windowHours)} stay and the requirements above.</span>
                </div>
                {pairs.length > 0 ? (
                  <CompareTable rows={pairs.flatMap(([id, u]) => { const s = sites.find((x) => x.id === id); return s ? [{ s, i0: Math.round(indexOf(eph, u)), key: `${id}@${u}`, when: u }] : [] })}
                    trackFor={trackFor} len={windowHours} selectedKey={`${site.id}@${landingUnix}`}
                    onPick={(r) => { setSelectedId(r.s.id); if (r.when) setLandingUnix(r.when);jumpTo('explore') }}
                    onRemove={(r) => setPairs((pp) => pp.filter(([id, u]) => `${id}@${u}` !== r.key))}
                    passes={passes} maxSlope={req.maxSlopeDeg} eph={eph} power={power} radio={radio} terrainCheck={terrainCheck} />
                ) : (
                  <p className="muted" style={{ margin: '12px 0 0' }}>Choose a site and date above, then select Add.</p>
                )}
              </>)}
            </div>
          </div>
        </section>

        <div hidden={workspace.page!=='compare'||workspace.section!=='search'} data-page="search">
        {!unresolvedSky.length&&<MissionSearch active={workspace.page==='compare'&&workspace.section==='search'} eph={eph} candidates={compareSites} trackFor={trackFor} len={windowHours} observerM={observerM} req={req} power={power} radio={radio} terrainCheck={terrainCheck}
          settings={searchSettings} onSettings={setSearchSettings} currentUnix={landingUnix} earthMinClear={earthMinClear} requireDsn={requireDsn}
          onUse={option => useDecision(option)} />}

        </div>

        <section className="block" id="whatif" hidden={workspace.page!=='whatif'} data-page="whatif">
          <header>
            <div>
              <p className="eyebrow">Delays</p>
              <h2>Land late. Then what?</h2>
              <p>Slip the landing by days or weeks: which sites still work, how long you would wait here, and how far a missed touchdown can drift.</p>
            </div>
          </header>
        {plan && !unresolvedSky.length && <LandingDecision anchor={planSite} originalUnix={plan[1]} delayDays={plan[2]} len={windowHours} req={req} result={decision}
          currentSite={site} currentUnix={landingUnix} replacement={decisionChoice ?? null} onChoose={option => setProposalId(option.site.id)}
          goal={decisionGoal} onGoal={goal => {
            setDecisionGoal(goal)
            const option = rawDecision && rankDecision(rawDecision, goal).changeSite
            setProposalId(option ? option.site.id : null)
          }} onPowerAdjustment={() => {
            if (!decision?.powerAdjustment) return
            setPower(p => ({ ...p, batteryWh: decision.powerAdjustment!.batteryWh }))
            useDecision(decision.powerAdjustment.option, false)
          }}
          onDelay={days => setPlan([plan[0], plan[1], days])} onUse={useDecision} onReset={replanCurrent} candidates={pinned.length} onEditCandidates={() => jumpTo('compare')}
          onCompare={() => {
            setPairs(decisionPairs([decision?.before ?? null, decision?.delayed ?? null, decisionChoice ?? null, decision?.waitHere ?? null]))
            setCompareMode('pairs'); jumpTo('compare')
          }} />}
          <div className="whatif-h">
            <div><h3>Every landing day, and every touchdown point</h3><p className="muted">Click a day to land on it.</p></div>
            <label className="field">
              <span>Colour by</span>
              <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
                {(Object.keys(METRICS) as MetricKey[]).map((k) => <option key={k} value={k}>{METRICS[k].label}</option>)}
              </select>
            </label>
          </div>
          <div className="whatif">
            <div className="panel">
              <div className="panel-h"><h3>Landing date, next 12 months</h3><span className="aside">{durationDays}-day stay · underline: <span style={{ color: 'var(--good)' }}>passes</span> · <span style={{ color: 'var(--warn)' }}>fails with {raisedPhrase(pinned.map(errOf))}</span></span></div>
              <div className="panel-b">
                <SlipHeatmap eph={eph} rows={rows} landingUnix={landingUnix} windowHours={windowHours} metric={metric} selectedId={site.id}
                  passes={passFor} raised={raisedPhrase(pinned.map(errOf))} onPickDate={(u, id) => { setLandingUnix(u); setSelectedId(id) }} />
                <SlipSummary site={site} i0={i0} windowHours={windowHours} eph={eph} passFor={passFor} errOf={errOf} landingUnix={landingUnix} onJump={setLandingUnix} pinnedIds={pinned} terrain={pointTerrain} />
                <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>{METRICS[metric].help}</p>
              </div>
            </div>
            <div className="panel">
              <div className="panel-h"><h3>Touchdown error, ±500 m</h3><span className="aside">{site.name} · panels {gridObserverM} m{gridObserverM !== observerM ? ` (no ${observerM} m grid here)` : ""}</span></div>
              <div className="panel-b">
                {site.localSky?<p className="muted">This mixed-terrain scenario is a stationary point. A source-matched touchdown grid is not available; the background grid is not substituted.</p>:gridSite && gridHz && validRange ? (
                  <Dispersion eph={eph} site={gridSite} grid={gridHz} sites={sites} i0={i0} len={windowHours} metric={metric} earthMinClear={earthMinClear} req={req} requireDsn={requireDsn} skyErr={skyErr} observerM={gridObserverM} footprintActive={areaRequired} onAddSite={(la, lo) => custom.request(la, lo)} />
                ) : site.dispersion ? (
                  <p className="muted">Loading touchdown grid…</p>
                ) : site.custom && site.lat <= -80 ? (
                  <div className="muted">
                    <p style={{ marginTop: 0 }}>Compute 121 touchdown points, 100 m apart, around {site.name}. Each gets its own horizon from the 80 m terrain at {observerM} m panel height; it takes a few seconds.</p>
                    {gridJob?.id === site.id && !gridJob.error ? (
                      <div className="progress" role="progressbar" aria-valuenow={Math.round(gridJob.progress * 100)}><span style={{ width: `${gridJob.progress * 100}%` }} /></div>
                    ) : (
                      <button className="btn" onClick={startGrid}>Compute touchdown grid</button>
                    )}
                    {gridJob?.id === site.id && gridJob.error && <p className="bad">{gridJob.error}</p>}
                  </div>
                ) : (
                  <p className="muted">Touchdown grids need terrain fine enough to resolve 100 m. They are precomputed for every curated site, and your browser can compute one for any site you add south of 80°S, where the 80 m polar grid is available.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="page-head" hidden={workspace.page!=='engineering'}>
          <p className="eyebrow">Engineering</p>
          <h1>Can it land, drive, stay powered and reach Earth?</h1>
          <p>Landing room and routes, the power budget and the radio link for the mission above.</p>
        </div>
        <nav className="page-subnav" aria-label="Engineering pages" hidden={workspace.page!=='engineering'}>
          <a href="#terrain-area" aria-current={workspace.section==='terrain-area'?'page':undefined} onClick={pageLink('terrain-area')}>Terrain & routes</a>
          <a href="#power" aria-current={workspace.section==='power'?'page':undefined} onClick={pageLink('power')}>Power & temperature</a>
          <a href="#communication" aria-current={workspace.section==='communication'?'page':undefined} onClick={pageLink('communication')}>Communication & data</a>
        </nav>
        <section className="block" id="terrain-area" hidden={workspace.page!=='engineering'||workspace.section!=='terrain-area'} data-page="terrain-area">
          <LandingAreaPanel eph={eph} traverseInput={traverseInput} traverseInvalid={traverseInvalid} traverseOpen={traverseEnabled} onTraverseSettings={onTraverseSettings} site={site} maxSlopeDeg={req.maxSlopeDeg} settings={areaSettings} initialOpen={!!urlState.area||areaRequired||!!terrainImport||!!urlState.route||traverseEnabled} active={workspace.page==='engineering'&&workspace.section==='terrain-area'} busy={!!custom.busy} requirePoint={areaRequired} onRequirePoint={setAreaRequired} importId={terrainImport} onImport={setTerrainImport} routeSettings={routeSettings} onRouteSettings={setRouteSettings}
            computeError={custom.error} onApplySky={sky=>{custom.request(site.lat,site.lon,false,{sky,name:`${site.name.replace(/ · mixed terrain$/,'')} · mixed terrain`});jumpTo('explore')}}
            onRetryTerrain={()=>setTerrainRevision(v=>v+1)}
            onSettings={setAreaSettings} onSlope={maxSlopeDeg=>setReq({...req,maxSlopeDeg})} onReport={onTerrainReport} onInspect={(lat,lon)=>{custom.request(lat,lon);jumpTo('explore')}}/>
        </section>

        <section className="block" id="systems" hidden={workspace.page!=='engineering'||workspace.section==='terrain-area'} data-page="systems">
            {validRange && budget && (
              <div className="system-panels">
              <div className="panel power-panel" id="power" hidden={workspace.section!=='power'}>
                <div className="panel-h"><h2>Power</h2><span className="aside">includes the radio while it transmits</span></div>
                <div className="panel-b">
                  <PowerPanel eph={eph} track={track} i0={i0} len={windowHours} cursor={cursor} power={power} stats={budget.power} radioW={budget.radioW} onChange={setPower} />
                  <SurfaceContextPanel site={site} />
                </div>
              </div>
              <div className="panel comm-panel" id="communication" hidden={workspace.section!=='communication'}>
                <div className="panel-h"><h2>Communication</h2><span className="aside">{radio.relay?'assumed relay service; Earth arrival tracked separately':'downlink to the Deep Space Network, limited by power'}</span></div>
                <div className="panel-b">
                  <CommPanel eph={eph} track={track} i0={i0} len={windowHours} cursor={cursor} radio={radio} budget={budget} onChange={setRadio} onReference={useRelayReference}/>
                </div>
              </div>
              </div>
            )}
          {!validRange&&<p className="warnnote">Choose a date and stay inside the retained ephemeris coverage to calculate the systems.</p>}
        </section>

        <div className="page-head" hidden={workspace.page!=='reference'}>
          <p className="eyebrow">Evidence</p>
          <h1>Why trust it?</h1>
          <p>Real landings compared with the model, the checks against NASA and JPL data, and what the model does not cover.</p>
        </div>
        <nav className="page-subnav" aria-label="Reference pages" hidden={workspace.page!=='reference'}>
          <a href="#cases" aria-current={workspace.section==='cases'?'page':undefined} onClick={pageLink('cases')}>Case files</a>
          <a href="#upcoming" aria-current={workspace.section==='upcoming'?'page':undefined} onClick={pageLink('upcoming')}>Next landings</a>
          <a href="#evidence" aria-current={workspace.section==='evidence'?'page':undefined} onClick={pageLink('evidence')}>Evidence & limits</a>
        </nav>
        <section className="block" id="upcoming" hidden={workspace.page!=='reference'||workspace.section!=='upcoming'} data-page="upcoming">
          <header>
            <div>
              <h2>Next landings: which days work?</h2>
              <p>Days meeting your requirements at each mission’s representative site.</p>
            </div>
          </header>
          <Upcoming eph={eph} sites={sites} trackFor={trackFor} req={req} terrainCheck={terrainCheck}
            onExplore={(id, unix, days) => { setSelectedId(id); setLandingUnix(unix); setDurationDays(days); jumpTo('explore') }} />
        </section>

        <section className="block" id="cases" hidden={workspace.page!=='reference'||workspace.section!=='cases'} data-page="cases">
          <header>
            <div>
              <h2>Real landings</h2>
              <p>Reported events vs modeled conditions. ± tests a {SKYLINE_ERR_DEG}° skyline shift, not an error bound.</p>
            </div>
          </header>
          <CaseFiles eph={eph} sites={sites} trackFor={trackFor} onOpen={(id, unix, days) => { setSelectedId(id); setLandingUnix(unix); setDurationDays(days); jumpTo('explore') }} />
        </section>

        <section className="block" id="evidence" hidden={workspace.page!=='reference'||workspace.section!=='evidence'} data-page="evidence">
          <header>
            <div>
              <h2>Validation and limits</h2>
            </div>
          </header>
          <Evidence />
        </section>

        <footer className="footer">
          <span>LUNORIZON · NASA Space Apps Challenge 2026 · Lunar Landing Site Navigator</span>
          <span>Terrain: NASA LRO LOLA (PDS) · Ephemeris: NASA/JPL DE440 via NAIF SPICE</span>
          <span>Not affiliated with or endorsed by NASA.</span>
          <a href="#evidence" onClick={pageLink('evidence')}>Assumptions & limits</a>
          <a href="./third-party-notices.txt" target="_blank" rel="noopener noreferrer">Third-party notices</a>
        </footer>
      </main>
    </>
  )
}

function SlipSummary({ site, i0, windowHours, eph, passFor, errOf, landingUnix, onJump, pinnedIds,terrain }: {
  site: SiteRecord; i0: number; windowHours: number; eph: Ephemeris; passFor: (id: string, dayIndex: number, robust?: boolean) => boolean; errOf: (id: string) => number; landingUnix: number; onJump: (u: number) => void; pinnedIds: string[]
  terrain?:TerrainPointScreen
}) {
  const s = useMemo(() => {
    const days = Math.max(0, Math.min(365, Math.floor((eph.count - windowHours - i0) / 24)))
    const ok = Array.from({ length: days }, (_, d) => passFor(site.id, i0 + d * 24))
    const total = ok.filter(Boolean).length
    let tolerance = 0
    while (tolerance < days && ok[tolerance]) tolerance++
    const next = ok.findIndex((v, d) => v && d > 0 && !ok[0]) // only meaningful if today fails
    // NASA keeps several Artemis III regions because one region alone rarely has enough viable days
    const ids = Array.from(new Set([site.id, ...pinnedIds]))
    const perSite = ids.map((id) => Array.from({ length: days }, (_, d) => passFor(id, i0 + d * 24)))
    const anyDays = Array.from({ length: days }, (_, d) => perSite.some((row) => row[d])).filter(Boolean).length
    const bestSingle = Math.max(...perSite.map((row) => row.filter(Boolean).length))
    // the same with each skyline raised by its uncertainty: a raised skyline only removes Sun and Earth time, so this is the pessimistic case
    const okHi = ok.map((v, d) => v && passFor(site.id, i0 + d * 24, true))
    const perSiteHi = perSite.map((row, k) => row.map((v, d) => v && passFor(ids[k], i0 + d * 24, true)))
    const anyDaysHi = Array.from({ length: days }, (_, d) => perSiteHi.some((row) => row[d])).filter(Boolean).length
    // landing windows: runs of consecutive passing days
    const windows: { start: number; len: number; robust: number }[] = []
    for (let d = 0; d < days; d++) {
      if (!ok[d]) continue
      const start = d
      while (d < days && ok[d]) d++
      windows.push({ start, len: d - start, robust: okHi.slice(start, d).filter(Boolean).length })
    }
    return { days, total, tolerance, next, today: ok[0], todayHi: okHi[0], totalHi: okHi.filter(Boolean).length, anyDays, anyDaysHi, bestSingle, nSites: ids.length, windows }
  }, [site, i0, windowHours, eph, passFor, pinnedIds])
  if (!s.days) return null
  return (
    <>
    {terrain&&!terrain.pass&&<p className="model-note">Required point footprint is not verified: {terrain.issue} Passing dates are not credited under this constraint; changing the date does not create terrain data or enlarge the footprint.</p>}
    <div className={`callout ${s.today ? '' : 'bad'}`} style={{ marginTop: 12 }}>
      {s.today ? (
        <><b>{site.name}</b> meets the {terrain?'Sun/Earth/slope/point-footprint':'Sun/Earth/slope'} rules on this date and keeps meeting them if the landing slips by up to <b className="mono">{s.tolerance >= s.days ? `${s.days}+` : s.tolerance - 1} day{s.tolerance === 2 ? '' : 's'}</b>. </>
      ) : (
        <><b>{site.name}</b> misses a {terrain?'Sun/Earth/slope/point-footprint':'Sun/Earth/slope'} rule on this date.{' '}
          {s.next > 0 ? <>The next landing day that meets all of them is <button className="btn sm" onClick={() => onJump(landingUnix + s.next * 86400)}>{fmtDate(landingUnix + s.next * 86400, false)} (+{s.next} d)</button>. </> : 'No day in the next 12 months meets all of them. '}
        </>
      )}
      {s.today && !s.todayHi && <><b>Fragile:</b> it fails with {raisedPhrase([errOf(site.id)])}. </>}
      <span className="muted">{s.total} of the next {s.days} landing days pass; {s.totalHi} still pass with {raisedPhrase([errOf(site.id)])}.</span>
    </div>
    {s.windows.length > 0 && (
      <div className="windows" aria-label="Landing windows in the next year">
        <span className="faint">Landing windows, next {s.days} days</span>
        {s.windows.slice(0, 10).map((w) => {
          const u = landingUnix + w.start * 86400
          const day = (x: number) => new Date(x * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
          return (
            <button key={w.start} className={`window ${w.start === 0 ? 'now' : ''} ${w.robust < w.len ? 'fragile' : ''}`} onClick={() => onJump(u)}
              title={`${w.len} landing day${w.len > 1 ? 's' : ''} in a row; ${w.robust} still pass${w.robust === 1 ? 'es' : ''} with ${raisedPhrase([errOf(site.id)])}. Click to land on the first.`}>
              {w.len > 1 ? `${day(u)} – ${day(u + (w.len - 1) * 86400)}` : day(u)} <b>{w.len} d</b>
            </button>
          )
        })}
        {s.windows.length > 10 && <span className="faint">+{s.windows.length - 10} more</span>}
      </div>
    )}
    {s.nSites > 1 && (
      <div className="callout earth" style={{ marginTop: 8 }}>
        <b>Combined availability:</b> keep all {s.nSites} compared sites open and at least one meets the {terrain?'Sun/Earth/slope/point-footprint':'Sun/Earth/slope'} rules on{' '}
        <b className="mono">{s.anyDays}</b> of {s.days} days ({Math.round((100 * s.anyDays) / s.days)}%), against <b className="mono">{s.bestSingle}</b> for the best single site. With {raisedPhrase(pinnedIds.map(errOf))}: <b className="mono">{s.anyDaysHi}</b> days.
      </div>
    )}
    </>
  )
}


/** Guided example scenarios, opened from the top bar. Each one starts from clean settings. */
function ExamplesMenu({ onContrast, onArtemis, onFarSide, onRecover }: { onContrast: () => void; onArtemis: () => void; onFarSide: () => void; onRecover: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (e: PointerEvent) => { const el = ref.current; if (el?.open && !el.contains(e.target as Node)) el.open = false }
    const esc = (e: KeyboardEvent) => { const el = ref.current; if (e.key === 'Escape' && el?.open) { el.open = false; el.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [])
  const pick = (run: () => void) => () => { if (ref.current) ref.current.open = false; run() }
  return (
    <details className="examples-pop" ref={ref}>
      <summary className="btn sm" aria-label="Try an example">Examples</summary>
      <div className="examples-pop-body stories" role="group" aria-label="Try an example">
        <span className="faint">Try an example</span>
        <button className="story story-primary" onClick={pick(onRecover)}><b>7 days late</b> find a landing option →</button>
        <button className="story" onClick={pick(onArtemis)}><b>Artemis III</b> why NASA keeps nine regions</button>
        <button className="story" onClick={pick(onContrast)}><b>Pole vs Apollo 11</b> why the pole is hard</button>
        <button className="story" onClick={pick(onFarSide)}><b>Chang’e 6</b> why the far side needs a relay</button>
      </div>
    </details>
  )
}

/** The candidate sites every comparison, search and delay replacement draws from. */
function CandidateList({ sites, pinned, currentId, onToggle, onSelect }: {
  sites: SiteRecord[]; pinned: string[]; currentId: string; onToggle: (id: string) => void; onSelect: (id: string) => void
}) {
  const candidates = pinned.map((id) => sites.find((s) => s.id === id)).filter((s): s is SiteRecord => !!s)
  const rest = sites.filter((s) => !pinned.includes(s.id))
  const groups = [...new Set(rest.map((s) => s.group))]
  const full = candidates.length >= 10
  const current = sites.find((s) => s.id === currentId)
  const [open, setOpen] = useState(false)
  return (
    <section className={`candidates ${open ? 'open' : 'closed'}`} aria-labelledby="candidates-title">
      <div className="candidates-h">
        <h2 id="candidates-title">Candidate sites <span className="muted">{candidates.length} / 10</span></h2>
        {!open && <p className="candidates-line">{candidates.map((s) => s.name).join(' · ')}{current && !pinned.includes(current.id) ? <span className="muted"> · plus the current site, {current.name}</span> : null}</p>}
        {open && <p className="muted">Used by every comparison, search and delay plan{current && !pinned.includes(current.id) ? `, together with ${current.name}` : ''}.</p>}
        <button className="btn-link candidates-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Done' : 'Edit'}</button>
      </div>
      {open && <ul className="candidate-chips">
        {candidates.map((s) => (
          <li key={s.id} className={s.id === currentId ? 'current' : undefined}>
            <i className="dot" style={{ background: GROUP_COLOR[s.group] }} />
            <button className="candidate-name" onClick={() => onSelect(s.id)} title="Make this the current site (keeps the date)">{s.name}</button>
            <button className="candidate-x" aria-label={`Remove ${s.name} from candidates`} title="Remove from candidates" onClick={() => onToggle(s.id)}>×</button>
          </li>
        ))}
        <li className="candidate-add">
          <select className="input" aria-label="Add a candidate site" value="" disabled={full} onChange={(e) => { if (e.target.value) onToggle(e.target.value) }}>
            <option value="">{full ? 'List full (10)' : '+ Add site…'}</option>
            {groups.map((g) => <optgroup key={g} label={g}>{rest.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
          </select>
        </li>
      </ul>}
    </section>
  )
}

function ReqField({ label, unit, value, onChange }: { label: string; unit: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input className="input num" type="number" min={0} value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
        <span className="muted">{unit}</span>
      </span>
    </label>
  )
}

type SunsetRange = { early: number | null; late: number | null } | null

/** "6 d 20 h – 7 d 9 h" for the sunset if the skyline were the site's skyline shift higher or lower; '' when the range is under an hour. */
function sunsetSpread(r: SunsetRange, hours: number): string {
  if (!r) return ''
  const e = r.early ?? hours
  const l = r.late ?? hours
  if (l - e < 1) return ''
  return `${e === 0 ? 'lands in darkness' : fmtHours(e)} – ${r.late === null ? `≥ ${fmtHours(hours)}` : fmtHours(l)}`
}

function Headline({ site, stats, sunset, skyErr, windowHours, valid, maxSlope, earthMinClear, requireDsn, verdict, actions, powerEmptyAt, dataOverflow, thermalBreachH,relayScenario,relayIssue }: {
  site: SiteRecord; stats: WindowStats | null; sunset: SunsetRange; skyErr: number; landingUnix: number; windowHours: number; valid: boolean; maxSlope: number
  earthMinClear: number; requireDsn: boolean; verdict: { all: boolean; robust: boolean; misses: string[] } | null; actions?: React.ReactNode
  powerEmptyAt: number | null
  dataOverflow: { bits: number; limitGb: number; where?: string } | null
  thermalBreachH: number | null
  relayScenario: boolean
  relayIssue:string|null
}) {
  const chipClass = site.group === 'Flown' ? 'flown' : site.group === 'Best-lit' ? 'lit' : site.group === 'Artemis III region' ? 'artemis' : ''
  let sentence: React.ReactNode = 'Pick a date inside 2023–2031.'
  if (valid && stats) {
    if (stats.startsInEclipse) {
      sentence = <>Lands <span className="accent-bad">during an eclipse</span>: Earth hides the Sun. Light returns in {fmtHours(stats.firstSunrise ?? stats.hours)}{stats.firstSunrise === null ? '+' : ''}.</>
    } else if (stats.startsDark) {
      sentence = <>Lands in <span className="accent-bad">darkness</span>. First light in {fmtHours(stats.firstSunrise ?? stats.hours)}{stats.firstSunrise === null ? '+' : ''}.</>
    } else if (stats.firstSunset === null) {
      sentence = <>The Sun <span className="accent">never sets</span> in the {windowHours % 24 === 0 ? `${windowHours / 24}-day` : fmtHours(windowHours)} window.</>
    } else {
      sentence = <>The Sun sets <span className="accent">{fmtHours(stats.firstSunset)}</span> after touchdown.</>
    }
  }
  let spread = ''
  if (valid && stats && !stats.startsDark && sunset) {
    const r = sunsetSpread(sunset, stats.hours)
    if (r && sunset.early === 0) spread = `On a knife edge: a skyline ${skyErr}° higher would put touchdown in darkness.`
    else if (r && stats.firstSunset === null) spread = `A skyline ${skyErr}° higher would bring sunset after ${fmtHours(sunset.early ?? stats.hours)}.`
    else if (r) spread = `If the skyline is ${skyErr}° higher or lower, sunset moves to ${r} after touchdown.`
  }
  // near the pole the Sun skims the skyline and metre-scale relief decides single sunsets: always say how far the
  // verdicts held against sharper terrain (validate_mission_effect.py) and how far single sunsets did not (validate_skyline_effect.py)
  const nac = site.dem.includes('LROC')
  const polarNote = site.localSky?'Mixed-source scenario: the retained regional 0.1-degree validation does not calibrate this scenario. See its source and seam limits.':site.lat < -80
    ? nac
      ? ' This horizon uses LROC stereo terrain near the site.'
      : POLAR_LIMITS
    : ''
  const spreadTip = site.localSky ? 'Mixed-terrain scenario: ±1° is an uncalibrated engineering sensitivity. It does not propagate DEM RMS or quantify registration/seam uncertainty.' : skyErr === SKYLINE_ERR_DEG
    ? `Sensitivity test: ${SKYLINE_ERR_DEG}° is about the 90th percentile of the LOLA vs LROC 3–4 m stereo skyline difference at two flown sites. Not an error bound.`
    : `Sensitivity test: this horizon comes from the 1.9 km whole-Moon grid, which differs from 59 m terrain by a median 0.02–0.9° and up to 4° near hills. Not an error bound.`
  const eclipseLine = stats && stats.eclipseHours > 0 && stats.firstEclipse !== null
    ? ` Earth eclipses the Sun ${fmtHours(stats.firstEclipse)} after touchdown: about ${fmtHours(stats.eclipseHours)} with no sunlight at all.`
    : ''
  // "below the skyline" is a physical statement; under a clearance threshold (Earth ≥ 2° or 5°) Earth may still be visible
  const under = earthMinClear > 0 ? `under the ${earthMinClear}° clearance asked` : 'below the skyline'
  const earthLine = stats && requireDsn
    ? stats.earthHours === 0 ? 'No reference DSN antenna clears both the lunar terrain and its receiving mask in this window.'
      : stats.startsNoEarth ? `No reference DSN path at touchdown; both-end geometry is available for ${((100 * stats.earthHours) / stats.hours).toFixed(0)}% of the window.`
      : stats.firstEarthset === null ? 'At least one reference DSN path clears both ends throughout the window.'
      : `The first reference DSN geometry gap starts ${fmtHours(stats.firstEarthset)} after touchdown.`
    : stats
    ? stats.earthHours === 0
      ? stats.maxEarthClear < 0
        ? 'Earth stays below the skyline the whole window.'
        : stats.maxEarthClear >= earthMinClear && requireDsn
          ? 'Earth rises above the skyline, but never while a DSN antenna sees the Moon.'
          : `Earth rises at most ${stats.maxEarthClear.toFixed(1)}° above the skyline, under the ${earthMinClear}° clearance asked.`
      : stats.startsNoEarth
      ? `${stats.startEarthClear >= earthMinClear && requireDsn ? 'Earth clears the terrain at touchdown, but no DSN complex sees the Moon then' : `Earth is ${under} at touchdown`}; contact criteria are met ${((100 * stats.earthHours) / stats.hours).toFixed(0)}% of the window.`
      : stats.firstEarthset === null
        ? 'Earth stays in view the whole window.'
        : stats.earthsetByDsn
          ? `The first DSN contact gap starts ${fmtHours(stats.firstEarthset)} after touchdown.`
          : earthMinClear > 0
            ? `Earth sinks under the ${earthMinClear}° clearance after ${fmtHours(stats.firstEarthset)}.`
            : `Earth drops behind the terrain after ${fmtHours(stats.firstEarthset)}.`
    : ''
  const verdictLine = verdict && (verdict.all
    ? <span className={`verdict ${verdict.robust ? 'ok' : 'fragile'}`}
        title="Checks only the selected requirements and skyline shift; this is not a landing-safety or battery-survival verdict">
        {verdict.robust ? `Meets selected rules, also with the skyline ${skyErr}° higher` : `Meets selected rules, but fragile: fails with the skyline ${skyErr}° higher`}
      </span>
    : <span className="verdict bad">Misses: {verdict.misses.join(', ')}</span>)
  return (
    <div className="panel headline">
      <div className="kicker">
        <span className={`chip ${chipClass}`}><span style={{ width: 6, height: 6, borderRadius: 3, background: GROUP_COLOR[site.group] }} />{site.group}</span>
        {slopeKnown(site) ? (
          <span className={`chip ${site.slope_deg! > maxSlope ? 'flown' : ''}`} title={site.localSky?'Local source slope cell; see terrain provenance':`Slope over a ${site.slope_baseline_m ?? 40} m baseline`}>slope {site.slope_deg!.toFixed(0)}°</span>
        ) : (
          <span className="chip flown" title="No terrain fine enough here to measure the slope, so the slope requirement counts as not met">slope not measured</span>
        )}
        <span style={{ marginLeft: 'auto' }}>{actions}</span>
      </div>
      <p className="headline-place"><b>{site.name}</b> <span className="mono">{fmtLat(site.lat)} {fmtLon(site.lon)} · {site.ground_m.toFixed(0)} m</span></p>
      <h1><span className="headline-site sr-only">{site.name}: </span><span className="headline-outcome">{sentence}</span></h1>
      <p className="verdict-line">{verdictLine}{powerEmptyAt !== null && <span className="bad"> · Power shortfall at T+{fmtHours(powerEmptyAt)}</span>}{dataOverflow && <span className="bad"> · {dataOverflow.where??'Payload'} overflow {fmtBytes(dataOverflow.bits)} exceeds {dataOverflow.limitGb} GB limit</span>}{thermalBreachH !== null && <span className="bad"> · Equipment temperature limit at T+{fmtHours(thermalBreachH)}</span>}</p>
      <p>{earthLine}{eclipseLine}</p>
      {site.localSky&&<LocalSkyPanel site={site}/>}
      {relayScenario&&<p className="warnnote">Assumed relay service plan active · relay geometry/RF/booking unverified · Earth-view rules still test direct visibility.</p>}
      {relayIssue&&<p className="bad relay-headline-issue">{relayIssue}</p>}
      <details className="site-evidence">
        <summary>{site.lat < -80 ? 'Terrain-sensitive · check the limits' : skyErr > SKYLINE_ERR_DEG ? 'Coarse terrain · check the limits' : 'Site notes & model limits'}</summary>
        {spread && <p className="spread" title={spreadTip}>{spread}</p>}
        <p>{polarNote} {site.note}</p>
        <p className="faint">The verdict checks the selected daylight, darkness, Earth-view and slope requirements. It does not certify landing safety or battery survival. A raised skyline is a sensitivity test, not an error bound.</p>
      </details>
    </div>
  )
}

const kwh = (wh: number) => (Math.abs(wh) >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${Math.round(wh)} Wh`)

function Kpis({ stats, pass, req, power, tab, onTab, onPower, onComms }: {
  stats: WindowStats; pass: { daylight: boolean; dark: boolean; earth: boolean }; req: Requirements
  power: PowerStats | null; tab: 'sun' | 'power' | 'earth'; onTab: (t: 'sun' | 'power' | 'earth') => void; onPower: () => void; onComms: () => void
}) {
  const pct = (v: number) => (100 * v) / stats.hours
  const daylight = stats.startsDark ? 0 : stats.firstSunset ?? stats.hours
  const sunOk = pass.daylight && pass.dark
  const powerOk = power ? power.shortfallAt === null : null
  const daylightValue = stats.firstSunset === null && !stats.startsDark ? `≥${compactHours(stats.hours)}` : compactHours(daylight)
  const tabs = [
    { id: 'sun' as const, name: 'Sunlight', value: daylightValue, ok: sunOk, cls: 'sun' },
    { id: 'power' as const, name: 'Power', value: power ? (power.shortfallAt === null ? 'Lasts' : `T+${compactHours(power.shortfallAt)}`) : '—', ok: powerOk, cls: '' },
    { id: 'earth' as const, name: 'Earth', value: `${pct(stats.earthHours).toFixed(0)}%`, ok: pass.earth, cls: 'earth' },
  ]
  return (
    <div className="kpis pillars" aria-label="Sunlight, power and Earth contact">
      <div className="verdict-tabs" role="tablist" aria-label="Verdict detail">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={t.ok === false ? 'fail' : 'pass'} onClick={() => onTab(t.id)}>
            <span className="vt-name">{t.ok !== null && <i className={`vt-dot ${t.ok ? 'pass' : 'fail'}`} aria-hidden="true" />}{t.name}{t.ok !== null && <span className="sr-only">{t.ok ? ' passes' : ' fails'}</span>}</span>
            <span className={`vt-value ${t.cls}`}>{t.value}</span>
          </button>
        ))}
      </div>
      <div className="verdict-detail" role="tabpanel" key={tab}>
        {tab === 'sun' && <>
          <div className={`pillar-main kpi ${pass.daylight ? 'pass' : 'fail'}`} title={METRICS.firstSunset.help}>
            <div className="label">Daylight after landing</div>
            <div className="sub">{req.minDaylightH > stats.hours ? `need Sun for the whole ${fmtHours(stats.hours)} stay` : `need ≥ ${fmtHours(req.minDaylightH)}`}</div>
          </div>
          <dl>
            <div className={pass.dark ? '' : 'miss'} title={METRICS.longestDark.help}><dt>Longest darkness</dt><dd>{stats.darkOpenEnded ? '≥' : ''}{fmtHours(stats.longestDark)}<small>{stats.darkOpenEnded ? `runs past the window edge · limit ${fmtHours(req.maxDarkH)}` : `limit ${fmtHours(req.maxDarkH)}`}</small></dd></div>
            <div title={METRICS.sun.help}><dt>Sunlight in window</dt><dd>{pct(stats.sunEquivHours).toFixed(0)}%<small>{fmtHours(stats.sunEquivHours)} full-Sun equivalent</small></dd></div>
          </dl>
        </>}
        {tab === 'power' && <>
          {power ? <>
            <div className={`pillar-main kpi ${powerOk ? 'pass' : 'fail'}`}>
              <div className="label">{power.shortfallAt === null ? 'No power shortfall' : `First power shortfall at T+${fmtHours(power.shortfallAt)}`}</div>
              <div className="sub">{power.shortfallAt === null ? `${kwh(power.usableWh)} usable storage meets the full window` : `${fmtHours(power.unpoweredH)} with unmet demand in the window`}</div>
            </div>
            <dl>
              <div><dt>Rated battery needed</dt><dd>{Number.isFinite(power.batteryNeededWh) ? kwh(power.batteryNeededWh) : 'Not feasible'}<small>with selected losses and limits</small></dd></div>
              <div className={power.balanceWh >= 0 ? '' : 'miss'}><dt>Energy balance</dt><dd>{power.balanceWh >= 0 ? '+' : ''}{kwh(power.balanceWh)}<small>{kwh(power.energyWh)} generated</small></dd></div>
            </dl>
          </> : <p className="muted">Choose a date inside the ephemeris to calculate power.</p>}
          <button className="pillar-more" onClick={onPower}>Power details →</button>
        </>}
        {tab === 'earth' && <>
          <div className={`pillar-main kpi ${pass.earth ? 'pass' : 'fail'}`} title={METRICS.earth.help}>
            <div className="label">Earth in view</div>
            <div className="sub">need ≥ {req.minEarthPct}%{stats.dsnEarthHours !== null ? ` · ${pct(stats.dsnEarthHours).toFixed(0)}% with a DSN antenna` : ''}</div>
          </div>
          <dl>
            <div><dt>Longest gap</dt><dd>{stats.noEarthOpenEnded ? '≥' : ''}{fmtHours(stats.longestNoEarth)}<small>without Earth in view</small></dd></div>
            <div title={METRICS.both.help}><dt>Sun + Earth together</dt><dd>{pct(stats.bothHours).toFixed(0)}%<small>{Number.isFinite(stats.meanSunElevUp) ? `Sun at ${stats.meanSunElevUp.toFixed(1)}° elevation on average while up` : 'Sun never up'}</small></dd></div>
          </dl>
          <button className="pillar-more" onClick={onComms}>Communication details →</button>
        </>}
      </div>
    </div>
  )
}

/** How far the landing can slip at this site before a rule fails: the same daily test as the Delays page. */
function DelayStrip({ site, i0, windowHours, eph, passFor, landingUnix, onJump, planOpen, onPlan }: {
  site: SiteRecord; i0: number; windowHours: number; eph: Ephemeris; passFor: (id: string, dayIndex: number) => boolean
  landingUnix: number; onJump: (u: number) => void; planOpen: boolean; onPlan: () => void
}) {
  const s = useMemo(() => {
    const days = Math.max(0, Math.min(365, Math.floor((eph.count - windowHours - i0) / 24)))
    const ok = Array.from({ length: days }, (_, d) => passFor(site.id, i0 + d * 24))
    let tolerance = 0
    while (tolerance < days && ok[tolerance]) tolerance++
    const next = ok.findIndex((v, d) => v && d > 0)
    return { days, ok, tolerance, next }
  }, [site.id, i0, windowHours, eph, passFor])
  if (!s.days) return null
  const steps = [1, 3, 7, 14, 30].filter((d) => d < s.days)
  const today = s.ok[0]
  return (
    <section className={`delay-strip ${today ? '' : 'bad'}`} aria-label="If the landing slips">
      <span className="delay-strip-k">If the landing slips</span>
      <ol className="delay-steps">
        {steps.map((d) => <li key={d} className={s.ok[d] ? 'ok' : 'miss'} title={`${fmtDate(landingUnix + d * 86400, false)}: ${s.ok[d] ? 'meets' : 'misses'} the mission needs`}>+{d} d <b>{s.ok[d] ? '✓' : '✕'}</b></li>)}
      </ol>
      <p>{today
        ? s.tolerance >= s.days ? <>Still meets your needs if it lands up to <b>{s.days}+ days</b> late.</> : <>Still meets your needs if it lands up to <b>{s.tolerance - 1} day{s.tolerance === 2 ? '' : 's'}</b> late.</>
        : s.next > 0 ? <>This date misses a rule. Next passing day: <button className="linkish" onClick={() => onJump(landingUnix + s.next * 86400)}>{fmtDate(landingUnix + s.next * 86400, false)} (+{s.next} d)</button></>
        : <>No day in the next 12 months meets every rule here.</>}</p>
      <button className="btn primary sm delay-strip-go" onClick={onPlan}>{planOpen ? 'Back to delay plan →' : 'Plan for a delay →'}</button>
    </section>
  )
}

/** Full mission requirements, opened from the mission bar so they can be edited from any page. */
function NeedsEditor({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (e: PointerEvent) => { const el = ref.current; if (el?.open && !el.contains(e.target as Node)) el.open = false }
    const esc = (e: KeyboardEvent) => { const el = ref.current; if (e.key === 'Escape' && el?.open) { el.open = false; el.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [])
  return (
    <details className="needs-pop" ref={ref}>
      <summary className="btn sm" aria-label="Edit mission requirements">Edit</summary>
      <div className="needs-pop-body" role="group" aria-label="Mission requirements">{children}</div>
    </details>
  )
}

const REQ_PRESETS: { name: string; tip: string; req: Requirements; days?: number }[] = [
  { name: 'Default', tip: 'Default', req: DEFAULT_REQ },
  { name: 'No-night lander', tip: 'Solar lander that cannot survive any darkness, 10-day mission', days: 10, req: { minDaylightH: 240, maxDarkH: 0, minEarthPct: 60, maxSlopeDeg: 8 } },
  { name: 'Artemis III crew', tip: 'Crewed surface stay of about 6.25 days in continuous sunlight, with good Earth visibility for direct-to-Earth links (after NASA’s stated Artemis III criteria)', req: { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }, days: 6.25 },
  { name: 'Hardened', tip: 'Lander with heaters and batteries for multi-day shadow', req: { minDaylightH: 72, maxDarkH: 100, minEarthPct: 30, maxSlopeDeg: 15 } },
]



type CompareRow = { s: SiteRecord; i0: number; key: string; when?: number }

function CompareTable({ rows, trackFor, len, selectedKey, onPick, onRemove, passes, maxSlope, eph, power, radio,terrainCheck }: {
  rows: CompareRow[]; trackFor: (s: SiteRecord) => Track; len: number; selectedKey: string; onPick: (r: CompareRow) => void; onRemove?: (r: CompareRow) => void
  passes: (s: WindowStats) => { daylight: boolean; dark: boolean; earth: boolean }; maxSlope: number; eph: Ephemeris; power: PowerSystem; radio: Radio
  terrainCheck?:TerrainCheck
}) {
  const [sortKey, setSortKey] = useState<MetricKey>('firstSunset')
  const withDates = rows.some((r) => r.when !== undefined)
  const data = rows.filter((r) => r.i0 >= 0 && r.i0 + len < eph.count).map((r) => {
    const { s, i0 } = r
    const st = windowStats(trackFor(s), i0, len)
    const vals: Record<MetricKey, number> = {
      firstSunset: st.startsDark ? 0 : st.firstSunset ?? st.hours,
      sun: (100 * st.sunEquivHours) / st.hours,
      longestDark: st.longestDark,
      earth: (100 * st.earthHours) / st.hours,
      both: (100 * st.bothHours) / st.hours,
    }
    const b = missionBudget(eph, trackFor(s), i0, len, power, radio)
    return { r, s, st, vals, p: { ...passes(st), slope: slopeOk(s, maxSlope) }, flat: b.power.shortfallAt, bits: b.returnedBits,
      lossBits: b.totalLostBits, dataPass: b.dataLossPass,relaySetup:b.relaySetupPass,relayIssues:b.relayService?.issues.join(' ')??'', thermal: b.power.thermal, thermalOk: thermalPass(b.power),terrain:terrainCheck?.(s) }
  })
  const keys: MetricKey[] = ['firstSunset', 'sun', 'longestDark', 'earth', 'both']
  const sorted = [...data].sort((a, b) => (METRICS[sortKey].better === 'high' ? b.vals[sortKey] - a.vals[sortKey] : a.vals[sortKey] - b.vals[sortKey]))
  const best = (k: MetricKey) => (METRICS[k].better === 'high' ? Math.max(...data.map((d) => d.vals[k])) : Math.min(...data.map((d) => d.vals[k])))
  // the answer first: rank by unmet requirements, then daylight after landing, then Earth in view
  const misses = (d: (typeof data)[number]) => [!d.p.daylight && 'daylight', !d.p.dark && 'darkness', !d.p.earth && 'Earth in view', !d.p.slope && 'slope',
    d.flat !== null && 'power', d.thermal && !d.thermalOk && 'temperature', terrainCheck && !d.terrain?.pass && 'terrain footprint',
    (radio.operations?.traffic || radio.relay) && !d.dataPass && `data loss (${fmtBytes(d.lossBits)})`,
    (radio.relay?.reference || radio.relay?.rf) && !d.relaySetup && 'relay inputs'].filter((x): x is string => !!x)
  const ranked = [...data].sort((a, b) => misses(a).length - misses(b).length || b.vals.firstSunset - a.vals.firstSunset || b.vals.earth - a.vals.earth || b.vals.sun - a.vals.sun || b.vals.both - a.vals.both)
  const label = (d: (typeof data)[number]) => <><b>{d.s.name}</b>{withDates && d.r.when !== undefined ? `, ${fmtDate(d.r.when, false)}` : ''}</>
  const top = ranked[0], next = ranked[1]
  return (
    <div style={{ overflowX: 'auto', marginTop: 12 }}>
      {top && data.length > 1 && (() => {
        const passing = ranked.filter((d) => misses(d).length === 0)
        const tied = next && misses(next).length === 0 && next.vals.firstSunset === top.vals.firstSunset && next.vals.earth === top.vals.earth
        const lead = !next ? '' : top.vals.firstSunset > next.vals.firstSunset ? `the longest daylight after landing (${fmtMetric('firstSunset', top.vals.firstSunset, len)})`
          : top.vals.earth > next.vals.earth ? `the most Earth in view (${top.vals.earth.toFixed(0)}%)`
          : top.vals.sun > next.vals.sun ? `the most sunlight (${top.vals.sun.toFixed(0)}%)` : `the most time with Sun and Earth together (${top.vals.both.toFixed(0)}%)`
        return (
          <div className={`compare-verdict ${passing.length ? 'good' : 'bad'}`} role="status">
            <p>{passing.length === 0
              ? <>None of these meets every selected check. {label(top)} comes closest; it misses {misses(top).join(', ')}.{next && <> Next: {label(next)} (misses {misses(next).join(', ')}).</>}</>
              : tied
              ? <>{passing.length} sites meet every selected check with equal daylight and Earth view. Compare slope, delay tolerance and storage before choosing.</>
              : <>{label(top)} leads: every selected check met, with {lead}.{next && <> Next: {label(next)}{misses(next).length ? ` (misses ${misses(next).join(', ')})` : ', also passes'}.</>}</>}</p>
            <small>Ranked by unmet checks, then daylight after landing, Earth in view and sunlight. Select a row to open it in Plan.</small>
          </div>
        )
      })()}
      <table className="ctable">
        <thead>
          <tr>
            <th>Site</th>
            {withDates && <th style={{ textAlign: 'left' }}>Landing</th>}
            {keys.map((k) => (
              <th key={k} onClick={() => setSortKey(k)} aria-sort={sortKey === k ? 'descending' : 'none'} title={METRICS[k].help}>
                {METRICS[k].short}{sortKey === k ? ' ▾' : ''}
              </th>
            ))}
            <th title={`First unmet demand with the Power panel's ${power.batteryWh} Wh rated battery, selected losses, limits, heater and radio load`}>Power shortfall</th>
            <th title={radio.relay?'Actually forwarded to Earth within the assumed relay service scenario, not simply sent to relay':`Data sent home over the window by the Communication panel's ${radio.band}-band radio (${radio.txW} W, ${antennaGain(radio).toFixed(1)} dBi) to a DSN 34 m antenna, only while the battery and array can power it; upper bound`}>Data home</th>
            {(radio.operations?.traffic||radio.relay) && <th title="Modeled discarded overflow; relay mode sums lander and relay losses, whose separate limits apply">Data loss</th>}
            {(radio.relay?.reference||radio.relay?.rf)&&<th>Relay scope/RF inputs</th>}
            {power.thermal && <th title="Equipment-node range under the selected fixed thermal boundaries; not regolith temperature">Equipment K</th>}
            <th title="Ground slope at the target: 40 m baseline on the polar 20 m terrain, 120 m on the 59 m global terrain, 160 m for sites you add south of 80°S (none for sites added elsewhere)">Slope</th>
            <th>{terrainCheck?'Sun/Earth/slope':'Surface rules'}</th>
            {terrainCheck&&<th>Required point footprint</th>}
            {onRemove && <th />}
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ r, s, st, vals, p, flat, bits, lossBits, dataPass,relaySetup,relayIssues, thermal, thermalOk,terrain }) => (
            <tr key={r.key} aria-selected={r.key === selectedKey} onClick={() => onPick(r)} style={{ cursor: 'pointer' }}>
              <td><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: GROUP_COLOR[s.group], marginRight: 8 }} />{s.name}</td>
              {withDates && <td style={{ textAlign: 'left' }}>{r.when !== undefined ? fmtDate(r.when) : ''}</td>}
              {keys.map((k) => (
                <td key={k} className={vals[k] === best(k) && data.length > 1 ? 'best' : ''}>{k === 'longestDark' && st.darkOpenEnded ? '≥' : ''}{fmtMetric(k, vals[k], len)}</td>
              ))}
              <td className={flat === null ? 'best' : ''}>{flat === null ? 'never' : `T+${fmtHours(flat)}`}</td>
              <td className={bits > 0 && bits === Math.max(...data.map((d) => d.bits)) && data.length > 1 ? 'best' : bits ? '' : 'failv'}>{bits ? fmtBytes(bits) : 'none'}</td>
              {(radio.operations?.traffic||radio.relay) && <td className={dataPass ? '' : 'failv'}>{fmtBytes(lossBits)}</td>}
              {(radio.relay?.reference||radio.relay?.rf)&&<td title={relayIssues} className={relaySetup?'':'failv'}>{relaySetup?(radio.relay.rf?'scenario inputs set':'reference scope matched'):'not usable'}</td>}
              {power.thermal && <td className={thermalOk ? '' : 'failv'}>{thermal ? `${thermal.minK.toFixed(0)}–${thermal.maxK.toFixed(0)} K` : 'not evaluated'}</td>}
              <td className={p.slope ? '' : 'failv'}>{s.slope_deg != null && Number.isFinite(s.slope_deg) ? `${s.slope_deg.toFixed(0)}°` : '—'}</td>
              <td className={p.daylight && p.dark && p.earth && p.slope ? 'best' : 'failv'}>
                {p.daylight && p.dark && p.earth && p.slope ? 'all met' : [!p.daylight && 'daylight', !p.dark && 'darkness', !p.earth && 'Earth', !p.slope && (slopeKnown(s) ? 'slope' : 'slope not measured')].filter(Boolean).join(', ')}
              </td>
              {terrainCheck&&<td className={terrain?.pass?'best':'failv'} title={terrain?.issue??'Terrain screen at the exact point'}>{terrain?.status==='ready'?`${terrain.pass?'fits':'too small'} · ${(2*terrain.radiusM!).toFixed(1)} / ${terrain.requiredDiameterM} m`:terrain?.status??'unavailable'}</td>}
              {onRemove && <td><button className="icon-btn sm" aria-label={`Remove ${s.name}`} title="Remove this pair" onClick={(e) => { e.stopPropagation(); onRemove(r) }}>×</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
