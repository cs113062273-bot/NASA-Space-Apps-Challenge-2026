import {Ephemeris,siteFrame} from './astro'
import {computeTrack,earthVisible,HorizonSampler} from './metrics'
import {missionBudget,Radio} from './link'
import {PowerSystem,storageModel} from './power'
import {operationsFor,DEFAULT_TRAFFIC,validOperations} from './communications'
import {validRelay} from './relay'
import {validThermal} from './thermal'
import {TerrainRoute,RouteNode} from './terrain-route'
import {toLatLon} from './data'
import {intervalEphemeris} from './moving-ephemeris'
import {MobilitySettings,MobilityResult,validMobility,solveMobility} from './mobility'

export interface TraverseSettings {
  version:1;speedMps:number;driveW:number;driveBusHeatFraction:number;panelFrame:'lunar-north'|'travel'
  departureDelayH:number;goalHoldH:number;reservePct:number;maxStepS:number
  maxDarkH:number|null;maxSilenceH:number|null;minDataGb:number;searchMaxDelayH:number;allowAssumedRelay:boolean
  mobility?:MobilitySettings
}
export const DEFAULT_TRAVERSE:TraverseSettings={version:1,speedMps:.01,driveW:80,driveBusHeatFraction:0,panelFrame:'travel',departureDelayH:0,goalHoldH:1,reservePct:10,maxStepS:60,maxDarkH:null,maxSilenceH:null,minDataGb:0,searchMaxDelayH:24,allowAssumedRelay:false}
const between=(v:unknown,a:number,b:number):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=a&&v<=b
export function validTraverseSettings(v:unknown):v is TraverseSettings {
  const p=v as TraverseSettings,optional=(x:unknown)=>x===null||between(x,0,72)
  return !!p&&Object.keys(p).filter(k=>k!=='mobility').sort().join()===Object.keys(DEFAULT_TRAVERSE).sort().join()&&(p.mobility===undefined||validMobility(p.mobility))&&p.version===1&&between(p.speedMps,.001,1)&&between(p.driveW,0,1e6)&&between(p.driveBusHeatFraction,0,1)
    &&['lunar-north','travel'].includes(p.panelFrame)&&between(p.departureDelayH,0,48)&&between(p.goalHoldH,0,24)&&between(p.reservePct,0,100)
    &&[15,30,60,120,300].includes(p.maxStepS)&&optional(p.maxDarkH)&&optional(p.maxSilenceH)&&between(p.minDataGb,0,1e9)
    &&Number.isInteger(p.searchMaxDelayH)&&between(p.searchMaxDelayH,0,48)&&typeof p.allowAssumedRelay==='boolean'
}
export interface TraverseInputs {
  startUnix:number;observerM:number;earthMinClear:number;requireDsn:boolean;power:PowerSystem;radio:Radio;settings:TraverseSettings
}
export type FoundRoute=Extract<TerrainRoute,{status:'found'}>
export interface TraversePose {lat:number;lon:number;x:number;y:number;mapDistanceM:number;headingDeg:number}
export interface TraverseSample extends TraversePose {
  unix:number;seconds:number;phase:'wait'|'drive'|'goal'|'halted';groundM:number;sunFraction:number;sunClearDeg:number;earthClearDeg:number;earthVisible:boolean
  arrayW:number;busW:number;driveW:number;poweredFraction:number;storedWh:number;temperatureK:number|null
  returnedBits:number;producedBits:number;lostBits:number;landerPendingBits:number;relayPendingBits:number
  receivingMask:number;chosenStation:number;linkRateBps:number
  mobility?:MobilityResult
}
export interface TraverseMobilitySummary {
  edgesChecked:number;maxAbsSlip:number|null;maxTorqueNm:number|null;maxSinkageM:number|null;maxWheelRpm:number|null;maxDriveDcW:number|null;maxBrakeW:number|null
  firstFailure:{unix:number;edgeIndex:number;result:MobilityResult}|null
}
export interface TraverseRun {
  shiftDeg:number;refined:boolean;pass:boolean;misses:string[];arrived:boolean;arrivalUnix:number|null;haltUnix:number|null;haltReason:string|null;finalDistanceM:number
  endUnix:number;endStoredWh:number;endUsablePct:number|null;minStoredWh:number;solarWh:number;loadWh:number;driveWh:number;deliveredDriveWh:number;heaterWh:number;unservedWh:number
  firstPowerH:number|null;firstThermalH:number|null;minK:number|null;maxK:number|null;maxDarkH:number;maxSilenceH:number;earthViewH:number
  returnedBits:number;producedBits:number;missedProductionBits:number;lostBits:number;landerLostBits:number;relayLostBits:number;landerPendingBits:number;relayPendingBits:number
  maxStepS:number;maxTravelPerStepM:number;sampleCount:number;samples:TraverseSample[]
  mobility?:TraverseMobilitySummary
}
export type TraverseEnvironment=(lat:number,lon:number,observerM:number,shiftDeg:number)=>{groundM:number;horizon:HorizonSampler}

