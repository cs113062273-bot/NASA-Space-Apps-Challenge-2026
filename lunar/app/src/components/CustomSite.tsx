import { useCallback, useEffect, useRef, useState } from 'react'
import { Horizon } from '../lib/astro'
import { SiteRecord, migrateCustom } from '../lib/data'
import { COARSE_SKYLINE_ERR_DEG } from '../lib/metrics'
import { fmtLat, fmtLon } from '../lib/ui'
import {LocalSkyConfig,LocalSkyEvidence,CompositeSky,matchesPoint,skyResultHash,validLocalSky,skyCode} from '../lib/local-sky'
import {loadTerrain} from '../lib/landing-terrain'
import {toXY} from '../lib/data'
import {terrainCellAtPoint} from '../lib/landing-area'

export interface CustomState {
  sites: SiteRecord[]
  busy: { lat: number; lon: number } | null
  error: string | null
  request: (lat: number, lon: number, quiet?: boolean, options?:{sky?:LocalSkyConfig;name?:string}) => void // quiet: add without selecting it
  remove: (id: string) => void
  rename: (id: string, name: string) => void
  lastCreated: { id: string; n: number } | null // n changes on every request, so asking for the same point again selects it again
}

const KEY = 'lastlight.custom.v1'

// One worker for the page lifetime; it caches terrain tiles between requests.
let sharedWorker: Worker | null = null
function horizonWorker(): Worker {
  if (!sharedWorker) sharedWorker = new Worker(new URL('../lib/horizon.worker.ts', import.meta.url), { type: 'module' })
  return sharedWorker
}

export type GridMeta = NonNullable<SiteRecord['dispersion']>
const gridCache = new Map<string, Promise<{ meta: GridMeta; hz: Horizon[] }>>()

/** Touchdown grid (11 x 11 points, 100 m apart) for a custom polar site at panel height `h`, computed in the worker; kept for the session. */
export function requestGrid(site: SiteRecord, h: number, onProgress: (f: number) => void) {
  if(site.localSky)return Promise.reject(new Error('Mixed-terrain scenarios support a stationary point only; no source-matched touchdown grid is available.'))
  const key = `${site.id}|${h}`
  let p = gridCache.get(key)
  if (!p) {
    const id = `grid-${site.id}-${h}`
    const w = horizonWorker()
    p = new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent) => {
        if (e.data.id !== id) return
        if (e.data.progress !== undefined) return onProgress(e.data.progress)
        w.removeEventListener('message', onMsg)
        if (!e.data.ok) return reject(new Error(e.data.error))
        const meta = e.data.grid as GridMeta
        const all = e.data.horizons as Int16Array
        resolve({ meta, hz: Array.from({ length: meta.n * meta.n }, (_, k) => new Horizon(all.subarray(k * 360, (k + 1) * 360))) })
      }
      w.addEventListener('message', onMsg)
      w.postMessage({ kind: 'grid', id, lat: site.lat, lon: site.lon, n: 11, step: 100, h, root: new URL('./data/terrain/', document.baseURI).href })
    })
    p.catch(() => gridCache.delete(key))
    gridCache.set(key, p)
  }
  return p
}

const patchCache = new Map<string, Promise<{ meta: { n: number; step_m: number; ground_m: number; frame: 'polar' }; rel: Int16Array } | null>>()

/** 3D terrain patch for a custom polar site from the 80 m grid (null where there is none). */
export function requestPatch(site: SiteRecord) {
  if(site.localSky)return Promise.resolve(null)
  let p = patchCache.get(site.id)
  if (!p) {
    const id = `patch-${site.id}`
    const w = horizonWorker()
    p = new Promise((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.data.id !== id) return
        w.removeEventListener('message', onMsg)
        resolve(e.data.ok ? { meta: e.data.meta, rel: e.data.rel } : null)
      }
      w.addEventListener('message', onMsg)
      w.postMessage({ kind: 'patch', id, lat: site.lat, lon: site.lon, root: new URL('./data/terrain/', document.baseURI).href })
    })
    patchCache.set(site.id, p)
  }
  return p
}

function load(): SiteRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as SiteRecord[]).filter(s=>!s.localSky).map(migrateCustom) : []
  } catch {
    return []
  }
}

let seq = 0 // keeps ids unique when several sites are requested in the same millisecond

