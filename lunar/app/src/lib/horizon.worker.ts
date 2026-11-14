/// <reference lib="webworker" />
import {Grid,HorizonResult,bodyFractionAt,stationFractionAt,computeHorizon,sampleGrid,toXY} from './terrain'
import {getFar,nearGrid,globeHorizons,POLAR_LIMIT} from './terrain-loader'
import { toLatLon } from './data'
import {compositeSky} from './local-sky'

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer)

/** Slope (deg) from the 80 m grid by central differences, one pixel either side (160 m baseline). */
function slopeAt(g: Grid, x: number, y: number) {
  const b = g.scale
  const gx = (sampleGrid(g, x + b, y) - sampleGrid(g, x - b, y)) / (2 * b)
  const gy = (sampleGrid(g, x, y + b) - sampleGrid(g, x, y - b)) / (2 * b)
  return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI
}

/**
 * Touchdown grid around a polar site: n x n points `step` metres apart (row 0 = +Y), each with a
 * 360-bin horizon at `h` m and the slope from the 80 m grid over a 160 m baseline.
 */
async function touchdownGrid(id: string, lat: number, lon: number, n: number, step: number, h: number, root: string) {
  const [near, far] = await Promise.all([nearGrid(root, lat, lon, 26_000 + n * step), getFar(root)])
  if (!near.data) throw new Error('Touchdown grids need the 80 m polar terrain (south of 80°S)')
  const [cx, cy] = toXY(lat, lon)
  const mid = (n - 1) / 2
  const hz = new Int16Array(n * n * 360)
  const ground: number[] = []
  const slope: number[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = cx + (c - mid) * step
      const y = cy + (mid - r) * step
      const [la, lo] = toLatLon(x, y)
      const res = computeHorizon(la, lo, near, far, h, 360)
      const k = r * n + c
      for (let j = 0; j < 360; j++) hz[k * 360 + j] = Math.round(res.elev[j] * 100)
      ground.push(res.groundM)
      slope.push(slopeAt(near, x, y))
      post({ id, progress: (k + 1) / (n * n) })
    }
  }
  post({ id, ok: true, grid: { n, step_m: step, bins: 360, observer_m: h, ground_m: ground, slope_deg: slope, slope_baseline_m: 2 * near.scale, frame: 'polar', browser: true }, horizons: hz }, [hz.buffer])
}

/** 3D terrain patch like build_patches.py: 301 x 301 points 40 m apart, decimetres relative to the site (row 0 = +Y, col 0 = -X). */
async function terrainPatch(id: string, lat: number, lon: number, root: string) {
  const near = await nearGrid(root, lat, lon, 7_000)
  if (!near.data) throw new Error('No 80 m terrain here')
  const n = 301
  const step = 40
  const [cx, cy] = toXY(lat, lon)
  const h0 = sampleGrid(near, cx, cy)
  const rel = new Int16Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const h = sampleGrid(near, cx + (c - (n - 1) / 2) * step, cy - (r - (n - 1) / 2) * step)
      rel[r * n + c] = Number.isFinite(h) ? Math.max(-32000, Math.min(32000, Math.round((h - h0) * 10))) : 0
    }
  }
  post({ id, ok: true, meta: { n, step_m: step, ground_m: h0, frame: 'polar' }, rel }, [rel.buffer])
}

/**
 * Light (or Earth view) at one moment over a square around a polar point: for every pixel, march along the
 * ground toward the body's azimuth over the 80 m and 480 m terrain out to 300 km (the same horizon method as
 * the sites), and keep the visible fraction of the disk. `body` is the Sun or Earth position (km, MOON_ME,
 * from the Moon's centre); each pixel uses its own direction to it, so Earth's parallax is included.
 * Output: one byte per pixel, 0..250 = visible fraction, 255 = no terrain. Row 0 is the +Y edge.
 */
