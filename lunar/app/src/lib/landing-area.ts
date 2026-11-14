/** Connected terrain and centred footprint geometry on the actual source cells.
 * This is a slope/coverage screen, separate from mission-date light, power and data.
 */
export interface AreaSettings { diameterM:number;rmsMultiplier:number;requireReturns:boolean }
export const DEFAULT_AREA:AreaSettings={diameterM:100,rmsMultiplier:1,requireReturns:false}
export function validAreaSettings(x:unknown):x is AreaSettings {
  const s=x as AreaSettings
  return !!s&&typeof s==='object'&&Number.isFinite(s.diameterM)&&s.diameterM>=0&&s.diameterM<=1000
    &&[0,1,2].includes(s.rmsMultiplier)&&typeof s.requireReturns==='boolean'
}
export interface TerrainGrid {
  rows:number;cols:number;stepM:number;x0:number;y0:number
  slope:Float32Array;slopeRms:Float32Array;returns:Float32Array;height:Float32Array;heightRms:Float32Array
  available?:{slopeRms:boolean;returns:boolean;heightRms:boolean}
}
export interface AreaResult {
  inCircle:number;known:number;nominal:number;eligible:number;directReturns:number
  mapAreaM2:number;largestConnectedM2:number;components:number;fittingCentres:number
  best:{index:number;x:number;y:number;radiusM:number}|null
  mask:Uint8Array;radiusM:Float64Array;labels:Int32Array;largestLabel:number
}
export const wholeCellInCircle=(x:number,y:number,step:number,targetX:number,targetY:number)=>Math.hypot(Math.abs(x-targetX)+step/2,Math.abs(y-targetY)+step/2)<=500
export function terrainSourceIssue(g:TerrainGrid,s:AreaSettings):string|null {
  if(g.available&&!g.available.slopeRms&&s.rmsMultiplier!==0)return 'This DEM has no slope RMS layer. Select nominal slope explicitly or import a slope RMS layer.'
  if(g.available&&!g.available.returns&&s.requireReturns)return 'This DEM has no return-count layer. Import one or turn off the per-cell return requirement explicitly.'
  return null
}
export const terrainCellKnown=(g:TerrainGrid,k:number,s:AreaSettings=DEFAULT_AREA)=>!terrainSourceIssue(g,s)
  &&[g.slope[k],g.height[k]].every(Number.isFinite)&&g.slope[k]>=0&&g.slope[k]<=90
  &&(g.available?.slopeRms===false||Number.isFinite(g.slopeRms[k])&&g.slopeRms[k]>=0)
  &&(g.available?.returns===false||Number.isFinite(g.returns[k])&&g.returns[k]>=0)
  &&(g.available?.heightRms===false||Number.isFinite(g.heightRms[k])&&g.heightRms[k]>=0)
export function terrainCellAtPoint(grid:Pick<TerrainGrid,'rows'|'cols'|'stepM'|'x0'|'y0'>,x:number,y:number):number|null {
  const {rows,cols,stepM:s,x0,y0}=grid,left=x0-s/2,right=x0+(cols-.5)*s,top=y0+s/2,bottom=y0-(rows-.5)*s
  if(![x,y,left,right,top,bottom].every(Number.isFinite)||x<left||x>=right||y<=bottom||y>top)return null
  return Math.min(rows-1,Math.floor((top-y)/s))*cols+Math.floor((x-left)/s)
}

/** Exact disc radius at an arbitrary mission point, not the best nearby centre.
 * Invalid pixels are closed rectangles; the patch boundary is also limiting.
 */
export function radiusAtPoint(grid:Pick<TerrainGrid,'rows'|'cols'|'stepM'|'x0'|'y0'>,mask:Uint8Array,x:number,y:number):{radiusM:number;eligible:boolean} {
  const {rows,cols,stepM:s,x0,y0}=grid,left=x0-s/2,right=x0+(cols-.5)*s,top=y0+s/2,bottom=y0-(rows-.5)*s
  if(mask.length!==rows*cols||![x,y,left,right,top,bottom].every(Number.isFinite))throw new Error('Invalid mission-point footprint geometry')
  const cell=terrainCellAtPoint(grid,x,y)
  if(cell===null||!mask[cell])return {radiusM:0,eligible:false}
  let squared=Math.min(x-left,right-x,top-y,y-bottom)**2
  for(let k=0;k<mask.length;k++)if(!mask[k]) {
    const cx=x0+(k%cols)*s,cy=y0-Math.floor(k/cols)*s
    const dx=Math.max(Math.abs(cx-x)-s/2,0),dy=Math.max(Math.abs(cy-y)-s/2,0)
    squared=Math.min(squared,dx*dx+dy*dy)
  }
  return {radiusM:Math.sqrt(squared),eligible:true}
}

// Squared Euclidean distance to zero-valued lattice points, via the lower
// envelope of parabolas (Felzenszwalb/Huttenlocher). Finite sentinel avoids INF-INF.
function transform1d(f:Float64Array,n:number,out:Float64Array,v:Int32Array,z:Float64Array) {
  let k=0;v[0]=0;z[0]=-Infinity;z[1]=Infinity
  for(let q=1;q<n;q++) {
    let s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]))
    while(s<=z[k]) {k--;s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]))}
    v[++k]=q;z[k]=s;z[k+1]=Infinity
  }
  k=0
  for(let q=0;q<n;q++) {while(z[k+1]<q)k++;out[q]=(q-v[k])**2+f[v[k]]}
}

