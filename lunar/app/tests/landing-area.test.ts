import {describe,it,expect} from 'vitest'
import {DEFAULT_AREA,footprintRadii,terrainArea,TerrainGrid} from '../src/lib/landing-area'

const grid=(rows:number,cols:number,stepM=5):TerrainGrid=>({rows,cols,stepM,x0:-(cols-1)*stepM/2,y0:(rows-1)*stepM/2,
  slope:new Float32Array(rows*cols).fill(2),slopeRms:new Float32Array(rows*cols).fill(1),returns:new Float32Array(rows*cols).fill(0),height:new Float32Array(rows*cols).fill(1000),heightRms:new Float32Array(rows*cols).fill(.4)})

describe('source-cell terrain areas and physical footprint geometry',()=>{
  it('measures pixel edges instead of unsafe distances to bad cell centres',()=>{
    expect(Array.from(footprintRadii(new Uint8Array([1]),1,1,5))).toEqual([2.5])
    const mask=new Uint8Array(25).fill(1);mask[0]=0
    const r=footprintRadii(mask,5,5,5)
    expect(r[6]).toBeCloseTo(Math.hypot(2.5,2.5),12)
    expect(r[12]).toBeCloseTo(Math.hypot(7.5,7.5),12)
    expect(r[1]).toBe(2.5)
  })
  it('matches a separate exhaustive point-to-rectangle oracle on random grids',()=>{
    let seed=117
    for(let trial=0;trial<60;trial++) {
      const rows=3+trial%7,cols=4+trial%6,mask=Uint8Array.from({length:rows*cols},()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32>.25?1:0})
      const actual=footprintRadii(mask,rows,cols,7)
      for(let k=0;k<mask.length;k++) {
        if(!mask[k]) {expect(actual[k]).toBe(0);continue}
        const y=Math.floor(k/cols)+.5,x=k%cols+.5
        let expected=Math.min(x,cols-x,y,rows-y)
        for(let j=0;j<mask.length;j++)if(!mask[j]) {
          const r=Math.floor(j/cols),c=j%cols
          expected=Math.min(expected,Math.hypot(Math.max(c-x,0,x-c-1),Math.max(r-y,0,y-r-1)))
        }
        expect(actual[k]).toBeCloseTo(expected*7,10)
      }
    }
  })
  it('keeps corner-only islands separate and screens the whole requested disc',()=>{
    const g=grid(3,3);g.slope.fill(20);g.slope[0]=g.slope[4]=g.slope[8]=2
    const r=terrainArea(g,0,0,10,{...DEFAULT_AREA,diameterM:6})
    expect(r.components).toBe(3);expect(r.largestConnectedM2).toBe(25)
    expect(r.mapAreaM2).toBe(75);expect(r.best?.radiusM).toBe(2.5);expect(r.fittingCentres).toBe(0)
    expect(terrainArea(g,0,0,10,{...DEFAULT_AREA,diameterM:5}).fittingCentres).toBe(3)
  })
  it('RMS stress and measured-return requirements never invent eligible ground',()=>{
    const g=grid(5,5);g.slope[12]=9.5;g.returns[6]=3
    const nominal=terrainArea(g,0,0,10,{...DEFAULT_AREA,rmsMultiplier:0})
    const stressed=terrainArea(g,0,0,10,DEFAULT_AREA)
    const returns=terrainArea(g,0,0,10,{...DEFAULT_AREA,requireReturns:true})
    expect(nominal.eligible).toBe(25);expect(stressed.eligible).toBe(24);expect(returns.eligible).toBe(1)
    expect(stressed.best!.radiusM).toBeLessThanOrEqual(nominal.best!.radiusM)
    expect(returns.best!.radiusM).toBeLessThanOrEqual(stressed.best!.radiusM)
    expect(nominal.directReturns).toBe(1)
    g.slopeRms[6]=NaN
    expect(terrainArea(g,0,0,10,{...DEFAULT_AREA,requireReturns:true}).eligible).toBe(0)
  })
  it('unknown values and the analysis boundary block footprints and count separately',()=>{
    const g=grid(201,201);g.slope[201*100+100]=NaN
    const r=terrainArea(g,0,0,10,DEFAULT_AREA)
    expect(r.inCircle).toBeLessThan(201*201)
    expect(r.known).toBe(r.inCircle-1);expect(r.eligible).toBe(r.known)
    for(let k=0;k<r.mask.length;k++)if(r.mask[k]) {
      const x=g.x0+k%g.cols*5,y=g.y0-Math.floor(k/g.cols)*5
      expect(Math.hypot(Math.abs(x)+2.5,Math.abs(y)+2.5)).toBeLessThanOrEqual(500)
    }
  })
})
