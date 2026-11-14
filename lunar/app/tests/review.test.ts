// Regression checks for the November 2026 external review: each test pins one finding so it cannot come back.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ephemeris, Horizon, R0_KM, diskFraction, earthAt, earthRadiusDeg, earthShadowFactor, indexOf, siteFrame, sunAt, sunRadiusDeg, visibleSunFraction } from '../src/lib/astro'
import { computeTrack, windowStats } from '../src/lib/metrics'
import { DEFAULT_RADIO, antennaGain, dishGainDbi, linkStats, missionBudget, rateBps } from '../src/lib/link'
import { DEFAULT_POWER, powerStats } from '../src/lib/power'
import { SiteRecord } from '../src/lib/data'
import { areaShare, touchdownCells, touchdownPass } from '../src/lib/touchdown'
import { decodeShare, encodeShare } from '../src/lib/share'
import { DEFAULT_REQ } from '../src/lib/requirements'
import { STEREO_CHECK } from '../src/lib/evidence'

const DATA = resolve(__dirname, '../public/data')
const VALID = resolve(__dirname, '../../data/validation')
function loadEph(): Ephemeris {
  const meta = JSON.parse(readFileSync(`${DATA}/ephemeris.json`, 'utf8'))
  const buf = readFileSync(`${DATA}/ephemeris.f32`)
  const dsn = readFileSync(`${DATA}/dsn.u8`)
  const stations = readFileSync(`${DATA}/stations.f32`)
  return { startUnix: meta.start_unix, stepS: meta.step_s, count: meta.count, data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), dsn: new Uint8Array(dsn.buffer, dsn.byteOffset, dsn.byteLength),
    stations: { data: new Float32Array(stations.buffer, stations.byteOffset, stations.byteLength / 4), orientation: JSON.parse(readFileSync(`${DATA}/stations.json`, 'utf8')).earth_orientation } }
}
const eph = loadEph()
const sites = JSON.parse(readFileSync(`${DATA}/sites.json`, 'utf8')).sites as SiteRecord[]
const site = (id: string) => sites.find((s) => s.id === id)!
const at = (iso: string) => indexOf(eph, Date.parse(iso) / 1000)
const D2R = Math.PI / 180

describe('terrain and Earth hiding the same Sun', () => {
  // Shackleton during the 12 January 2028 eclipse, when the Sun is low on the rim's skyline
  const s = site('shackleton')
  const hz = new Horizon(s.horizons['2'])
  const f = siteFrame(s.lat, s.lon, R0_KM + (s.ground_m + 2) / 1000)

  /** Independent check: sample the solar disk on the sphere; keep points above the real skyline and outside Earth's disk. */
  function monteCarlo(idx: number, n = 400) {
    const sun = sunAt(eph, f, idx)
    const earth = earthAt(eph, f, idx)
    const v = (az: number, el: number) => [Math.cos(el * D2R) * Math.sin(az * D2R), Math.cos(el * D2R) * Math.cos(az * D2R), Math.sin(el * D2R)]
    const sv = v(sun.az, sun.el)
    const ev = v(earth.az, earth.el)
    let up = [-sv[2] * sv[0], -sv[2] * sv[1], 1 - sv[2] * sv[2]]
    const m = Math.hypot(...up)
    up = up.map((x) => x / m)
    const right = [sv[1] * up[2] - sv[2] * up[1], sv[2] * up[0] - sv[0] * up[2], sv[0] * up[1] - sv[1] * up[0]]
    const rs = sunRadiusDeg(sun.dist) * D2R
    const re = earthRadiusDeg(earth.dist) * D2R
    let inDisk = 0, seen = 0
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const x = (-1 + (2 * (a + 0.5)) / n) * rs
        const y = (-1 + (2 * (b + 0.5)) / n) * rs
        if (x * x + y * y > rs * rs) continue
        inDisk++
        const p = [0, 1, 2].map((k) => sv[k] + Math.tan(x) * right[k] + Math.tan(y) * up[k])
        const pm = Math.hypot(...p)
        const q = p.map((c) => c / pm)
        const el = Math.asin(q[2]) / D2R
        const az = ((Math.atan2(q[0], q[1]) / D2R) % 360 + 360) % 360
        const behindEarth = Math.acos(Math.min(1, q[0] * ev[0] + q[1] * ev[1] + q[2] * ev[2])) < re
        if (el > hz.at(az) && !behindEarth) seen++
      }
    }
    return seen / inDisk
  }

  it('takes the shared visible area, not the product of the two remaining shares', () => {
    const idx = at('2028-01-12T03:00:00Z')
    const sun = sunAt(eph, f, idx)
    const earth = earthAt(eph, f, idx)
    const hs = hz.at(sun.az)
    const product = diskFraction(sun.el, hs, sunRadiusDeg(sun.dist)) * earthShadowFactor(sun, earth)
    const joint = visibleSunFraction(sun, hs, earth)
    const ref = monteCarlo(idx)
    console.log(`Shackleton 2028-01-12 03:00 visible Sun: product ${(100 * product).toFixed(1)}%, joint ${(100 * joint).toFixed(1)}%, sampled ${(100 * ref).toFixed(1)}%`)
    expect(Math.abs(joint - ref)).toBeLessThan(0.015)
    expect(product - ref).toBeGreaterThan(0.05) // the old formula overstated it
  })

  it('agrees with sampling through the whole eclipse', () => {
    let worst = 0
    for (let m = 0; m <= 240; m += 15) {
      const idx = at('2028-01-12T01:30:00Z') + m / 60
      const sun = sunAt(eph, f, idx)
      worst = Math.max(worst, Math.abs(visibleSunFraction(sun, hz.at(sun.az), earthAt(eph, f, idx)) - monteCarlo(idx, 200)))
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('lands during the eclipse: light returns when Earth uncovers the Sun, not "in 0 min"', () => {
    const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: hz }, 0)
    const i0 = Math.round(at('2028-01-12T04:00:00Z'))
    const st = windowStats(t, i0, 24)
    expect(st.startsDark).toBe(true)
    expect(st.startsInEclipse).toBe(true)
    // minute by minute: the first minute with any of the Sun visible
    let scan = -1
    for (let k = 0; k <= 180; k++) {
      const idx = i0 + k / 60
      const sun = sunAt(eph, f, idx)
      if (visibleSunFraction(sun, hz.at(sun.az), earthAt(eph, f, idx)) > 0) {
        scan = k
        break
      }
    }
    console.log(`first light after the eclipse: engine ${(st.firstSunrise! * 60).toFixed(0)} min, minute scan ${scan} min`)
    expect(scan).toBeGreaterThan(10)
    expect(Math.abs(st.firstSunrise! * 60 - scan)).toBeLessThan(5)
  })
})

