// Reproduce the browser export through the same TS function, without a web server.
import {createServer} from 'vite'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const output=new URL('../test-results/',import.meta.url),data=new URL('../public/data/landing-terrain/',import.meta.url)
const vite=await createServer({server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,entries:[],include:[]}})
try {
  const {terrainArea,DEFAULT_AREA}=await vite.ssrLoadModule('/src/lib/landing-area.ts')
  const {areaReport,parseTerrainIndex}=await vite.ssrLoadModule('/src/lib/landing-terrain.ts')
  const {terrainGeoTiff}=await vite.ssrLoadModule('/src/lib/terrain-geotiff.ts')
  const {toXY}=await vite.ssrLoadModule('/src/lib/data.ts')
  const index=parseTerrainIndex(JSON.parse(await readFile(new URL('index.json',data),'utf8'))),meta=index.patches.find(p=>p.id==='c1')
  const bytes=await readFile(new URL(meta.file,data)),view=new DataView(new Uint8Array(bytes).buffer),n=meta.rows*meta.cols
  const fields=Array.from({length:5},(_,f)=>Float32Array.from({length:n},(_,k)=>view.getFloat32((f*n+k)*4,true)))
  const asset={index,meta,grid:{...meta,slope:fields[0],slopeRms:fields[1],returns:fields[2],height:fields[3],heightRms:fields[4]}}
  const [x,y]=toXY(meta.site.lat,meta.site.lon),result=terrainArea(asset.grid,x,y,10,DEFAULT_AREA),report=areaReport(asset,result,meta.site,10,DEFAULT_AREA)
  await mkdir(output,{recursive:true})
  const artifacts=[]
  for(const band of ['slope','slopeRms','returns','height','heightRms','eligible','footprintRadius']) {
    const array=await terrainGeoTiff(asset,result,report,band),name=`terrain-reference-${band}.tif`
    await writeFile(new URL(name,output),new Uint8Array(array))
    artifacts.push({band,file:name,sha256:createHash('sha256').update(new Uint8Array(array)).digest('hex')})
  }
  await writeFile(new URL('terrain-export-reference.json',output),JSON.stringify({report,artifacts},null,2)+'\n','utf8')
  console.log(`Exported ${artifacts.length} real-source lunar terrain GeoTIFFs`)
  const {prepareTerrainImport,importedTerrainAt}=await vite.ssrLoadModule('/src/lib/terrain-import.ts')
  const fixture=new URL('../tests/fixtures/terrain-import/',import.meta.url),source=await readFile(new URL('height-area.tif',fixture)),reference=JSON.parse(await readFile(new URL('reference.json',fixture),'utf8'))
  const input=await prepareTerrainImport({height:{name:'height-area.tif',buffer:new Uint8Array(source).buffer}},'MOON_ME_DE421_METRES')
  const imported=await importedTerrainAt(input,reference.site.lat,reference.site.lon),settings={...DEFAULT_AREA,rmsMultiplier:0}
  const [ix,iy]=toXY(reference.site.lat,reference.site.lon),screen=terrainArea(imported.grid,ix,iy,10,settings),importReport=areaReport(imported,screen,reference.site,10,settings),importArtifacts=[]
  for(const band of ['slope','slopeRms','returns','height','heightRms','eligible','footprintRadius']) {
    const bytes=await terrainGeoTiff(imported,screen,importReport,band),file=`terrain-import-reference-${band}.tif`
    await writeFile(new URL(file,output),new Uint8Array(bytes));importArtifacts.push({band,file,sha256:createHash('sha256').update(new Uint8Array(bytes)).digest('hex')})
  }
  await writeFile(new URL('terrain-import-export-reference.json',output),JSON.stringify({report:importReport,artifacts:importArtifacts},null,2)+'\n','utf8')
  console.log(`Exported ${importArtifacts.length} imported-DEM lunar terrain GeoTIFFs`)
} finally {await vite.close()}
