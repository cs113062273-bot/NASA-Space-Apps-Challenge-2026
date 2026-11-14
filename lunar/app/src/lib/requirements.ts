// Mission requirements and the PASS / FAIL checks every view shares.
import type { SiteRecord } from './data'
import type { WindowStats } from './metrics'

export interface Requirements {
  minDaylightH: number
  maxDarkH: number
  minEarthPct: number
  maxSlopeDeg: number
}

export const DEFAULT_REQ: Requirements = { minDaylightH: 168, maxDarkH: 50, minEarthPct: 40, maxSlopeDeg: 10 }

export const sameReq = (a: Requirements, b: Requirements) =>
  a.minDaylightH === b.minDaylightH && a.maxDarkH === b.maxDarkH && a.minEarthPct === b.minEarthPct && a.maxSlopeDeg === b.maxSlopeDeg

/** Zero explicitly disables the initial-daylight constraint, including for night-start missions. */
export const daylightPass = (s: Pick<WindowStats, 'startsDark' | 'firstSunset' | 'hours'>, minimumH: number) =>
  minimumH <= 0 || (!s.startsDark && (s.firstSunset ?? s.hours) >= Math.min(minimumH, s.hours))

/**
 * Window checks. A daylight need longer than the stay is checked as Sun up for the whole stay
 * (nothing after the stay matters); the UI says so wherever that happens.
 */
export function checkWindow(s: WindowStats, req: Requirements) {
  return {
    daylight: daylightPass(s, req.minDaylightH),
    dark: s.longestDark <= req.maxDarkH,
    earth: (100 * s.earthHours) / s.hours >= req.minEarthPct,
  }
}

export const slopeKnown = (s: Pick<SiteRecord, 'slope_deg'>) => s.slope_deg != null && Number.isFinite(s.slope_deg)

/** An unmeasured slope is not a pass: the requirement cannot be verified. */
export const slopeOk = (s: Pick<SiteRecord, 'slope_deg'>, max: number) => slopeKnown(s) && s.slope_deg! <= max
