import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import raw from '../public/data/relay-reference.json'
import { Ephemeris,Horizon,indexOf } from '../src/lib/astro'
import { DEFAULT_OPERATIONS } from '../src/lib/communications'
import { SiteRecord } from '../src/lib/data'
import { DEFAULT_RADIO,missionBudget } from '../src/lib/link'
import { Track,computeTrack } from '../src/lib/metrics'
import { DEFAULT_POWER } from '../src/lib/power'
import { RelayPlan,validRelay } from '../src/lib/relay'
import { RELAY_REFERENCES,parseReferencePackage,referenceScope } from '../src/lib/relay-reference'
import { DEFAULT_RELAY_RF,fsplDb,requiredEirpPlusGtDb,rfRateBps,validRelayRF } from '../src/lib/relay-rf'
import { relayService } from '../src/lib/relay-service'
import { searchMissions } from '../src/lib/search'
import { DEFAULT_PINS,decodeShare,encodeShare } from '../src/lib/share'
import { DEFAULT_REQ } from '../src/lib/requirements'

const c=RELAY_REFERENCES.find(c=>c.id==='c1-sv1')!
const plan=(patch:Partial<RelayPlan>={}):RelayPlan=>({source:'Reference geometry; RF and allocation are assumptions',bufferGb:5,initialGb:0,maxLossGb:0,passes:c.passes,reference:{id:c.id,reportSha256:c.reportSha256},...patch})
const context=(value=c,height=2,shiftDeg=0)=>({geometry:{lat:value.site.lat,lon:value.site.lon,groundM:value.site.ground_m,observerM:height,horizon:new Horizon(value.horizonCentideg.map(v=>v+shiftDeg*100))}} as Track)
const strong={...DEFAULT_RELAY_RF,relayGtDbK:15,relayEirpDbW:30,groundGtDbK:45}
const buf=readFileSync(new URL('../public/data/ephemeris.f32',import.meta.url)),meta=JSON.parse(readFileSync(new URL('../public/data/ephemeris.json',import.meta.url),'utf8'))
const eph:Ephemeris={startUnix:meta.start_unix,stepS:meta.step_s,count:meta.count,data:new Float32Array(buf.buffer,buf.byteOffset,buf.byteLength/4)}
const sites=JSON.parse(readFileSync(new URL('../public/data/sites.json',import.meta.url),'utf8')).sites as SiteRecord[]
const site=sites.find(s=>s.id==='c1')!
const track=computeTrack(eph,{lat:site.lat,lon:site.lon,groundM:site.ground_m,observerM:2,horizon:new Horizon(site.horizons['2'])})
const system={...DEFAULT_POWER,batteryWh:1e6,areaM2:0}
const radio=(relay:RelayPlan)=>({...DEFAULT_RADIO,relay,operations:{...DEFAULT_OPERATIONS,traffic:{generatedKbps:0,initialGb:.2,bufferGb:1,maxLossGb:0}}})
const budget=(relay:RelayPlan)=>missionBudget(eph,track,indexOf(eph,c.startUnix),168,system,radio(relay))

