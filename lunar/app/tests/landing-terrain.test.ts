import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {fromArrayBuffer} from 'geotiff'
import {DEFAULT_AREA,terrainArea,TerrainGrid,radiusAtPoint} from '../src/lib/landing-area'
import {areaReport,loadTerrain,parseTerrainIndex,TerrainAsset} from '../src/lib/landing-terrain'
import {terrainGeoTiff} from '../src/lib/terrain-geotiff'
import {decodeShare,encodeShare,DEFAULT_PINS} from '../src/lib/share'
import {DEFAULT_POWER} from '../src/lib/power'
import {DEFAULT_REQ} from '../src/lib/requirements'
import {prepareTerrainImport,importedTerrainAt,ImportRole} from '../src/lib/terrain-import'
import {toXY} from '../src/lib/data'

const root=new URL('../public/data/landing-terrain/',import.meta.url)
const indexText=readFileSync(new URL('index.json',root),'utf8'),index=parseTerrainIndex(JSON.parse(indexText))
const fixtures=JSON.parse(readFileSync(new URL('../../data/validation/landing-area-reference.json',import.meta.url),'utf8'))
function asset(id:string):TerrainAsset {
  const meta=index.patches.find(p=>p.id===id)!,raw=readFileSync(new URL(meta.file,root)),n=meta.rows*meta.cols
  const view=new DataView(new Uint8Array(raw).buffer)
  const fields=Array.from({length:5},(_,f)=>Float32Array.from({length:n},(_,k)=>view.getFloat32((f*n+k)*4,true)))
  return {meta,index,grid:{...meta,slope:fields[0],slopeRms:fields[1],returns:fields[2],height:fields[3],heightRms:fields[4]}}
}
afterEach(()=>vi.unstubAllGlobals())

describe('native terrain provenance and independent real-source spatial references',()=>{
  it('matches all independent TIFF/SciPy windows and source-cell geometry without raw downloads',()=>{
    expect(createHash('sha256').update(indexText).digest('hex')).toBe(fixtures.indexSha256)
    expect(fixtures.pixelChecks).toHaveLength(index.patches.length*5)
    for(const p of index.patches)expect(createHash('sha256').update(readFileSync(new URL(p.file,root))).digest('hex')).toBe(p.sha256)
    for(const test of fixtures.cases) {
      const a=asset(test.id),r=terrainArea(a.grid,test.targetX,test.targetY,test.maxSlope,test.settings)
      for(const key of ['inCircle','known','nominal','eligible','directReturns','mapAreaM2','largestConnectedM2','components','fittingCentres'] as const)expect(r[key],`${test.id}: ${key}`).toBe(test.result[key])
      if(test.result.best) {expect(r.best?.index).toBe(test.result.best.index);expect(r.best?.radiusM).toBeCloseTo(test.result.best.radiusM,10)}
      else expect(r.best).toBeNull()
      const point=radiusAtPoint(a.grid,r.mask,test.targetX,test.targetY)
      expect(point.eligible,`${test.id}: exact mission-point eligibility`).toBe(test.result.point.eligible)
      expect(point.radiusM,`${test.id}: exact mission-point radius`).toBeCloseTo(test.result.point.radiusM,9)
    }
  })
  it('fails on malformed grid/frame/field order and refuses corrupted patch bytes',async()=>{
    for(const mutate of [(p:any)=>p.frame='IAU_MOON',(p:any)=>p.fieldOrder.reverse(),(p:any)=>p.patches[0].bytes=1,(p:any)=>p.patches[0].sourceFiles.slp.sha256='missing']) {
      const p=JSON.parse(indexText);mutate(p);expect(()=>parseTerrainIndex(p)).toThrow()
    }
    const a=asset('c1'),bytes=new Uint8Array(readFileSync(new URL(a.meta.file,root)));bytes[20]^=1
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(url.endsWith('.json')?new Response(indexText):new Response(bytes))))
    await expect(loadTerrain(a.meta.site.lat,a.meta.site.lon,'c1','/corrupt/')).rejects.toThrow(/checksum/)
  })
  it('does not borrow terrain outside a patch and retries a failed optional source',async()=>{
    vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(indexText))))
    expect(await loadTerrain(0,0,'apollo11','/outside/')).toBeNull()
    const a=asset('c1'),bytes=new Uint8Array(readFileSync(new URL(a.meta.file,root)));let fail=true
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(url.endsWith('.json')?new Response(indexText):new Response(fail?bytes.subarray(1):bytes))))
    await expect(loadTerrain(a.meta.site.lat,a.meta.site.lon,'c1','/retry/')).rejects.toThrow(/byte count/)
    fail=false
    const restored=await loadTerrain(a.meta.site.lat,a.meta.site.lon,'c1','/retry/')
    expect(restored?.meta.id).toBe('c1');expect(restored?.grid.slope[0]).toBe(a.grid.slope[0])
  })
})

