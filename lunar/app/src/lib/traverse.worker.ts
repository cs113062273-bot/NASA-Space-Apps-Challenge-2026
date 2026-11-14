/// <reference lib="webworker" />
import {getFar,nearGrid,globeHorizons} from './terrain-loader'
import {movingSky,MissingWideTerrain} from './moving-sky'
import {evaluateTraverse,findTraverseDeparture,TraversePacket,TRAVERSE_LIMITS,TraverseEvaluation} from './traverse-evaluation'
import type {Ephemeris} from './astro'
import type {TerrainAsset} from './landing-terrain'
import type {TerrainRouteReport} from './terrain-route'
import type {TraverseInputs} from './traverse'
import type {Sampler} from './terrain'
import {checkTraverseRoute} from './traverse-route-check'
import {MOBILITY_METHOD} from './mobility'

interface Request {scope:string;search:boolean;asset:TerrainAsset;route:TerrainRouteReport;input:TraverseInputs;eph:Ephemeris;root:string}
const post=(data:unknown)=>self.postMessage(data)
self.onmessage=async(e:MessageEvent<Request>)=>{
  const {scope,asset,route,input,eph,root,search}=e.data
  try {
    if(route.result.status!=='found')throw new Error('A found source route is required')
    checkTraverseRoute(asset,route)
    const path=route.result,[near,far]=await Promise.all([nearGrid(root,route.mission.lat,route.mission.lon,27000),getFar(root)])
    let globe:Sampler|undefined
    const factory=(refined:boolean)=>{const env=movingSky(asset.grid,near,far,globe,refined ? .5 : 1);return {counts:env.counts,environment:env.point}}
    const make=async(value:TraverseInputs,evaluation:TraverseEvaluation):Promise<TraversePacket>=>{
      const state=JSON.parse(scope);state.input=value
      // Identify the actual four-point knot span, independent of extra unused
      // padding sent for a longer departure search. Re-running a chosen wait
      // must not acquire a different identity merely from a smaller buffer.
      const source=state.ephemeris,first=(u:number)=>Math.max(0,Math.min(source.count-4,Math.floor((u-source.start)/source.step)-1))
      const packet:TraversePacket={schema:1,scope:JSON.stringify(state),input:value,route,evaluation,ephemeris:{bodySha256:eph.sha256??null,stationsSha256:eph.stations?.sha256??null,sourceStepS:eph.stepS,windowStartUnix:source.start+first(value.startUnix)*source.step,windowEndUnix:source.start+(first(evaluation.nominal.endUnix)+3)*source.step,interpolation:'Four-point Lagrange, normalized receiver zenith; canonical used-knot span, no extrapolation'},method:'Causal held-pose drive/wait/goal integration; point-specific local/wide directional rays; full common bus, thermal and communication accounting; nominal/raised and time/spatial/radial refinement',limits:[...TRAVERSE_LIMITS,...(value.settings.mobility?MOBILITY_METHOD.limits:[])],mobilityModel:value.settings.mobility?MOBILITY_METHOD:undefined}
      const bytes=new TextEncoder().encode(JSON.stringify({...packet,scope:undefined}));packet.resultSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');return packet
    }
    const run=async()=>{
      if(search){
        const result=await findTraverseDeparture(eph,path,asset.grid.stepM,input,factory,{onProgress:(attempt,total,run)=>post({scope,progress:{attempt,total,run}})})
        const recommendation=result.found?await make(result.found.input,result.found.evaluation):null
        post({scope,ok:true,search:{...result,found:undefined},recommendation})
      }else {
        const evaluation=evaluateTraverse(eph,path,asset.grid.stepM,input,factory,true,run=>post({scope,progress:{attempt:1,total:1,run}}))
        post({scope,ok:true,packet:await make(input,evaluation)})
      }
    }
    try {await run()}catch(error){if(!(error instanceof MissingWideTerrain))throw error;post({scope,progress:{attempt:0,total:1,run:'loading missing wide terrain'}});globe=(await globeHorizons(root,route.mission.lat,route.mission.lon)).sampler;await run()}
  }catch(error){post({scope,ok:false,error:error instanceof Error?error.message:String(error)})}
}
