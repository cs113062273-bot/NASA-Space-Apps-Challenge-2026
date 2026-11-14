import {Ephemeris} from './astro'
// Engineering sensitivity margins for the new interpolation, not confidence
// bounds. Independent sub-hour SPICE residuals are retained in the test fixture.
export const MOVING_GROUND_INTERPOLATION_GUARD_DEG=.01
export const MOVING_AIM_INTERPOLATION_GUARD_DEG=.0005

/** Four-point Lagrange interpolation of the retained hourly vectors. This is
 * interpolation, not new sub-hour SPICE data. No extrapolation is permitted. */
export function intervalEphemeris(eph:Ephemeris,startUnix:number,stepS:number):Ephemeris {
  if(!Number.isFinite(startUnix)||!Number.isFinite(stepS)||stepS<=0||eph.count<4||startUnix<eph.startUnix-1e-6||startUnix+stepS>eph.startUnix+(eph.count-1)*eph.stepS+1e-6)throw new Error('Traverse interval lies outside retained ephemeris coverage')
  const interpolate=(source:Float32Array,stride:number,unix:number)=>{
    const x=Math.max(0,Math.min(eph.count-1,(unix-eph.startUnix)/eph.stepS)),first=Math.max(0,Math.min(eph.count-4,Math.floor(x)-1)),u=x-first
    const weights=Array.from({length:4},(_,i)=>{let w=1;for(let j=0;j<4;j++)if(j!==i)w*=(u-j)/(i-j);return w})
    return Array.from({length:stride},(_,k)=>weights.reduce((v,w,i)=>v+w*source[(first+i)*stride+k],0))
  }
  const o=eph.stations?.orientation
  const data=new Float32Array(12),stations=eph.stations&&o?{...eph.stations,orientation:{...o,
    recent_ground_stress_deg:o.recent_ground_stress_deg+MOVING_GROUND_INTERPOLATION_GUARD_DEG,long_term_ground_stress_deg:o.long_term_ground_stress_deg+MOVING_GROUND_INTERPOLATION_GUARD_DEG,
    recent_aim_stress_deg:o.recent_aim_stress_deg+MOVING_AIM_INTERPOLATION_GUARD_DEG,long_term_aim_stress_deg:o.long_term_aim_stress_deg+MOVING_AIM_INTERPOLATION_GUARD_DEG},data:new Float32Array(54)}:undefined
  const dsn=eph.dsn?new Uint8Array(2):undefined
  for(let i=0;i<2;i++){
    const unix=startUnix+i*stepS;data.set(interpolate(eph.data,6,unix),i*6)
    if(stations&&eph.stations){
      const values=interpolate(eph.stations.data,27,unix)
      for(let j=0;j<3;j++){const k=j*9+6,norm=Math.hypot(values[k],values[k+1],values[k+2]);if(!Number.isFinite(norm)||norm<=0)throw new Error('Invalid interpolated station zenith');for(let a=0;a<3;a++)values[k+a]/=norm}
      stations.data.set(values,i*27)
    }
    if(dsn&&eph.dsn)dsn[i]=eph.dsn[Math.max(0,Math.min(eph.count-1,Math.floor((unix-eph.startUnix)/eph.stepS)))]
  }
  return {...eph,startUnix,stepS,count:2,data,stations,dsn}
}
