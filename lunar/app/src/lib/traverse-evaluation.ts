import {Ephemeris} from './astro'
import {FoundRoute,TraverseInputs,TraverseRun,TraverseEnvironment,simulateTraverse} from './traverse'
import {MissingWideTerrain,type MovingSkyCounts} from './moving-sky'
import type {TerrainRouteReport} from './terrain-route'
import {MOBILITY_METHOD} from './mobility'

export type EvaluatedRun=TraverseRun&{skyCounts?:MovingSkyCounts}
export interface TraverseEvaluation {
  pass:boolean;nominal:EvaluatedRun;raised:EvaluatedRun;refinedNominal:EvaluatedRun|null;refinedRaised:EvaluatedRun|null
  refinement:{nominalReserveDifferenceWh:number;raisedReserveDifferenceWh:number;nominalReturnedDifferenceBits:number;raisedReturnedDifferenceBits:number}|null
}
export type EnvironmentFactory=(refined:boolean)=>{environment:TraverseEnvironment;counts?:MovingSkyCounts}
export function evaluateTraverse(eph:Ephemeris,route:FoundRoute,cellStepM:number,input:TraverseInputs,factory:EnvironmentFactory,full=true,onRun?:(name:string)=>void):TraverseEvaluation {
  const run=(shift:number,refined:boolean)=>{onRun?.(`${refined?'refined':'base'} ${shift?'raised':'nominal'}`);const env=factory(refined),result=simulateTraverse(eph,route,cellStepM,input,env.environment,shift,refined);return {...result,skyCounts:env.counts?{...env.counts}:undefined}}
  const nominal=run(0,false),raised=run(1,false),refine=full||nominal.pass&&raised.pass
  const refinedNominal=refine?run(0,true):null,refinedRaised=refine?run(1,true):null
  return {pass:nominal.pass&&raised.pass&&!!refinedNominal?.pass&&!!refinedRaised?.pass,nominal,raised,refinedNominal,refinedRaised,
    refinement:refinedNominal&&refinedRaised?{nominalReserveDifferenceWh:refinedNominal.endStoredWh-nominal.endStoredWh,raisedReserveDifferenceWh:refinedRaised.endStoredWh-raised.endStoredWh,
      nominalReturnedDifferenceBits:refinedNominal.returnedBits-nominal.returnedBits,raisedReturnedDifferenceBits:refinedRaised.returnedBits-raised.returnedBits}:null}
}
export interface DepartureAttempt {
  delayH:number;status:'pass'|'fail'|'unavailable';issue:string|null;misses:string[];nominalReserveWh:number|null;raisedReserveWh:number|null;smallerReturnedGb:number|null;refined:boolean
}
export interface DepartureSearch {attempts:DepartureAttempt[];found:{input:TraverseInputs;evaluation:TraverseEvaluation}|null;maxDelayH:number;stepH:1;completeThroughDelayH:number}
export async function findTraverseDeparture(eph:Ephemeris,route:FoundRoute,cellStepM:number,input:TraverseInputs,factory:EnvironmentFactory,control:{onProgress?:(attempt:number,total:number,run:string)=>void;yieldTask?:()=>Promise<void>}={}):Promise<DepartureSearch> {
  const attempts:DepartureAttempt[]=[],maximum=input.settings.searchMaxDelayH
  for(let delayH=0;delayH<=maximum;delayH++){
    const candidate={...input,settings:{...input.settings,departureDelayH:delayH}}
    try {
      const result=evaluateTraverse(eph,route,cellStepM,candidate,factory,false,name=>control.onProgress?.(delayH+1,maximum+1,name))
      attempts.push({delayH,status:result.pass?'pass':'fail',issue:null,misses:[...new Set([result.nominal,...[result.raised,result.refinedNominal,result.refinedRaised].filter((v):v is EvaluatedRun=>!!v)].flatMap(r=>r.misses))],nominalReserveWh:result.nominal.endStoredWh,raisedReserveWh:result.raised.endStoredWh,
        smallerReturnedGb:Math.min(...[result.nominal,result.raised,result.refinedNominal,result.refinedRaised].filter((v):v is EvaluatedRun=>!!v).map(r=>r.returnedBits))/8e9,refined:!!result.refinement})
      if(result.pass)return {attempts,found:{input:candidate,evaluation:result},maxDelayH:maximum,stepH:1,completeThroughDelayH:delayH}
    } catch(e) {
      // A missing wide grid must trigger loading/retry of the complete job, not
      // be misclassified as a physically infeasible departure.
      if(e instanceof MissingWideTerrain)throw e
      attempts.push({delayH,status:'unavailable',issue:e instanceof Error?e.message:String(e),misses:[],nominalReserveWh:null,raisedReserveWh:null,smallerReturnedGb:null,refined:false})
    }
    await (control.yieldTask?.()??new Promise<void>(resolve=>setTimeout(resolve,0)))
  }
  return {attempts,found:null,maxDelayH:maximum,stepH:1,completeThroughDelayH:maximum}
}

