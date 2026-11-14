import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {describe,it,expect} from 'vitest'
import {prepareTerrainImport,importedTerrainAt,ImportFile} from '../src/lib/terrain-import'
import {DEFAULT_AREA,terrainArea,terrainSourceIssue} from '../src/lib/landing-area'
import {pointTerrainScreen} from '../src/lib/terrain-constraint'
import {toXY,toLatLon} from '../src/lib/data'
import {decodeShare,encodeShare,DEFAULT_PINS} from '../src/lib/share'
import {DEFAULT_REQ} from '../src/lib/requirements'
import {DEFAULT_POWER} from '../src/lib/power'

const root=new URL('./fixtures/terrain-import/',import.meta.url)
const reference=JSON.parse(readFileSync(new URL('reference.json',root),'utf8'))
const file=(name:string):ImportFile=>({name,buffer:new Uint8Array(readFileSync(new URL(name,root))).buffer})
const declaration='MOON_ME_DE421_METRES' as const

describe('local lunar DEM inputs with explicit source identity and unknown quality',()=>{
  it('matches independent GDAL PixelIsArea/Point registration, deflate values and SciPy slopes',async()=>{
    for(const [name,sha] of Object.entries(reference.sourceSha256))expect(createHash('sha256').update(readFileSync(new URL(name,root))).digest('hex')).toBe(sha)
    for(const name of ['height-area.tif','height-point.tif']) {
      const data=await prepareTerrainImport({height:file(name)},declaration),a=(await importedTerrainAt(data,reference.site.lat,reference.site.lon))!
      const g=data.provenance.files.height!.grid
      expect(g.x0).toBeCloseTo(reference.x0,9);expect(g.y0).toBeCloseTo(reference.y0,9)
      expect(g.rasterType).toBe(name.includes('point')?2:1)
      const start=a.meta.sourceWindow
      const inside=(r:number,c:number)=>r>=start.row&&r<start.row+a.grid.rows&&c>=start.col&&c<start.col+a.grid.cols
      let checked=0
      for(const sample of reference.samples) {
        if(!inside(sample.row,sample.col))continue
        const k=(sample.row-start.row)*a.grid.cols+sample.col-start.col
        expect(a.grid.height[k]).toBe(sample.height);expect(a.grid.slope[k]).toBeCloseTo(sample.slope,5)
        checked++
      }
      expect(checked).toBeGreaterThan(20)
      let unknown=0
      for(let r=0;r<reference.rows;r++)for(let c=0;c<reference.cols;c++)if(inside(r,c)&&!Number.isFinite(a.grid.slope[(r-start.row)*a.grid.cols+c-start.col]))unknown++
      expect(unknown).toBe(reference.unknownSlopeCoordinates.filter(([r,c]:number[])=>inside(r,c)).length)
      expect(a.grid.slopeRms.every(Number.isNaN)).toBe(true);expect(a.grid.returns.every(Number.isNaN)).toBe(true)
      const [x,y]=toXY(reference.site.lat,reference.site.lon)
      expect(terrainArea(a.grid,x,y,10,DEFAULT_AREA).known).toBe(0)
      expect(pointTerrainScreen(a,reference.site,10,DEFAULT_AREA).issue).toMatch(/no slope RMS/)
      const nominal={...DEFAULT_AREA,rmsMultiplier:0}
      expect(terrainArea(a.grid,x,y,10,nominal).eligible).toBeGreaterThan(0)
      expect(pointTerrainScreen(a,reference.site,10,nominal).pass).toBe(true)
      expect(terrainSourceIssue(a.grid,{...nominal,requireReturns:true})).toMatch(/no return-count/)
      const [lat,lon]=toLatLon(reference.x0,reference.y0),edge=(await importedTerrainAt(data,lat,lon))!
      expect(pointTerrainScreen(edge,{lat,lon},10,nominal).status).toBe('unavailable')
    }
  })
  it('retains supplied slope/quality rather than inventing them and rejects source-grid misalignment',async()=>{
    const files={height:file('height-area.tif'),slope:file('slope.tif'),slopeRms:file('slope-rms.tif'),returns:file('returns.tif'),heightRms:file('height-rms.tif')}
    const data=await prepareTerrainImport(files,declaration),a=(await importedTerrainAt(data,reference.site.lat,reference.site.lon))!
    expect(a.grid.available).toEqual({slopeRms:true,returns:true,heightRms:true})
    expect(pointTerrainScreen(a,reference.site,10,DEFAULT_AREA).pass).toBe(true)
    expect(data.provenance.slopeMethod).toMatch(/Supplied slope/)
    expect(await importedTerrainAt(data,-89,0)).toBeNull()
    await expect(prepareTerrainImport({...files,slopeRms:file('misaligned-rms.tif')},declaration)).rejects.toThrow(/exact pixel-centre grid/)
  })
  it('refuses Earth CRSs, rotations, invalid frame declarations and malformed TIFFs',async()=>{
    expect(createHash('sha256').update(readFileSync(new URL('../../pipeline/build_terrain_import_reference.py',import.meta.url))).digest('hex')).toBe(reference.generatorSha256)
    await expect(prepareTerrainImport({height:file('earth.tif')},declaration)).rejects.toThrow(/lunar spherical/)
    await expect(prepareTerrainImport({height:file('rotated.tif')},declaration)).rejects.toThrow(/Rotated/)
    await expect(prepareTerrainImport({height:file('height-area.tif')},'IAU_MOON' as any)).rejects.toThrow(/explicit ME421/)
    await expect(prepareTerrainImport({height:{name:'bad.tif',buffer:new ArrayBuffer(20)}},declaration)).rejects.toThrow()
  })
  it('identifies source bytes, role and file names; share cannot silently discard a bad source selection',async()=>{
    const files={height:file('height-area.tif')},a=await prepareTerrainImport(files,declaration),same=await prepareTerrainImport(files,declaration)
    expect(a.provenance.id).toBe(same.provenance.id)
    expect((await prepareTerrainImport({height:{...files.height,name:'other.tif'}},declaration)).provenance.id).not.toBe(a.provenance.id)
    const q=encodeShare({site:'c1',date:1798761600,days:1,req:DEFAULT_REQ,h:2,ec:0,cmp:DEFAULT_PINS,pw:DEFAULT_POWER,terrainImport:a.provenance.id,areaRequired:true})
    expect(decodeShare(q.toString()).terrainImport).toBe(a.provenance.id)
    expect(decodeShare('?groundsrc=bad&groundcheck=1').terrainImport).toBe('invalid')
    expect(decodeShare('?groundsrc=&groundcheck=1').areaRequired).toBe(true)
  })
})
