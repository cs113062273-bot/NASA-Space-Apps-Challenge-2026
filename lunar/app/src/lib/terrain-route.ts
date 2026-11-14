import {toXY,toLatLon} from './data'
import {terrainCellAtPoint,AreaResult,AreaSettings,TerrainGrid} from './landing-area'
import type {TerrainAsset} from './landing-terrain'

export interface RouteSettings {
  start:[number,number]|null;goal:[number,number]|null
  widthM:number;maxGradeDeg:number;heightRmsMultiplier:number;ascentCost:number
}
export const DEFAULT_ROUTE:RouteSettings={start:null,goal:null,widthM:4,maxGradeDeg:10,heightRmsMultiplier:1,ascentCost:0}
export function validRouteSettings(value:unknown):value is RouteSettings {
  const p=value as RouteSettings,point=(x:unknown)=>x===null||Array.isArray(x)&&x.length===2&&x.every(v=>typeof v==='number'&&Number.isFinite(v))&&x[0]>=-90&&x[0]<=90&&x[1]>=-180&&x[1]<=360
  return !!p&&point(p.start)&&point(p.goal)&&Number.isFinite(p.widthM)&&p.widthM>=0&&p.widthM<=100
    &&Number.isFinite(p.maxGradeDeg)&&p.maxGradeDeg>=0&&p.maxGradeDeg<=90&&[0,1,2].includes(p.heightRmsMultiplier)
    &&Number.isFinite(p.ascentCost)&&p.ascentCost>=0&&p.ascentCost<=100
}
export interface RouteNode {index:number;x:number;y:number;heightM:number;heightRmsM:number|null;nodeClearanceM:number;nominalGradeDeg:number|null;stressedGradeDeg:number|null;distanceM:number;lat:number;lon:number}
export interface RouteEndpoint {requested:[number,number];snapped:[number,number];snapDistanceM:number;index:number}
interface RouteBase {
  issue:string|null;expanded:number
  start:RouteEndpoint|null;goal:RouteEndpoint|null;nodes:RouteNode[]
}
interface RouteMetrics {
  mapLengthM:number;ascentM:number;descentM:number;cost:number;maxNominalGradeDeg:number;maxStressedGradeDeg:number
}
type FailedRoute=RouteBase&{status:'blocked'|'unavailable'}&{[K in keyof RouteMetrics]:null}
export type TerrainRoute=(RouteBase&{status:'found'}&RouteMetrics)|FailedRoute
type Point={x:number;y:number}
const sq=(x:number)=>x*x
export function segmentRectangleDistance(a:Point,b:Point,left:number,bottom:number,right:number,top:number):number {
  const dx=b.x-a.x,dy=b.y-a.y
  let lo=0,hi=1,intersects=true
  for(const [p,q] of [[-dx,a.x-left],[dx,right-a.x],[-dy,a.y-bottom],[dy,top-a.y]]) {
    if(p===0) {if(q<0)intersects=false;continue}
    const t=q/p
    if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t)
  }
  if(intersects&&lo<=hi)return 0
  const pointRect=(p:Point)=>sq(Math.max(left-p.x,0,p.x-right))+sq(Math.max(bottom-p.y,0,p.y-top))
  let best=Math.min(pointRect(a),pointRect(b));const length2=dx*dx+dy*dy
  for(const x of [left,right])for(const y of [bottom,top]) {
    const t=length2?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/length2)):0
    best=Math.min(best,sq(x-a.x-t*dx)+sq(y-a.y-t*dy))
  }
  return Math.sqrt(best)
}
const xy=(g:Pick<TerrainGrid,'cols'|'stepM'|'x0'|'y0'>,k:number):Point=>({x:g.x0+k%g.cols*g.stepM,y:g.y0-Math.floor(k/g.cols)*g.stepM})

/** The complete swept disc, not endpoint discs alone. Unknown/excluded cells
 * are closed rectangles. Exact segment/rectangle distance bounds the capsule. */
