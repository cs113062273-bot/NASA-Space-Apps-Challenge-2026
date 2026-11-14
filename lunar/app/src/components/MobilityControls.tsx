import {useEffect,useState} from 'react'
import {DEFAULT_MOBILITY,MobilitySettings,SOILS,Soil,validMobility} from '../lib/mobility'

export function MobilityControls({value,onChange}:{value:MobilitySettings|undefined;onChange:(v:MobilitySettings|undefined)=>void}){
  const matched=SOILS.find(s=>JSON.stringify(s.soil)===JSON.stringify(value?.soil)),[custom,setCustom]=useState(!!value&&!matched)
  useEffect(()=>{if(!value)setCustom(false)},[value])
  const m=value??DEFAULT_MOBILITY,set=(p:Partial<MobilitySettings>)=>onChange({...m,...p})
  const field=(label:string,key:Exclude<keyof MobilitySettings,'version'|'soil'|'wheelCount'>,min:number,max:number,step:number)=><label className="field"><span>{label}</span><input className="input num" aria-label={label} type="number" min={min} max={max} step={step} value={m[key]} onChange={e=>{const v=Number(e.target.value);if(Number.isFinite(v))set({[key]:Math.max(min,Math.min(max,key==='grouserCount'?Math.round(v):v))})}}/></label>
  const soilField=(label:string,key:keyof Soil,min:number,max:number,step:number)=><label className="field"><span>{label}</span><input className="input num" aria-label={label} type="number" min={min} max={max} step={step} value={m.soil[key]} onChange={e=>{const v=Number(e.target.value);if(Number.isFinite(v))set({soil:{...m.soil,[key]:Math.max(min,Math.min(max,v))}})}}/></label>
  return <div className="mobility-controls" data-testid="mobility-controls">
    <label className="mobility-toggle"><input type="checkbox" checked={!!value} onChange={e=>onChange(e.target.checked?{...DEFAULT_MOBILITY,soil:{...DEFAULT_MOBILITY.soil}}:undefined)}/>Calculate drive power from vehicle & soil</label>
    {value&&<>
      <p className="model-note">Illustrative vehicle and uniform soil assumptions. Replace them with your vehicle values. Wheel demand replaces the manual extra-drive wattage; the main base load and radio still apply. A rejected segment stops the modeled trip before entering it.</p>
      <div className="traverse-controls">
        {field('Total rover mass (kg)','massKg',.1,500,.1)}
        <label className="field"><span>Driven wheels</span><select className="input" aria-label="Driven wheels" value={m.wheelCount} onChange={e=>set({wheelCount:Number(e.target.value) as 4|6})}><option value="4">4 equally loaded wheels</option><option value="6">6 equally loaded wheels</option></select></label>
        <label className="field"><span>Soil assumption</span><select className="input" aria-label="Soil assumption" value={custom||!matched?'custom':matched.id} onChange={e=>{const next=SOILS.find(s=>s.id===e.target.value);setCustom(!next);if(next)set({soil:{...next.soil}})}}>{SOILS.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}<option value="custom">Custom soil parameters</option></select></label>
      </div>
      <details className="model-details"><summary>Wheels, drivetrain & mobility limits</summary><div className="traverse-controls">
        {field('Wheel radius (m)','radiusM',.05,.2,.005)}{field('Wheel width (m)','widthM',.03,.2,.005)}
        {field('Grouser height (m)','grouserHeightM',0,.02,.001)}{field('Grousers per wheel','grouserCount',0,24,1)}
        {field('Drivetrain efficiency','efficiency',.01,1,.01)}{field('Maximum hub torque (Nm)','maxHubTorqueNm',.001,100,.01)}
        {field('Maximum wheel speed (rpm)','maxWheelRpm',.01,1000,.1)}{field('Maximum absolute slip','maxAbsSlip',0,.95,.01)}
        {field('Maximum sinkage / radius','maxSinkageRatio',.01,1,.01)}{field('Total brake dissipation limit (W)','maxBrakeW',0,1e6,1)}
        {field('Soil shear strength factor','shearScale',.1,2,.05)}
      </div></details>
      {custom&&<details className="model-details" open><summary>Custom soil parameters</summary><div className="traverse-controls">
        {soilField('Sinkage exponent n','n',.1,2,.01)}{soilField('Cohesive modulus kc (kN/mⁿ⁺¹)','kC',-1000,1e6,.1)}{soilField('Frictional modulus kφ (kN/mⁿ⁺²)','kPhi',0,1e6,1)}
        {soilField('Soil cohesion (kPa)','cohesionKpa',0,100,.01)}{soilField('Soil friction angle (°)','frictionDeg',0,60,1)}{soilField('Shear deformation length K (m)','shearLengthM',.0001,1,.001)}
      </div><p className="model-note">The effective modulus kc / wheel width + kφ must be positive. Negative fitted kc is permitted only with a positive effective modulus.</p></details>}
      {!validMobility(value)&&<p className="bad" role="alert">Vehicle or soil inputs are outside the supported model. Check the limits and positive effective soil modulus before running.</p>}
      <p className="model-note">Straight steady travel with nominal edge heights and equal wheel loads. Soil presets come from the pinned RoverDevKit catalogue; they are not measurements of this route. No regenerative charging is credited. Turning, cross-slope stability, load transfer, soil variation and measured vehicle performance remain unresolved.</p>
    </>}
  </div>
}
