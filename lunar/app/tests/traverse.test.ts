import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {describe,it,expect} from 'vitest'
import {Ephemeris,stationAtVector,siteFrame,bodyAtVector} from '../src/lib/astro'
import {toXY,toLatLon} from '../src/lib/data'
import {DEFAULT_POWER} from '../src/lib/power'
import {DEFAULT_RADIO} from '../src/lib/link'
import {DEFAULT_OPERATIONS,DEFAULT_TRAFFIC} from '../src/lib/communications'
import {THERMAL_EXAMPLE} from '../src/lib/thermal'
import {FoundRoute,DEFAULT_TRAVERSE,TraverseInputs,simulateTraverse,routePose} from '../src/lib/traverse'
import {intervalEphemeris} from '../src/lib/moving-ephemeris'
import {movingSky,MissingWideTerrain} from '../src/lib/moving-sky'
import {findTraverseDeparture} from '../src/lib/traverse-evaluation'
import {DEFAULT_MOBILITY,SOILS,solveMobility} from '../src/lib/mobility'

const root=new URL('../public/data/',import.meta.url),read=(name:string)=>readFileSync(new URL(name,root)),meta=JSON.parse(read('ephemeris.json').toString('utf8')),body=read('ephemeris.f32'),stations=read('stations.f32'),sm=JSON.parse(read('stations.json').toString('utf8'))
const native:Ephemeris={startUnix:meta.start_unix,stepS:meta.step_s,count:meta.count,data:new Float32Array(body.buffer,body.byteOffset,body.length/4),stations:{data:new Float32Array(stations.buffer,stations.byteOffset,stations.length/4),orientation:sm.earth_orientation}}
const startUnix=Date.parse('2027-01-08T00:00:00Z')/1000
const synthetic:Ephemeris={startUnix:startUnix-3600,stepS:3600,count:100,data:Float32Array.from({length:600},(_,k)=>[1e8,0,-1e7,380000,0,-40000][k%6])}
function route(length=100):FoundRoute {
  const [x,y]=toXY(-89.4398,222.83),n=Math.max(1,Math.ceil(length/10)),nodes=Array.from({length:n+1},(_,i)=>{const distanceM=length*i/n,xx=x+distanceM,[lat,lon]=toLatLon(xx,y);return {index:i,x:xx,y,lat,lon,heightM:0,heightRmsM:0,nodeClearanceM:100,nominalGradeDeg:i?0:null,stressedGradeDeg:i?0:null,distanceM}})
  return {status:'found',issue:null,expanded:n+1,start:null,goal:null,nodes,mapLengthM:length,ascentM:0,descentM:0,cost:length,maxNominalGradeDeg:0,maxStressedGradeDeg:0}
}
const noRadio={...DEFAULT_RADIO,operations:{...DEFAULT_OPERATIONS,stationMask:0}}
const input=(patch:Partial<TraverseInputs>={}):TraverseInputs=>({startUnix,observerM:2,earthMinClear:0,requireDsn:false,power:{...DEFAULT_POWER,areaM2:0,loadW:100,batteryWh:100},radio:noRadio,settings:{...DEFAULT_TRAVERSE,goalHoldH:0,reservePct:0},...patch})
const flat=()=>({groundM:0,horizon:{at:()=>0}})