/** Exact distance, at valid cell CENTRES, to invalid closed pixel squares or
 * the grid boundary. Half-cell lattice includes every possible nearest point
 * (edge midpoint/corner); ordinary centre-to-centre EDT would overstate clearance.
 */
export function footprintRadii(mask:Uint8Array,rows:number,cols:number,stepM:number):Float64Array {
  if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<1||cols<1||rows>1024||cols>1024||mask.length!==rows*cols||!Number.isFinite(stepM)||stepM<=0)throw new Error('Invalid footprint grid')
  const nr=rows*2+1,nc=cols*2+1,m=Math.max(nr,nc),field=new Float64Array(nr*nc).fill(1e12)
  for(let r=0;r<nr;r++)field[r*nc]=field[r*nc+nc-1]=0
  for(let c=0;c<nc;c++)field[c]=field[(nr-1)*nc+c]=0
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)if(!mask[r*cols+c])
    for(let a=0;a<3;a++)for(let b=0;b<3;b++)field[(2*r+a)*nc+2*c+b]=0
  const f=new Float64Array(m),out=new Float64Array(m),v=new Int32Array(m),z=new Float64Array(m+1)
  for(let r=0;r<nr;r++) {f.set(field.subarray(r*nc,(r+1)*nc));transform1d(f,nc,out,v,z);field.set(out.subarray(0,nc),r*nc)}
  for(let c=0;c<nc;c++) {for(let r=0;r<nr;r++)f[r]=field[r*nc+c];transform1d(f,nr,out,v,z);for(let r=0;r<nr;r++)field[r*nc+c]=out[r]}
  const result=new Float64Array(rows*cols)
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)if(mask[r*cols+c])result[r*cols+c]=Math.sqrt(field[(2*r+1)*nc+2*c+1])*stepM/2
  return result
}

export function terrainArea(grid:TerrainGrid,targetX:number,targetY:number,maxSlope:number,settings:AreaSettings):AreaResult {
  const {rows,cols,stepM}=grid,n=rows*cols
  if(!validAreaSettings(settings)||!Number.isInteger(rows)||!Number.isInteger(cols)||rows<1||cols<1||rows>1024||cols>1024||!Number.isFinite(stepM)||stepM<1||stepM>100
    ||!Number.isFinite(maxSlope)||maxSlope<0||maxSlope>90||![targetX,targetY,grid.x0,grid.y0].every(Number.isFinite)
    ||[grid.slope,grid.slopeRms,grid.returns,grid.height,grid.heightRms].some(a=>a.length!==n))throw new Error('Invalid terrain screen inputs')
  let inCircle=0,known=0,nominal=0,eligible=0,directReturns=0
  const mask=new Uint8Array(n),labels=new Int32Array(n),stack=new Int32Array(n)
  // Denominator includes the circle's cells outside this particular source
  // patch: those are unknown, never silently omitted from coverage reporting.
  for(let r=Math.ceil((grid.y0-targetY-500)/stepM);r<=Math.floor((grid.y0-targetY+500)/stepM);r++)
    for(let c=Math.ceil((targetX-500-grid.x0)/stepM);c<=Math.floor((targetX+500-grid.x0)/stepM);c++)
      if(Math.hypot(Math.abs(grid.x0+c*stepM-targetX)+stepM/2,Math.abs(grid.y0-r*stepM-targetY)+stepM/2)<=500)inCircle++
  for(let k=0;k<n;k++) {
    const dx=grid.x0+(k%cols)*stepM-targetX,dy=grid.y0-Math.floor(k/cols)*stepM-targetY
    // Entire source square inside the 500 m analysis circle, never just its centre.
    if(Math.hypot(Math.abs(dx)+stepM/2,Math.abs(dy)+stepM/2)>500)continue
    const slope=grid.slope[k],error=grid.slopeRms[k],returns=grid.returns[k]
    if(!terrainCellKnown(grid,k,settings))continue
    known++;if(returns>0)directReturns++
    if(slope<=maxSlope)nominal++
    if(slope+(settings.rmsMultiplier?settings.rmsMultiplier*error:0)<=maxSlope&&(!settings.requireReturns||returns>0)) {mask[k]=1;eligible++}
  }
  const radiusM=footprintRadii(mask,rows,cols,stepM)
  let components=0,largestCount=0,largestLabel=0,best:AreaResult['best']=null,fittingCentres=0
  for(let k=0;k<n;k++)if(mask[k]) {
    const x=grid.x0+(k%cols)*stepM,y=grid.y0-Math.floor(k/cols)*stepM,radius=radiusM[k]
    if(2*radius+1e-8>=settings.diameterM)fittingCentres++
    if(!best||radius>best.radiusM+1e-8||Math.abs(radius-best.radiusM)<1e-8&&Math.hypot(x-targetX,y-targetY)<Math.hypot(best.x-targetX,best.y-targetY))best={index:k,x,y,radiusM:radius}
    if(labels[k])continue
    const label=++components;let top=0,count=0;stack[top++]=k;labels[k]=label
    while(top) {
      const p=stack[--top],r=Math.floor(p/cols),c=p%cols;count++
      for(const q of [r? p-cols:-1,r+1<rows?p+cols:-1,c?p-1:-1,c+1<cols?p+1:-1])if(q>=0&&mask[q]&&!labels[q]) {labels[q]=label;stack[top++]=q}
    }
    if(count>largestCount) {largestCount=count;largestLabel=label}
  }
  return {inCircle,known,nominal,eligible,directReturns,mapAreaM2:eligible*stepM**2,largestConnectedM2:largestCount*stepM**2,components,fittingCentres,best,mask,radiusM,labels,largestLabel}
}
