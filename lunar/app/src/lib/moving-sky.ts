import {toXY} from './data'
import {TerrainGrid} from './landing-area'
import {Grid,Sampler,rayDistances,sampleGrid} from './terrain'
import {localHeight} from './local-sky'

export class MissingWideTerrain extends Error {}
export interface MovingSkyCounts {rays:number;localSamples:number;nearSamples:number;farSamples:number;globeSamples:number;localGapFallbacks:number}
export const emptyMovingCounts=():MovingSkyCounts=>({rays:0,localSamples:0,nearSamples:0,farSamples:0,globeSamples:0,localGapFallbacks:0})

/** Trace the actual requested body directions at each held integration pose.
 * No old fixed-point horizon or interpolation between route-node skylines is used. */
export function movingSky(local:TerrainGrid,near:Grid,far:Grid,globe?:Sampler,radialScale=1) {
  if(![1,.5].includes(radialScale))throw new Error('Unsupported moving-sky radial refinement')
  const counts=emptyMovingCounts(),R=1737400
  return {counts,point(lat:number,lon:number,observerM:number,skyShiftDeg=0){
    if(!Number.isFinite(lat)||lat< -90||lat> -75||!Number.isFinite(lon)||!Number.isFinite(observerM)||observerM<=0||observerM>100)throw new Error('Unsupported moving observer')
    const [x0,y0]=toXY(lat,lon),groundM=localHeight(local,x0,y0)
    if(!Number.isFinite(groundM))throw new Error('A moving observer lacks complete local bilinear height support. No background observer is substituted.')
    if(R+groundM<=0)throw new Error('Local heights imply a nonpositive lunar radius. Check source units and vertical datum.')
    const right=local.x0+(local.cols-1)*local.stepM,bottom=local.y0-(local.rows-1)*local.stepM
    const range=Math.max(...[local.x0,right].flatMap(x=>[local.y0,bottom].map(y=>Math.hypot(x-x0,y-y0))))
    const d=Array.from(rayDistances()),step=Math.max(.5,local.stepM/2)*radialScale
    for(let value=step;value<=range+local.stepM;value+=step)d.push(value)
    // Refine the background as well, not just the finest local patch.
    if(radialScale<1){const base=rayDistances();for(let i=0;i+1<base.length;i++)d.push((base[i]+base[i+1])/2)}
    d.sort((a,b)=>a-b);const distances=d.filter((v,i)=>!i||v-d[i-1]>1e-7),sin=distances.map(v=>Math.sin(v/R)),cos=distances.map(v=>Math.cos(v/R))
    const la=lat*Math.PI/180,lo=lon*Math.PI/180,sl=Math.sin(la),cl=Math.cos(la),so=Math.sin(lo),co=Math.cos(lo),memo=new Map<number,number>()
    return {groundM,horizon:{at(azimuth:number){
      const az=((azimuth%360)+360)%360
      const cached=memo.get(az);if(cached!==undefined)return cached
      if(!Number.isFinite(az))throw new Error('Invalid moving horizon direction')
      counts.rays++
      const sa=Math.sin(az*Math.PI/180),ca=Math.cos(az*Math.PI/180),tx=-sl*co*ca-so*sa,ty=-sl*so*ca+co*sa,tz=cl*ca
      let best=-Math.PI/2
      for(let i=0;i<distances.length;i++){
        const vx=cl*co*cos[i]+tx*sin[i],vy=cl*so*cos[i]+ty*sin[i],vz=sl*cos[i]+tz*sin[i],x=2*R*vy/(1-vz),y=2*R*vx/(1-vz)
        let h=distances[i]<=range+local.stepM?localHeight(local,x,y):NaN
        if(Number.isFinite(h))counts.localSamples++
        else {
          if(distances[i]<25000){h=sampleGrid(near,x,y);if(Number.isFinite(h))counts.nearSamples++}
          if(!Number.isFinite(h)){h=sampleGrid(far,x,y);if(Number.isFinite(h))counts.farSamples++}
          if(!Number.isFinite(h)&&globe){h=globe(Math.atan2(vz,Math.hypot(vx,vy)),Math.atan2(vy,vx));if(Number.isFinite(h))counts.globeSamples++}
          if(!Number.isFinite(h))throw new MissingWideTerrain('A moving sightline has unknown wide terrain; no partial horizon is accepted.')
          if(x>=local.x0&&x<=right&&y<=local.y0&&y>=bottom)counts.localGapFallbacks++
        }
        const rt=R+h;if(rt<=0)throw new Error('Terrain height implies a nonpositive lunar radius. Check source units and vertical datum.');best=Math.max(best,Math.atan2(rt*cos[i]-(R+groundM+observerM),rt*sin[i]))
      }
      const value=best*180/Math.PI+skyShiftDeg;memo.set(az,value);return value
    }}}
  }}
}