export function useCustomSites(): CustomState {
  const [sites, setSites] = useState<SiteRecord[]>(load)
  const [busy, setBusy] = useState<{ lat: number; lon: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastCreated, setLastCreated] = useState<{ id: string; n: number } | null>(null)
  const current = useRef(sites)
  current.current = sites

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sites.filter(s=>!s.localSky)))
    } catch {
      /* storage unavailable: sites live for this session only */
    }
  }, [sites])


  const inflight=useRef(new Set<string>())
  const request = useCallback((lat:number,lon:number,quiet=false,options?:{sky?:LocalSkyConfig;name?:string})=>{
    if(!(Math.abs(lat)<=90)||!Number.isFinite(lon)) {setError('Latitude must be between -90° and 90°.');return}
    if(lon<0||lon>=360)lon=((lon%360)+360)%360
    const sky=options?.sky
    if(sky&&!validLocalSky(sky)){setError('Invalid local terrain scenario identity. Choose a source and calculate it again.');return}
    const same=current.current.find(s=>matchesPoint(s,{lat,lon,sky}))
    if(same){setError(null);if(!quiet)setLastCreated(p=>({id:same.id,n:(p?.n??0)+1}));return}
    const job=[lat,lon,sky?skyCode(sky):'baseline'].join('|')
    if(inflight.current.has(job))return
    inflight.current.add(job);setBusy({lat,lon});setError(null)
    const id=`my-${Date.now().toString(36)}${(seq++).toString(36)}`
    const compute=async()=>{
      const asset=sky?await loadTerrain(lat,lon,id,undefined,sky.sourceId==='nasa'?undefined:sky.sourceId):null
      if(sky&&!asset)throw new Error('The selected terrain does not cover this mission point. No background-only mission point was substituted.')
      if(sky?.patchSha256&&asset?.meta.sha256!==sky.patchSha256)throw new Error('Local terrain patch checksum differs from the shared scenario. Recreate the scenario explicitly with the current source.')
      const w=horizonWorker()
      const out=await new Promise<any>((resolve,reject)=>{
        const finish=()=>{w.removeEventListener('message',onMsg);w.removeEventListener('error',onError);clearTimeout(timer)}
        const onMsg=(e:MessageEvent)=>{if(e.data.id!==id)return;finish();if(e.data.ok)resolve(e.data);else reject(new Error(e.data.error))}
        const onError=(e:ErrorEvent)=>{finish();reject(new Error(e.message||'Terrain worker failed'))}
        const timer=setTimeout(()=>{finish();reject(new Error('Terrain computation timed out. Retry the scenario.'))},180000)
        w.addEventListener('message',onMsg);w.addEventListener('error',onError)
        w.postMessage({kind:sky?'local':undefined,id,lat,lon,heights:[2,10],local:asset?.grid,root:new URL('./data/terrain/',document.baseURI).href})
      })
      let localSky:LocalSkyEvidence|undefined,slope=out.slope,slopeBaseline=out.slopeBaseline
      let ground=out.groundM,horizons=out.horizons
      if(sky&&asset){
        const r=out.composite as CompositeSky
        if(r.missingSamples)throw new Error('Incomplete mixed-terrain skyline; no mission point was created.')
        const {horizons:hz,...values}=r
        const [x,y]=toXY(lat,lon),k=terrainCellAtPoint(asset.grid,x,y)
        slope=k!==null&&Number.isFinite(asset.grid.slope[k])&&asset.grid.slope[k]>=0&&asset.grid.slope[k]<=90?asset.grid.slope[k]:null
        slopeBaseline=undefined
        const proof:Omit<LocalSkyEvidence,'config'|'limits'>={revision:1,...values,patchSha256:asset.meta.sha256,manifestSha256:asset.index.sourceManifestSha256,stepM:asset.grid.stepM,
          groundDifferenceM:r.baselineGroundM===null?null:r.groundM-r.baselineGroundM,source:{meta:asset.meta,index:asset.index,imported:asset.imported}}
        const resultSha256=await skyResultHash(lat,lon,r.groundM,hz,slope,proof)
        if(sky.resultSha256&&resultSha256!==sky.resultSha256)throw new Error('Recomputed skyline differs from the shared result checksum. No changed result was substituted. Recreate explicitly with the current terrain/model.')
        localSky={...proof,config:{sourceId:sky.sourceId,patchSha256:asset.meta.sha256,resultSha256},limits:[
          'Alternative mixed-source scenario, not a uniform accuracy improvement over curated 20 m horizons. Valid local bilinear heights replace the background; rays are retraced from the local observer ground height.',
          'Local heights use a nominal ME421 spherical south-polar alignment, radius 1737400 m. No measured horizontal registration or vertical seam correction is applied; source differences can create artificial cliffs.',
          'Each 0.125 degree azimuth-bin centre is sampled to 300 km. Local radial steps are half a pixel (minimum 0.5 m); the background uses 80 m near / 480 m far grids, with a 1.9 km whole-Moon fallback where needed. Narrow features between rays or radial samples can be missed.',
          'Missing local samples fall back to background; unknown background samples prevent creation. Source counters count ray samples, not geographic area or independent observations.',
          'The ±1 degree skyline shift is an uncalibrated engineering sensitivity, not source RMS propagation or a confidence interval. Finite Sun/Earth disks use the existing locally flat skyline approximation.',
          'This is one stationary mission point. Footprint, route, map shades, 3D views and touchdown grids have their own scopes; no moving-rover illumination, energy, contact or thermal route model is inferred.'
        ]}
        ground=r.groundM;horizons=hz
      }
      const global=out.terrain==='globe'
      const rec:SiteRecord={id,name:options?.name??(localSky?'Mixed-terrain mission point':`My site ${current.current.length+1}`),group:'My sites',lat,lon,date:new Date().toISOString(),duration_days:14,
        note:localSky?'Source-specific mixed-terrain mission scenario. Inspect provenance and seam limits before comparing decisions.':global?`Horizon computed in your browser from the ${(out.nearRes/1000).toFixed(1)} km whole-Moon LOLA grid: a quick estimate. At the curated whole-Moon sites it differs from our 59 m horizons by 0.02–0.9° (median) and up to 4° toward nearby hills. Near the equator 1° of skyline is about 2 h of Sun.`:`Horizon computed in your browser from LOLA ${out.nearRes} m terrain (near field) and ${out.farRes} m terrain (far field).`,
        source:localSky?(asset?.imported?'User-imported DEM + NASA background':'NASA PGDA local DEM + NASA background'):'User-selected point',url:'',
        dem:localSky?`${asset!.grid.stepM} m local + 80 / 480 m background (mixed scenario)`:global?`${(out.nearRes/1000).toFixed(1)} km whole-Moon grid (browser)`:`${out.nearRes} m near field + ${out.farRes} m far field (browser)`,
        ground_m:ground,horizons,custom:true,...(localSky?{localSky,skyline_err_deg:1}:global?{skyline_err_deg:COARSE_SKYLINE_ERR_DEG}:{}),
        ...(slope!=null&&Number.isFinite(slope)?{slope_deg:localSky?slope:Math.round(slope*10)/10,...(slopeBaseline?{slope_baseline_m:slopeBaseline}:{})}:{})}
      // Update the ref immediately so simultaneous restore requests cannot duplicate a completed point.
      current.current=[...current.current,rec];setSites(prev=>[...prev,rec])
      if(!quiet)setLastCreated(p=>({id,n:(p?.n??0)+1}))
    }
    void compute().catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>{inflight.current.delete(job);if(!inflight.current.size)setBusy(null)})
  }, [])

  const remove = useCallback((id: string) => setSites((prev) => prev.filter((s) => s.id !== id)), [])
  const rename = useCallback((id: string, name: string) => setSites((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s))), [])
  return { sites, busy, error, request, remove, rename, lastCreated }
}

