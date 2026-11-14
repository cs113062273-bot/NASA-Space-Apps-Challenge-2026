import {describe,it,expect} from 'vitest'
import {DEFAULT_ROUTE,edgeFits,planTerrainRoute,segmentRectangleDistance} from '../src/lib/terrain-route'
import {footprintRadii,TerrainGrid} from '../src/lib/landing-area'
import {toLatLon} from '../src/lib/data'
import {toXY} from '../src/lib/data'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {terrainArea,DEFAULT_AREA} from '../src/lib/landing-area'
import {DEFAULT_POWER} from '../src/lib/power'
import {DEFAULT_REQ} from '../src/lib/requirements'
import {encodeShare,decodeShare,DEFAULT_PINS} from '../src/lib/share'

function fixture(rows=7,cols=7,stepM=5) {
  const n=rows*cols,mask=new Uint8Array(n).fill(1),grid:TerrainGrid={rows,cols,stepM,x0:0,y0:0,height:new Float32Array(n),heightRms:new Float32Array(n),slope:new Float32Array(n),slopeRms:new Float32Array(n),returns:new Float32Array(n).fill(1)}
  return {grid,mask,screen:()=>({mask,radiusM:footprintRadii(mask,rows,cols,stepM)}),point:(r:number,c:number)=>toLatLon(c*stepM,-r*stepM)}
}
describe('full-width static terrain routes',()=>{
  it('matches independent GEOS edge certificates and directed SciPy Dijkstra optima on synthetic and real-source graphs',async()=>{
    const ref=JSON.parse(readFileSync(new URL('./fixtures/terrain-route.json',import.meta.url),'utf8')),root=new URL('../public/data/landing-terrain/',import.meta.url),indexText=readFileSync(new URL('index.json',root),'utf8'),index=JSON.parse(indexText)
    expect(createHash('sha256').update(indexText).digest('hex')).toBe(ref.nativeIndexSha256)
    expect(createHash('sha256').update(readFileSync(new URL('../../pipeline/build_route_reference.py',import.meta.url))).digest('hex')).toBe(ref.codeSha256)
    for(const test of [...ref.cases,...ref.native]) {
      let g:TerrainGrid,screen:{mask:Uint8Array;radiusM:Float64Array},mission:{lat:number;lon:number}
      if(test.id) {
        const meta=index.patches.find((p:any)=>p.id===test.id),bytes=readFileSync(new URL(meta.file,root)),n=meta.rows*meta.cols,view=new DataView(new Uint8Array(bytes).buffer),f=Array.from({length:5},(_,j)=>Float32Array.from({length:n},(_,k)=>view.getFloat32((j*n+k)*4,true)))
        expect(meta.sha256).toBe(test.patchSha256)
        g={...meta,slope:f[0],slopeRms:f[1],returns:f[2],height:f[3],heightRms:f[4]};mission=meta.site
        const [x,y]=toXY(mission.lat,mission.lon);screen=terrainArea(g,x,y,10,DEFAULT_AREA)
      } else {
        const f=fixture(test.rows,test.cols,test.stepM);g=f.grid;g.height=Float32Array.from(test.height);g.heightRms=Float32Array.from(test.heightRms);f.mask.set(test.mask);screen=f.screen();mission={lat:-90,lon:0}
      }
      const point=(k:number)=>toLatLon(g.x0+k%g.cols*g.stepM,g.y0-Math.floor(k/g.cols)*g.stepM)
      const p={...DEFAULT_ROUTE,...test.settings,start:point(test.start),goal:point(test.goal)},actual=await planTerrainRoute(g,screen,mission,p,{yieldTask:()=>Promise.resolve()})
      expect(actual.status).toBe(test.reference.status)
      if(actual.status==='found') {
        expect(actual.cost).toBeCloseTo(test.reference.cost,7)
        expect(actual.nodes[0].index).toBe(test.start);expect(actual.nodes.at(-1)!.index).toBe(test.goal)
        for(let k=1;k<actual.nodes.length;k++) {
          const u=actual.nodes[k-1].index,v=actual.nodes[k].index,dr=Math.floor(v/g.cols)-Math.floor(u/g.cols),dc=v%g.cols-u%g.cols,d=ref.directions.findIndex(([r,c]:number[])=>r===dr&&c===dc)
          expect(d).toBeGreaterThanOrEqual(0);expect(test.reference.allowedDirections[u]&(1<<d),`${test.id??'synthetic'} edge ${u}→${v}`).not.toBe(0)
        }
      }
    }
    for(const d of ref.distances)expect(segmentRectangleDistance({x:d.a[0],y:d.a[1]},{x:d.b[0],y:d.b[1]},...d.bounds as [number,number,number,number])).toBeCloseTo(d.distance,9)
  })
  it('checks the swept segment when both endpoint discs fit but an obstacle lies closer to its middle',()=>{
    const f=fixture();f.mask[1*7+2]=0;const screen=f.screen(),u=3*7+3,v=2*7+4
    expect(screen.radiusM[u]).toBeGreaterThan(7.5);expect(screen.radiusM[v]).toBeGreaterThan(7.5)
    expect(segmentRectangleDistance({x:15,y:-15},{x:20,y:-10},7.5,-7.5,12.5,-2.5)).toBeCloseTo(Math.sqrt(50),12)
    expect(edgeFits(f.grid,screen,u,v,7.5)).toBe(false);expect(edgeFits(f.grid,screen,u,v,7)).toBe(true)
    expect(segmentRectangleDistance({x:0,y:0},{x:5,y:5},1,1,2,2)).toBe(0)
  })
  it('does not cut unknown corners or silently move a rejected endpoint to a nearby valid cell',async()=>{
    const f=fixture();f.mask.fill(0);f.mask[3*7+3]=f.mask[2*7+4]=1
    const [lat,lon]=f.point(3,3),p={...DEFAULT_ROUTE,start:f.point(3,3),goal:f.point(2,4),widthM:0,heightRmsMultiplier:0}
    const blocked=await planTerrainRoute(f.grid,f.screen(),{lat,lon},p)
    expect(blocked.status).toBe('blocked');expect(blocked.cost).toBeNull();expect(blocked.mapLengthM).toBeNull()
    p.goal=f.point(2,3)
    expect((await planTerrainRoute(f.grid,f.screen(),{lat,lon},p)).issue).toMatch(/endpoint cell fails/)
  })
  it('distinguishes width, grade stress and missing height RMS from nominal graph connectivity',async()=>{
    const f=fixture(),[lat,lon]=f.point(3,1),p={...DEFAULT_ROUTE,start:f.point(3,1),goal:f.point(3,5),widthM:0,heightRmsMultiplier:0}
    const nominal=await planTerrainRoute(f.grid,f.screen(),{lat,lon},p)
    expect(nominal.status).toBe('found');expect(nominal.mapLengthM).toBeCloseTo(20,10)
    f.grid.heightRms.fill(2)
    expect((await planTerrainRoute(f.grid,f.screen(),{lat,lon},{...p,heightRmsMultiplier:1})).status).toBe('blocked')
    f.grid.available={slopeRms:true,returns:true,heightRms:false}
    expect((await planTerrainRoute(f.grid,f.screen(),{lat,lon},{...p,heightRmsMultiplier:1})).status).toBe('unavailable')
    expect((await planTerrainRoute(f.grid,f.screen(),{lat,lon},{...p,widthM:100})).status).toBe('blocked')
  })
  it('preserves requested endpoints and explicit snap distance, can cancel and never invent outside terrain',async()=>{
    const f=fixture(),[lat,lon]=toLatLon(6.2,-16.5),p={...DEFAULT_ROUTE,goal:f.point(4,5),heightRmsMultiplier:0,widthM:0}
    const r=await planTerrainRoute(f.grid,f.screen(),{lat,lon},p)
    expect(r.status).toBe('found');expect(r.start!.requested).toEqual([lat,lon]);expect(r.start!.snapDistanceM).toBeCloseTo(Math.hypot(1.2,1.5),6)
    expect((await planTerrainRoute(f.grid,f.screen(),{lat,lon},{...p,goal:[0,0]})).status).toBe('unavailable')
    const controller=new AbortController();controller.abort()
    await expect(planTerrainRoute(f.grid,f.screen(),{lat,lon},p,{signal:controller.signal})).rejects.toThrow(/cancelled/)
  })
  it('shares route endpoints at full numeric precision and does not reinterpret the route as a mission PASS requirement',()=>{
    const route={...DEFAULT_ROUTE,start:[-89.4400123456789,222.8300123456789] as [number,number],goal:[-89.4412345678912,222.8312345678912] as [number,number],widthM:15,ascentCost:5}
    const q=encodeShare({site:'c1',date:1798761600,days:1,req:DEFAULT_REQ,h:2,ec:0,cmp:DEFAULT_PINS,pw:DEFAULT_POWER,route})
    expect(decodeShare(q.toString()).route).toEqual(route);expect(decodeShare(q.toString()).areaRequired).toBeUndefined()
    expect(decodeShare('?route='+encodeURIComponent(JSON.stringify({...route,widthM:-1}))).route).toBeUndefined()
  })
})
