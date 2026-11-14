import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ephemeris, R0_KM, indexOf, siteFrame, sunAt } from '../src/lib/astro'
import { skylineSample, skylineWindow } from '../src/lib/skyline'

const data = resolve(__dirname, '../public/data')
const meta = JSON.parse(readFileSync(`${data}/ephemeris.json`, 'utf8'))
const raw = readFileSync(`${data}/ephemeris.f32`)
const eph: Ephemeris = { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count,
  data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) }

describe('skyline time boundaries', () => {
  it('keeps the distinct Sun positions at both ends of the real 30-day C1 window', () => {
    const site = JSON.parse(readFileSync(`${data}/sites.json`, 'utf8')).sites.find((s: { id: string }) => s.id === 'c1')
    const start = Date.parse('2027-01-01T00:00:00Z') / 1000
    const range = skylineWindow(eph.count, indexOf(eph, start), 720)
    const frame = siteFrame(site.lat, site.lon, R0_KM + (site.ground_m + 2) / 1000)
    const first = sunAt(eph, frame, range.a), last = sunAt(eph, frame, range.b)
    expect(eph.startUnix + range.b * eph.stepS).toBe(Date.parse('2027-01-31T00:00:00Z') / 1000)
    expect(first.az).toBeCloseTo(40.29344, 4)
    expect(first.el).toBeCloseTo(1.44123, 4)
    expect(last.az).toBeCloseTo(35.51674, 4)
    expect(last.el).toBeCloseTo(0.70489, 4)
  })

  it('uses the actual final minute instead of freezing an hour early', () => {
    const { a, b } = skylineWindow(eph.count, indexOf(eph, Date.parse('2027-01-01T00:00:00Z') / 1000), 720)
    const sample = skylineSample(eph.count, a, b, a + 720 - 1 / 60)
    expect(sample.k0).toBe(a + 719)
    expect(sample.t).toBeCloseTo(59 / 60, 8)
    expect(sample.index).toBeCloseTo(b - 1 / 60, 8)
  })

  it('retains the last ephemeris point with a valid interpolation pair', () => {
    const range = skylineWindow(3, 1, 720)
    expect(range).toEqual({ a: 1, b: 2 })
    expect(skylineSample(3, range.a, range.b, 50)).toEqual({ index: 2, k0: 1, t: 1 })
    expect(skylineSample(3, range.a, range.b, -1)).toEqual({ index: 1, k0: 1, t: 0 })
  })
})
