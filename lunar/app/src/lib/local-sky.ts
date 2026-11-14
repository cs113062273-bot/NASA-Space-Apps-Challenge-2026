import {toXY} from './data'
import type {TerrainGrid} from './landing-area'
import type {TerrainAsset} from './landing-terrain'
import {Grid,Sampler,sampleGrid,rayDistances} from './terrain'

export interface LocalSkyConfig {sourceId:string;patchSha256?:string;resultSha256?:string}
export interface LocalSkyEvidence {
  revision:1;config:LocalSkyConfig;patchSha256:string;manifestSha256:string;stepM:number
  groundM:number;baselineGroundM:number|null;groundDifferenceM:number|null;heightRmsM:number|null
  bins:number;localSamples:number;nearSamples:number;farSamples:number;globeSamples:number;missingSamples:number;localGapFallbacks:number
  localDeltaMinM:number|null;localDeltaMaxM:number|null;limits:string[]
  source:Pick<TerrainAsset,'meta'|'index'|'imported'>
}
export function validLocalSky(p:unknown):p is LocalSkyConfig {
  const v=p as LocalSkyConfig,hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)
  return !!v&&(v.sourceId==='nasa'||hash(v.sourceId))&&(v.patchSha256===undefined||hash(v.patchSha256))&&(v.resultSha256===undefined||hash(v.resultSha256))
}
export function skyCode(p:LocalSkyConfig):string {return [p.sourceId,p.patchSha256??'',p.resultSha256??''].join(':')}
export function parseSkyCode(value:string):LocalSkyConfig {
  const v=value.split(':'),p={sourceId:v[0],...(v[1]?{patchSha256:v[1]}:{}),...(v[2]?{resultSha256:v[2]}:{})}
  return v.length===3&&validLocalSky(p)?p:{sourceId:'invalid'}
}
export function pointReference(s:{lat:number;lon:number;localSky?:LocalSkyEvidence}):string {
  return s.localSky?`pt:${s.lat}:${s.lon}:sky1:${skyCode(s.localSky.config)}`:`pt:${s.lat.toFixed(7)}:${s.lon.toFixed(7)}`
}
export function parsePointReference(id:string):{lat:number;lon:number;sky?:LocalSkyConfig}|null {
  const v=id.split(':'),lat=Number(v[1]),lon=Number(v[2])
  if(v[0]!=='pt'||!v[1]?.trim()||!v[2]?.trim()||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon))return null
  return {lat,lon:lon<0||lon>=360?((lon%360)+360)%360:lon,...(v.length>3?{sky:v[3]==='sky1'?parseSkyCode(v.slice(4).join(':')):{sourceId:'invalid'}}:{})}
}
export function matchesPoint(s:{lat:number;lon:number;localSky?:LocalSkyEvidence},p:{lat:number;lon:number;sky?:LocalSkyConfig}):boolean {
  const lon=p.lon<0||p.lon>=360?((p.lon%360)+360)%360:p.lon
  return Math.abs(s.lat-p.lat)<(p.sky?1e-12:1e-7)&&Math.abs(s.lon-lon)<(p.sky?1e-12:1e-7)
    &&(p.sky?!!s.localSky&&s.localSky.config.sourceId===p.sky.sourceId&&(!p.sky.patchSha256||s.localSky.patchSha256===p.sky.patchSha256)&&(!p.sky.resultSha256||s.localSky.config.resultSha256===p.sky.resultSha256):!s.localSky)
}
export function localHeight(g:TerrainGrid,x:number,y:number,field:'height'|'heightRms'='height'):number {
  const c=(x-g.x0)/g.stepM,r=(g.y0-y)/g.stepM
  if(c<0||r<0||c>g.cols-1||r>g.rows-1)return NaN
  const cc=Math.min(g.cols-2,Math.floor(c)),rr=Math.min(g.rows-2,Math.floor(r)),u=c-cc,v=r-rr,k=rr*g.cols+cc,a=g[field],samples=[a[k],a[k+1],a[k+g.cols],a[k+g.cols+1]]
  if(!samples.every(v=>Number.isFinite(v)&&(field!=='heightRms'||v>=0)))return NaN
  return (samples[0]*(1-u)+samples[1]*u)*(1-v)+(samples[2]*(1-u)+samples[3]*u)*v
}
export interface CompositeSky {
  horizons:Record<string,number[]>;groundM:number;baselineGroundM:number|null;heightRmsM:number|null
  bins:number;localSamples:number;nearSamples:number;farSamples:number;globeSamples:number;missingSamples:number;localGapFallbacks:number
  localDeltaMinM:number|null;localDeltaMaxM:number|null
}
/** Re-trace the complete mixed surface from the local observer height. This
 * replaces valid local samples; it does not merely raise the old skyline. */
