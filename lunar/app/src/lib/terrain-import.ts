import type {GeoTIFFImage} from 'geotiff'
import {toXY} from './data'
import type {TerrainAsset,TerrainPatchMeta} from './landing-terrain'
import type {TerrainGrid} from './landing-area'

export const IMPORT_ROLES=['height','slope','slopeRms','returns','heightRms'] as const
export type ImportRole=typeof IMPORT_ROLES[number]
export interface ImportFile {name:string;buffer:ArrayBuffer}
interface ImportGrid {rows:number;cols:number;stepM:number;x0:number;y0:number;rasterType:number;nodata:number|'NaN'|null}
export interface ImportProvenance {
  id:string;declaration:'MOON_ME_DE421_METRES';slopeMethod:string
  files:Partial<Record<ImportRole,{name:string;bytes:number;sha256:string;grid:ImportGrid}>>
}
export interface TerrainImport {provenance:ImportProvenance;files:Partial<Record<ImportRole,ImportFile>>}
const R=1737400,MAX_BYTES=256*1024*1024
const memory=new Map<string,Promise<TerrainImport>>()
const readers=new WeakMap<TerrainImport,Promise<Partial<Record<ImportRole,GeoTIFFImage>>>>()
export async function sha256(bytes:ArrayBuffer):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')
}
const close=(a:unknown,b:number)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<1e-9

/** Deliberately explicit supported CRS. No Earth EPSG, fitted registration,
 * implicit reprojecting or treating a missing lunar frame as a measured fact. */
