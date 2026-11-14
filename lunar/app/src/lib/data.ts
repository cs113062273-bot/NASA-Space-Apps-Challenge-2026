import { Horizon } from './astro'
import { COARSE_SKYLINE_ERR_DEG } from './metrics'
import { SurfaceContext, attachSurfaceContext } from './surface'
import type { LocalSkyEvidence } from './local-sky'

export interface SiteRecord {
  id: string
  name: string
  group: string
  lat: number
  lon: number
  date: string
  duration_days: number
  note: string
  source: string
  url: string
  dem: string
  ground_m: number
  localSky?: LocalSkyEvidence
  surfaceContext?: SurfaceContext
  surfaceContextError?: string // optional background unavailable; core mission inputs still load independently
  horizons: Record<string, number[]>
  dispersion?: { n: number; step_m: number; bins: number; observer_m: number; ground_m: number[]; slope_deg: number[]; slope_baseline_m?: number
    frame?: 'polar' | 'enu' // polar: rows along stereographic Y (toward 0°E); enu: row 0 = north, col 0 = west
    heights?: number[] // panel heights with a grid file (2 m: disp/<id>.i16, others: disp/<id>.h<h>.i16); absent: 2 m only
    browser?: boolean }
  slope_deg?: number | null // null: no terrain fine enough to measure it
  skyline_err_deg?: number // skyline shift used for sensitivity ranges (default SKYLINE_ERR_DEG)
  slope_baseline_m?: number
  region_xy?: [number, number, number, number] // xmin, xmax, ymin, ymax (m) of an Artemis III region box
  custom?: boolean
}

/** Sites saved before the skyline shift was stored per site: whole-Moon-grid ones get the coarse shift. */
export function migrateCustom(s: SiteRecord): SiteRecord {
  if (s.skyline_err_deg == null && s.dem?.includes('whole-Moon')) return { ...s, skyline_err_deg: COARSE_SKYLINE_ERR_DEG }
  return s
}

export interface BasemapLayer {
  file: string
  half_extent_m: number
  px: number
  m_per_px: number
}

export interface Basemap {
  overview: BasemapLayer
  detail: BasemapLayer
  illumination?: BasemapLayer & { period: string; observer_m: number; max_pct?: number; top_pct?: number }
  earthvis_polar?: BasemapLayer & { period: string; observer_m: number }
  layer_values?: { file: string; half_extent_m: number; step_m: number; n: number; scale: number }
  globe?: { relief: string; earthvis: string; px: [number, number]; relief_source: string; earthvis_period: string; always_pct: number; never_pct: number }
}

export async function loadSites(base = './data/'): Promise<SiteRecord[]> {
  const get = async (name: string) => {
    const r = await fetch(`${base}${name}`)
    if (!r.ok) throw new Error(`Cannot load ${name}: HTTP ${r.status}`)
    return r.json()
  }
  const [catalogue, background] = await Promise.allSettled([get('sites.json'),get('diviner-prp-sites.json')])
  if (catalogue.status === 'rejected') throw catalogue.reason
  const sites = catalogue.value.sites as SiteRecord[]
  try {
    if (background.status === 'rejected') throw background.reason
    const contexts = attachSurfaceContext(sites,background.value)
    return sites.map(s => ({ ...s, surfaceContext: contexts.get(s.id) }))
  } catch (error) {
    // Context does not feed any mission constraint. Preserve core analysis while
    // explicitly exposing unavailable background instead of attaching stale values.
    return sites.map(s => ({ ...s,surfaceContext:undefined,surfaceContextError:error instanceof Error ? error.message : String(error) }))
  }
}

export async function loadBasemap(base = './data/'): Promise<Basemap> {
  return (await fetch(`${base}basemap.json`)).json()
}

const dispCache = new Map<string, Promise<Horizon[]>>()

/** Heights the touchdown grid exists for: 2 m always, more when the pipeline added them. */
export const gridHeights = (site: SiteRecord) => site.dispersion?.heights ?? [2]

/** Dispersion grid of horizons around a curated site (row 0 = map top, col 0 = map left), at panel height `h`. */
export function loadDispersion(site: SiteRecord, h = 2, base = './data/'): Promise<Horizon[]> {
  if (!site.dispersion) return Promise.resolve([])
  const key = `${site.id}|${h}`
  let p = dispCache.get(key)
  if (!p) {
    const bins = site.dispersion.bins
    p = fetch(`${base}disp/${site.id}${h === 2 ? '' : `.h${h}`}.i16`)
      .then((r) => {
        if (!r.ok) throw new Error(`no ${h} m touchdown grid for ${site.id}`)
        return r.arrayBuffer()
      })
      .then((buf) => {
        const all = new Int16Array(buf)
        const out: Horizon[] = []
        for (let k = 0; k * bins < all.length; k++) out.push(new Horizon(all.subarray(k * bins, (k + 1) * bins)))
        return out
      })
    p.catch(() => dispCache.delete(key))
    dispCache.set(key, p)
  }
  return p
}

/** South polar stereographic (PDS LOLA convention), metres; +Y toward 0°E, +X toward 90°E. */
export function toXY(latDeg: number, lonDeg: number): [number, number] {
  const R = 1737400
  const rho = 2 * R * Math.tan(((90 + latDeg) * Math.PI) / 360)
  const lo = (lonDeg * Math.PI) / 180
  return [rho * Math.sin(lo), rho * Math.cos(lo)]
}

export function toLatLon(x: number, y: number): [number, number] {
  const R = 1737400
  const rho = Math.hypot(x, y)
  const lat = -90 + (2 * Math.atan((0.5 * rho) / R) * 180) / Math.PI
  const lon = (((Math.atan2(x, y) * 180) / Math.PI) % 360 + 360) % 360
  return [lat, lon]
}