describe('packaged reference provenance and scope',()=>{
  it('matches retained source reports, fine samples and centred-horizon checks',()=>{
    expect(RELAY_REFERENCES).toHaveLength(2)
    for(const r of RELAY_REFERENCES) {
      const text=readFileSync(new URL(`../../data/validation/relay-geometry-${r.site.id}-sv1.json`,import.meta.url),'utf8')
      const report=JSON.parse(text)
      expect(createHash('sha256').update(text).digest('hex')).toBe(r.reportSha256)
      expect(r.hourly).toEqual(report.hourly)
      expect(r.accessChecks).toEqual(report.access_check_samples)
      expect(r.limbTerrain.sha256).toBe(report.limb_terrain.source.files['ldem_64.img'].sha256)
      expect(r.limbTerrain.frame).toBe('MOON_ME_DE421')
      expect(r.limbTerrain.stepM).toBe(12.5)
      expect(r.limbTerrain.maximumStressMovingFrameCheckErrorM).toBeLessThanOrEqual(1)
      const stressText=readFileSync(new URL('../../data/validation/lunar-limb-checks.json',import.meta.url),'utf8')
      const stress=JSON.parse(stressText)
      expect(r.limbTerrain.validationSha256).toBe(createHash('sha256').update(stressText).digest('hex'))
      expect(r.limbTerrain.maximumStressMovingFrameCheckErrorM).toBe(stress.maximum_moving_frame_error_m)
      expect(stress.spice_spherical_intercept_checks).toHaveLength(160)
      expect(stress.near_limb_rays).toBe(96)
      const h=new Horizon(r.horizonCentideg)
      for(const sample of r.accessChecks)expect(sample.elDeg-h.at(sample.azDeg)).toBeCloseTo(sample.clearanceDeg,5)
      expect(h.at(.25)).toBeCloseTo(r.horizonCentideg[0]/100,6)
      expect(h.at(0)).toBeCloseTo((r.horizonCentideg[719]+r.horizonCentideg[0])/200,6)
    }
  })
  it('rejects mismatched hourly contacts, shifted bins, wrong frames and failed numerical evidence',()=>{
    for(const mutate of [
      (p:typeof raw)=>{p.cases[0].hourly[0].backhaul=!p.cases[0].hourly[0].backhaul},
      (p:typeof raw)=>{p.cases[0].horizonCentideg.push(p.cases[0].horizonCentideg.shift()!)},
      (p:typeof raw)=>{p.cases[0].source.terrainFrame='MOON_PA_DE421'},
      (p:typeof raw)=>{p.cases[0].numerics.maximum30DayPositionDifferenceM=21},
      (p:typeof raw)=>{p.cases[0].limbTerrain.frame='MOON_PA_DE421'},
      (p:typeof raw)=>{p.cases[0].limbTerrain.maximumStressMovingFrameCheckErrorM=2},
      (p:typeof raw)=>{p.cases[0].limbTerrain.sha256='changed'},
      (p:typeof raw)=>{p.cases[0].limbTerrain.stepM=50},
      (p:typeof raw)=>{p.cases[0].limbTerrain.validationSha256='missing'},
    ]) {const p=structuredClone(raw);mutate(p);expect(()=>parseReferencePackage(p)).toThrow()}
  })
  it('blocks other points/heights, uncovered stays, changed assets and missing geometry without borrowing contacts',()=>{
    const p=plan()
    expect(referenceScope(p,context(),c.startUnix,168).issue).toBeNull()
    expect(referenceScope(p,context(),c.startUnix+3600,167).issue).toBeNull()
    for(const [q,t,u] of [[p,context(RELAY_REFERENCES.find(c=>c.site.id==='change6')!),c.startUnix],
      [p,context(c,10),c.startUnix],[p,context(),c.startUnix+3600],
      [plan({reference:{id:c.id,reportSha256:'0'.repeat(64)}}),context(),c.startUnix],
      [p,{} as Track,c.startUnix]] as const) {
      const s=relayService(q,t,u,168,3600,10)
      expect(s.setupPass).toBe(false)
      expect(s.access.every(v=>v===0)).toBe(true)
      expect(s.backhaul.every(v=>v===0)).toBe(true)
    }
  })
  it('removes reference hours under a raised skyline and never invents hours after a lower skyline',()=>{
    const normal=relayService(plan(),context(),c.startUnix,168,3600,10)
    const delta=Math.min(...c.hourly.filter(h=>h.access).map(h=>h.access_clearance_min_deg))-.1+.01
    const raised=relayService(plan(),context(c,2,delta),c.startUnix,168,3600,10)
    const lower=relayService(plan(),context(c,2,-1),c.startUnix,168,3600,10)
    expect(raised.access.filter(v=>v>0).length).toBeLessThan(normal.access.filter(v=>v>0).length)
    expect(raised.access.every((v,j)=>!v||normal.access[j]>0)).toBe(true)
    expect(Array.from(lower.access)).toEqual(Array.from(normal.access))
  })
})