describe('moving sightlines on the same independently checked local/wide surfaces',()=>{
  const ref=JSON.parse(readFileSync(new URL('./fixtures/local-sky.json',import.meta.url),'utf8'))
  for(const c of [...ref.synthetic.filter((c:any)=>c.name!=='unknown-background'),...ref.poles])it(`matches independent 3D directional heights: ${c.name}`,()=>{
    const local={...c.local,height:Float32Array.from(c.local.height.flat(),(v:number|null)=>v===null?NaN:v),heightRms:Float32Array.from(c.local.heightRms.flat(),(v:number|null)=>v===null?NaN:v)},grid=(v:any)=>({...v,data:Int16Array.from(v.data.flat())})
    const env=movingSky(local,grid(c.near),grid(c.far),c.globe===null?undefined:()=>c.globe)
    for(const height of [2,10])for(let j=0;j<36;j++)expect(Math.round(env.point(c.lat,c.lon,height).horizon.at((j+.5)*10)*100)).toBe(c.reference.horizons[String(height)][j])
  })
  it('rejects a directional gap rather than accepting a partial ray',()=>{
    const c=ref.synthetic.find((c:any)=>c.name==='unknown-background'),local={...c.local,height:Float32Array.from(c.local.height.flat()),heightRms:Float32Array.from(c.local.heightRms.flat())},grid=(v:any)=>({...v,data:Int16Array.from(v.data.flat())})
    expect(()=>movingSky(local,grid(c.near),grid(c.far)).point(c.lat,c.lon,2).horizon.at(25)).toThrow(MissingWideTerrain)
  })
})

describe('sub-hour geometry interpolation with independent complete SPICE vectors',()=>{
  const ref=JSON.parse(readFileSync(new URL('./fixtures/moving-ephemeris.json',import.meta.url),'utf8'))
  it('pins source/kernel/generator files and matches independent SciPy cubic values',()=>{
    for(const [name,hash] of Object.entries(ref.sourceSha256)) {
      const bytes=readFileSync(new URL('../../'+name,import.meta.url))
      const canonical=name.endsWith('.json') ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n')) : bytes
      expect(createHash('sha256').update(canonical).digest('hex')).toBe(hash)
    }
    expect(createHash('sha256').update(readFileSync(new URL('../../pipeline/build_moving_ephemeris_reference.py',import.meta.url))).digest('hex')).toBe(ref.generatorSha256)
    let maxGround=0,maxAim=0,maxBody=0
    const angle=(a:number[],b:number[])=>{const cross=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];return Math.atan2(Math.hypot(...cross),a.reduce((v,q,i)=>v+q*b[i],0))*180/Math.PI}
    for(const c of ref.samples){
      const result=intervalEphemeris(native,c.unix,10)
      for(let k=0;k<27;k++)expect(Math.abs(result.stations!.data[k]-c.interpolated[k])).toBeLessThanOrEqual(Math.max(1,Math.abs(c.interpolated[k]))*2**-22)
      for(let k=0;k<6;k++)expect(Math.abs(result.data[k]-c.bodyInterpolated[k])).toBeLessThanOrEqual(Math.max(1,Math.abs(c.bodyInterpolated[k]))*2**-22)
      for(const [lat,lon] of [[-89.4398,222.83],[0,0],[45,90]]){
        const frame=siteFrame(lat,lon)
        for(let j=0;j<3;j++){
          const value=stationAtVector(frame,result.stations!.data,j*9),truth=stationAtVector(frame,c.stationVectors,j*9)
          maxGround=Math.max(maxGround,Math.abs(value.receiverEl-truth.receiverEl))
          maxAim=Math.max(maxAim,angle(Array.from(result.stations!.data.slice(j*9,j*9+3)),c.stationVectors.slice(j*9,j*9+3)))
        }
        for(let j=0;j<2;j++)maxBody=Math.max(maxBody,angle(Array.from(result.data.slice(j*3,j*3+3)),c.bodyVectors.slice(j*3,j*3+3)))
      }
    }
    expect(maxGround).toBeLessThan(.01);expect(maxAim).toBeLessThan(.0002);expect(maxBody).toBeLessThan(.0001)
  })
  it('does not extrapolate or retain a non-unit receiver zenith',()=>{
    expect(()=>intervalEphemeris(native,native.startUnix-1,30)).toThrow(/outside/)
    expect(()=>intervalEphemeris(native,native.startUnix+(native.count-1)*native.stepS,30)).toThrow(/outside/)
    const r=intervalEphemeris(native,startUnix+1234,60)
    for(let j=0;j<3;j++)expect(Math.hypot(...r.stations!.data.slice(j*9+6,j*9+9))).toBeCloseTo(1,7)
  })
})

