import {Grid,TerrainMeta,computeHorizonGlobal,globeSampler,globeTilesFor,inflate,toXY,undelta} from './terrain'

let meta: TerrainMeta | null = null
let far: Grid | null = null
const tiles = new Map<string, Promise<Int16Array | null>>()
const globeTiles: Promise<Int16Array | null>[] = []

/** South of 75°S the polar grids are finer; elsewhere the 1.9 km whole-Moon grid. */
export const POLAR_LIMIT = -75

export async function getMeta(root: string) {
  if (!meta) {
    const response=await fetch(`${root}terrain.json`)
    if(!response.ok)throw new Error(`Terrain metadata HTTP ${response.status}`)
    meta=await response.json()
  }
  return meta!
}

export async function getFar(root: string): Promise<Grid> {
  const m = await getMeta(root)
  if (!far) {
    const response=await fetch(`${root}far.i16z`)
    if(!response.ok)throw new Error(`Far terrain HTTP ${response.status}`)
    const raw=await inflate(await response.arrayBuffer())
    if(raw.length!==m.far.n*m.far.n)throw new Error('Far terrain grid has an unexpected byte count')
    undelta(raw,m.far.n)
    far = { data: raw, scale: m.far.scale, x0: m.far.x0, y0: m.far.y0, rows: m.far.n, cols: m.far.n, factor: m.factor }
  }
  return far
}

function fetchTile(url: string, size: number) {
  return fetch(url)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then(async (buf) => {
      if(!buf)return null
      const raw=await inflate(buf)
      return raw.length===size*size?undelta(raw,size):null
    })
    .catch(() => null)
}

export async function globeHorizons(root: string, lat: number, lon: number) {
  const m = await getMeta(root)
  const g = m.globe
  const need = globeTilesFor(g, lat, lon)
  for (const i of need) globeTiles[i] ??= fetchTile(`${root}globe/${Math.floor(i / g.cols)}_${i % g.cols}.i16z`, g.tile).then(v=>{if(!v)delete globeTiles[i];return v})
  const loaded: (Int16Array | null)[] = new Array(g.rows * g.cols).fill(null)
  await Promise.all(need.map(async (i) => { loaded[i] = await globeTiles[i] }))
  const sampler = globeSampler(g, loaded, m.factor)
  return { sampler, res: Math.round(g.m_per_px), run: (h: number) => computeHorizonGlobal(lat, lon, sampler, h) }
}

function tile(root: string, r: number, c: number, size: number) {
  const key = `${r}_${c}`
  let p = tiles.get(key)
  if (!p) {
    p = fetchTile(`${root}near/${key}.i16z`, size)
    tiles.set(key, p)
    void p.then(v=>{if(!v)tiles.delete(key)})
  }
  return p
}

/** Mosaic the 80 m tiles covering a square of +/- radius around the site into one grid. */
export async function nearGrid(root: string, lat: number, lon: number, radius: number): Promise<Grid> {
  const m = (await getMeta(root)).near
  const [x, y] = toXY(lat, lon)
  const span = m.tile * m.scale
  const c1 = Math.floor((x - radius - m.x0) / span)
  const c2 = Math.floor((x + radius - m.x0) / span)
  const r1 = Math.floor((m.y0 - (y + radius)) / span)
  const r2 = Math.floor((m.y0 - (y - radius)) / span)
  const cols = (c2 - c1 + 1) * m.tile
  const rows = (r2 - r1 + 1) * m.tile
  const data = new Int16Array(rows * cols).fill(-32768)
  let any = false
  const jobs: Promise<void>[] = []
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      if (r < 0 || c < 0 || r >= m.tiles || c >= m.tiles) continue
      jobs.push(
        tile(root, r, c, m.tile).then((t) => {
          if (!t) return
          any = true
          for (let k = 0; k < m.tile; k++) data.set(t.subarray(k * m.tile, (k + 1) * m.tile), ((r - r1) * m.tile + k) * cols + (c - c1) * m.tile)
        }),
      )
    }
  }
  await Promise.all(jobs)
  return { data: any ? data : null, scale: m.scale, x0: m.x0 + c1 * span, y0: m.y0 - r1 * span, rows, cols, factor: (await getMeta(root)).factor,nodata:-32768 }
}

