import {readFileSync} from 'node:fs'
import {describe,it,expect} from 'vitest'
import {DEFAULT_AREA,radiusAtPoint,terrainArea,terrainCellAtPoint} from '../src/lib/landing-area'
import {parseTerrainIndex} from '../src/lib/landing-terrain'
import {pointTerrainScreen,unavailableTerrain} from '../src/lib/terrain-constraint'
import {toXY,SiteRecord} from '../src/lib/data'
import {Ephemeris,Horizon} from '../src/lib/astro'
import {computeTrack as trackForPoint} from '../src/lib/metrics'
import {DEFAULT_POWER} from '../src/lib/power'
import {DEFAULT_RADIO} from '../src/lib/link'
import {createLandingEvaluator,replanLanding,decisionBrief} from '../src/lib/decision'
import {searchMissions,searchCsv} from '../src/lib/search'
import {decodeShare,encodeShare,DEFAULT_PINS} from '../src/lib/share'
import {hourlyAnalysisCsv} from '../src/lib/export'

const root=new URL('../public/data/',import.meta.url)
const index=parseTerrainIndex(JSON.parse(readFileSync(new URL('landing-terrain/index.json',root),'utf8')))
const meta=index.patches.find(p=>p.id==='c1')!,bytes=readFileSync(new URL('landing-terrain/'+meta.file,root)),view=new DataView(new Uint8Array(bytes).buffer),n=meta.rows*meta.cols
const f=Array.from({length:5},(_,j)=>Float32Array.from({length:n},(_,k)=>view.getFloat32((j*n+k)*4,true)))
const asset={index,meta,grid:{...meta,slope:f[0],slopeRms:f[1],returns:f[2],height:f[3],heightRms:f[4]}}
const sites=JSON.parse(readFileSync(new URL('sites.json',root),'utf8')).sites as SiteRecord[],site=sites.find(s=>s.id==='c1')!
const em=JSON.parse(readFileSync(new URL('ephemeris.json',root),'utf8')),eb=readFileSync(new URL('ephemeris.f32',root))
const eph:Ephemeris={startUnix:em.start_unix,stepS:em.step_s,count:em.count,data:new Float32Array(eb.buffer,eb.byteOffset,eb.byteLength/4)}
const track=trackForPoint(eph,{lat:site.lat,lon:site.lon,groundM:site.ground_m,observerM:2,horizon:new Horizon(site.horizons['2'])})
const req={minDaylightH:0,maxDarkH:1000,minEarthPct:0,maxSlopeDeg:10},unix=Date.parse('2027-01-01T00:00:00Z')/1000
const input={eph,trackFor:()=>track,len:24,observerM:2,req,power:{...DEFAULT_POWER,areaM2:0,batteryWh:1e6},radio:DEFAULT_RADIO}

