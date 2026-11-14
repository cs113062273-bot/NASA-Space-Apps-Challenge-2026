import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { AU_KM,Ephemeris,Horizon,indexOf } from '../src/lib/astro'
import { DEFAULT_OPERATIONS,DEFAULT_TRAFFIC,TrafficModel } from '../src/lib/communications'
import { DEFAULT_RADIO,missionBudget,radioDcW } from '../src/lib/link'
import { DEFAULT_POWER } from '../src/lib/power'
import { Track,computeTrack } from '../src/lib/metrics'
import { RelayPlan,exampleRelayPlan,parseRelayCsv,relayCsv,relayDelivery,relayRate,validRelay } from '../src/lib/relay'
import { DEFAULT_PINS,decodeShare,encodeShare } from '../src/lib/share'
import { DEFAULT_REQ } from '../src/lib/requirements'
import { createLandingEvaluator } from '../src/lib/decision'
import { searchMissions } from '../src/lib/search'
import { SiteRecord } from '../src/lib/data'

const start=Date.parse('2027-01-01T00:00:00Z')/1000
const plan=(patch:Partial<RelayPlan>={}):RelayPlan=>({...exampleRelayPlan(start),...patch})
const bitsGb=(bits:number)=>bits/8e9
const traffic=(patch:Partial<TrafficModel>={}):TrafficModel=>({generatedKbps:0,initialGb:0,bufferGb:bitsGb(100),maxLossGb:0,...patch})
const f=(a:number[])=>Float32Array.from(a)

describe('two-queue hourly store-and-forward conservation and timing',()=>{
  it('delivers only after a later backhaul contact and continues after lander power fails',()=>{
    const r=relayDelivery(plan({bufferGb:bitsGb(10),initialGb:0}),traffic({initialGb:bitsGb(2)}),f([2,0,0]),f([0,0,2]),f([1,0,0]),1)
    expect(Array.from(r.received)).toEqual([2,0,0])
    expect(Array.from(r.delivered)).toEqual([0,0,2])
    expect(r.deliveredBits).toBe(2)
    expect(r.relayPendingBits).toBe(0)
    expect(r.lander.deliveredBits).toBe(2)
  })
  it('never forwards same-bin arrivals even when both service legs overlap',()=>{
    const r=relayDelivery(plan({bufferGb:bitsGb(10),initialGb:0}),traffic({initialGb:bitsGb(4)}),f([2,2,2]),f([2,2,2]),f([1,1,1]),1)
    expect(Array.from(r.delivered)).toEqual([0,2,2])
    expect(Array.from(r.buffer)).toEqual([2,2,0])
    expect(r.relayBufferNeededBits).toBe(2)
    const short=relayDelivery(plan({bufferGb:bitsGb(10),initialGb:0}),traffic({initialGb:bitsGb(4)}),f([2]),f([2]),f([1]),1)
    expect(short.deliveredBits).toBe(0)
    expect(short.relayPendingBits).toBe(2)
    expect(short.lander.pendingBits).toBe(2)
  })
  it('accounts separately for initial overflow and relay drop-tail losses',()=>{
    const r=relayDelivery(plan({bufferGb:bitsGb(2),initialGb:bitsGb(1)}),traffic({initialGb:bitsGb(10),bufferGb:bitsGb(4)}),f([4,0]),f([0,2]),f([1,0]),1)
    expect(r.lander.lostBits).toBe(6)
    expect(r.relayLostBits).toBe(3)
    expect(r.deliveredBits).toBe(2)
    expect(r.firstRelayOverflowH).toBe(1/3600)
    expect(r.relayInitialBits+r.lander.initialBits+r.lander.producedBits).toBeCloseTo(r.deliveredBits+r.relayPendingBits+r.lander.pendingBits+r.relayLostBits+r.lander.lostBits,10)
  })
  it('respects partial-hour acquisition/access power while backhaul uses its own service resource',()=>{
    const r=relayDelivery(plan({bufferGb:bitsGb(100),initialGb:0}),traffic({generatedKbps:0.001}),f([0.5,0]),f([2,2]),f([0.5,0]),10)
    expect(r.lander.producedBits).toBe(5)
    expect(r.lander.missedProductionBits).toBe(15)
    expect(r.lander.pendingBits).toBe(2.5)
    expect(Array.from(r.delivered)).toEqual([0,2.5])
    expect(r.earthActiveFrac[1]).toBe(0.125)
  })
  it('conserves mission data and never exceeds either queue across independent random contacts',()=>{
    let seed=37
    const rand=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32)
    for(let k=0;k<100;k++){
      const p=plan({bufferGb:bitsGb(rand()*20),initialGb:bitsGb(rand()*20)})
      const t=traffic({initialGb:bitsGb(rand()*20),bufferGb:bitsGb(rand()*20),generatedKbps:rand()/1000})
      const a=f(Array.from({length:20},()=>rand()*2)),b=f(Array.from({length:20},()=>rand()*2)),power=f(Array.from({length:20},()=>rand()))
      const r=relayDelivery(p,t,a,b,power,10)
      const input=r.relayInitialBits+r.lander.initialBits+r.lander.producedBits
      const output=r.deliveredBits+r.relayPendingBits+r.lander.pendingBits+r.relayLostBits+r.lander.lostBits
      expect(Math.abs(input-output)).toBeLessThan(1e-9)
      expect(r.buffer.every(v=>v>=0&&v<=p.bufferGb*8e9+1e-10)).toBe(true)
      expect(r.lander.buffer.every(v=>v>=0&&v<=t.bufferGb*8e9+1e-10)).toBe(true)
      expect(r.deliveredBits).toBeLessThanOrEqual(r.relayInitialBits+r.lander.deliveredBits+1e-10)
    }
  })
})

