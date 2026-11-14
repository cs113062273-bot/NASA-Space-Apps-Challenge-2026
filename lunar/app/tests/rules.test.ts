// Requirement checks and share links: what decides PASS / FAIL and whether a link reopens the same case.
import { describe, expect, it } from 'vitest'
import { DEFAULT_REQ, checkWindow, slopeOk } from '../src/lib/requirements'
import { DEFAULT_PINS, decodeShare, encodeShare } from '../src/lib/share'
import { DEFAULT_POWER } from '../src/lib/power'
import { DEFAULT_RADIO } from '../src/lib/link'
import { migrateCustom, SiteRecord } from '../src/lib/data'
import { COARSE_SKYLINE_ERR_DEG, SKYLINE_ERR_DEG, WindowStats, raisedPhrase, skylineErr } from '../src/lib/metrics'
import { CellStats, touchdownPass } from '../src/lib/touchdown'

const win = (o: Partial<WindowStats>): WindowStats => ({
  hours: 240, sunEquivHours: 240, sunUpHours: 240, earthHours: 240, bothHours: 240, longestDark: 0, longestNoEarth: 0,
  darkOpenEnded: false, noEarthOpenEnded: false, firstSunset: null, firstEarthset: null, startsDark: false, startsNoEarth: false,
  firstSunrise: null, meanSunElevUp: 5, dsnEarthHours: null, eclipseHours: 0, firstEclipse: null, earthsetByDsn: false, ...o,
})

describe('requirements', () => {
  it('a zero daylight minimum permits a dark start consistently in the main and touchdown screens', () => {
    const req = { ...DEFAULT_REQ, minDaylightH: 0, maxDarkH: 240 }
    expect(checkWindow(win({ startsDark: true, firstSunset: null, longestDark: 240 }), req).daylight).toBe(true)
    expect(checkWindow(win({ startsDark: true }), { ...req, minDaylightH: 1 }).daylight).toBe(false)
    const cell: CellStats = { startsDark: true, firstSunset: 0, longestDark: 240, earth: 100, sun: 0, both: 0,
      hi: { startsDark: true, firstSunset: 0, longestDark: 240, earth: 100 } }
    const site = { dispersion: { slope_deg: [0] } } as unknown as SiteRecord
    expect(touchdownPass(site, [cell], req, 240)).toMatchObject({ ok: [true], okHi: [true] })
    expect(touchdownPass(site, [cell], { ...req, minDaylightH: 1 }, 240)).toMatchObject({ ok: [false], okHi: [false] })
  })
  it('an unmeasured slope is never a pass', () => {
    expect(slopeOk({ slope_deg: undefined }, 10)).toBe(false)
    expect(slopeOk({ slope_deg: null }, 10)).toBe(false)
    expect(slopeOk({ slope_deg: NaN }, 10)).toBe(false)
    expect(slopeOk({ slope_deg: 9.9 }, 10)).toBe(true)
    expect(slopeOk({ slope_deg: 12 }, 10)).toBe(false)
  })
  it('daylight: sunset before the need fails; a need longer than the stay means Sun up for the whole stay', () => {
    expect(checkWindow(win({ firstSunset: 100 }), DEFAULT_REQ).daylight).toBe(false)
    expect(checkWindow(win({ firstSunset: 200 }), DEFAULT_REQ).daylight).toBe(true)
    expect(checkWindow(win({ hours: 24, firstSunset: null }), DEFAULT_REQ).daylight).toBe(true)
    expect(checkWindow(win({ hours: 24, firstSunset: 20 }), DEFAULT_REQ).daylight).toBe(false)
    expect(checkWindow(win({ startsDark: true }), DEFAULT_REQ).daylight).toBe(false)
  })
  it('darkness and Earth limits', () => {
    const c = checkWindow(win({ longestDark: 51, earthHours: 95 }), DEFAULT_REQ)
    expect(c.dark).toBe(false)
    expect(c.earth).toBe(false) // 39.6% < 40%
  })
})

