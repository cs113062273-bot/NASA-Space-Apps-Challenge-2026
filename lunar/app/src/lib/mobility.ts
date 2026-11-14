/** Rigid-wheel Bekker–Wong / Janosi–Hanamoto engineering screen.
 * Adapted from the reviewed MIT RoverDevKit wheel kernel at commit
 * ec0b198f01bca4c8ce2892577e72e9c9c65914b5. See THIRD_PARTY_NOTICES.md.
 * Equal wheel loads, homogeneous assumed soil and straight steady travel only.
 */
export interface Soil {
  n:number;kC:number;kPhi:number;cohesionKpa:number;frictionDeg:number;shearLengthM:number
}
export interface MobilitySettings {
  version:1;massKg:number;wheelCount:4|6;radiusM:number;widthM:number;grouserHeightM:number;grouserCount:number
  efficiency:number;maxHubTorqueNm:number;maxWheelRpm:number;maxAbsSlip:number;maxSinkageRatio:number;maxBrakeW:number;shearScale:number;soil:Soil
}
export const SOILS:{id:string;name:string;soil:Soil}[]=[
  {id:'nominal',name:'Assumed nominal regolith',soil:{n:1,kC:1.4,kPhi:820,cohesionKpa:.17,frictionDeg:46,shearLengthM:.018}},
  {id:'loose',name:'Assumed loose regolith',soil:{n:1,kC:.5,kPhi:400,cohesionKpa:.1,frictionDeg:30,shearLengthM:.018}},
  {id:'dense',name:'Assumed dense regolith',soil:{n:1.2,kC:2,kPhi:1200,cohesionKpa:.5,frictionDeg:50,shearLengthM:.018}}
]
export const DEFAULT_MOBILITY:MobilitySettings={version:1,massKg:20,wheelCount:4,radiusM:.1,widthM:.05,grouserHeightM:.005,grouserCount:12,efficiency:.8,maxHubTorqueNm:2,maxWheelRpm:30,maxAbsSlip:.8,maxSinkageRatio:.5,maxBrakeW:5,shearScale:1,soil:{...SOILS[0].soil}}
const within=(x:unknown,a:number,b:number):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b
const keys=(p:object,expected:object)=>Object.keys(p).sort().join()===Object.keys(expected).sort().join()
export function validMobility(p:unknown):p is MobilitySettings {
  const m=p as MobilitySettings,s=m?.soil
  return !!m&&keys(m,DEFAULT_MOBILITY)&&m.version===1&&within(m.massKg,.1,500)&&[4,6].includes(m.wheelCount)&&within(m.radiusM,.05,.2)&&within(m.widthM,.03,.2)
    &&within(m.grouserHeightM,0,.02)&&Number.isInteger(m.grouserCount)&&within(m.grouserCount,0,24)&&within(m.efficiency,.01,1)&&within(m.maxHubTorqueNm,.001,100)
    &&within(m.maxWheelRpm,.01,1000)&&within(m.maxAbsSlip,0,.95)&&within(m.maxSinkageRatio,.01,1)&&within(m.maxBrakeW,0,1e6)&&within(m.shearScale,.1,2)
    &&!!s&&keys(s,SOILS[0].soil)&&within(s.n,.1,2)&&within(s.kC,-1000,1e6)&&within(s.kPhi,0,1e6)&&s.kC/m.widthM+s.kPhi>0
    &&within(s.cohesionKpa,0,100)&&within(s.frictionDeg,0,60)&&within(s.shearLengthM,.0001,1)
}
export interface MobilityResult {
  feasible:boolean;issues:string[];gradeDeg:number;normalPerWheelN:number;requiredDrawbarPerWheelN:number
  slip:number|null;torqueNm:number|null;sinkageM:number|null;wheelRpm:number|null;driveDcW:number|null;motorLossW:number|null;brakeW:number|null;balanceResidualN:number|null;quadrature:number
}
export interface WheelForce {drawbarN:number;torqueNm:number;sinkageM:number;normalN:number}
function bisect(f:(x:number)=>number,lo:number,hi:number,tolerance:number):number|null {
  let a=f(lo),b=f(hi)
  if(!Number.isFinite(a)||!Number.isFinite(b))throw new Error('Wheel/soil model has a non-finite balance')
  if(a===0)return lo;if(b===0)return hi;if(a*b>0)return null
  for(let i=0;i<80;i++){
    const mid=(lo+hi)/2,v=f(mid)
    if(!Number.isFinite(v))throw new Error('Wheel/soil model has a non-finite balance')
    if(v===0||hi-lo<tolerance)return mid
    if((v<0)===(a<0)){lo=mid;a=v}else {hi=mid;b=v}
  }
  throw new Error('Wheel/soil balance did not converge')
}
/** Same declared stress/heuristic equations as the pinned reference. Bisection
 * replaces SciPy Brent; the refined run doubles trapezoidal quadrature. */