export function compositeSky(lat:number,lon:number,local:TerrainGrid,near:Grid,far:Grid,heights=[2,10],nAz=2880,globe?:Sampler):CompositeSky {
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat< -90||lat> -75||!Number.isInteger(nAz)||nAz<36||nAz>5760||!heights.length||heights.some(h=>!Number.isFinite(h)||h<=0||h>100))throw new Error('Unsupported local-sky point or sampling inputs')
  if(![local.rows,local.cols].every(v=>Number.isInteger(v)&&v>=2&&v<=512)||![local.x0,local.y0,local.stepM].every(Number.isFinite)||local.stepM<1||local.stepM>100||local.height.length!==local.rows*local.cols||local.heightRms.length!==local.rows*local.cols)throw new Error('Invalid local-sky terrain grid')
  const R=1737400,[x0,y0]=toXY(lat,lon),ground=localHeight(local,x0,y0)
  if(!Number.isFinite(ground))throw new Error('The local DEM has no complete bilinear height support at this observer. No baseline ground height is substituted.')
  if(R+ground<=0)throw new Error('Local heights imply a nonpositive lunar radius. Check source units and vertical datum.')
  const baseline=(x:number,y:number,d:number,la:number,lo:number):[number,'nearSamples'|'farSamples'|'globeSamples']=>{
    if(d<25000){const v=sampleGrid(near,x,y);if(Number.isFinite(v))return [v,'nearSamples']}
    const v=sampleGrid(far,x,y);if(Number.isFinite(v))return [v,'farSamples']
    return [globe?.(la,lo)??NaN,'globeSamples']
  }
  const la=lat*Math.PI/180,lo=lon*Math.PI/180,background=baseline(x0,y0,0,la,lo)[0],sigma=localHeight(local,x0,y0,'heightRms')
  const result:CompositeSky={horizons:{},groundM:ground,baselineGroundM:Number.isFinite(background)?background:null,heightRmsM:Number.isFinite(sigma)&&sigma>=0?sigma:null,
    bins:nAz,localSamples:0,nearSamples:0,farSamples:0,globeSamples:0,missingSamples:0,localGapFallbacks:0,localDeltaMinM:null,localDeltaMaxM:null}
  const cornerX=[local.x0,local.x0+(local.cols-1)*local.stepM],cornerY=[local.y0,local.y0-(local.rows-1)*local.stepM]
  let range=0;for(const x of cornerX)for(const y of cornerY)range=Math.max(range,Math.hypot(x-x0,y-y0))
  const distances=Array.from(rayDistances()),step=Math.max(.5,local.stepM/2)
  for(let d=step;d<=range+local.stepM;d+=step)distances.push(d)
  distances.sort((a,b)=>a-b);const D=distances.filter((v,i)=>!i||v-distances[i-1]>1e-7),sin=D.map(v=>Math.sin(v/R)),cos=D.map(v=>Math.cos(v/R)),sl=Math.sin(la),cl=Math.cos(la),so=Math.sin(lo),co=Math.cos(lo)
  const bins=heights.map(()=>new Float64Array(nAz).fill(-Math.PI/2))
  for(let j=0;j<nAz;j++) {
    const az=(j+.5)*2*Math.PI/nAz,sa=Math.sin(az),ca=Math.cos(az),tx=-sl*co*ca-so*sa,ty=-sl*so*ca+co*sa,tz=cl*ca
    for(let i=0;i<D.length;i++) {
      // Rotate observer-up toward its azimuth tangent in 3D. The usual
      // destination-longitude formula divides two cancelling terms at a pole.
      const vx=cl*co*cos[i]+tx*sin[i],vy=cl*so*cos[i]+ty*sin[i],vz=sl*cos[i]+tz*sin[i]
      const x=2*R*vy/(1-vz),y=2*R*vx/(1-vz),la2=Math.atan2(vz,Math.hypot(vx,vy)),lo2=Math.atan2(vy,vx)
      const fine=D[i]<=range+local.stepM?localHeight(local,x,y):NaN
      let h=fine
      if(Number.isFinite(fine)) {
        result.localSamples++
        const base=baseline(x,y,D[i],la2,lo2)[0]
        if(Number.isFinite(base)){const delta=fine-base;result.localDeltaMinM=Math.min(result.localDeltaMinM??Infinity,delta);result.localDeltaMaxM=Math.max(result.localDeltaMaxM??-Infinity,delta)}
      } else {
        const [value,kind]=baseline(x,y,D[i],la2,lo2);h=value
        if(!Number.isFinite(h)){result.missingSamples++;continue}
        result[kind]++
        if(x>=cornerX[0]&&x<=cornerX[1]&&y<=cornerY[0]&&y>=cornerY[1])result.localGapFallbacks++
      }
      const rt=R+h
      if(rt<=0)throw new Error('Terrain height implies a nonpositive lunar radius. Check source units and vertical datum.')
      for(let k=0;k<heights.length;k++)bins[k][j]=Math.max(bins[k][j],Math.atan2(rt*cos[i]-(R+ground+heights[k]),rt*sin[i]))
    }
  }
  for(let k=0;k<heights.length;k++)result.horizons[String(heights[k])]=Array.from(bins[k],v=>Math.round(v*180/Math.PI*100))
  return result
}
export async function skyResultHash(lat:number,lon:number,groundM:number,horizons:Record<string,number[]>,slope:number|null,evidence:Omit<LocalSkyEvidence,'config'|'limits'>):Promise<string> {
  const text=JSON.stringify({lat,lon,groundM,horizons,slope,evidence}),bytes=new TextEncoder().encode(text)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')
}