describe('downlink physics', () => {
  it('a dish loses gain at the longer S-band wavelength', () => {
    expect(dishGainDbi(0.5, 'X')).toBeCloseTo(30.3, 1)
    expect(dishGainDbi(0.5, 'X') - dishGainDbi(0.5, 'S')).toBeCloseTo(20 * Math.log10(8425 / 2295), 6) // 11.3 dB
    expect(antennaGain({ band: 'S', txW: 10, gainDbi: 30, dishM: 0.5 })).toBeCloseTo(dishGainDbi(0.5, 'S'), 6)
    const x = rateBps({ band: 'X', txW: 10, gainDbi: 0, dishM: 0.5 }, 384_400)
    const sb = rateBps({ band: 'S', txW: 10, gainDbi: 0, dishM: 0.5 }, 384_400)
    expect(x / sb).toBeGreaterThan(10) // the review found S band overstated about 13.5x when it kept 30 dBi
  })

  it('a radio rate cap limits the rate', () => {
    expect(rateBps({ ...DEFAULT_RADIO, maxKbps: 500 }, 384_400)).toBe(500_000)
  })

  it('Odysseus: no data flows once the battery is flat, and the radio is part of the load', () => {
    const s = site('im1')
    const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
    const i0 = Math.round(at('2024-02-29T23:00:00Z'))
    const len = 7 * 24
    const b = missionBudget(eph, t, i0, len, DEFAULT_POWER, DEFAULT_RADIO)
    expect(b.link.stationGeometry).toBe(true)
    const geometric = linkStats(eph, t, i0, len, DEFAULT_RADIO)
    const noRadio = powerStats(eph, t, i0, len, DEFAULT_POWER)
    expect(b.power.emptyAt).not.toBeNull()
    expect(b.power.emptyAt!).toBeLessThanOrEqual(noRadio.emptyAt!) // the radio's draw only brings it forward
    expect(b.power.loadWh).toBeGreaterThan(noRadio.loadWh)
    expect(b.link.bits).toBeCloseTo(geometric.bits, -3)
    expect(b.link.bitsPowered).toBeLessThan(0.6 * b.link.bits)
    // after the battery is flat and the Sun is down, nothing more is sent
    const flat = Math.ceil(b.power.emptyAt!)
    let late = 0
    for (let j = flat; j < len; j++) if (b.power.metFrac[j] === 0) late += b.link.rate[j]
    expect(late).toBeGreaterThan(0) // contact continues geometrically...
    let sentLate = 0
    for (let j = flat; j < len; j++) sentLate += b.link.rate[j] * b.power.metFrac[j]
    expect(sentLate).toBeLessThan(late) // ...but the dead hours carry nothing
    console.log(`IM-1 7 d: battery flat T+${b.power.emptyAt!.toFixed(1)} h; data home ${(b.link.bitsPowered / 8e9).toFixed(0)} GB of a ${(b.link.bits / 8e9).toFixed(0)} GB link limit`)
  })

  it('the longest silence says when it runs past the window edge', () => {
    const s = site('change6')
    const t = computeTrack(eph, { lat: s.lat, lon: s.lon, groundM: s.ground_m, observerM: 2, horizon: new Horizon(s.horizons['2']) }, 0)
    const l = linkStats(eph, t, Math.round(at(s.date)), 48, DEFAULT_RADIO)
    expect(l.longestGapH).toBe(48)
    expect(l.gapOpenEnded).toBe(true)
  })
})

