import mission from '../../../data/validation/mission-effect.json'

const summary = mission.summary['all points']
const crew = summary['Artemis III crew']
export const MISSION_CHECKS = Object.keys(mission.presets).map((name) => ({
  name, ...summary[name as keyof typeof mission.presets],
}))
const nominalOnly = MISSION_CHECKS.map((check) => check.nominal_only_confirmed_pct)

/** Results describe this sample, not the probability that an arbitrary selected mission will succeed. */
export const STEREO_CHECK = {
  points: mission.rows.length,
  confirmedPct: Math.round(crew.lola_pass_confirmed_pct),
  raisedConfirmedPct: Math.round(crew.raised_pass_confirmed_pct),
  confirmedDays: crew.lola_pass_days - crew.lola_pass_stereo_fail,
  passDays: crew.lola_pass_days,
  pointsWithPass: crew.points_with_any_pass,
  nominalOnlyRange: `${Math.round(Math.min(...nominalOnly))}–${Math.round(Math.max(...nominalOnly))}%`,
  timestepFlipsArtemis: crew.timestep_lola_disagree,
}

export const POLAR_LIMITS = `Polar sunset timing depends on fine terrain: 1 in 10 sunsets shifted by 7 h or more in the ridge/rim check. The +0.1° run shows the effect of a higher skyline. At ${STEREO_CHECK.points} sampled points and 2 m height, finer terrain confirmed ${STEREO_CHECK.confirmedDays} of ${STEREO_CHECK.passDays} Artemis III PASS days; ${STEREO_CHECK.pointsWithPass} points had passing days. These counts describe that regional sample.`