export async function importGrid(image:GeoTIFFImage):Promise<ImportGrid> {
  const k=image.getGeoKeys(),d=image.fileDirectory
  if(!k)throw new Error('GeoTIFF coordinate reference keys are missing.')
  const value=async(name:'ModelTransformation'|'ModelPixelScale'|'ModelTiepoint')=>d.hasTag(name)?Array.from(await d.loadValue(name) as ArrayLike<number>):null
  if(k.GTModelTypeGeoKey!==1||k.ProjectedCSTypeGeoKey!==32767||k.GeographicTypeGeoKey!==32767||k.ProjCoordTransGeoKey!==15
    ||k.ProjLinearUnitsGeoKey!==9001||k.GeogAngularUnitsGeoKey!==9102||!close(k.GeogSemiMajorAxisGeoKey,R)
    ||!close(k.GeogSemiMinorAxisGeoKey,R)||!close(k.ProjNatOriginLatGeoKey,-90)
    ||!close(k.ProjNatOriginLongGeoKey??k.ProjStraightVertPoleLongGeoKey,0)
    ||k.ProjNatOriginLongGeoKey!==undefined&&!close(k.ProjNatOriginLongGeoKey,0)
    ||k.ProjStraightVertPoleLongGeoKey!==undefined&&!close(k.ProjStraightVertPoleLongGeoKey,0)
    ||!close(k.ProjFalseEastingGeoKey,0)||!close(k.ProjFalseNorthingGeoKey,0)||!close(k.ProjScaleAtNatOriginGeoKey,1)
    ||k.GeogPrimeMeridianLongGeoKey!==undefined&&!close(k.GeogPrimeMeridianLongGeoKey,0)
    ||k.VerticalUnitsGeoKey!==undefined&&k.VerticalUnitsGeoKey!==9001)
    throw new Error('Use a lunar spherical south-polar stereographic GeoTIFF: radius 1,737,400 m, pole −90°, meridian 0°, scale 1, metre units, user-defined CRS. Reproject other CRSs in GIS first; Earth or other lunar frames cannot be relabeled here.')
  const citation=[k.GTCitationGeoKey,k.GeogCitationGeoKey,k.PCSCitationGeoKey].join(' ')
  if(/WGS|WGS84|ITRF|IAU[_ ]?MOON|MOON[_ ]PA|PRINCIPAL[_ ]AX/i.test(citation))throw new Error('The source names a different body/frame. Transform it to MOON_ME_DE421 before importing; declaring a frame does not transform coordinates.')
  const rasterType=k.GTRasterTypeGeoKey
  if(rasterType!==1&&rasterType!==2)throw new Error('GeoTIFF must explicitly declare PixelIsArea or PixelIsPoint registration.')
  if(image.getSamplesPerPixel()!==1)throw new Error('Each layer must be a single-band numeric GeoTIFF.')
  const transform=await value('ModelTransformation'),scale=await value('ModelPixelScale'),tie=await value('ModelTiepoint')
  let sx:number,sy:number,left:number,top:number
  if(transform) {
    if(scale||tie||transform.length!==16||transform.some((v,i)=>![0,3,5,7,10,15].includes(i)&&v!==0)||transform[15]!==1||![0,1].includes(transform[10]))throw new Error('Rotated, skewed, conflicting or 3D raster transforms are unsupported. Export a north-up square grid in GIS first.')
    sx=transform[0];sy=-transform[5];left=transform[3];top=transform[7]
  } else {
    if(!scale||scale.length!==3||!tie||tie.length!==6||tie[2]!==0||tie[5]!==0||![0,1].includes(scale[2]))throw new Error('A single valid tiepoint and pixel scale are required; convert nontrivial height scale/offset to physical units first.')
    sx=scale[0];sy=scale[1];left=tie[3]-tie[0]*sx;top=tie[4]+tie[1]*sy
  }
  if(![sx,sy,left,top].every(Number.isFinite)||sx<1||sx>100||!close(sx,sy))throw new Error('Use north-up square pixels between 1 and 100 map metres. No resampling or missing-edge interpolation is performed here.')
  const meta=await image.getGDALMetadata(0)
  if(meta&&Object.entries(meta).some(([name,v])=>/^(scale|scale_factor)$/i.test(name)&&Number(v)!==1||/^(offset|add_offset)$/i.test(name)&&Number(v)!==0))throw new Error('Convert the band scale/offset to physical layer values before import.')
  const sampleBits=image.getBitsPerSample(0),blockPixels=image.getTileWidth()*image.getTileHeight()
  if(sampleBits>64||blockPixels*sampleBits/8>64*1024*1024)throw new Error('A decoded TIFF tile/strip is too large. Retile the source to smaller blocks before import.')
  const cols=image.getWidth(),rows=image.getHeight()
  if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(cols)||rows<3||cols<3||rows>1e7||cols>1e7)throw new Error('Unsupported DEM dimensions.')
  let nodata=await image.getGDALNoData()
  if(nodata===null&&meta?._FillValue!==undefined)nodata=Number(meta._FillValue)
  return {rows,cols,stepM:sx,x0:left+(rasterType===1?sx/2:0),y0:top-(rasterType===1?sy/2:0),rasterType,nodata:nodata!==null&&!Number.isFinite(nodata)?'NaN':nodata}
}

export async function prepareTerrainImport(files:Partial<Record<ImportRole,ImportFile>>,declaration:'MOON_ME_DE421_METRES'):Promise<TerrainImport> {
  if(declaration!=='MOON_ME_DE421_METRES'||!files.height)throw new Error('A height DEM and explicit ME421/metre declaration are required.')
  if(Object.values(files).reduce((n,f)=>n+f.buffer.byteLength,0)>MAX_BYTES)throw new Error('Import at most 256 MiB of source layers. Crop or tile larger datasets in GIS first.')
  const {fromArrayBuffer}=await import('geotiff'),provenance:ImportProvenance={id:'',declaration,slopeMethod:files.slope?'Supplied slope layer (degrees)':'Horn 3×3 map-plane gradient; no edge/nodata interpolation',files:{}}
  for(const role of IMPORT_ROLES)if(files[role]) {
    const f=files[role]!,tiff=await fromArrayBuffer(f.buffer),image=await tiff.getImage(),grid=await importGrid(image)
    provenance.files[role]={name:f.name,bytes:f.buffer.byteLength,sha256:await sha256(f.buffer),grid}
  }
  const a=provenance.files.height!.grid
  for(const f of Object.values(provenance.files))if(['rows','cols','stepM','x0','y0'].some(key=>f.grid[key as keyof ImportGrid]!==a[key as keyof ImportGrid]))throw new Error('All companion layers must share the exact pixel-centre grid. Align them in GIS first; layers are not shifted or resampled automatically.')
  provenance.id=await sha256(new TextEncoder().encode(JSON.stringify({...provenance,id:undefined})).buffer)
  return {provenance,files}
}