async function shadeMap(id: string, lat: number, lon: number, half: number, n: number, body: number[], radiusKm: number, root: string, occluder?: number[], observerM = 2, clearanceDeg = 0, available = true, stations?: Float32Array) {
  // 80 m terrain near the centre (where shadows are drawn finest), 480 m beyond
  const [far, near] = await Promise.all([getFar(root), nearGrid(root, lat, lon, Math.min(half, 30_000) + 10_000)])
  const t0 = performance.now()
  const hAt = (x: number, y: number) => {
    const v = near.data ? sampleGrid(near, x, y) : NaN
    return Number.isFinite(v) ? v : sampleGrid(far, x, y)
  }
  const [cx, cy] = toXY(lat, lon)
  const step = (2 * half) / n
  const out = new Uint8Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = cx - half + (c + 0.5) * step, y = cy + half - (r + 0.5) * step
      const f = stations ? stationFractionAt(hAt, x, y, stations, observerM, clearanceDeg)
        : bodyFractionAt(hAt, x, y, body, radiusKm, occluder, observerM, clearanceDeg)
      out[r * n + c] = f === null ? 255 : available ? Math.round(250 * f) : 0
    }
  }
  post({ id, ok: true, n, half, cx, cy, data: out, ms: Math.round(performance.now() - t0) }, [out.buffer])
}

self.onmessage = async (e: MessageEvent) => {
  if(e.data.kind==='local') {
    const {id,lat,lon,local,root}=e.data
    try {
      const [near,farGrid]=await Promise.all([nearGrid(root,lat,lon,26_000),getFar(root)])
      let result=compositeSky(lat,lon,local,near,farGrid)
      if(result.missingSamples) {
        const {sampler}=await globeHorizons(root,lat,lon)
        result=compositeSky(lat,lon,local,near,farGrid,[2,10],2880,sampler)
      }
      if(result.missingSamples)throw new Error(`Mixed terrain is incomplete: ${result.missingSamples} ray samples have no background height. No mission point was created; retry when the terrain files are available.`)
      post({id,ok:true,composite:result})
    } catch(err) {post({id,ok:false,error:String((err as Error).message??err)})}
    return
  }
  if (e.data.kind === 'shade') {
    const { id, lat, lon, half, n, body, radiusKm, root, occluder, observerM, clearanceDeg, available } = e.data as { id: string; lat: number; lon: number; half: number; n: number; body: number[]; radiusKm: number; root: string; occluder?: number[]; observerM?: number; clearanceDeg?: number; available?: boolean }
    try {
      await shadeMap(id, lat, lon, half, n, body, radiusKm, root, occluder, observerM, clearanceDeg, available, e.data.stations)
    } catch (err) {
      post({ id, ok: false, error: String((err as Error).message ?? err) })
    }
    return
  }
  if (e.data.kind === 'patch') {
    const { id, lat, lon, root } = e.data as { id: string; lat: number; lon: number; root: string }
    try {
      await terrainPatch(id, lat, lon, root)
    } catch (err) {
      post({ id, ok: false, error: String((err as Error).message ?? err) })
    }
    return
  }
  if (e.data.kind === 'grid') {
    const { id, lat, lon, n, step, h, root } = e.data as { id: string; lat: number; lon: number; n: number; step: number; h?: number; root: string }
    try {
      await touchdownGrid(id, lat, lon, n, step, h ?? 2, root)
    } catch (err) {
      post({ id, ok: false, error: String((err as Error).message ?? err) })
    }
    return
  }
  const { id, lat, lon, heights, root } = e.data as { id: string; lat: number; lon: number; heights: number[]; root: string }
  const dataRoot = root
  try {
    let run: (h: number) => HorizonResult
    let nearRes: number
    let farRes: number
    let slope: number | null = null
    if (lat <= POLAR_LIMIT) {
      const [near, farGrid] = await Promise.all([nearGrid(dataRoot, lat, lon, 26_000), getFar(dataRoot)])
      run = (h) => computeHorizon(lat, lon, near, farGrid, h)
      nearRes = near.data ? 80 : 480
      farRes = 480
      if (near.data) slope = slopeAt(near, ...toXY(lat, lon))
    } else {
      const g = await globeHorizons(dataRoot, lat, lon)
      run = g.run
      nearRes = farRes = g.res
    }
    const out: Record<string, number[]> = {}
    let ground = 0
    for (const h of heights) {
      const r = run(h)
      ground = r.groundM
      out[String(h)] = Array.from(r.elev, (v) => Math.round(v * 100))
    }
    post({ id, ok: true, horizons: out, groundM: ground, nearRes, farRes, terrain: lat <= POLAR_LIMIT ? 'polar' : 'globe', slope, slopeBaseline: 2 * 80 })
  } catch (err) {
    post({ id, ok: false, error: String((err as Error).message ?? err) })
  }
}
