import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { PRP_PRODUCT, attachSurfaceContext, surfaceContextSummary } from '../src/lib/surface'
import { loadSites } from '../src/lib/data'

const root = new URL('../public/data/',import.meta.url)
const source = JSON.parse(readFileSync(new URL('diviner-prp-sites.json',root),'utf8'))
const sites = JSON.parse(readFileSync(new URL('sites.json',root),'utf8')).sites
const audit = JSON.parse(readFileSync(new URL('../../data/validation/diviner-prp-spatial.json',import.meta.url),'utf8'))
const manifest = JSON.parse(readFileSync(new URL('../../data/validation/diviner-prp-source.json',import.meta.url),'utf8'))
const remote = JSON.parse(readFileSync(new URL('../../data/validation/diviner-prp-range-check.json',import.meta.url),'utf8'))

describe('source-traceable Diviner PRP V2 context', () => {
  it('uses the source hash and verified facets with explicit depth/statistic semantics', () => {
    const samples = attachSurfaceContext(sites,source)
    expect(source.product).toBe(PRP_PRODUCT)
    expect(source.source.sha256).toBe(manifest.files['dlre_prp_south.tab'].sha256)
    expect(source.source.sha256).toBe(audit.source_sha256)
    expect(source.source.bytes).toBe(604800210)
    expect(audit.source_rows).toBe(2880000)
    expect(audit.cases).toHaveLength(4)
    expect(remote.source_sha256).toBe(source.source.sha256)
    expect(remote.cases).toHaveLength(4)
    for (const c of audit.cases) {
      const p = samples.get(c.site)!
      expect(p.facet_index).toBe(c.selected_facet)
      expect(c.full_table_edge_matches).toContain(p.facet_index)
      expect(p.annual_mean_2cm_k).toBe(c.source_values[12])
      expect(p.annual_surface_max_k).toBe(c.source_values[13])
      expect(p.vertices_km!.flat()).toEqual(c.source_values.slice(0,9))
      const fetched = remote.cases.find((r: {site:string}) => r.site === c.site)
      expect(fetched.byte_start).toBe(210*(p.facet_index!+1))
      expect(fetched.byte_end-fetched.byte_start+1).toBe(210)
      expect(fetched.fixed_field_values.temp_avg).toBe(p.annual_mean_2cm_k)
      expect(fetched.fixed_field_values.temp_max).toBe(p.annual_surface_max_k)
      expect(surfaceContextSummary(p)).toContain('mean at 2 cm')
      expect(surfaceContextSummary(p)).toContain('not a mission-date or equipment temperature')
    }
    expect(samples.get('apollo11')!.status).toBe('outside-published-mesh')
    expect(samples.get('c1')!.status).toBe('sampled')
  })

  it('rejects stale site coordinates, duplicates, V1, impossible source values and a mismatched facet', () => {
    const clone = () => structuredClone(source)
    const change = (fn: (d: typeof source) => void, pattern: RegExp) => {
      const d = clone();fn(d);expect(() => attachSurfaceContext(sites,d)).toThrow(pattern)
    }
    change(d => { d.product = 'LRO-L-DLRE-5-PRP-V1.0' },/source/)
    change(d => { d.sites[0].lat += 0.01 },/contain|coordinates/)
    change(d => { d.sites.push(d.sites[0]) },/record/)
    change(d => { d.sites.pop() },/catalogue/)
    change(d => { d.source.sha256 = '' },/source/)
    change(d => { d.sites.find((s: {status:string}) => s.status === 'sampled').annual_mean_2cm_k = -999 },/facet/)
    change(d => { d.sites.find((s: {status:string}) => s.status === 'sampled').ice_stability_depth_m = -999 },/facet/)
    change(d => { d.sites.find((s: {status:string}) => s.status === 'sampled').barycentric_weights = [1,0,0] },/contain/)
  })

  it('distinguishes source exclusions and unsupported points without inventing a thermal boundary', () => {
    const samples = [...attachSurfaceContext(sites,source).values()]
    const sampled = samples.filter(s => s.status === 'sampled')
    expect(sampled.length).toBe(audit.sampled_sites)
    expect(samples.filter(s => s.status !== 'sampled').length).toBe(audit.outside_sites)
    expect(sampled.some(s => s.ice_stability_depth_m === null)).toBe(true)
    expect(surfaceContextSummary(undefined)).toContain('no thermal background inferred')
    expect(surfaceContextSummary(samples.find(s => s.status !== 'sampled'))).toContain('Outside the published south-polar PRP mesh')
    for (const s of sampled) {
      expect(s.centre_distance_m).toBeLessThan(2000)
      expect(s.neighborhood!.count).toBeGreaterThan(0)
      expect(s.neighborhood!.selection).toBe('facet centres within radius')
    }
  })
})

describe('catalogue context loading', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('attaches matching records and keeps core catalogue available with explicit optional-context errors', async () => {
    const mock = (bad = '') => vi.stubGlobal('fetch',vi.fn(async (url: string) => {
      if (url.endsWith('sites.json') && !url.endsWith('prp-sites.json')) return Response.json({ sites })
      if (bad === 'missing') return new Response('',{status:404})
      return Response.json(bad === 'invalid' ? { ...source,product:'wrong' } : source)
    }))
    mock()
    const loaded = await loadSites()
    expect(loaded.find(s => s.id === 'c1')!.surfaceContext!.annual_surface_max_k).toBe(source.sites.find((s:{id:string}) => s.id === 'c1').annual_surface_max_k)
    mock('missing')
    const missing = await loadSites()
    expect(missing).toHaveLength(sites.length)
    expect(missing[0].surfaceContext).toBeUndefined()
    expect(missing[0].surfaceContextError).toContain('Cannot load diviner-prp-sites.json')
    mock('invalid')
    const invalid = await loadSites()
    expect(invalid[0].surfaceContext).toBeUndefined()
    expect(invalid[0].surfaceContextError).toBe('Invalid Diviner context source')
    expect(surfaceContextSummary(invalid[0].surfaceContext,invalid[0].surfaceContextError)).toContain('core mission calculations are independent')
    vi.stubGlobal('fetch',vi.fn(async () => new Response('',{status:404})))
    await expect(loadSites()).rejects.toThrow('Cannot load sites.json')
  })
})
