/** Published annual PRP context, deliberately separate from mission-day heat/power calculations. */
export const PRP_PRODUCT = 'LRO-L-DLRE-5-PRP-V2.0'
export const PRP_CATALOG = 'https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/catalog/prpds.cat'
export interface SurfaceThermalSample {
  id: string
  lat: number
  lon: number
  status: 'sampled' | 'outside-published-mesh'
  facet_index?: number
  source_record_number?: number
  centre_lat?: number
  centre_lon?: number
  centre_distance_m?: number
  annual_mean_2cm_k?: number
  annual_surface_max_k?: number
  ice_stability_depth_m?: number | null
  vertices_km?: number[][]
  barycentric_weights?: number[]
  ray_radius_km?: number
  neighborhood?: { radius_m: number; selection: string; count: number; annual_mean_2cm_min_k: number; annual_mean_2cm_max_k: number; annual_surface_max_min_k: number; annual_surface_max_max_k: number }
}
export interface SurfaceContext extends SurfaceThermalSample {
  source: { url: string; sha256: string }
  catalogUrl: string
  product: string
}

/** Reject stale/misaligned context rather than attaching one site's facet to another. */
export function attachSurfaceContext(sites: { id: string; lat: number; lon: number }[], raw: unknown): Map<string, SurfaceContext> {
  const d = raw as { schema?: number; product?: string; source?: { url: string; sha256: string }; sites?: SurfaceThermalSample[] }
  if (!d || d.schema !== 1 || d.product !== PRP_PRODUCT || !Array.isArray(d.sites)
    || !d.source || !/^[a-f0-9]{64}$/.test(d.source.sha256)
    || d.source.url !== 'https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab') throw new Error('Invalid Diviner context source')
  const rows = new Map<string,SurfaceContext>()
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const temperature = (v: unknown) => finite(v) && v > 0 && v < 500
  for (const r of d.sites) {
    if (!r || typeof r.id !== 'string' || rows.has(r.id) || !finite(r.lat) || !finite(r.lon)
      || !['sampled','outside-published-mesh'].includes(r.status)) throw new Error('Invalid Diviner site record')
    if (r.status === 'sampled') {
      const n = r.neighborhood
      if (!Number.isInteger(r.facet_index) || r.facet_index! < 0 || r.facet_index! >= 2880000 || r.source_record_number !== r.facet_index! + 1
        || !finite(r.centre_lat) || !finite(r.centre_lon) || !finite(r.centre_distance_m) || r.centre_distance_m < 0 || r.centre_distance_m > 2000
        || !temperature(r.annual_mean_2cm_k) || !temperature(r.annual_surface_max_k) || r.annual_surface_max_k! < r.annual_mean_2cm_k!
        || (r.ice_stability_depth_m !== null && (!finite(r.ice_stability_depth_m) || r.ice_stability_depth_m < 0 || r.ice_stability_depth_m > 2.8738))
        || !n || n.radius_m !== 1000 || !Number.isInteger(n.count) || n.count < 1
        || ![n.annual_mean_2cm_min_k,n.annual_mean_2cm_max_k,n.annual_surface_max_min_k,n.annual_surface_max_max_k].every(temperature)
        || n.annual_mean_2cm_min_k > r.annual_mean_2cm_k! || n.annual_mean_2cm_max_k < r.annual_mean_2cm_k!
        || n.annual_surface_max_min_k > r.annual_surface_max_k! || n.annual_surface_max_max_k < r.annual_surface_max_k!) throw new Error(`Invalid Diviner facet at ${r.id}`)
      const v = r.vertices_km, w = r.barycentric_weights
      if (!v || v.length !== 3 || !v.every(a => Array.isArray(a) && a.length === 3 && a.every(finite))
        || !w || w.length !== 3 || !w.every(a => finite(a) && a >= -1e-8 && a <= 1+1e-8)
        || Math.abs(w.reduce((a,b) => a+b,0)-1)>1e-7 || !finite(r.ray_radius_km) || r.ray_radius_km < 1700 || r.ray_radius_km > 1770) throw new Error(`Invalid Diviner geometry at ${r.id}`)
      const lat = r.lat*Math.PI/180, lon = r.lon*Math.PI/180
      const direction = [Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)]
      const errorKm = Math.hypot(...direction.map((u,j) => u*r.ray_radius_km! - v.reduce((sum,a,k) => sum+a[j]*w[k],0)))
      if (errorKm > 0.0001) throw new Error(`Diviner facet does not contain ${r.id}`)
    }
    rows.set(r.id,{ ...r, source: d.source, catalogUrl: PRP_CATALOG, product: PRP_PRODUCT })
  }
  if (rows.size !== sites.length) throw new Error('Diviner site list differs from the site catalogue')
  for (const s of sites) {
    const r = rows.get(s.id)
    if (!r || Math.abs(r.lat-s.lat)>1e-8 || Math.abs(r.lon-s.lon)>1e-8) throw new Error(`Diviner coordinates differ at ${s.id}`)
  }
  return rows
}

export function surfaceContextSummary(c: SurfaceContext | undefined, error?: string): string {
  if (error) return `Diviner background unavailable: ${error}. No thermal background or boundary inferred; core mission calculations are independent of this optional context.`
  if (!c) return 'No packaged Diviner PRP sample at this point; no thermal background inferred.'
  if (c.status !== 'sampled') return 'Outside the published south-polar PRP mesh; no thermal background inferred.'
  return `Diviner PRP V2 annual model: mean at 2 cm ${c.annual_mean_2cm_k!.toFixed(1)} K; surface maximum ${c.annual_surface_max_k!.toFixed(1)} K; facet ${c.facet_index} (source data row ${c.source_record_number}); centre ${c.centre_distance_m!.toFixed(0)} m from site. Context only, not a mission-date or equipment temperature.`
}
