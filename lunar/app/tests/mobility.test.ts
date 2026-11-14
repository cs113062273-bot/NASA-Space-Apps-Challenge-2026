import {describe,it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {DEFAULT_MOBILITY,SOILS,solveMobility,validMobility,wheelForces} from '../src/lib/mobility'

const json=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'))
describe('declared rigid-wheel model and actual pinned comparator outputs',()=>{
  it('matches the 15 executed publisher soil/slope probes within its source solver precision',()=>{
    const ref=json('../../data/validation/competitor-roverdevkit-mobility.json'),manifest=new URL('../../data/validation/competitor-roverdevkit-source.json',import.meta.url)
    expect(createHash('sha256').update(readFileSync(manifest)).digest('hex')).toBe(ref.sourceManifestSha256)
    for(const c of ref.cases){
      const s=c.soilParameters,model={...DEFAULT_MOBILITY,soil:{n:s.n,kC:s.k_c,kPhi:s.k_phi,cohesionKpa:s.cohesion_kpa,frictionDeg:s.friction_angle_deg,shearLengthM:s.shear_modulus_k_m}}
      // The probe prescribes surface speed; the application prescribes map speed.
      const result=solveMobility(model,c.slopeDeg,.01*Math.cos(c.slopeDeg*Math.PI/180))
      if(c.slip===null){expect(result.issues).toContain('no bracketed drawbar solution');expect(result.driveDcW).toBeNull()}
      else {
        expect(result.feasible).toBe(true);expect(result.slip).toBeCloseTo(c.slip,4)
        expect(result.torqueNm).toBeCloseTo(c.perWheel.driving_torque_nm,4);expect(result.sinkageM).toBeCloseTo(c.perWheel.sinkage_m,5)
        expect(result.driveDcW).toBeCloseTo(c.driveDcW,4);expect(Math.abs(result.balanceResidualN!)).toBeLessThan(1e-5)
      }
    }
  })
  it('uses explicit torque, speed, slip and burial limits instead of free motion at a chosen wattage',()=>{
    const m=DEFAULT_MOBILITY
    expect(solveMobility({...m,maxHubTorqueNm:.001},0,.01).issues).toContain('hub torque limit')
    expect(solveMobility({...m,maxWheelRpm:.01},0,.01).issues).toContain('wheel speed limit')
    expect(solveMobility({...m,maxAbsSlip:0},0,.01).issues).toContain('slip limit')
    expect(solveMobility({...m,maxSinkageRatio:.01},0,.01).issues).toContain('sinkage limit')
    expect(solveMobility({...m,soil:SOILS[1].soil},10,.01).feasible).toBe(false)
  })
  it('keeps downhill brake work out of battery generation and checks its dissipation limit',()=>{
    const m=DEFAULT_MOBILITY,r=solveMobility(m,-20,.01)
    expect(r.brakeW).toBeGreaterThan(0);expect(r.driveDcW).toBe(0);expect(r.motorLossW).toBe(0)
    expect(solveMobility({...m,maxBrakeW:0},-20,.01).issues).toContain('brake dissipation limit')
    const up=solveMobility(m,10,.01)
    expect(up.driveDcW!-up.motorLossW!).toBeCloseTo(m.wheelCount*up.torqueNm!*up.wheelRpm!*2*Math.PI/60,8)
  })
  it('refines force quadrature and rejects invalid or unsupported assumptions visibly',()=>{
    const a=solveMobility(DEFAULT_MOBILITY,5,.01),b=solveMobility(DEFAULT_MOBILITY,5,.01,true)
    expect(a.quadrature).toBe(100);expect(b.quadrature).toBe(200);expect(Math.abs(a.driveDcW!-b.driveDcW!)).toBeLessThan(.001)
    expect(validMobility({...DEFAULT_MOBILITY,massKg:NaN})).toBe(false)
    expect(validMobility({...DEFAULT_MOBILITY,soil:{...DEFAULT_MOBILITY.soil,kC:-1000,kPhi:1}})).toBe(false)
    expect(()=>wheelForces(DEFAULT_MOBILITY,0,0)).toThrow();expect(()=>solveMobility(DEFAULT_MOBILITY,80,.01)).toThrow()
  })
})