describe('absolute service-plan import, overlap and portability',()=>{
  it('uses the largest overlapping grant without multiplying service, with exclusive ends',()=>{
    const p=plan({passes:[{startUnix:start,endUnix:start+3600,leg:'access',kbps:2},{startUnix:start,endUnix:start+7200,leg:'access',kbps:3},{startUnix:start,endUnix:start+3600,leg:'backhaul',kbps:8}]})
    expect(relayRate(p,'access',start)).toBe(3000)
    expect(relayRate(p,'access',start+3600)).toBe(3000)
    expect(relayRate(p,'access',start+7200)).toBe(0)
    expect(relayRate(p,'backhaul',start)).toBe(8000)
    expect(parseRelayCsv(relayCsv(p))).toEqual(p.passes)
    expect(validRelay(p)).toBe(true)
  })
  it('rejects ambiguous timestamps, normalized invalid dates, negative rates, reversed contacts and excessive rows',()=>{
    const head='start_utc,end_utc,leg,rate_kbps\n'
    for(const row of ['2027-01-01T00:30Z,2027-01-01T01:00Z,access,1','2027-01-01T00:00,2027-01-01T01:00Z,access,1',
      '2027-02-30T00:00Z,2027-03-03T01:00Z,access,1','2027-01-01T02:00Z,2027-01-01T01:00Z,access,1',
      '2027-01-01T00:00Z,2027-01-01T01:00Z,access,-1','2027-01-01T00:00Z,2027-01-01T01:00Z,unknown,1'])expect(()=>parseRelayCsv(head+row)).toThrow()
    expect(()=>parseRelayCsv(head+Array(65).fill('2027-01-01T00:00Z,2027-01-01T01:00Z,access,1').join('\n'))).toThrow()
    expect(()=>parseRelayCsv('wrong\n')).toThrow('Use start_utc')
  })
  it('round-trips every plan value and rejects invalid relay state without inventing availability',()=>{
    const p=plan({bufferGb:3,initialGb:1,maxLossGb:0.2})
    const query=encodeShare({site:'c1',date:start,days:7,req:DEFAULT_REQ,h:2,ec:0,cmp:DEFAULT_PINS,pw:DEFAULT_POWER,rd:{...DEFAULT_RADIO,relay:p}})
    expect(decodeShare(query.toString()).rd?.relay).toEqual(p)
    expect(decodeShare('?relay=%7Bbroken').rd?.relay).toBeUndefined()
    expect(decodeShare('?relay='+encodeURIComponent(JSON.stringify({...p,bufferGb:-1}))).rd?.relay).toBeUndefined()
  })
})

