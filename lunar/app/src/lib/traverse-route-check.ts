import {terrainArea,terrainCellAtPoint} from './landing-area'
import {toXY,toLatLon} from './data'
import {edgeFits,validRouteSettings,TerrainRouteReport} from './terrain-route'
import {TerrainAsset} from './landing-terrain'

/** Rebind the supplied path to the actual source and active static criteria
 * before any moving simulation can use it. */
export function checkTraverseRoute(asset:TerrainAsset,report:TerrainRouteReport):void {
  if(report.result.status!=='found'||!validRouteSettings(report.settings)||report.source.patch.sha256!==asset.meta.sha256||report.source.manifestSha256!==asset.index.sourceManifestSha256||report.source.imported?.id!==asset.imported?.id)throw new Error('Moving route source or criteria differ from the retained terrain')
  const g=asset.grid,[x,y]=toXY(report.mission.lat,report.mission.lon),screen=terrainArea(g,x,y,report.terrain.maxSlopeDeg,report.terrain),p=report.settings
  for(const [i,n] of report.result.nodes.entries()){
    const k=n.index,xx=g.x0+k%g.cols*g.stepM,yy=g.y0-Math.floor(k/g.cols)*g.stepM,[lat,lon]=toLatLon(xx,yy)
    if(!Number.isInteger(k)||k<0||k>=g.rows*g.cols||n.x!==xx||n.y!==yy||n.heightM!==g.height[k]||Math.abs(n.lat-lat)>1e-9||Math.abs(n.lon-lon)>1e-9||!screen.mask[k]||screen.radiusM[k]+1e-9<p.widthM/2||terrainCellAtPoint(g,n.x,n.y)!==k)throw new Error('Moving path vertex differs from its verified source cell or clearance')
    if(i){const before=report.result.nodes[i-1],length=Math.hypot(n.x-before.x,n.y-before.y),rms=p.heightRmsMultiplier*(g.heightRms[k]+g.heightRms[before.index]),stress=p.heightRmsMultiplier?rms:0
      if(!Number.isFinite(stress)||stress<0||Math.atan2(Math.abs(n.heightM-before.heightM)+stress,length)*180/Math.PI>p.maxGradeDeg+1e-10||!edgeFits(g,screen,before.index,k,p.widthM/2))throw new Error('Moving path edge fails its original width/grade screen')
    }
  }
}
