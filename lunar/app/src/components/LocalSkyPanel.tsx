import {SiteRecord} from '../lib/data'

export function LocalSkyPanel({site}:{site:SiteRecord}) {
  const p=site.localSky
  if(!p)return null
  const save=()=>{
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({point:{lat:site.lat,lon:site.lon},groundM:site.ground_m,slopeDeg:site.slope_deg??null,horizons:site.horizons,evidence:p},null,2)],{type:'application/json'}));a.download=`lunorizon-${site.id}-mixed-skyline.json`;a.click();URL.revokeObjectURL(a.href)
  }
  return <details className="model-details" data-testid="mixed-skyline"><summary><strong>Mixed-terrain mission scenario</strong> · {p.stepM} m local cells · source & seam limits</summary><div className="panel-b">
    <p>The skyline, Sun/Earth tracks, power, contact and thermal calculations now use this source-specific stationary point. The original point remains a separate comparison option. A finer local grid does not establish a more accurate complete horizon.</p>
    <p>Local ground: <b>{p.groundM.toFixed(3)} m</b>. Background difference: {p.groundDifferenceM===null?'unknown':`${p.groundDifferenceM.toFixed(3)} m`}. Local/background height differences along sampled rays: {p.localDeltaMinM===null?'unknown':`${p.localDeltaMinM.toFixed(3)} to ${p.localDeltaMaxM!.toFixed(3)} m`}. No seam correction was fitted.</p>
    <p>Ray samples: local {p.localSamples.toLocaleString()}, 80 m near {p.nearSamples.toLocaleString()}, 480 m far {p.farSamples.toLocaleString()}, whole-Moon fallback {p.globeSamples.toLocaleString()}. Local holes using background: {p.localGapFallbacks.toLocaleString()}. Missing background: {p.missingSamples}. These are sample counts, not area percentages.</p>
    <ul>{p.limits.map(l=><li key={l}>{l}</li>)}</ul>
    <p className="reference-fingerprint">Local patch SHA-256: <code>{p.patchSha256}</code><br/>Scenario result SHA-256: <code>{p.config.resultSha256}</code></p>
    <p>Share links recompute this point and check these identities. Imported files stay in this browser; another browser must import the same named layers. This does not pin an immutable application release.</p>
    <button className="btn sm" onClick={save}>Export mixed skyline & provenance</button>
  </div></details>
}