describe('touchdown grid follows the panel height', () => {
  const s = site('a3-haworth')
  const t2 = existsSync(`${DATA}/disp/a3-haworth.h10.i16`)
  const load = (h: number) => {
    const buf = readFileSync(`${DATA}/disp/a3-haworth${h === 2 ? '' : `.h${h}`}.i16`)
    const all = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
    return Array.from({ length: s.dispersion!.n ** 2 }, (_, k) => new Horizon(all.subarray(k * 360, (k + 1) * 360)))
  }
  const crew = { minDaylightH: 150, maxDarkH: 0, minEarthPct: 50, maxSlopeDeg: 8 }
  const share = (h: number) => {
    const i0 = Math.round(at(s.date))
    const cells = touchdownCells(eph, s, load(h), i0, 150, { earthMinClear: 0, skyErr: 0.1, requireDsn: false, observerM: h })
    const { ok, okHi } = touchdownPass(s, cells, crew, 150)
    return areaShare(s, ok, okHi)
  }
  it.runIf(t2)('Haworth on its default date, Artemis III crew rules: the documented shares at 2 m and 10 m', () => {
    const a = share(2)
    const b = share(10)
    console.log(`Haworth ${s.date}: 2 m ${a.okPct.toFixed(0)}% / ${a.okPctHi.toFixed(0)}%, 10 m ${b.okPct.toFixed(0)}% / ${b.okPctHi.toFixed(0)}%`)
    expect(s.dispersion!.heights).toContain(10)
    // the numbers VALIDATION.md quotes (the review measured 53% / 52% at 2 m in the browser)
    expect([Math.round(a.okPct), Math.round(a.okPctHi)]).toEqual([53, 52])
    expect([Math.round(b.okPct), Math.round(b.okPctHi)]).toEqual([69, 68])
  })
})

describe('share links', () => {
  const base = { date: Date.parse('2027-01-07T00:00:00Z') / 1000, days: 7, req: DEFAULT_REQ, h: 2, ec: 0, pw: DEFAULT_POWER, cmp: [] as string[] }
  it('a dish travels as its diameter, and the rate cap with it', () => {
    const rd = { band: 'S' as const, txW: 20, gainDbi: 12, dishM: 0.5, maxKbps: 2000 }
    const q = encodeShare({ ...base, site: 'c1', rd })
    expect(q.get('rd')).toBe('S,20,d0.5,2000')
    expect(decodeShare(`?${q}`).rd).toEqual(rd)
  })
  it('site + date pairs can hold a site you added, as coordinates', () => {
    const pairs: [string, number][] = [['c1', base.date], ['pt:-85.5000:35.0000', base.date + 86400]]
    expect(decodeShare(`?${encodeShare({ ...base, site: 'c1', pairs })}`).pairs).toEqual(pairs)
  })
})

describe('evidence numbers on the page match the validation files', () => {
  it('the polar stereo mission check', () => {
    const j = JSON.parse(readFileSync(`${VALID}/mission-effect.json`, 'utf8'))
    const a = j.summary['all points']['Artemis III crew']
    expect(j.rows.length).toBe(STEREO_CHECK.points)
    expect(Math.round(a.lola_pass_confirmed_pct)).toBe(STEREO_CHECK.confirmedPct)
    expect(Math.round(a.raised_pass_confirmed_pct)).toBe(STEREO_CHECK.raisedConfirmedPct)
    const nominal = Object.values(j.summary['all points']).flatMap((v) => (typeof v === 'object' && v && 'nominal_only_confirmed_pct' in v ? [(v as { nominal_only_confirmed_pct: number }).nominal_only_confirmed_pct] : []))
    expect(`${Math.round(Math.min(...nominal))}–${Math.round(Math.max(...nominal))}%`).toBe(STEREO_CHECK.nominalOnlyRange)
    expect(a.timestep_lola_disagree).toBe(STEREO_CHECK.timestepFlipsArtemis)
  })
})