/** Position follows the screened polyline in projected map metres. The heading
 * is geographic at this pose, rather than an unrotated polar-map bearing. */
export function routePose(nodes:RouteNode[],distance:number):TraversePose {
  if(!nodes.length||!Number.isFinite(distance))throw new Error('Invalid traverse polyline')
  const last=nodes.at(-1)!,d=Math.max(0,Math.min(last.distanceM,distance))
  let i=1;while(i<nodes.length-1&&nodes[i].distanceM<=d+1e-7)i++
  const a=nodes[Math.max(0,i-1)]??last,b=nodes[i]??a,length=b.distanceM-a.distanceM,f=length?Math.max(0,Math.min(1,(d-a.distanceM)/length)):0
  const x=a.x+f*(b.x-a.x),y=a.y+f*(b.y-a.y),[lat,lon]=toLatLon(x,y),frame=siteFrame(lat,lon)
  const point=(n:RouteNode)=>siteFrame(n.lat,n.lon,1737.4+n.heightM/1000).pos,pa=point(a),pb=point(b),delta=pa.map((v,k)=>pb[k]-v)
  const dot=(v:readonly number[])=>delta.reduce((s,q,k)=>s+q*v[k],0),headingDeg=length?((Math.atan2(dot(frame.e),dot(frame.n))*180/Math.PI)%360+360)%360:0
  return {lat,lon,x,y,mapDistanceM:d,headingDeg}
}
const actualRoute=(route:FoundRoute)=>{
  if(route.status!=='found'||!route.nodes.length||route.nodes.length>100000||!between(route.mapLengthM,0,1e6))throw new Error('A found source route is required')
  let previous=-1
  for(const n of route.nodes){if(![n.x,n.y,n.lat,n.lon,n.heightM,n.distanceM].every(Number.isFinite)||n.distanceM<previous)throw new Error('Invalid route vertex');previous=n.distanceM}
  if(Math.abs(previous-route.mapLengthM)>1e-7||route.nodes[0].distanceM!==0)throw new Error('Route distance differs from its vertices')
}

/** Causal, first-order held-pose integration. Motion halts permanently on the
 * first mobility-screen, bus shortfall or equipment-temperature breach; later communication is
 * evaluated at the stopped pose, never at a fictitious reached destination. */