describe('causal traverse energy, thermal, service and state carry',()=>{
  it('replaces the manual drive watts with wheel demand in the shared battery integration',()=>{
    const p=input({power:{...DEFAULT_POWER,areaM2:0,loadW:0,batteryWh:100},settings:{...DEFAULT_TRAVERSE,goalHoldH:0,reservePct:0,mobility:DEFAULT_MOBILITY}})
    const r=simulateTraverse(synthetic,route(),10,p,flat),dc=solveMobility(DEFAULT_MOBILITY,0,p.settings.speedMps).driveDcW!
    expect(r.arrived).toBe(true);expect(r.mobility?.edgesChecked).toBe(10)
    expect(r.driveWh).toBeCloseTo(dc*100/.01/3600,7);expect(r.endStoredWh).toBeCloseTo(100-r.driveWh,6)
  })
  it('halts at the first rejected soil edge and keeps later service at that location',()=>{
    const path=route(30);path.nodes[2].heightM=10*Math.tan(10*Math.PI/180);path.nodes[3].heightM=path.nodes[2].heightM
    const p=input({power:{...DEFAULT_POWER,areaM2:0,loadW:0,batteryWh:100},settings:{...DEFAULT_TRAVERSE,goalHoldH:0,reservePct:0,mobility:{...DEFAULT_MOBILITY,soil:SOILS[1].soil}}})
    const r=simulateTraverse(synthetic,path,10,p,flat)
    expect(r.arrived).toBe(false);expect(r.finalDistanceM).toBeCloseTo(10,7);expect(r.mobility?.firstFailure?.edgeIndex).toBe(2)
    expect(r.haltReason).toContain('no bracketed drawbar solution');expect(r.misses).toContain('wheel/soil screen')
    expect(r.samples.filter(s=>s.phase==='halted').every(s=>Math.abs(s.mapDistanceM-10)<1e-7&&s.driveW===0)).toBe(true)
  })
  it('stops a failed drive at its powered distance and never credits a fictitious destination',()=>{
    const r=simulateTraverse(synthetic,route(),10,input(),flat)
    expect(r.arrived).toBe(false);expect(r.pass).toBe(false);expect(r.firstPowerH).toBeCloseTo(100/180,7)
    expect(r.finalDistanceM).toBeCloseTo(.01*3600*100/180,6)
    expect(r.deliveredDriveWh).toBeCloseTo(80*100/180,5)
    expect(r.samples.filter(s=>s.phase==='halted').every(s=>Math.abs(s.mapDistanceM-r.finalDistanceM)<1e-7&&s.driveW===0)).toBe(true)
  })
  it('carries battery through the departure wait instead of granting a fresh charge',()=>{
    const r=simulateTraverse(synthetic,route(),10,input({settings:{...DEFAULT_TRAVERSE,departureDelayH:1,goalHoldH:0,reservePct:0}}),flat)
    expect(r.finalDistanceM).toBeCloseTo(0,7);expect(r.firstPowerH).toBeCloseTo(1,7);expect(r.arrived).toBe(false)
  })
  it('closes energy accounting and preserves a successful arrival across sampling refinement',()=>{
    const p=input({power:{...DEFAULT_POWER,areaM2:0,loadW:100,batteryWh:10000},settings:{...DEFAULT_TRAVERSE,speedMps:.1,departureDelayH:.25,goalHoldH:.5,reservePct:50}})
    const a=simulateTraverse(synthetic,route(),10,p,flat),b=simulateTraverse(synthetic,route(),10,p,flat,0,true)
    const expectedWh=100*(.25+100/.1/3600+.5)+80*100/.1/3600
    expect(a.pass).toBe(true);expect(b.pass).toBe(true);expect(a.endStoredWh).toBeCloseTo(10000-expectedWh,6);expect(b.endStoredWh).toBeCloseTo(a.endStoredWh,6)
    expect(a.arrivalUnix).toBeCloseTo(startUnix+.25*3600+100/.1,5)
    expect(a.maxTravelPerStepM).toBeLessThanOrEqual(5+1e-7);expect(b.maxTravelPerStepM).toBeLessThanOrEqual(2.5+1e-7)
  })
  it('distinguishes electrical drive demand from heat dissipated inside the equipment node',()=>{
    const th={...THERMAL_EXAMPLE,initialK:300,minK:3,maxK:1000,setpointK:3,heatCapacityJPerK:1000,solarAbsorptivity:0,emissivity:0,conductanceWPerK:0,wasteHeatFraction:1,maxHeaterW:0}
    const p=input({power:{...DEFAULT_POWER,areaM2:0,loadW:0,batteryWh:1000,thermal:th},settings:{...DEFAULT_TRAVERSE,speedMps:1,driveW:100,goalHoldH:0,reservePct:0}})
    const a=simulateTraverse(synthetic,route(),10,p,flat),b=simulateTraverse(synthetic,route(),10,{...p,settings:{...p.settings,driveBusHeatFraction:1}},flat)
    expect(a.endStoredWh).toBeCloseTo(b.endStoredWh,8);expect(a.maxK).toBeCloseTo(300,4);expect(b.maxK).toBeCloseTo(310,3)
    const failed=simulateTraverse(synthetic,route(),10,{...p,power:{...p.power,thermal:{...th,maxK:305}},settings:{...p.settings,driveBusHeatFraction:1}},flat)
    expect(failed.arrived).toBe(false);expect(failed.finalDistanceM).toBeCloseTo(50,1);expect(failed.haltReason).toBe('equipment temperature')
  })
  it('uses geographic route heading rather than the polar map Y axis',()=>{
    const p=routePose(route().nodes,50)
    expect(p.headingDeg).toBeCloseTo((90-p.lon+360)%360,3)
  })
  it('keeps relay access quarantined until the next source UTC hour and conserves both queues',()=>{
    const r=input({power:{...DEFAULT_POWER,areaM2:0,loadW:0,batteryWh:10000},settings:{...DEFAULT_TRAVERSE,goalHoldH:2,reservePct:0,allowAssumedRelay:true},radio:{...DEFAULT_RADIO,operations:{...DEFAULT_OPERATIONS,traffic:{...DEFAULT_TRAFFIC,generatedKbps:32,initialGb:0,bufferGb:1}},relay:{source:'Assumed test grants',bufferGb:1,initialGb:0,maxLossGb:0,passes:[{startUnix,endUnix:startUnix+3*3600,leg:'access',kbps:1000},{startUnix,endUnix:startUnix+3*3600,leg:'backhaul',kbps:1000}]}}})
    const result=simulateTraverse(synthetic,route(0),10,r,flat)
    expect(result.samples.filter(s=>s.unix<startUnix+3600).every(s=>s.returnedBits===0)).toBe(true)
    expect(result.returnedBits).toBeCloseTo(32e3*3600,1)
    expect(result.producedBits).toBeCloseTo(result.returnedBits+result.lostBits+result.landerPendingBits+result.relayPendingBits,1)
    expect(()=>simulateTraverse(synthetic,route(0),10,{...r,settings:{...r.settings,allowAssumedRelay:false}},flat)).toThrow(/Explicitly allow/)
  })
  it('finds a charging wait before a shadowed traverse without resetting initial energy',async()=>{
    const path=route(200),frame=siteFrame(path.nodes[0].lat,path.nodes[0].lon),sun=frame.u.map((v,i)=>149597870.7*(v*.5+frame.n[i]*Math.sqrt(.75))),earth=sun.map(v=>-v*380000/149597870.7)
    const eph={...synthetic,data:Float32Array.from({length:synthetic.count*6},(_,k)=>[...sun,...earth][k%6])},x=path.nodes[0].x
    const factory=()=>({environment:(lat:number,lon:number,_h:number,shift:number)=>({groundM:0,horizon:{at:()=>toXY(lat,lon)[0]>x+20+1e-7?90+shift:shift}})})
    const p=input({power:{...DEFAULT_POWER,loadW:100,batteryWh:1000,storage:{maxDod:1,initialSoc:.05,chargeEfficiency:1,dischargeEfficiency:1,maxChargeW:null,maxDischargeW:null,darkHeaterW:0,arrayFactor:1}},settings:{...DEFAULT_TRAVERSE,goalHoldH:0,reservePct:0,searchMaxDelayH:4}})
    const found=await findTraverseDeparture(eph,path,10,p,factory,{yieldTask:async()=>{}})
    expect(found.found?.input.settings.departureDelayH).toBe(2)
    expect(found.attempts.map(a=>a.status)).toEqual(['fail','fail','pass'])
    expect(found.attempts.slice(0,2).every(a=>!a.refined)).toBe(true)
    expect(found.found?.evaluation.refinedRaised?.arrived).toBe(true)
  })
  it('cannot turn invalid numeric settings or point-bound relay geometry into a passing drive',()=>{
    expect(()=>simulateTraverse(synthetic,route(),10,input({power:{...DEFAULT_POWER,loadW:NaN}}),flat)).toThrow(/Invalid moving/)
    expect(()=>simulateTraverse(synthetic,route(),10,input({settings:{...DEFAULT_TRAVERSE,speedMps:NaN}}),flat)).toThrow(/Invalid traverse/)
    const p=input();p.radio={...p.radio,relay:{source:'unmatched',bufferGb:1,initialGb:0,maxLossGb:0,passes:[],reference:{id:'unknown',reportSha256:'a'.repeat(64)}}}
    expect(()=>simulateTraverse(synthetic,route(),10,p,flat)).toThrow(/Point-bound/)
  })
  it('does not repeat initial payload loss and preserves production/return conservation after a power halt',()=>{
    const traffic={...DEFAULT_TRAFFIC,generatedKbps:32,initialGb:.5,bufferGb:.1,maxLossGb:0}
    const r=simulateTraverse(synthetic,route(0),10,input({power:{...DEFAULT_POWER,areaM2:0,loadW:100,batteryWh:10},settings:{...DEFAULT_TRAVERSE,goalHoldH:2,reservePct:0},radio:{...DEFAULT_RADIO,operations:{...DEFAULT_OPERATIONS,traffic}}}),flat)
    expect(r.landerLostBits).toBeCloseTo((.5-.1)*8e9,1)
    expect(traffic.initialGb*8e9+r.producedBits).toBeCloseTo(r.returnedBits+r.lostBits+r.landerPendingBits,1)
    expect(r.missedProductionBits).toBeGreaterThan(0)
  })
  it('clamps an overfilled initial relay once and carries its remaining ready queue',()=>{
    const r=simulateTraverse(synthetic,route(0),10,input({power:{...DEFAULT_POWER,areaM2:0,loadW:0,batteryWh:1000},settings:{...DEFAULT_TRAVERSE,goalHoldH:2,reservePct:0,allowAssumedRelay:true},radio:{...DEFAULT_RADIO,operations:{...DEFAULT_OPERATIONS,traffic:{...DEFAULT_TRAFFIC,generatedKbps:0,initialGb:0,bufferGb:1}},relay:{source:'Initial relay queue',bufferGb:1,initialGb:2,maxLossGb:0,passes:[{startUnix,endUnix:startUnix+2*3600,leg:'backhaul',kbps:1000}]}}}),flat)
    expect(r.relayLostBits).toBeCloseTo(8e9,1);expect(r.returnedBits).toBeCloseTo(1e6*7200,1)
    expect(2*8e9).toBeCloseTo(r.returnedBits+r.relayLostBits+r.relayPendingBits,1)
  })
})
