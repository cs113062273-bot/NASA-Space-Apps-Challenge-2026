// Integrity of the shipped data files: every record the app reads points at a file of the right size.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DATA = resolve(__dirname, '../public/data')
const json = (f: string) => JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8'))
const sites = json('sites.json').sites as {
  id: string; date: string; duration_days: number; horizons: Record<string, number[]>
  dispersion?: { n: number; bins: number; ground_m: number[]; slope_deg: number[]; heights?: number[] }
}[]

describe('shipped data', () => {
  it('every site has two full horizons and a landing window inside the ephemeris', () => {
    const eph = json('ephemeris.json')
    const end = eph.start_unix + (eph.count - 1) * eph.step_s
    expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length)
    for (const s of sites) {
      expect(s.horizons['2'], s.id).toHaveLength(720)
      expect(s.horizons['10'], s.id).toHaveLength(720)
      const t = Date.parse(s.date) / 1000
      expect(t, s.id).toBeGreaterThanOrEqual(eph.start_unix)
      expect(t + s.duration_days * 86400, s.id).toBeLessThanOrEqual(end)
    }
  })

  it('every touchdown grid and 3D patch file matches its record', () => {
    for (const s of sites.filter((x) => x.dispersion)) {
      const d = s.dispersion!
      expect(statSync(`${DATA}/disp/${s.id}.i16`).size, s.id).toBe(d.n * d.n * d.bins * 2)
      // every curated grid also exists at 10 m, so the touchdown map follows the panel-height switch
      expect(d.heights, s.id).toEqual([2, 10])
      expect(statSync(`${DATA}/disp/${s.id}.h10.i16`).size, `${s.id} 10 m`).toBe(d.n * d.n * d.bins * 2)
      expect(d.ground_m, s.id).toHaveLength(d.n * d.n)
      expect(d.slope_deg, s.id).toHaveLength(d.n * d.n)
    }
    const patches = json('patch/patches.json') as Record<string, { n: number }>
    for (const s of sites) expect(patches[s.id], `patch for ${s.id}`).toBeDefined()
    for (const [id, m] of Object.entries(patches)) expect(statSync(`${DATA}/patch/${id}.i16`).size, id).toBe(m.n * m.n * 2)
  })

  it('every map layer named in basemap.json exists', () => {
    const b = json('basemap.json')
    const files = [b.overview.file, b.detail.file, b.illumination?.file, b.earthvis_polar?.file, b.layer_values?.file, b.globe?.relief, b.globe?.earthvis].filter(Boolean)
    for (const f of files) expect(existsSync(`${DATA}/${f}`), f).toBe(true)
    if (b.layer_values) expect(statSync(`${DATA}/${b.layer_values.file}`).size).toBe(2 * b.layer_values.n ** 2)
  })

  it('terrain tile sets are complete', () => {
    const t = json('terrain/terrain.json')
    for (let r = 0; r < t.globe.rows; r++) for (let c = 0; c < t.globe.cols; c++) expect(existsSync(`${DATA}/terrain/globe/${r}_${c}.i16z`), `globe ${r}_${c}`).toBe(true)
    for (let r = 0; r < t.near.tiles; r++) for (let c = 0; c < t.near.tiles; c++) expect(existsSync(`${DATA}/terrain/near/${r}_${c}.i16z`), `near ${r}_${c}`).toBe(true)
  })
})