describe('terrain settings, geographic precision and GIS export',()=>{
  it('reimports all five real-source lunar GeoTIFF fields without changing the terrain decision',async()=>{
    const a=asset('c1'),[x,y]=toXY(a.meta.site.lat,a.meta.site.lon),expected=terrainArea(a.grid,x,y,10,DEFAULT_AREA),report=areaReport(a,expected,a.meta.site,10,DEFAULT_AREA)
    const files:Partial<Record<ImportRole,{name:string;buffer:ArrayBuffer}>>={}
    for(const role of ['height','slope','slopeRms','returns','heightRms'] as const)files[role]={name:role+'.tif',buffer:await terrainGeoTiff(a,expected,report,role)}
    const input=await prepareTerrainImport(files,'MOON_ME_DE421_METRES'),restored=(await importedTerrainAt(input,a.meta.site.lat,a.meta.site.lon))!
    const actual=terrainArea(restored.grid,x,y,10,DEFAULT_AREA)
    for(const key of ['known','eligible','directReturns','components','largestConnectedM2','fittingCentres'] as const)expect(actual[key]).toBe(expected[key])
    expect(actual.best?.radiusM).toBe(expected.best?.radiusM)
  })
  it('round-trips screen settings and sub-pixel coordinates while rejecting malformed controls',()=>{
    const point:[number,number]=[-89.4398765,222.8301234],area={diameterM:150,rmsMultiplier:2,requireReturns:true}
    const q=encodeShare({add:point,date:1798761600,days:7,req:DEFAULT_REQ,h:2,ec:0,cmp:DEFAULT_PINS,pw:DEFAULT_POWER,area})
    expect(decodeShare(q.toString()).add).toEqual(point);expect(decodeShare(q.toString()).area).toEqual(area)
    for(const text of ['','1,1','100,3,0','-1,1,0','100,1,yes',',1,1','100,1,1,extra'])expect(decodeShare('?ground='+text).area).toBeUndefined()
  })
  it('exports true float32 lunar GeoTIFF bands with pixel corners, NaNs and no Earth EPSG',async()=>{
    const a=asset('c1'),test=fixtures.cases.find((c:any)=>c.id==='c1'&&!c.settings.requireReturns&&c.settings.rmsMultiplier===1)
    const r=terrainArea(a.grid,test.targetX,test.targetY,10,DEFAULT_AREA),report=areaReport(a,r,a.meta.site,10,DEFAULT_AREA)
    for(const band of ['slope','footprintRadius'] as const) {
      const bytes=await terrainGeoTiff(a,r,report,band),tiff=await fromArrayBuffer(bytes),image=await tiff.getImage()
      expect(image.getWidth()).toBe(a.grid.cols);expect(image.getHeight()).toBe(a.grid.rows)
      expect(image.getGeoKeys().ProjectedCSTypeGeoKey).toBe(32767)
      expect(image.getGeoKeys().GeogSemiMajorAxisGeoKey).toBe(1737400)
      expect(image.getGeoKeys().ProjNatOriginLatGeoKey).toBe(-90)
      expect(image.getOrigin().slice(0,2)).toEqual([a.grid.x0-2.5,a.grid.y0+2.5])
      const values=await image.readRasters({interleave:true}) as Float32Array
      if(band==='slope')expect(Array.from(values)).toEqual(Array.from(a.grid.slope))
      else {expect(Number.isNaN(values[0])).toBe(true);expect(values[r.best!.index]).toBeCloseTo(r.best!.radiusM,4)}
    }
  })
})
