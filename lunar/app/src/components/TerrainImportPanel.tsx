import {useState} from 'react'
import {IMPORT_ROLES,ImportRole,prepareTerrainImport,saveTerrainImport,removeTerrainImport} from '../lib/terrain-import'

const labels:Record<ImportRole,string>={height:'Height DEM (m)',slope:'Slope (degrees)',slopeRms:'Slope RMS (degrees)',returns:'Returns per cell',heightRms:'Height RMS (m)'}
export function TerrainImportPanel({importId,onSelect}:{importId?:string;onSelect:(id:string|undefined)=>void}) {
  const [files,setFiles]=useState<Partial<Record<ImportRole,File>>>({}),[declared,setDeclared]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[status,setStatus]=useState<string|null>(null),[inputKey,setInputKey]=useState(0)
  const choose=(role:ImportRole,file:File|undefined)=>{setFiles(v=>({...v,[role]:file}));setDeclared(false)}
  const run=async()=>{
    setBusy(true);setError(null);setStatus('Checking source grids, file hashes and layer alignment…')
    try {
      const input:Partial<Record<ImportRole,{name:string;buffer:ArrayBuffer}>>={}
      for(const role of IMPORT_ROLES)if(files[role])input[role]={name:files[role]!.name,buffer:await files[role]!.arrayBuffer()}
      const data=await prepareTerrainImport(input,'MOON_ME_DE421_METRES')
      await saveTerrainImport(data);onSelect(data.provenance.id)
      setStatus(`Imported ${files.height!.name}. The selected dataset is used for terrain footprints at all compared points; outside coverage stays unverified.`)
    } catch(e) {setError(e instanceof Error?e.message:String(e));setStatus(null)} finally {setBusy(false)}
  }
  const remove=async()=>{
    if(!importId)return
    setBusy(true);setError(null)
    try {await removeTerrainImport(importId);onSelect(undefined);setStatus('Local dataset removed. NASA patches selected.')}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  return <details className="model-details terrain-import"><summary>Use your own terrain GeoTIFF</summary>
    <p>Import a height DEM and, optionally, matching slope and quality layers. Files stay in this browser. This replaces the footprint source for all points; mission calculations retain their existing sources until you explicitly create a mixed-terrain mission point in the footprint panel. Existing mixed-terrain points keep their pinned source.</p>
    <p>Supported: single-band, north-up square pixels of 1–100 m; lunar spherical south-polar stereographic, radius 1,737,400 m, pole −90°, meridian 0°, scale 1. Other projections/frames need conversion in GIS first. Up to 256 MiB total. Missing layers stay unknown; no RMS or return values are invented.</p>
    <div className="terrain-import-files" key={inputKey}>
      <label className="field"><span>{labels.height}</span><input type="file" accept=".tif,.tiff" aria-label="Import height DEM" disabled={busy} onChange={e=>choose('height',e.target.files?.[0])}/></label>
      <details><summary>Optional slope and quality layers</summary><div className="terrain-import-files">{IMPORT_ROLES.filter(r=>r!=='height').map(role=><label className="field" key={role}><span>{labels[role]}</span><input type="file" accept=".tif,.tiff" aria-label={`Import ${labels[role]}`} disabled={busy} onChange={e=>choose(role,e.target.files?.[0])}/></label>)}</div></details>
    </div>
    <label className="terrain-return-toggle"><input type="checkbox" checked={declared} disabled={busy} onChange={e=>setDeclared(e.target.checked)}/>I confirm these coordinates are MOON_ME_DE421, height values are metres above the 1,737,400 m sphere, and companion layers use the indicated units. This declaration does not transform another frame or certify registration.</label>
    <div className="terrain-export-row"><button className="btn sm" disabled={busy||!files.height||!declared} onClick={run}>{busy?'Checking terrain…':'Import terrain layers'}</button><button className="btn sm" disabled={busy} onClick={()=>{setFiles({});setDeclared(false);setInputKey(v=>v+1)}}>Reset selected files</button><button className="btn sm" disabled={busy||!importId} onClick={()=>{onSelect(undefined);setStatus('NASA patches selected. Saved local files remain available to links using their dataset identity.')}}>Use NASA patches</button>{importId&&<button className="btn sm" disabled={busy} onClick={remove}>Remove local terrain</button>}</div>
    {importId&&<p className="reference-fingerprint">Selected local dataset: <code>{importId}</code>. Share links retain its identity, not the files. Another browser must import the same named layers and declaration; unavailable local files cannot fall back to NASA data silently.</p>}
    {status&&<p role="status" className="model-note">{status}</p>}{error&&<p role="alert" className="bad">Terrain import failed: {error}</p>}
  </details>
}