export interface TraversePacket {
  schema:1;scope:string;input:TraverseInputs;route:TerrainRouteReport;evaluation:TraverseEvaluation
  ephemeris:{bodySha256:string|null;stationsSha256:string|null;sourceStepS:number;windowStartUnix:number;windowEndUnix:number;interpolation:string}
  method:string;limits:string[];resultSha256?:string;mobilityModel?:typeof MOBILITY_METHOD
}
export const TRAVERSE_LIMITS=[
  'Prescribed screened polyline and a discrete departure-delay search; not a global or joint spatial/time/energy optimum. Initial charge and payloads are carried from the selected landing time through the wait, drive and goal hold.',
  'Held-pose, held-environment integration: each base interval is at most the requested time step and half a local source pixel of planned travel. The refined run halves time and travel steps and radial-ray spacing. No continuous/sub-grid guarantee follows from agreement.',
  'The local bilinear observer and actual Sun/Earth/antenna-direction rays use local and wider terrain out to sampled distances below 300 km. Unknown observer or remaining unknown wide terrain prevents a result. No measured frame registration or seam correction is applied.',
  'First bus shortfall or equipment-temperature breach permanently halts motion in this model. That interval keeps its scheduled drive demand until its boundary; later intervals remove drive power and use the stopped position. An enabled wheel/soil rejection halts before entering that segment. No automatic restart, coast, controller recovery or flight execution is simulated.',
  'Speed is an assumed projected-map speed. Manual drive DC or the optional declared rigid-wheel/soil model sets demand. The wheel model uses nominal adjacent heights and uniform assumed soil, not measured local mobility. Inertia, turning, tilt, vehicle stability and actual rover execution remain unverified.',
  'Sun-tracking/horizontal panels retain the common model. Chassis-fixed panel azimuth can follow geographic travel heading; thermal solar area and ground/mount boundaries stay the selected equipment assumptions. Antenna pointing/tracking capability remains assumed.',
  'Four-point interpolation of hourly body/station vectors is not new sub-hour ephemeris data. Receiver zenith is normalized. Raised runs also apply the original Earth-orientation sensitivity plus 0.01 degree receiver / 0.0005 degree aim interpolation guards; these and the +1 degree skyline shift are engineering sensitivities, not confidence bounds.',
  'Finite Sun/Earth disks retain the locally flat skyline approximation. Sampled contact and darkness may miss shorter interruptions. Direct silence means powered allocated-link availability; assumed-relay silence means actual modeled Earth forwarding, not command availability.',
  'Point-bound reference/RF relay geometry is rejected for motion. Other relay grants need explicit unverified trajectory consent. Access arrivals stay quarantined until the next source UTC hour; no provider allocation, relay energy or DTN protocol is established.',
  'All four runs must reach the goal, meet uninterrupted bus/temperature, enabled data-loss, final usable-reserve and selected service requirements. No conditions beyond the selected goal hold are inferred. Main stationary mission PASS remains separate.',
  'Source and output hashes document this run; no immutable or signed model/data release, landing certification, human or running-competitor outcome is inferred.'
]
export function traverseCsv(packet:TraversePacket):string {
  const header=['scenario,utc,interval_seconds,phase,map_distance_m,latitude_deg,longitude_deg,heading_deg,ground_m,sun_fraction,sun_clearance_deg,earth_clearance_deg,earth_visible,array_w,bus_w,drive_requested_w,powered_fraction,stored_wh,equipment_k,returned_bits,produced_bits,lost_bits,lander_pending_bits,relay_pending_bits,receiving_mask,chosen_station,link_rate_bps,wheel_grade_deg,wheel_screen_pass,wheel_slip,wheel_torque_nm,wheel_sinkage_m,wheel_rpm,wheel_required_dc_w,wheel_motor_loss_w,wheel_brake_w,wheel_balance_residual_n,wheel_quadrature,wheel_issues']
  for(const [name,run] of Object.entries({nominal:packet.evaluation.nominal,raised:packet.evaluation.raised,refined_nominal:packet.evaluation.refinedNominal,refined_raised:packet.evaluation.refinedRaised}))if(run)for(const s of run.samples)header.push([name,new Date(s.unix*1000).toISOString(),s.seconds,s.phase,s.mapDistanceM,s.lat,s.lon,s.headingDeg,s.groundM,s.sunFraction,s.sunClearDeg,s.earthClearDeg,Number(s.earthVisible),s.arrayW,s.busW,s.driveW,s.poweredFraction,s.storedWh,s.temperatureK??'',s.returnedBits,s.producedBits,s.lostBits,s.landerPendingBits,s.relayPendingBits,s.receivingMask,s.chosenStation,s.linkRateBps,s.mobility?.gradeDeg??'',s.mobility?Number(s.mobility.feasible):'',s.mobility?.slip??'',s.mobility?.torqueNm??'',s.mobility?.sinkageM??'',s.mobility?.wheelRpm??'',s.mobility?.driveDcW??'',s.mobility?.motorLossW??'',s.mobility?.brakeW??'',s.mobility?.balanceResidualN??'',s.mobility?.quadrature??'',s.mobility?.issues.join('; ')??''].join(','))
  return ['# LUNORIZON moving traverse; scenario inputs, source and limits: '+JSON.stringify({...packet,evaluation:undefined,scope:undefined}),
    '# wheel fields describe required segment conditions, including a rejected edge; drive_requested_w is actual scheduled demand; no regenerative charging; row pose/environment are held from interval start; stored energy/temperature and queues are interval-end states; failed driving halts in this model; no source-matched spatial optimization or flight clearance',...header].join('\n')+'\n'
}