describe('a footprint at the exact mission point, not an offset proxy',()=>{
  it('measures arbitrary coordinates to bad pixel edges and rejects outside/missing cells',()=>{
    const grid={rows:3,cols:3,stepM:5,x0:-5,y0:5},mask=new Uint8Array(9).fill(1);mask[5]=0
    expect(radiusAtPoint(grid,mask,1.25,.5)).toEqual({radiusM:1.25,eligible:true})
    expect(radiusAtPoint(grid,mask,5,0)).toEqual({radiusM:0,eligible:false})
    expect(radiusAtPoint(grid,mask,10,0)).toEqual({radiusM:0,eligible:false})
  })
  it('does not borrow the larger nearby disc from the real C1 raster',()=>{
    const [x,y]=toXY(site.lat,site.lon),area=terrainArea(asset.grid,x,y,10,DEFAULT_AREA),at=pointTerrainScreen(asset,site,10,DEFAULT_AREA)
    expect(at.radiusM).toBeLessThan(area.best!.radiusM)
    const diameterM=(2*at.radiusM!+2*area.best!.radiusM)/2
    expect(terrainArea(asset.grid,x,y,10,{...DEFAULT_AREA,diameterM}).fittingCentres).toBeGreaterThan(0)
    expect(pointTerrainScreen(asset,site,10,{...DEFAULT_AREA,diameterM}).pass).toBe(false)
  })
  it('requires both the actual point terrain and the centre mission conditions in decisions/search',async()=>{
    const baseline=createLandingEvaluator(input).evaluate(site,unix)!
    expect(baseline.clearsScreen).toBe(true)
    const terrainCheck=(s:SiteRecord)=>pointTerrainScreen(asset,s,10,{...DEFAULT_AREA,diameterM:1000})
    const rejected=createLandingEvaluator({...input,terrainCheck}).evaluate(site,unix)!
    expect(rejected.clearsScreen).toBe(false);expect(rejected.misses).toContain('terrain footprint at mission point')
    expect(rejected.bits).toBe(baseline.bits);expect(rejected.powerPass).toBe(baseline.powerPass)
    const settings={startUnix:unix,days:7,stepDays:1,minDataGb:0,maxSilenceH:null}
    const result=await searchMissions({...input,terrainCheck,candidates:[site],settings})
    expect(result.passing).toHaveLength(0);expect(result.reasons['terrain footprint at mission point']).toBe(7)
    expect(searchCsv(result,{restoreUrl:'test',assumptions:{}})).toContain('terrain_patch_sha256')
    const plan=replanLanding({...input,terrainCheck,anchor:site,originalUnix:unix,delayDays:1,candidates:[site],searchDays:7})
    expect(plan.changeSite).toBeNull();expect(plan.waitHere).toBeNull();expect(plan.powerAdjustment).toBeNull()
    const brief=decisionBrief(plan,site,unix,1)
    expect(brief).toContain(asset.meta.sha256);expect(brief).toContain('1000 m required');expect(brief).toContain('NOT MET')
    expect(brief).toContain('not substituted');expect(brief).toContain('does not pin an immutable model/data release')
    const hourly=hourlyAnalysisCsv(eph,site,track,(unix-eph.startUnix)/eph.stepS,24,2,undefined,undefined,'test',undefined,rejected.terrain)
    expect(hourly).toContain('# terrain_point_requirement:');expect(hourly).toContain(asset.meta.sha256)
    expect(hourly).toContain('"pass":false');expect(hourly).toContain('"requiredDiameterM":1000')
    // A logically passing terrain fixture still cannot waive a centre Earth rule.
    const good=(s:SiteRecord)=>({...unavailableTerrain(s,10,DEFAULT_AREA,'unavailable',''),status:'ready' as const,pass:true,radiusM:100,patchSha256:asset.meta.sha256,issue:null})
    expect(createLandingEvaluator({...input,terrainCheck:good}).evaluate(site,unix)!.clearsScreen).toBe(true)
    expect(createLandingEvaluator({...input,terrainCheck:good,req:{...req,minEarthPct:100}}).evaluate(site,unix)!.clearsScreen).toBe(false)
    const stale=createLandingEvaluator({...input,terrainCheck:good,req:{...req,maxSlopeDeg:9}}).evaluate(site,unix)!
    expect(stale.misses).toContain('terrain data unavailable');expect(stale.clearsScreen).toBe(false)
  })
  it('unavailable or loading source data fails separately without changing power/data accounting',()=>{
    for(const status of ['unavailable','loading'] as const) {
      const result=createLandingEvaluator({...input,terrainCheck:s=>unavailableTerrain(s,10,DEFAULT_AREA,status,'Source missing')}).evaluate(site,unix)!
      expect(result.clearsScreen).toBe(false);expect(result.misses).toContain('terrain data unavailable');expect(result.dataPass).toBe(true)
    }
    const [x,y]=toXY(site.lat,site.lon),k=terrainCellAtPoint(asset.grid,x,y)!,copy={...asset,grid:{...asset.grid,heightRms:asset.grid.heightRms.slice()}}
    copy.grid.heightRms[k]=NaN
    const unknown=pointTerrainScreen(copy,site,10,DEFAULT_AREA)
    expect(unknown.status).toBe('unavailable');expect(unknown.radiusM).toBeNull();expect(unknown.pass).toBe(false)
  })
  it('restores the optional mission constraint independently of nearby terrain display settings',()=>{
    const q=encodeShare({site:'c1',date:unix,days:1,req,h:2,ec:0,cmp:DEFAULT_PINS,pw:input.power,area:DEFAULT_AREA,areaRequired:true})
    expect(decodeShare(q.toString()).areaRequired).toBe(true)
    expect(decodeShare('?groundcheck=0').areaRequired).toBeUndefined()
  })
})
