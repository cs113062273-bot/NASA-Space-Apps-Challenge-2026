import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {describe,it,expect,vi,afterEach} from 'vitest'
import {compositeSky,localHeight,matchesPoint,parsePointReference,pointReference,skyResultHash,LocalSkyEvidence} from '../src/lib/local-sky'
import {toXY,toLatLon} from '../src/lib/data'
import {sampleGrid,traceHorizon,toXY as terrainXY} from '../src/lib/terrain'
import {loadTerrain} from '../src/lib/landing-terrain'
import {decodeShare,encodeShare,DEFAULT_PINS} from '../src/lib/share'
import {DEFAULT_REQ} from '../src/lib/requirements'
import {DEFAULT_POWER} from '../src/lib/power'
import {Ephemeris,Horizon,sliceEphemeris,indexOf} from '../src/lib/astro'
import {computeTrack,windowStats} from '../src/lib/metrics'
import {missionBudget,DEFAULT_RADIO} from '../src/lib/link'
import {THERMAL_EXAMPLE} from '../src/lib/thermal'
import {searchMissions} from '../src/lib/search'
import type {SiteRecord} from '../src/lib/data'

const ref=JSON.parse(readFileSync(new URL('./fixtures/local-sky.json',import.meta.url),'utf8'))
function local(raw:any){const height=Float32Array.from(raw.height.flat(),(v:number|null)=>v===null?NaN:v),heightRms=Float32Array.from(raw.heightRms.flat(),(v:number|null)=>v===null?NaN:v);return {...raw,height,heightRms,slope:new Float32Array(height.length),slopeRms:new Float32Array(height.length),returns:new Float32Array(height.length)}}
const grid=(raw:any)=>({...raw,data:Int16Array.from(raw.data.flat())})
afterEach(()=>vi.unstubAllGlobals())