export function wheelForces(m:MobilitySettings,loadN:number,slip:number,quadrature=100):WheelForce {
  if(!(loadN>0)||!Number.isFinite(loadN)||!within(slip,-.9,.95)||![100,200].includes(quadrature))throw new Error('Invalid wheel force inputs')
  const s=m.soil,r=m.radiusM,b=m.widthM,k=(s.kC/b+s.kPhi)*1000,cohesion=s.cohesionKpa*1000,tanPhi=Math.tan(s.frictionDeg*Math.PI/180)
  const lift=1+Math.min(.6,m.grouserCount*m.grouserHeightM/(2*Math.PI*r))
  const integrate=(entry:number)=>{
    const peak=(.4+.2*Math.abs(slip))*entry,ce=Math.cos(entry),se=Math.sin(entry),step=entry/(quadrature-1)
    let normal=0,drawbar=0,torque=0
    for(let i=0;i<quadrature;i++){
      const theta=i*step,c=Math.cos(theta),sn=Math.sin(theta),mapped=theta>=peak?theta:entry-theta/peak*(entry-peak)
      const sigma=k*r**s.n*Math.max(0,Math.cos(mapped)-ce)**s.n,j=r*((entry-theta)-(1-slip)*(se-sn))
      const tau=(cohesion+sigma*tanPhi)*(-Math.expm1(-Math.abs(j)/s.shearLengthM))*Math.sign(j)*lift*m.shearScale
      const weight=i===0||i===quadrature-1?.5:1
      normal+=weight*(sigma*c+tau*sn);drawbar+=weight*(tau*c-sigma*sn);torque+=weight*tau
    }
    const factor=b*r*step
    return {normalN:normal*factor,drawbarN:drawbar*factor,torqueNm:torque*factor*r,sinkageM:r*(1-ce)}
  }
  const entry=bisect(theta=>integrate(theta).normalN-loadN,1e-5,Math.PI/2-1e-4,1e-10)
  if(entry===null)throw new Error('No bracketed normal-load solution in the rigid-wheel model; no drive feasibility is inferred')
  return integrate(entry)
}
export function solveMobility(m:MobilitySettings,gradeDeg:number,mapSpeedMps:number,refined=false):MobilityResult {
  if(!validMobility(m)||!within(gradeDeg,-70,70)||!within(mapSpeedMps,.001,1))throw new Error('Invalid wheel/soil assumptions or route grade')
  const angle=gradeDeg*Math.PI/180,weight=m.massKg*1.62/m.wheelCount,load=weight*Math.cos(angle),required=weight*Math.sin(angle),quadrature=refined?200:100
  const result:MobilityResult={feasible:false,issues:[],gradeDeg,normalPerWheelN:load,requiredDrawbarPerWheelN:required,slip:null,torqueNm:null,sinkageM:null,wheelRpm:null,driveDcW:null,motorLossW:null,brakeW:null,balanceResidualN:null,quadrature}
  // Endpoint sign change is a bracketed-solution screen, not a proof that the
  // nonlinear model has no other root. Unknown normal balance throws visibly.
  const slip=bisect(s=>wheelForces(m,load,s,quadrature).drawbarN-required,-.9,.95,1e-9)
  if(slip===null)return {...result,issues:['no bracketed drawbar solution']}
  const f=wheelForces(m,load,slip,quadrature),speed=mapSpeedMps/Math.cos(angle),omega=speed/(m.radiusM*(1-slip)),mechanical=m.wheelCount*f.torqueNm*omega
  const drive=Math.max(0,mechanical)/m.efficiency,loss=drive-Math.max(0,mechanical),brake=Math.max(0,-mechanical),rpm=omega*60/(2*Math.PI),issues:string[]=[]
  if(Math.abs(slip)>m.maxAbsSlip+1e-8)issues.push('slip limit')
  if(Math.abs(f.torqueNm)>m.maxHubTorqueNm+1e-8)issues.push('hub torque limit')
  if(rpm>m.maxWheelRpm+1e-8)issues.push('wheel speed limit')
  if(f.sinkageM>m.radiusM*m.maxSinkageRatio+1e-9)issues.push('sinkage limit')
  if(brake>m.maxBrakeW+1e-8)issues.push('brake dissipation limit')
  return {...result,feasible:!issues.length,issues,slip,torqueNm:f.torqueNm,sinkageM:f.sinkageM,wheelRpm:rpm,driveDcW:drive,motorLossW:loss,brakeW:brake,balanceResidualN:f.drawbarN-required}
}

export const MOBILITY_METHOD={id:'lastlight-rigid-wheel-v1',reference:'https://github.com/Complex-Systems-Design-Lab/roverdevkit',commit:'ec0b198f01bca4c8ce2892577e72e9c9c65914b5',license:'MIT',
  limits:['Uniform user-assumed soil, equal wheel loads and straight steady-state travel; 1.62 m/s² lunar gravity. No measured soil map or vehicle qualification.',
    'Nominal adjacent source heights set longitudinal grade in projected-map metres. Surface speed is map speed / cos(grade); map distortion, local cross-slope, load transfer, stability, turns, acceleration, wheel flex and sub-grid hazards remain unresolved.',
    'Rigid-wheel stress equations and capped grouser shear heuristic follow the pinned reference; source soil presets and shear factor are assumptions, not registered local measurements or confidence bounds.',
    'A bracketed drawbar solution is checked against selected slip, hub torque, wheel RPM, sinkage and total mechanical brake dissipation. The torque/RPM envelope is rectangular; no motor curve or thermal brake rating is established.',
    'Positive wheel work / selected drivetrain efficiency sets drive DC. Negative wheel work is dissipated outside the equipment node; no regenerative charge is credited. Selected motor-loss heat fraction joins the existing node before its waste-heat fraction.',
    'All four moving runs use the same declared soil/shear assumptions; refinement doubles wheel quadrature from 100 to 200. Raised skyline does not establish soil or height uncertainty coverage. No alternative spatial route or adaptive speed is inferred.']}