describe('relay route coupled to selected lander power and mission screens',()=>{
  const n=5
  const e:Ephemeris={startUnix:start,stepS:3600,count:n,data:Float32Array.from({length:n*6},(_,k)=>k%6===0?AU_KM:k%6===3?384400:0)}
  const track={sunFrac:new Float32Array(n),sunAz:new Float32Array(n),sunEl:new Float32Array(n),earthClear:new Float32Array(n).fill(-5),earthMinClear:0} as Track
  const p=plan({passes:[{startUnix:start,endUnix:start+3600,leg:'access',kbps:1},{startUnix:start+7200,endUnix:start+10800,leg:'backhaul',kbps:1}],bufferGb:1,initialGb:0})
  it('reserves DC only for access, applies the modem cap, and counts actual Earth arrival after lander depletion',()=>{
    const r={...DEFAULT_RADIO,maxKbps:0.5,relay:p,operations:{stationMask:7,schedule:'all' as const,dailyStartHour:0,dailyHours:24,windows:[],traffic:{...DEFAULT_TRAFFIC,generatedKbps:0,initialGb:0.001,bufferGb:1}}}
    const b=missionBudget(e,track,0,n,{...DEFAULT_POWER,batteryWh:200},r)
    expect(b.directLink.contactH).toBe(0)
    expect(b.power.load[0]).toBeCloseTo(DEFAULT_POWER.loadW+radioDcW(r),4)
    expect(b.power.load[1]).toBe(DEFAULT_POWER.loadW)
    expect(b.power.metFrac[2]).toBe(0)
    expect(b.link.rate[0]).toBe(500)
    expect(b.relay!.received[0]).toBe(500*3600)
    expect(b.relay!.delivered[2]).toBe(500*3600)
    expect(b.returnedBits).toBe(500*3600)
    expect(b.link.longestPoweredGapH).toBe(2.5)
  })
  it('rejects relay overflow in general search and leaves the direct Earth-view rule intact',async()=>{
    const raw=readFileSync(new URL('../public/data/ephemeris.f32',import.meta.url)),meta=JSON.parse(readFileSync(new URL('../public/data/ephemeris.json',import.meta.url),'utf8'))
    const eph:Ephemeris={startUnix:meta.start_unix,stepS:meta.step_s,count:meta.count,data:new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4)}
    const sites=JSON.parse(readFileSync(new URL('../public/data/sites.json',import.meta.url),'utf8')).sites as SiteRecord[]
    const s=sites.find(s=>s.id==='a3-degerlache-2')!
    const t=computeTrack(eph,{lat:s.lat,lon:s.lon,groundM:s.ground_m,observerM:2,horizon:new Horizon(s.horizons['2'])})
    const unix=Date.parse('2027-01-18T00:00:00Z')/1000
    const relay=plan({bufferGb:0,initialGb:0,passes:[{startUnix:unix,endUnix:unix+150*3600,leg:'access',kbps:512}]})
    const input={eph,trackFor:()=>t,len:150,observerM:2,req:DEFAULT_REQ,power:DEFAULT_POWER,radio:{...DEFAULT_RADIO,relay}}
    const o=createLandingEvaluator(input).evaluate(s,unix)!
    expect(o.powerPass&&o.rulesPass).toBe(true)
    expect(o.dataPass).toBe(false)
    expect(o.misses).toContain('lander or relay data loss')
    const search=await searchMissions({...input,candidates:[s],settings:{startUnix:unix,days:2,stepDays:1,minDataGb:0,maxSilenceH:null}},{yieldTask:async()=>{}})
    expect(search.passing).toHaveLength(0)
    const direct=missionBudget(eph,t,indexOf(eph,unix),150,DEFAULT_POWER,{...DEFAULT_RADIO,relay:{...relay,bufferGb:100,maxLossGb:100}})
    expect(direct.returnedBits).toBe(0)
    expect(direct.relay!.lander.deliveredBits).toBeGreaterThan(0)
    const far=sites.find(s=>s.id==='change6')!
    const farTrack=computeTrack(eph,{lat:far.lat,lon:far.lon,groundM:far.ground_m,observerM:2,horizon:new Horizon(far.horizons['2'])})
    const farInput={...input,trackFor:()=>farTrack,power:{...DEFAULT_POWER,batteryWh:1e8},
      radio:{...DEFAULT_RADIO,relay:{...relay,bufferGb:100}},req:{minDaylightH:0,maxDarkH:150,minEarthPct:40,maxSlopeDeg:90}}
    const farOption=createLandingEvaluator(farInput).evaluate(far,unix)!
    expect(farOption.stats.earthHours).toBe(0)
    expect(farOption.powerPass&&farOption.dataPass).toBe(true)
    expect(farOption.rulesPass).toBe(false)
    expect(createLandingEvaluator({...farInput,req:{...farInput.req,minEarthPct:0}}).evaluate(far,unix)!.clearsScreen).toBe(true)
  })
})