describe('source-specific mixed DEM sky with independent 3D/SciPy evidence',()=>{
  for(const c of ref.poles)it(`matches independent asymmetric terrain at the exact south pole, orientation ${c.name}`,()=>{
    const r=compositeSky(c.lat,c.lon,local(c.local),grid(c.near),grid(c.far),[2,10],36)
    expect(r.horizons).toEqual(c.reference.horizons)
  })
  it('keeps ordinary browser horizon rays directional at the exact pole',()=>{
    const R=1737400,distances=Float64Array.from([40,50,1000]),sample=(la:number,lo:number)=>{const rho=2*R*Math.tan((Math.PI/2+la)/2),y=rho*Math.cos(lo);return y>30&&y<60?80:0}
    for(const lon of [0,90,222.83]) {
      const result=traceHorizon(-90,lon,sample,sample,2,36,0,distances)
      for(let j=0;j<36;j++) {
        const az=((j+.5)*10+lon)*Math.PI/180
        const expected=Math.max(...Array.from(distances,d=>{const y=2*R*Math.tan(d/(2*R))*Math.cos(az),h=y>30&&y<60?80:0;return Math.atan2((R+h)*Math.cos(d/R)-(R+2),(R+h)*Math.sin(d/R))*180/Math.PI}))
        expect(result.elev[j]).toBeCloseTo(expected,4)
      }
    }
  })
  for(const c of ref.synthetic)it(`matches independent spherical ray elevations and source counts: ${c.name}`,()=>{
    const r=compositeSky(c.lat,c.lon,local(c.local),grid(c.near),grid(c.far),[2,10],36,c.globe===null?undefined:()=>c.globe)
    expect(r.horizons).toEqual(c.reference.horizons)
    for(const k of ['localSamples','nearSamples','farSamples','globeSamples','missingSamples','localGapFallbacks','bins'] as const)expect(r[k],k).toBe(c.reference[k])
    for(const k of ['groundM','baselineGroundM','heightRmsM','localDeltaMinM','localDeltaMaxM'] as const)c.reference[k]===null?expect(r[k],k).toBeNull():expect(r[k],k).toBeCloseTo(c.reference[k],5)
  })
  it('pins the independent generator and every retained real source',()=>{
    expect(createHash('sha256').update(readFileSync(new URL('../../pipeline/build_local_sky_reference.py',import.meta.url))).digest('hex')).toBe(ref.generatorSha256)
    for(const [name,sha] of Object.entries(ref.sources))expect(createHash('sha256').update(readFileSync(new URL(`../../${name}`,import.meta.url))).digest('hex'),name).toBe(sha)
    expect(ref.actual.every((r:any)=>r.reference.missingSamples===0&&r.reference.horizons['2'].length===2880)).toBe(true)
  })
  it('refuses a missing local observer and never fabricates quality or a zero-height missing tile',()=>{
    const c=ref.synthetic[0],g=local(c.local),[x,y]=toXY(c.lat,c.lon)
    g.height[6*13+6]=NaN
    expect(()=>compositeSky(c.lat,c.lon,g,grid(c.near),grid(c.far),[2,10],36)).toThrow(/local DEM has no complete/)
    expect(Number.isNaN(localHeight(g,x,y))).toBe(true)
    const q=local(c.local);q.heightRms.fill(-1);expect(Number.isNaN(localHeight(q,x,y,'heightRms'))).toBe(true)
    const impossible=local(c.local);impossible.height.fill(-1737401)
    expect(()=>compositeSky(c.lat,c.lon,impossible,grid(c.near),grid(c.far),[2,10],36)).toThrow(/nonpositive lunar radius/)
    const near=grid(c.near);near.nodata=-32768;near.data.fill(-32768)
    expect(Number.isNaN(sampleGrid(near,x,y))).toBe(true)
    const result=compositeSky(c.lat,c.lon,local(c.local),near,grid(c.far),[2,10],36)
    expect(result.nearSamples).toBe(0);expect(result.farSamples).toBeGreaterThan(0)
    expect(()=>compositeSky(89,c.lon,local(c.local),near,grid(c.far))).toThrow(/Unsupported/)
  })
  it('keeps northern coordinates distinct from southern terrain coverage',async()=>{
    for(const lat of [-89.44,-20,0,20,89.44]){
      const [x,y]=toXY(lat,222.83),[la,lo]=toLatLon(x,y)
      expect(la).toBeCloseTo(lat,10);expect(lo).toBeCloseTo(222.83,10);expect(terrainXY(lat,222.83)).toEqual([x,y])
    }
    const index=readFileSync(new URL('../public/data/landing-terrain/index.json',import.meta.url),'utf8')
    vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(index))))
    expect(await loadTerrain(89.4398,222.83,'north','/north-test/')).toBeNull()
  })
  it('preserves full coordinate and source/result identity across shares and same-coordinate comparisons',()=>{
    const config={sourceId:'a'.repeat(64),patchSha256:'b'.repeat(64),resultSha256:'c'.repeat(64)},evidence={config,patchSha256:config.patchSha256} as LocalSkyEvidence
    const point={lat:-89.43981234567891,lon:222.8300123456789,localSky:evidence},id=pointReference(point),parsed=parsePointReference(id)!
    expect(parsed).toEqual({lat:point.lat,lon:point.lon,sky:config});expect(matchesPoint(point,parsed)).toBe(true)
    expect(matchesPoint({...point,localSky:undefined},parsed)).toBe(false)
    expect(matchesPoint(point,{lat:point.lat,lon:point.lon})).toBe(false)
    expect(matchesPoint(point,{...parsed,sky:{...config,resultSha256:'d'.repeat(64)}})).toBe(false)
    const q=encodeShare({add:[point.lat,point.lon],sky:config,cmpDetail:[id],date:1798761600,days:7,req:DEFAULT_REQ,h:2,ec:0,pw:DEFAULT_POWER,cmp:DEFAULT_PINS})
    const restored=decodeShare(`?${q}`);expect(restored.add).toEqual([point.lat,point.lon]);expect(restored.sky).toEqual(config);expect(restored.cmpDetail).toEqual([id])
    expect(decodeShare('?sky=broken').sky).toEqual({sourceId:'invalid'})
    expect(parsePointReference('pt::20')).toBeNull()
    expect(parsePointReference('pt:-89:20:unknown')?.sky).toEqual({sourceId:'invalid'})
  })
  it('binds scenario identity to terrain output, sampling and provenance',async()=>{
    const c=ref.synthetic[0],r=compositeSky(c.lat,c.lon,local(c.local),grid(c.near),grid(c.far),[2,10],36)
    const proof={revision:1,...r,patchSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),stepM:10,groundDifferenceM:0,source:{}} as unknown as Omit<LocalSkyEvidence,'config'|'limits'>
    const first=await skyResultHash(c.lat,c.lon,r.groundM,r.horizons,0,proof)
    expect(first).toMatch(/^[a-f0-9]{64}$/);expect(await skyResultHash(c.lat,c.lon,r.groundM,r.horizons,0,proof)).toBe(first)
    expect(await skyResultHash(c.lat,c.lon,r.groundM+1,r.horizons,0,proof)).not.toBe(first)
    expect(await skyResultHash(c.lat,c.lon,r.groundM,r.horizons,0,{...proof,bins:72})).not.toBe(first)
  })
  it('uses the imported observer and horizon throughout light, contact, power, thermal and search',async()=>{
    const root=new URL('../public/data/',import.meta.url),raw=readFileSync(new URL('ephemeris.f32',root)),meta=JSON.parse(readFileSync(new URL('ephemeris.json',root),'utf8'))
    const all:Ephemeris={startUnix:meta.start_unix,stepS:meta.step_s,count:meta.count,data:new Float32Array(raw.buffer,raw.byteOffset,raw.length/4),dsn:null}
    const unix=Date.parse('2027-01-08T00:00:00Z')/1000,eph=sliceEphemeris(all,indexOf(all,unix),169)
    const base:SiteRecord=JSON.parse(readFileSync(new URL('sites.json',root),'utf8')).sites.find((s:SiteRecord)=>s.id==='c1')
    const r=ref.actual.find((v:any)=>v.name==='imported-height-c1').reference
    const mixed:SiteRecord={...base,id:'mixed-c1',ground_m:r.groundM,horizons:r.horizons,slope_deg:0,skyline_err_deg:1}
    const trackFor=(s:SiteRecord)=>computeTrack(eph,{lat:s.lat,lon:s.lon,groundM:s.ground_m,observerM:2,horizon:new Horizon(s.horizons['2'])})
    const before=trackFor(base),after=trackFor(mixed)
    expect(after.geometry?.groundM).toBe(r.groundM)
    expect(windowStats(before,0,168).earthHours).toBeGreaterThan(windowStats(after,0,168).earthHours)
    expect(windowStats(before,0,168).sunUpHours).toBeGreaterThan(windowStats(after,0,168).sunUpHours)
    const power={...DEFAULT_POWER,thermal:{...THERMAL_EXAMPLE}},a=missionBudget(eph,before,0,168,power,DEFAULT_RADIO),b=missionBudget(eph,after,0,168,power,DEFAULT_RADIO)
    expect(a.power.energyWh).toBeGreaterThan(b.power.energyWh)
    expect(a.link.bitsPowered).toBeGreaterThan(b.link.bitsPowered)
    expect(a.power.thermal?.minK).not.toBe(b.power.thermal?.minK)
    const result=await searchMissions({eph,candidates:[base,mixed],trackFor,len:168,observerM:2,req:{minDaylightH:1,maxDarkH:1000,minEarthPct:1,maxSlopeDeg:90},power,radio:DEFAULT_RADIO,
      settings:{startUnix:unix,days:1,stepDays:1,minDataGb:0,maxSilenceH:null}},{yieldTask:async()=>{}})
    expect(result.rows).toHaveLength(2)
    expect(result.rows.find(row=>row.option.site.id===mixed.id)?.misses).toEqual(expect.arrayContaining(['daylight after landing','Earth contact']))
  })
})