export function simulateTraverse(eph:Ephemeris,route:FoundRoute,cellStepM:number,input:TraverseInputs,environment:TraverseEnvironment,shiftDeg=0,refined=false):TraverseRun {
  actualRoute(route)
  const {settings:p,power:base,radio:original}=input
  if(!validTraverseSettings(p)||!between(cellStepM,1,100)||!between(input.observerM,.01,100)||![0,1].includes(shiftDeg))throw new Error('Invalid traverse inputs')
  const storage=storageModel(base),unit=(x:unknown)=>between(x,0,1),rate=(x:unknown)=>x===null||between(x,0,1e9)
  if(!['tracking','fixed','horizontal'].includes(base.mode)||!between(base.areaM2,0,1e9)||!unit(base.efficiency)||!between(base.loadW,0,1e9)||!between(base.batteryWh,0,1e9)||!Number.isFinite(base.facingAz)
    ||!unit(storage.maxDod)||storage.maxDod===0||!unit(storage.initialSoc)||storage.initialSoc<1-storage.maxDod-1e-12||!unit(storage.chargeEfficiency)||!storage.chargeEfficiency||!unit(storage.dischargeEfficiency)||!storage.dischargeEfficiency||!unit(storage.arrayFactor)||!rate(storage.maxChargeW)||!rate(storage.maxDischargeW)||!between(storage.darkHeaterW,0,1e9)||base.thermal&&!validThermal(base.thermal))throw new Error('Invalid moving power/storage/thermal assumptions')
  if(!['S','X'].includes(original.band)||!between(original.txW,Number.MIN_VALUE,500)||!between(original.gainDbi,-5,45)||original.dishM!==undefined&&!between(original.dishM,.001,5)||original.maxKbps!==undefined&&!between(original.maxKbps,0,1e12)||!validOperations(operationsFor(original))||original.relay&&!validRelay(original.relay)||!between(input.earthMinClear,0,90))throw new Error('Invalid moving radio/contact assumptions')
  if(original.relay?.reference||original.relay?.rf)throw new Error('Point-bound reference/RF relay geometry cannot be applied to a moving route. Select direct service or an explicitly unverified assumed plan.')
  if(original.relay&&!p.allowAssumedRelay)throw new Error('Explicitly allow the assumed relay grants along this trajectory before they can receive service credit.')
  const driveS=route.mapLengthM/p.speedMps,departure=input.startUnix+p.departureDelayH*3600,endUnix=departure+driveS+p.goalHoldH*3600
  if(!Number.isFinite(input.startUnix)||endUnix<=input.startUnix||endUnix-input.startUnix>72*3600)throw new Error('The wait, drive and goal hold must total more than zero and at most 72 hours')
  if(input.startUnix<eph.startUnix||endUnix>eph.startUnix+(eph.count-1)*eph.stepS)throw new Error('The complete moving scenario lies outside retained ephemeris coverage')
  const m=storageModel(base),usable=base.batteryWh*m.maxDod,initial=base.batteryWh*(m.initialSoc-(1-m.maxDod)),ops=operationsFor(original)
  const traffic=ops.traffic??(original.relay?DEFAULT_TRAFFIC:null),relayCap=(original.relay?.bufferGb??0)*8e9
  let stored=Math.max(0,initial),temperature=base.thermal?.initialK??null,landerQueue=traffic?(traffic.initialGb*8e9):0,relayReady=(original.relay?.initialGb??0)*8e9,relayQuarantine=0
  let currentHour=Math.floor(input.startUnix/3600),time=input.startUnix,distance=0,arrivalUnix:number|null=route.mapLengthM===0?input.startUnix:null,haltUnix:number|null=null,haltReason:string|null=null
  let minStored=stored,solarWh=0,loadWh=0,driveWh=0,deliveredDriveWh=0,heaterWh=0,unservedWh=0,firstPowerH:number|null=null,firstThermalH:number|null=null,minK=temperature,maxK=temperature
  let returnedBits=0,producedBits=0,missedProductionBits=0,landerLostBits=0,relayLostBits=0,dark=0,maxDark=0,earthViewH=0,lastContactEnd=input.startUnix,maxSilence=0,maxStepS=0,maxTravelPerStepM=0
  const samples:TraverseSample[]=[],temporalStep=p.maxStepS/(refined?2:1),travelStep=cellStepM/(refined?4:2)
  const mobilityCache=new Map<number,MobilityResult>(),mobility:TraverseMobilitySummary|undefined=p.mobility?{edgesChecked:0,maxAbsSlip:null,maxTorqueNm:null,maxSinkageM:null,maxWheelRpm:null,maxDriveDcW:null,maxBrakeW:null,firstFailure:null}:undefined
  if(base.thermal&&(temperature!<base.thermal.minK||temperature!>base.thermal.maxK)){haltUnix=time;haltReason='equipment temperature';firstThermalH=0}
  while(time<endUnix-1e-6){
    if(samples.length>=20000)throw new Error('Moving scenario exceeds 20,000 integration intervals. No coarser step is substituted.')
    const hour=Math.floor((time+1e-6)/3600)
    if(hour!==currentHour){relayReady+=relayQuarantine;relayQuarantine=0;currentHour=hour}
    let phase:TraverseSample['phase']=haltUnix!==null?'halted':time<departure-1e-6?'wait':distance<route.mapLengthM-1e-7?'drive':'goal'
    let motion:MobilityResult|undefined
    if(phase==='drive'&&p.mobility){
      const edge=route.nodes.findIndex(n=>n.distanceM>distance+1e-7),a=route.nodes[edge-1],b=route.nodes[edge]
      if(!a||!b||b.distanceM<=a.distanceM)throw new Error('Moving wheel/soil model requires a positive source edge')
      motion=mobilityCache.get(edge)
      if(!motion){
        const grade=Math.atan2(b.heightM-a.heightM,b.distanceM-a.distanceM)*180/Math.PI
        motion=solveMobility(p.mobility,grade,p.speedMps,refined);mobilityCache.set(edge,motion);mobility!.edgesChecked=mobilityCache.size
        const peak=(old:number|null,next:number|null)=>next===null?old:Math.max(old??0,Math.abs(next))
        mobility!.maxAbsSlip=peak(mobility!.maxAbsSlip,motion.slip);mobility!.maxTorqueNm=peak(mobility!.maxTorqueNm,motion.torqueNm);mobility!.maxSinkageM=peak(mobility!.maxSinkageM,motion.sinkageM)
        mobility!.maxWheelRpm=peak(mobility!.maxWheelRpm,motion.wheelRpm);mobility!.maxDriveDcW=peak(mobility!.maxDriveDcW,motion.driveDcW);mobility!.maxBrakeW=peak(mobility!.maxBrakeW,motion.brakeW)
      }
      if(!motion.feasible){haltUnix=time;haltReason='wheel/soil screen: '+motion.issues.join(', ');mobility!.firstFailure={unix:time,edgeIndex:edge,result:motion};phase='halted'}
    }
    const pose=routePose(route.nodes,distance)
    let dt=Math.min(temporalStep,endUnix-time,(Math.floor((time+1e-6)/3600)+1)*3600-time)
    if(phase==='wait')dt=Math.min(dt,departure-time)
    if(phase==='drive'){
      const next=route.nodes.find(n=>n.distanceM>distance+1e-7)?.distanceM??route.mapLengthM
      dt=Math.min(dt,travelStep/p.speedMps,(next-distance)/p.speedMps)
    }
    if(!Number.isFinite(dt)||dt<1e-5)throw new Error('Traverse time integration lost a positive interval')
    const local=intervalEphemeris(eph,time,dt),sky=environment(pose.lat,pose.lon,input.observerM,shiftDeg)
    const track=computeTrack(local,{lat:pose.lat,lon:pose.lon,groundM:sky.groundM,observerM:input.observerM,horizon:sky.horizon,stationStress:shiftDeg>0},input.earthMinClear,input.requireDsn)
    const drive=phase==='drive'?(motion?.driveDcW??p.driveW):0,driveHeat=phase==='drive'?(motion?motion.motorLossW!:drive)*p.driveBusHeatFraction:0,power:PowerSystem={...base,facingAz:base.mode==='fixed'&&p.panelFrame==='travel'?(base.facingAz+pose.headingDeg)%360:base.facingAz,
      storage:{...m,initialSoc:base.batteryWh?(1-m.maxDod)+stored/base.batteryWh:m.initialSoc},thermal:base.thermal?{...base.thermal,initialK:temperature!}:undefined}
    const radio:Radio={...original,operations:{...ops,traffic:traffic?{...traffic,initialGb:landerQueue/8e9}:null},
      relay:original.relay?{...original.relay,initialGb:relayReady/8e9,bufferGb:Math.max(0,relayCap-relayQuarantine)/8e9}:undefined}
    const budget=missionBudget(local,track,0,1,power,radio,{loadW:Float32Array.of(drive),escapedW:Float32Array.of(Math.max(0,drive-driveHeat))}),b=budget.power
    const hours=dt/3600
    const haltAfter=Math.min(b.shortfallAt??Infinity,b.thermal?.firstBreachH??Infinity)
    if(firstPowerH===null&&b.shortfallAt!==null)firstPowerH=(time-input.startUnix)/3600+b.shortfallAt
    if(firstThermalH===null&&b.thermal?.firstBreachH!=null)firstThermalH=(time-input.startUnix)/3600+b.thermal.firstBreachH
    let moved=phase==='drive'?Math.min(route.mapLengthM-distance,p.speedMps*dt):0
    if(haltUnix===null&&Number.isFinite(haltAfter)){
      haltUnix=time+Math.min(hours,haltAfter)*3600;haltReason=(b.shortfallAt??Infinity)<=(b.thermal?.firstBreachH??Infinity)?'power shortfall':'equipment temperature'
      if(phase==='drive')moved*=Math.max(0,Math.min(1,haltAfter/hours))
    }
    distance+=moved;maxTravelPerStepM=Math.max(maxTravelPerStepM,moved)
    if(arrivalUnix===null&&distance>=route.mapLengthM-1e-7){distance=route.mapLengthM;arrivalUnix=time+(moved?moved/p.speedMps:0)}
    stored=b.endStoredWh;minStored=Math.min(minStored,stored);solarWh+=b.energyWh;loadWh+=b.loadWh;driveWh+=drive*hours;heaterWh+=b.heaterWh;unservedWh+=b.unservedWh
    deliveredDriveWh+=drive*hours*b.metFrac[0]
    if(b.thermal){temperature=b.endTemperatureK;minK=Math.min(minK!,b.thermal.minK);maxK=Math.max(maxK!,b.thermal.maxK)}
    returnedBits+=budget.returnedBits
    if(budget.delivery){landerQueue=budget.delivery.pendingBits;producedBits+=budget.delivery.producedBits;missedProductionBits+=budget.delivery.missedProductionBits;landerLostBits+=budget.delivery.lostBits}
    if(budget.relay){
      const effectiveCapacity=Math.max(0,relayCap-relayQuarantine),initialDrop=Math.max(0,relayReady-effectiveCapacity),arrivalDrop=Math.max(0,budget.relay.relayLostBits-initialDrop)
      relayReady=Math.max(0,Math.min(relayReady,effectiveCapacity)-budget.relay.deliveredBits)
      relayQuarantine+=Math.max(0,budget.relay.received[0]-arrivalDrop);relayLostBits+=budget.relay.relayLostBits
    }
    const fraction=budget.relay?budget.relay.earthActiveFrac[0]:budget.link.state[0]===2?b.metFrac[0]:0
    if(fraction>0){maxSilence=Math.max(maxSilence,(time-lastContactEnd)/3600);lastContactEnd=time+dt*Math.max(0,Math.min(1,fraction))}
    if(track.sunFrac[0]<=0){dark+=hours;maxDark=Math.max(maxDark,dark)}else dark=0
    const earth=earthVisible(track,0);if(earth)earthViewH+=hours
    samples.push({...pose,unix:time,seconds:dt,phase,groundM:sky.groundM,sunFraction:track.sunFrac[0],sunClearDeg:track.sunClear[0],earthClearDeg:track.earthClear[0],earthVisible:earth,
      arrayW:b.series[0],busW:b.load[0],driveW:drive,poweredFraction:b.metFrac[0],storedWh:stored,temperatureK:temperature,returnedBits:budget.returnedBits,
      producedBits:budget.delivery?.producedBits??0,lostBits:budget.totalLostBits,landerPendingBits:landerQueue,relayPendingBits:relayReady+relayQuarantine,
      receivingMask:budget.link.receivingMask[0],chosenStation:budget.link.chosenStation[0],linkRateBps:budget.link.rate[0],mobility:motion})
    maxStepS=Math.max(maxStepS,dt);time+=dt
  }
  maxSilence=Math.max(maxSilence,(endUnix-lastContactEnd)/3600)
  const endUsablePct=usable?100*stored/usable:null,arrived=arrivalUnix!==null,misses=[!arrived&&'destination not reached',!!mobility?.firstFailure&&'wheel/soil screen',firstPowerH!==null&&'power supply',firstThermalH!==null&&'equipment temperature',
    stored+1e-6<usable*p.reservePct/100&&'goal reserve',p.reservePct>0&&!usable&&'goal reserve requires storage',
    traffic&&landerLostBits>traffic.maxLossGb*8e9+1&&'lander data loss',original.relay&&relayLostBits>original.relay.maxLossGb*8e9+1&&'relay data loss',returnedBits+1<p.minDataGb*8e9&&'data return',
    p.maxDarkH!==null&&maxDark>p.maxDarkH+1e-9&&'longest darkness',p.maxSilenceH!==null&&maxSilence>p.maxSilenceH+1e-9&&'powered silence'].filter((v):v is string=>!!v)
  return {shiftDeg,refined,pass:!misses.length,misses,arrived,arrivalUnix,haltUnix,haltReason,finalDistanceM:distance,endUnix,endStoredWh:stored,endUsablePct,minStoredWh:minStored,solarWh,loadWh,driveWh,deliveredDriveWh,heaterWh,unservedWh,firstPowerH,firstThermalH,minK,maxK,maxDarkH:maxDark,maxSilenceH:maxSilence,earthViewH,returnedBits,producedBits,missedProductionBits,lostBits:landerLostBits+relayLostBits,landerLostBits,relayLostBits,landerPendingBits:landerQueue,relayPendingBits:relayReady+relayQuarantine,maxStepS,maxTravelPerStepM,sampleCount:samples.length,samples,mobility}
}

export function traverseScope(asset:{meta:{sha256:string};index:{sourceManifestSha256:string};imported?:{id:string}},route:FoundRoute,input:TraverseInputs,eph:Ephemeris,constraints?:unknown):string {
  return JSON.stringify({patch:asset.meta.sha256,manifest:asset.index.sourceManifestSha256,importId:asset.imported?.id,nodes:route.nodes.map(n=>[n.index,n.x,n.y,n.heightM]),input,ephemeris:{sha256:eph.sha256,stationsSha256:eph.stations?.sha256,start:eph.startUnix,count:eph.count,step:eph.stepS},constraints})
}