describe('reference-orbit geometry products through the same two-hop engine',()=>{
  it('checks retained CSV provenance and distinguishes access from Earth arrival at real C1 and far-side points',()=>{
    const raw=readFileSync(new URL('../public/data/ephemeris.f32',import.meta.url)),meta=JSON.parse(readFileSync(new URL('../public/data/ephemeris.json',import.meta.url),'utf8'))
    const eph:Ephemeris={startUnix:meta.start_unix,stepS:meta.step_s,count:meta.count,data:new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4)}
    const sites=JSON.parse(readFileSync(new URL('../public/data/sites.json',import.meta.url),'utf8')).sites as SiteRecord[]
    const unix=Date.parse('2027-03-01T00:00:00Z')/1000
    for(const id of ['c1','change6']) {
      const file=`relay-geometry-${id}-sv1`
      const csv=readFileSync(new URL(`../../data/validation/${file}.csv`,import.meta.url),'utf8')
      const provenance=JSON.parse(readFileSync(new URL(`../../data/validation/${file}.json`,import.meta.url),'utf8'))
      expect(createHash('sha256').update(csv).digest('hex')).toBe(provenance.csv.sha256)
      const passes=parseRelayCsv(csv)
      expect(passes).toEqual(provenance.passes)
      expect(provenance.cadence_utc_s).toBe(15)
      const site=sites.find(s=>s.id===id)!
      const t=computeTrack(eph,{lat:site.lat,lon:site.lon,groundM:site.ground_m,observerM:2,horizon:new Horizon(site.horizons['2'])})
      const relay=plan({source:'Research reference geometry; rates, RF and allocation remain assumptions',passes})
      const b=missionBudget(eph,t,indexOf(eph,unix),168,{...DEFAULT_POWER,batteryWh:1e6,areaM2:0},
        {...DEFAULT_RADIO,relay,operations:{...DEFAULT_OPERATIONS,traffic:{generatedKbps:0,initialGb:.2,bufferGb:1,maxLossGb:0}}})
      expect(b.returnedBits).toBeCloseTo(.2*8e9,4)
      expect(b.relay!.lander.pendingBits).toBe(0)
      expect(b.relay!.relayPendingBits).toBe(0)
      expect(b.totalLostBits).toBe(0)
      const firstUpload=b.relay!.received.findIndex(v=>v>0),firstEarth=b.relay!.delivered.findIndex(v=>v>0)
      expect(firstEarth).toBeGreaterThan(firstUpload)
      if(id==='c1') {expect(firstUpload).toBe(2);expect(firstEarth).toBe(5)}
      if(id==='change6') expect(b.directLink.contactH).toBe(0)
      expect(b.dataPass).toBe(true)
    }
  })
})