describe('skyline sensitivity per site', () => {
  it('uses 0.1° unless the site carries a coarser shift', () => {
    expect(skylineErr({})).toBe(SKYLINE_ERR_DEG)
    expect(skylineErr({ skyline_err_deg: COARSE_SKYLINE_ERR_DEG })).toBe(1)
    expect(raisedPhrase([0.1, 0.1])).toBe('the skyline 0.1° higher')
    expect(raisedPhrase([1, 0.1])).toContain('0.1° or 1°')
  })
  it('sites saved by older versions get the coarse shift when they came from the whole-Moon grid', () => {
    const old = { id: 'my-x', dem: '1.9 km whole-Moon grid (browser)', custom: true } as SiteRecord
    expect(skylineErr(migrateCustom(old))).toBe(COARSE_SKYLINE_ERR_DEG)
    expect(skylineErr(migrateCustom({ ...old, dem: '80 m near field + 480 m far field (browser)' }))).toBe(SKYLINE_ERR_DEG)
  })
})

describe('share links', () => {
  const base = { date: Date.UTC(2027, 0, 7, 12) / 1000, days: 6.25, req: DEFAULT_REQ, h: 2, ec: 0, cmp: DEFAULT_PINS, pw: DEFAULT_POWER }
  it('a default case stays short', () => {
    expect(encodeShare({ ...base, site: 'c1' }).toString()).toBe('site=c1&date=2027-01-07T12%3A00&days=6.25')
  })
  it('every setting that changes a PASS / FAIL round-trips', () => {
    const s = {
      ...base, site: 'malapert', req: { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }, h: 10, ec: 5,
      cmp: ['malapert', 'haworth'], pw: { ...DEFAULT_POWER, mode: 'fixed' as const, facingAz: 90, batteryWh: 2500 },
    }
    const back = decodeShare(`?${encodeShare(s)}`)
    expect(back).toEqual({ site: 'malapert', date: s.date, days: 6.25, req: s.req, h: 10, ec: 5, cmp: s.cmp, pw: s.pw })
  })
  it('site + date pairs round-trip', () => {
    const pairs: [string, number][] = [['a3-malapert', Date.UTC(2027, 0, 7) / 1000], ['a3-haworth', Date.UTC(2027, 9, 7, 12) / 1000]]
    expect(decodeShare(`?${encodeShare({ ...base, site: 'c1', pairs })}`).pairs).toEqual(pairs)
    expect(decodeShare('?pairs=c1@notadate,@2027-01-01T00:00').pairs).toBeUndefined()
    expect(decodeShare(`?${encodeShare({ ...base, pairs, compareMode: 'same' })}`).compareMode).toBe('same')
  })
  it('the lander radio round-trips; the default stays out of the link', () => {
    const rd = { band: 'S' as const, txW: 25, gainDbi: 0 }
    expect(decodeShare(`?${encodeShare({ ...base, site: 'c1', rd })}`).rd).toEqual(rd)
    expect(encodeShare({ ...base, site: 'c1', rd: DEFAULT_RADIO }).has('rd')).toBe(false)
    expect(decodeShare('?rd=K,10,12').rd).toBeUndefined()
  })
  it('an empty comparison stays empty', () => {
    expect(decodeShare(`?${encodeShare({ ...base, site: 'c1', cmp: [] })}`).cmp).toEqual([])
  })
  it('custom sites travel as coordinates, also when only compared', () => {
    expect(decodeShare(`?${encodeShare({ ...base, add: [-85.5, 35] })}`).add).toEqual([-85.5, 35])
    const back = decodeShare(`?${encodeShare({ ...base, site: 'c1', cmp: ['c1'], cmpAdd: [[-85.5, 35], [0.6741, 23.473]] })}`)
    expect(back.cmp).toEqual(['c1'])
    expect(back.cmpAdd).toEqual([[-85.5, 35], [0.6741, 23.473]])
    // only custom sites compared: the curated list is empty, not the default
    expect(decodeShare(`?${encodeShare({ ...base, site: 'c1', cmp: [], cmpAdd: [[-85.5, 35]] })}`).cmp).toEqual([])
  })
  it('malformed values are dropped, not half-applied', () => {
    expect(decodeShare('?req=1,2,3&h=7&ec=3&pw=solar,0,1,1,1,1&days=500')).toEqual({})
    expect(decodeShare('?req=1,-2,3,4').req).toBeUndefined()
    expect(decodeShare('?days=0.001&date=2027-02-30T00:00')).toEqual({})
  })
})
