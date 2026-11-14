import type {TerrainAsset,AreaReport} from './landing-terrain'
import type {AreaResult} from './landing-area'
import {terrainCellKnown,wholeCellInCircle} from './landing-area'

export type TerrainBand='slope'|'slopeRms'|'returns'|'height'|'heightRms'|'eligible'|'footprintRadius'
export const TERRAIN_BANDS:Record<TerrainBand,string>={slope:'Slope (degrees)',slopeRms:'Slope RMS error (degrees)',returns:'LOLA returns per cell',height:'Surface height (m)',heightRms:'Height RMS error (m)',eligible:'Terrain screen (1 pass, 0 fail)',footprintRadius:'Centred footprint radius (m)'}
export async function terrainGeoTiff(asset:TerrainAsset,result:AreaResult,report:AreaReport,band:TerrainBand):Promise<ArrayBuffer> {
  const {writeArrayBuffer}=await import('geotiff')
  const g=asset.grid,n=g.rows*g.cols
  let values:Float32Array
  if(band==='eligible'||band==='footprintRadius') {
    values=new Float32Array(n).fill(NaN)
    const R=1737400,rr=2*R*Math.tan((90+report.point.lat)*Math.PI/360),lo=report.point.lon*Math.PI/180
    const x=rr*Math.sin(lo),y=rr*Math.cos(lo)
    for(let k=0;k<n;k++) {
      if(!wholeCellInCircle(g.x0+k%g.cols*g.stepM,g.y0-Math.floor(k/g.cols)*g.stepM,g.stepM,x,y)||!terrainCellKnown(g,k,report.settings))continue
      values[k]=band==='eligible'?result.mask[k]:result.radiusM[k]
    }
  } else values=g[band]
  // No Earth EPSG code: this is an explicit spherical lunar polar projection.
  // A single band keeps library writer metadata below its fixed 1000-byte IFD.
  // Supply the directory explicitly: geotiff.js 3.0.5's automatic metadata
  // writer does not classify every custom projection GeoKey's field type.
  const citation=asset.imported?'MOON_ME_DE421 polar; user-declared frame|\0':'MOON_ME_DE421 polar; nominal registration|\0'
  const keys=[
    [1024,0,1,1],[1025,0,1,1],[1026,34737,citation.length-1,0],
    [2048,0,1,32767],[2050,0,1,32767],[2054,0,1,9102],[2056,0,1,32767],
    [2057,34736,1,0],[2058,34736,1,1],
    [3072,0,1,32767],[3073,34737,citation.length-1,0],[3075,0,1,15],[3076,0,1,9001],
    [3080,34736,1,2],[3081,34736,1,3],[3082,34736,1,4],[3083,34736,1,5],[3092,34736,1,6],
  ]
  const metadata={width:g.cols,height:g.rows,BitsPerSample:[32],SampleFormat:[3],SamplesPerPixel:1,
    ModelPixelScale:[g.stepM,g.stepM,0],ModelTiepoint:[0,0,0,g.x0-g.stepM/2,g.y0+g.stepM/2,0],
    ProjectedCSTypeGeoKey:32767,GeoKeyDirectory:[1,1,0,keys.length,...keys.flat()],
    GeoAsciiParams:citation,GeoDoubleParams:[1737400,1737400,0,-90,0,0,1],
    ImageDescription:`LUNORIZON ${band}; source ${asset.meta.region}; see terrain report JSON for assumptions and hashes`,GDAL_NODATA:'nan'}
  return writeArrayBuffer(values,metadata)
}