export function edgeFits(g:Pick<TerrainGrid,'rows'|'cols'|'stepM'|'x0'|'y0'>,screen:Pick<AreaResult,'mask'|'radiusM'>,u:number,v:number,radius:number):boolean {
  if(!screen.mask[u]||!screen.mask[v]||screen.radiusM[u]+1e-9<radius||screen.radiusM[v]+1e-9<radius)return false
  const a=xy(g,u),b=xy(g,v),s=g.stepM,ur=Math.floor(u/g.cols),uc=u%g.cols,vr=Math.floor(v/g.cols),vc=v%g.cols
  if(Math.abs(ur-vr)>1||Math.abs(uc-vc)>1)return false
  if(ur!==vr&&uc!==vc&&(!screen.mask[ur*g.cols+vc]||!screen.mask[vr*g.cols+uc]))return false
  // Distance to a fixed obstacle is 1-Lipschitz. Every segment point is at
  // most half an edge from one endpoint; this is only a safe early acceptance.
  if(Math.min(screen.radiusM[u],screen.radiusM[v])-Math.hypot(a.x-b.x,a.y-b.y)/2>=radius+1e-9)return true
  const c0=Math.max(0,Math.ceil((Math.min(a.x,b.x)-radius-s/2-g.x0)/s)),c1=Math.min(g.cols-1,Math.floor((Math.max(a.x,b.x)+radius+s/2-g.x0)/s))
  const r0=Math.max(0,Math.ceil((g.y0-Math.max(a.y,b.y)-radius-s/2)/s)),r1=Math.min(g.rows-1,Math.floor((g.y0-Math.min(a.y,b.y)+radius+s/2)/s))
  for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)if(!screen.mask[r*g.cols+c]) {
    const x=g.x0+c*s,y=g.y0-r*s
    if(segmentRectangleDistance(a,b,x-s/2,y-s/2,x+s/2,y+s/2)+1e-9<radius)return false
  }
  return true
}