const database=()=>new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('lastlight-terrain',1)
  request.onupgradeneeded=()=>request.result.createObjectStore('datasets')
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Local terrain storage is unavailable. Allow browser storage to retain this dataset.'))
  request.onblocked=()=>reject(new Error('Close other LUNORIZON tabs using older local terrain storage, then retry.'))
})
export async function saveTerrainImport(data:TerrainImport):Promise<void> {
  const db=await database()
  try {await new Promise<void>((resolve,reject)=>{const t=db.transaction('datasets','readwrite');t.objectStore('datasets').put(data,data.provenance.id);t.oncomplete=()=>resolve();t.onerror=()=>reject(new Error('Could not save terrain locally; storage may be full.'));t.onabort=()=>reject(new Error('Local terrain save was interrupted.'))})}
  finally {db.close()}
  memory.set(data.provenance.id,Promise.resolve(data))
}
export async function restoreTerrainImport(id:string):Promise<TerrainImport> {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid imported terrain identity.')
  let p=memory.get(id)
  if(!p) {
    p=(async()=>{
      const db=await database();let data:TerrainImport|undefined
      try {data=await new Promise<TerrainImport|undefined>((resolve,reject)=>{const r=db.transaction('datasets').objectStore('datasets').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Could not read local terrain.'))})} finally {db.close()}
      if(!data)throw new Error('This link requires local terrain files not present in this browser. Reimport the same layers and declaration; NASA patches are not substituted.')
      const checked=await prepareTerrainImport(data.files,data.provenance.declaration)
      if(checked.provenance.id!==id)throw new Error('Stored terrain source bytes or metadata differ from the shared dataset identity. Reimport the original layers.')
      return checked
    })()
    memory.set(id,p);p.catch(()=>memory.delete(id))
  }
  return p
}
export async function removeTerrainImport(id:string):Promise<void> {
  const db=await database()
  try {await new Promise<void>((resolve,reject)=>{const t=db.transaction('datasets','readwrite');t.objectStore('datasets').delete(id);t.oncomplete=()=>resolve();t.onerror=()=>reject(new Error('Could not remove local terrain.'))})} finally {db.close()}
  memory.delete(id)
}

/** Finite 3×3 support is mandatory. Missing edges are not extrapolated. */
export function hornSlope(halo:Float32Array,rows:number,cols:number,stepM:number):Float32Array {
  const width=cols+2,out=new Float32Array(rows*cols).fill(NaN)
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++) {
    const k=(r+1)*width+c+1,z=[halo[k-width-1],halo[k-width],halo[k-width+1],halo[k-1],halo[k],halo[k+1],halo[k+width-1],halo[k+width],halo[k+width+1]]
    if(!z.every(Number.isFinite))continue
    const dx=(z[2]+2*z[5]+z[8]-z[0]-2*z[3]-z[6])/(8*stepM),dy=(z[6]+2*z[7]+z[8]-z[0]-2*z[1]-z[2])/(8*stepM)
    out[r*cols+c]=Math.atan(Math.hypot(dx,dy))*180/Math.PI
  }
  return out
}
export async function importedTerrainAt(data:TerrainImport,lat:number,lon:number):Promise<TerrainAsset|null> {
  if(![lat,lon].every(Number.isFinite)||lat< -90||lat>=90)return null
  const g=data.provenance.files.height!.grid,[x,y]=toXY(lat,lon),s=g.stepM
  if(x<g.x0-s/2||x>=g.x0+(g.cols-.5)*s||y>g.y0+s/2||y<=g.y0-(g.rows-.5)*s)return null
  let pending=readers.get(data)
  if(!pending) {pending=(async()=>{const {fromArrayBuffer}=await import('geotiff'),images:Partial<Record<ImportRole,GeoTIFFImage>>={};for(const role of IMPORT_ROLES)if(data.files[role])images[role]=await (await fromArrayBuffer(data.files[role]!.buffer)).getImage();return images})();readers.set(data,pending)}
  const images=await pending,n=Math.min(512,Math.max(32,Math.ceil(1100/s))),row=Math.floor((g.y0+s/2-y)/s)-Math.floor(n/2),col=Math.floor((x-g.x0+s/2)/s)-Math.floor(n/2)
  async function read(role:ImportRole,halo=false):Promise<Float32Array> {
    const h=halo?1:0,size=n+2*h,out=new Float32Array(size*size).fill(NaN),image=images[role]
    if(!image)return out
    const x1=Math.max(0,col-h),y1=Math.max(0,row-h),x2=Math.min(g.cols,col+n+h),y2=Math.min(g.rows,row+n+h)
    if(x1>=x2||y1>=y2)return out
    const values=await image.readRasters({window:[x1,y1,x2,y2],samples:[0],interleave:true}) as ArrayLike<number>,nodata=data.provenance.files[role]!.grid.nodata
    for(let r=y1;r<y2;r++)for(let c=x1;c<x2;c++) {
      const v=values[(r-y1)*(x2-x1)+c-x1]
      if(Number.isFinite(v)&&v!==nodata) {
        if(role==='height'&&Math.abs(v)>30000)throw new Error('DEM values exceed ±30,000 m. Use heights above the 1,737,400 m sphere, not absolute radii or unconverted digital numbers.')
        out[(r-row+h)*size+c-col+h]=v
      }
    }
    return out
  }
  const height=await read('height'),slope=images.slope?await read('slope'):hornSlope(await read('height',true),n,n,s),slopeRms=await read('slopeRms'),returns=await read('returns'),heightRms=await read('heightRms')
  const grid:TerrainGrid={rows:n,cols:n,stepM:s,x0:g.x0+col*s,y0:g.y0-row*s,height,slope,slopeRms,returns,heightRms,available:{slopeRms:!!images.slopeRms,returns:!!images.returns,heightRms:!!images.heightRms}}
  const packed=new Float32Array(5*n*n);[slope,slopeRms,returns,height,heightRms].forEach((a,i)=>packed.set(a,i*n*n))
  // Explicit little-endian serialization keeps exported patch evidence portable.
  const bytes=new ArrayBuffer(packed.byteLength),view=new DataView(bytes);for(let i=0;i<packed.length;i++)view.setFloat32(i*4,packed[i],true)
  const sha=await sha256(bytes),sourceFiles=Object.fromEntries(Object.entries(data.provenance.files).map(([role,f])=>[role,{url:`local-file:${encodeURIComponent(f.name)}`,bytes:f.bytes,sha256:f.sha256}]))
  const meta:TerrainPatchMeta={id:`import-${data.provenance.id.slice(0,12)}-${row}-${col}`,site:{lat,lon},region:'User-imported DEM',rows:n,cols:n,stepM:s,x0:grid.x0,y0:grid.y0,file:sha+'.f32',bytes:bytes.byteLength,sha256:sha,sourceWindow:{row,col,rows:n,cols:n},sourceFiles}
  return {grid,meta,imported:data.provenance,index:{schema:1,frame:'MOON_ME_DE421',projection:'User-declared ME421 spherical south-polar stereographic; native source pixel centres',fieldOrder:['slp','slperr','ldec','surf','toterr'],productURL:'',sourceManifestSha256:data.provenance.id,patches:[meta],limits:[
    'User-declared frame and height units; numerical CRS checks do not establish measured registration or source accuracy',
    data.provenance.slopeMethod,'Native square-grid values without reprojection or resampling; point postings are screened as source-cell squares',
    'Missing uncertainty/return layers remain NaN, never invented zeros; nominal-only screening may be selected explicitly',
    'Map-plane areas and footprint lengths; source grid and 512-cell window bound the available region',
    'Imported DEM affects the terrain-footprint screen only; mission Sun/Earth/power horizons and coarse point slope retain their separate sources',
    'No sub-grid hazards, traversability, vehicle or flight landing qualification',
  ]}}
}
