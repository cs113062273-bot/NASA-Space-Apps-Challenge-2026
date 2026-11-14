import { SiteRecord } from '../lib/data'
import { PRP_CATALOG, surfaceContextSummary } from '../lib/surface'

/** Read-only annual model context; it must not silently become a mission thermal boundary. */
export function SurfaceContextPanel({ site }: { site: SiteRecord }) {
  const c = site.surfaceContext, sampled = c?.status === 'sampled', n = c?.neighborhood
  const download = () => {
    if (!c) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ site: { id: site.id,name: site.name,lat: site.lat,lon: site.lon },
      context: c, interpretation: 'Annual model context, not a mission-date temperature forecast, equipment temperature or confirmed ice detection. No automatic thermal boundary or mission pass/fail inferred.' },null,2)+'\n'], { type:'application/json' }))
    a.download = `lunorizon-${site.id}-diviner-prp.json`; a.click(); URL.revokeObjectURL(a.href)
  }
  return <details className="surface-context">
    <summary>Surface thermal background · {site.surfaceContextError ? 'unavailable' : sampled ? 'Diviner annual model' : 'no packaged sample'}</summary>
    <p role={site.surfaceContextError ? 'alert' : undefined}>{sampled ? 'Published model values at this point help compare the broader thermal setting. They are separate from the equipment-temperature scenario below.' : surfaceContextSummary(c,site.surfaceContextError)}</p>
    {sampled && <>
      <dl className="surface-values">
        <div><dt>Annual mean · 2 cm below surface</dt><dd>{c.annual_mean_2cm_k!.toFixed(1)} K <span>({(c.annual_mean_2cm_k!-273.15).toFixed(1)} °C)</span></dd></div>
        <div><dt>Annual maximum · at surface</dt><dd>{c.annual_surface_max_k!.toFixed(1)} K <span>({(c.annual_surface_max_k!-273.15).toFixed(1)} °C)</span></dd></div>
      </dl>
      <p className="model-note">Different depths and statistics: these are not the lower/upper temperatures of your selected stay. The product fits thermal models to Diviner’s first mapping-year polar observations and uses Kaguya terrain, rather than this app’s LOLA/LROC terrain. Published PRP V2 only; the archive rejects V1.</p>
      {n && <p className="model-note">Nearby context: {n.count} facet centres within 1 km. Annual 2 cm means span {n.annual_mean_2cm_min_k.toFixed(1)}–{n.annual_mean_2cm_max_k.toFixed(1)} K; annual surface maxima span {n.annual_surface_max_min_k.toFixed(1)}–{n.annual_surface_max_max_k.toFixed(1)} K. This shows modeled spatial variation, not a confidence interval or a landing safety probability.</p>}
      <p className="model-note">The site ray intersects source facet {c.facet_index}; its centre is {c.centre_distance_m!.toFixed(0)} m away. Values are retained per facet without interpolation. Exact frame/terrain registration to current site coordinates is unresolved, so use this as regional context. No temperature boundary or pass/fail is applied automatically.</p>
      <details className="model-details"><summary>Source record and modeled ice-stability depth</summary>
        <p>Source data row {c.source_record_number} (1-based, after the header); centre {c.centre_lat!.toFixed(6)}°, {c.centre_lon!.toFixed(6)}° east. Full-source SHA-256: <code>{c.source.sha256}</code>.</p>
        <p>{c.ice_stability_depth_m === null ? 'The ice-stability depth is excluded in this record (source sentinel −999); no depth is inferred.' : `Calculated ice-stability depth: ${c.ice_stability_depth_m!.toFixed(3)} m, for the product’s sublimation criterion of 1 kg/m² per billion years.`} This is a model result, not a detection or measurement of actual ice, abundance or accessibility.</p>
      </details>
      <button className="btn sm" onClick={download}>Export this Diviner sample</button>
    </>}
    <p className="model-note"><a href={c?.catalogUrl ?? PRP_CATALOG} target="_blank" rel="noreferrer">PDS product description and limits</a>{c && <> · <a href={c.source.url.replace('.tab','.xml')} target="_blank" rel="noreferrer">Source field definitions</a></>}</p>
  </details>
}