type Entry={id:number;g:number;f:number}
class Heap {
  values:Entry[]=[]
  less(a:Entry,b:Entry){return a.f<b.f||a.f===b.f&&(a.g<b.g||a.g===b.g&&a.id<b.id)}
  push(v:Entry){let k=this.values.length;this.values.push(v);while(k){const p=(k-1)>>1;if(!this.less(v,this.values[p]))break;this.values[k]=this.values[p];k=p}this.values[k]=v}
  pop():Entry|undefined {const first=this.values[0],last=this.values.pop();if(this.values.length&&last){let k=0;while(2*k+1<this.values.length){let c=2*k+1;if(c+1<this.values.length&&this.less(this.values[c+1],this.values[c]))c++;if(!this.less(this.values[c],last))break;this.values[k]=this.values[c];k=c}this.values[k]=last}return first}
}
const blank=(status:FailedRoute['status'],issue:string):FailedRoute=>({status,issue,expanded:0,start:null,goal:null,nodes:[],mapLengthM:null,ascentM:null,descentM:null,cost:null,maxNominalGradeDeg:null,maxStressedGradeDeg:null})
export async function planTerrainRoute(g:TerrainGrid,screen:Pick<AreaResult,'mask'|'radiusM'>,mission:{lat:number;lon:number},p:RouteSettings,control:{signal?:AbortSignal;yieldTask?:()=>Promise<void>}={}):Promise<TerrainRoute> {
  if(!validRouteSettings(p)||!Number.isInteger(g.rows)||!Number.isInteger(g.cols)||g.rows<1||g.cols<1||g.rows>1024||g.cols>1024||!Number.isFinite(g.stepM)||g.stepM<1||g.stepM>100
    ||screen.mask.length!==g.rows*g.cols||screen.radiusM.length!==screen.mask.length||g.height.length!==screen.mask.length||g.heightRms.length!==screen.mask.length)throw new Error('Invalid terrain-route inputs')
  if(!p.goal)return blank('unavailable','Choose a route destination.')
  if(p.heightRmsMultiplier&&g.available?.heightRms===false)return blank('unavailable','Height RMS is unavailable. Import it or explicitly select nominal route grades.')
  const endpoint=(point:[number,number]):RouteEndpoint|null=>{
    const [x,y]=toXY(...point),index=terrainCellAtPoint(g,x,y)
    if(index===null)return null
    const centre=xy(g,index),snapped=toLatLon(centre.x,centre.y)
    return {requested:point,snapped,snapDistanceM:Math.hypot(centre.x-x,centre.y-y),index}
  }
  const start=endpoint(p.start??[mission.lat,mission.lon]),goal=endpoint(p.goal)
  const result=blank('blocked','No route connects these endpoints under the selected terrain, width and grade conditions.');result.start=start;result.goal=goal
  if(!start||!goal){result.status='unavailable';result.issue='A route endpoint lies outside this source window. No outside terrain is inferred.';return result}
  const allowed=(k:number)=>!!screen.mask[k]&&screen.radiusM[k]+1e-9>=p.widthM/2&&Number.isFinite(g.height[k])&&(!p.heightRmsMultiplier||Number.isFinite(g.heightRms[k])&&g.heightRms[k]>=0)
  if(!allowed(start.index)||!allowed(goal.index)){result.issue='An endpoint cell fails terrain, width or height-error requirements. Endpoints are snapped to source-cell centres; no nearby valid cell is substituted.';return result}
  const abort=()=>{if(control.signal?.aborted)throw new DOMException('Route cancelled','AbortError')};abort()
  const n=screen.mask.length,dist=new Float64Array(n).fill(Infinity),parent=new Int32Array(n).fill(-1),closed=new Uint8Array(n),queue=new Heap(),destination=xy(g,goal.index)
  const heuristic=(k:number)=>{const v=xy(g,k);return Math.hypot(v.x-destination.x,v.y-destination.y)}
  dist[start.index]=0;queue.push({id:start.index,g:0,f:heuristic(start.index)})
  while(queue.values.length) {
    const current=queue.pop()!,u=current.id
    if(closed[u]||current.g!==dist[u])continue
    closed[u]=1;result.expanded++
    if(u===goal.index)break
    const r=Math.floor(u/g.cols),c=u%g.cols
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++) {
      if((!dr&&!dc)||r+dr<0||r+dr>=g.rows||c+dc<0||c+dc>=g.cols)continue
      const v=(r+dr)*g.cols+c+dc
      if(closed[v]||!allowed(v))continue
      const distance=g.stepM*Math.hypot(dr,dc),dh=g.height[v]-g.height[u],stress=p.heightRmsMultiplier?(g.heightRms[u]+g.heightRms[v])*p.heightRmsMultiplier:0
      if(Math.atan2(Math.abs(dh)+stress,distance)*180/Math.PI>p.maxGradeDeg+1e-10||!edgeFits(g,screen,u,v,p.widthM/2))continue
      const cost=dist[u]+distance+p.ascentCost*Math.max(0,dh)
      if(cost<dist[v]){dist[v]=cost;parent[v]=u;queue.push({id:v,g:cost,f:cost+heuristic(v)})}
    }
    if(result.expanded%512===0){await (control.yieldTask?.()??new Promise<void>(resolve=>setTimeout(resolve,0)));abort()}
  }
  abort()
  if(!closed[goal.index])return result
  const path:number[]=[];for(let k=goal.index;k!==-1;k=parent[k])path.push(k);path.reverse()
  const nodes:RouteNode[]=[];let mapLengthM=0,ascentM=0,descentM=0,maxNominalGradeDeg=0,maxStressedGradeDeg=0
  for(const [i,k] of path.entries()) {
    const point=xy(g,k),[lat,lon]=toLatLon(point.x,point.y)
    let nominalGradeDeg:number|null=null,stressedGradeDeg:number|null=null
    if(i) {
      const before=nodes[i-1],length=Math.hypot(point.x-before.x,point.y-before.y),dh=g.height[k]-before.heightM
      const stress=p.heightRmsMultiplier?(g.heightRms[path[i-1]]+g.heightRms[k])*p.heightRmsMultiplier:0
      mapLengthM+=length;ascentM+=Math.max(0,dh);descentM+=Math.max(0,-dh)
      nominalGradeDeg=Math.atan2(Math.abs(dh),length)*180/Math.PI;stressedGradeDeg=Math.atan2(Math.abs(dh)+stress,length)*180/Math.PI
      maxNominalGradeDeg=Math.max(maxNominalGradeDeg,nominalGradeDeg)
      maxStressedGradeDeg=Math.max(maxStressedGradeDeg,stressedGradeDeg)
    }
    nodes.push({index:k,...point,heightM:g.height[k],heightRmsM:Number.isFinite(g.heightRms[k])&&g.heightRms[k]>=0?g.heightRms[k]:null,nodeClearanceM:screen.radiusM[k],nominalGradeDeg,stressedGradeDeg,distanceM:mapLengthM,lat,lon})
  }
  return {...result,status:'found',issue:null,nodes,cost:dist[goal.index],mapLengthM,ascentM,descentM,maxNominalGradeDeg,maxStressedGradeDeg}
}