describe('conditional RF ceilings with physical units and coupled power/queues',()=>{
  it('matches Friis/noise power directly in SI, inverse-square laws, margin and the required sum',()=>{
    const distanceKm=20000,f=2250,tx=10,gainTx=10**1.2,gainRx=1000,tempK=500,loss=10**1.4,eb=10**.41,margin=10**.3
    const watts=tx*gainTx*gainRx*(299792458/(4*Math.PI*distanceKm*1000*f*1e6))**2
    const si=watts/(1.380649e-23*tempK*loss*eb*margin)
    const eirp=10*Math.log10(tx*gainTx),gt=10*Math.log10(gainRx/tempK)
    const rate=rfRateBps(eirp,gt,distanceKm,f,14,4.1,3)
    expect(rate).toBeCloseTo(si,7)
    expect(rfRateBps(eirp,gt,distanceKm*2,f,14,4.1,3)).toBeCloseTo(rate/4,7)
    expect(rfRateBps(eirp,gt,distanceKm,f*2,14,4.1,3)).toBeCloseTo(rate/4,7)
    expect(rfRateBps(eirp,gt,distanceKm,f,14,4.1,6)).toBeCloseTo(rate/10**.3,7)
    expect(requiredEirpPlusGtDb(rate,distanceKm,f,14,4.1,3)).toBeCloseTo(eirp+gt,11)
    expect(fsplDb(1,1000)).toBeCloseTo(92.447783,5)
  })
  it('credits no service for unknown RF inputs but keeps planned transmitter DC reserved',()=>{
    const assumed=budget(plan()),unknown=budget(plan({rf:{...DEFAULT_RELAY_RF}}))
    expect(unknown.returnedBits).toBe(0)
    expect(unknown.dataLossPass).toBe(true)
    expect(unknown.relaySetupPass).toBe(false)
    expect(unknown.dataPass).toBe(false)
    expect(Array.from(unknown.power.load)).toEqual(Array.from(assumed.power.load))
    expect(unknown.relayService!.requirements.accessGtDbK).not.toBeNull()
    expect(unknown.relayService!.requirements.backhaulEirpPlusGtDb).not.toBeNull()
  })
  it('changes Earth return and buffering with weaker RF without saving transmitter energy',()=>{
    const high=budget(plan({rf:strong})),low=budget(plan({rf:{...strong,relayGtDbK:-60}}))
    expect(high.relaySetupPass&&low.relaySetupPass).toBe(true)
    expect(high.returnedBits).toBeCloseTo(.2*8e9,3)
    expect(low.returnedBits).toBeLessThan(high.returnedBits/1000)
    expect(low.relay!.lander.pendingBits).toBeGreaterThan(0)
    expect(Array.from(low.power.load)).toEqual(Array.from(high.power.load))
    expect(low.relay!.deliveredBits+low.relay!.relayPendingBits+low.relay!.lander.pendingBits+low.totalLostBits).toBeCloseTo(.2*8e9,3)
  })
  it('keeps a known backhaul independent of missing access RF, counting only declared initial relay data',()=>{
    const b=budget(plan({initialGb:.2,rf:{...strong,relayGtDbK:null}}))
    expect(b.relaySetupPass).toBe(false)
    expect(b.relay!.lander.deliveredBits).toBe(0)
    expect(b.relay!.lander.pendingBits).toBe(.2*8e9)
    expect(b.returnedBits).toBeCloseTo(.2*8e9,3)
    expect(b.relay!.relayPendingBits).toBe(0)
    const noRange=relayService(plan({reference:undefined,rf:strong}),context(),c.startUnix,168,3600,10)
    expect(noRange.setupPass).toBe(false)
    expect(noRange.access.every(v=>v===0)&&noRange.backhaul.every(v=>v===0)).toBe(true)
  })
  it('retains RF inputs/reference identity in URLs and rejects invalid optional model fields',()=>{
    const p=plan({rf:strong})
    const q=encodeShare({site:'c1',date:c.startUnix,days:7,req:DEFAULT_REQ,h:2,ec:0,cmp:DEFAULT_PINS,pw:DEFAULT_POWER,rd:radio(p)})
    expect(decodeShare(q.toString()).rd?.relay).toEqual(p)
    expect(validRelay({...p,reference:{id:c.id,reportSha256:'bad'}})).toBe(false)
    expect(validRelay({...p,rf:{...strong,accessMHz:-1}})).toBe(false)
    expect(validRelayRF({...strong,groundGtDbK:NaN})).toBe(false)
    expect(budget(plan({reference:{id:c.id,reportSha256:'0'.repeat(64)},rf:strong})).returnedBits).toBe(0)
  })
  it('rejects missing RF setup in search and does not mistake it for discarded payload',async()=>{
    const result=await searchMissions({eph,trackFor:()=>track,len:168,observerM:2,req:{minDaylightH:0,maxDarkH:168,minEarthPct:0,maxSlopeDeg:90},power:system,radio:radio(plan({rf:{...DEFAULT_RELAY_RF}})),
      candidates:[site],settings:{startUnix:c.startUnix,days:1,stepDays:1,minDataGb:0,maxSilenceH:null}},{yieldTask:async()=>{}})
    expect(result.passing).toHaveLength(0)
    expect(result.rows[0].misses).toContain('relay reference / RF inputs')
    expect(result.rows[0].misses).not.toContain('lander or relay data loss')
  })
})