export function CustomSite({ state, onCreated }: { state: CustomState; onCreated: (id: string) => void }) {
  const [lat, setLat] = useState('-85.5')
  const [lon, setLon] = useState('35.0')
  const seen = useRef(0)
  useEffect(() => {
    if (state.lastCreated && state.lastCreated.n !== seen.current) {
      seen.current = state.lastCreated.n
      onCreated(state.lastCreated.id)
    }
  }, [state.lastCreated, onCreated])

  return (
    <div className="panel">
      <div className="panel-h"><h3>Add a site</h3></div>
      <form className="controls" style={{ paddingTop: 10 }} onSubmit={(e) => { e.preventDefault(); state.request(Number(lat), Number(lon)) }}>
        <label className="field"><span>Latitude (°)</span><input className="input num" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" style={{ width: 92 }} /></label>
        <label className="field"><span>Longitude (°E)</span><input className="input num" value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" style={{ width: 92 }} /></label>
        <button className="btn" type="submit" disabled={!!state.busy}>{state.busy ? 'Computing…' : 'Compute horizon'}</button>
      </form>
      {(state.busy || state.error) && (
        <div className="panel-b" style={{ paddingTop: 0 }}>
          {state.busy && <span className="muted">Tracing terrain rays up to 300 km from {fmtLat(state.busy.lat)} {fmtLon(state.busy.lon)}…</span>}
          {state.error && <span className="bad">{state.error}</span>}
        </div>
      )}
    </div>
  )
}