export function routeReport(asset:TerrainAsset,area:AreaSettings,maxSlopeDeg:number,mission:{lat:number;lon:number},settings:RouteSettings,result:TerrainRoute) {
  return {schema:1,method:'A* on an eight-neighbour source-cell graph; Euclidean lower-bound heuristic; complete swept-disc clearance and no diagonal corner cutting',
    source:{frame:asset.index.frame,projection:asset.index.projection,patch:asset.meta,manifestSha256:asset.index.sourceManifestSha256,imported:asset.imported},
    mission,terrain:{maxSlopeDeg,...area},settings,result,limits:[
      'Static terrain route within this source window and the whole-cell 500 m analysis circle; unknown/excluded cells block passage',
      'Endpoints snap only to their containing source-cell centres; requested points and snap distances retained',
      'Circular swept width; no turning radius, boulders, sub-grid hazards, soil/traction, vehicle dynamics or flight qualification',
      'Map-plane distance and adjacent-height grades; grade stress adds multiplier times both endpoint height RMS values, not a confidence bound',
      'Cost = map length + ascent penalty × accumulated ascent; graph optimum, not continuous-path optimum or actual energy',
      'This static record alone performs no time-varying Sun/Earth, moving power, communication, thermal or delay verification; a moving scenario must carry its own current source/input scope, and stationary mission PASS is independent',
      'No immutable model/data release pinning; source fingerprints document this run',
    ]}
}
export type TerrainRouteReport=ReturnType<typeof routeReport>
export function routeCsv(report:ReturnType<typeof routeReport>):string {
  if(report.result.status!=='found')throw new Error('A found route is required for path CSV export.')
  return ['# LUNORIZON static route; MOON_ME_DE421; south-polar stereographic x/y and heights above 1737400 m sphere; map metres',
    '# assumptions_and_result: '+JSON.stringify({...report,result:{...report.result,nodes:undefined}}),
    '# node_clearance_m is clearance at a cell centre, not the minimum along the complete adjoining segment; full swept width is separately screened',
    'step,latitude_deg,longitude_deg,x_m,y_m,height_m,height_rms_m,node_clearance_m,nominal_grade_from_previous_deg,stressed_grade_from_previous_deg,map_distance_m',
    ...report.result.nodes.map((v,i)=>[i,v.lat,v.lon,v.x,v.y,v.heightM,v.heightRmsM??'',v.nodeClearanceM,v.nominalGradeDeg??'',v.stressedGradeDeg??'',v.distanceM].join(','))].join('\n')+'\n'
}
