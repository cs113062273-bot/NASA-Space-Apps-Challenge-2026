import horizons from '../../../data/validation/horizons-crosscheck.json'
import glaser from '../../../data/validation/glaser2018-crosscheck.json'
import pgda from '../../../data/validation/pgda-avgvisib-crosscheck.json'
import dsn from '../../../data/validation/station-receivers-horizons.json'
import { max_abs_error as stationError, samples as stationSamples } from '../../../data/validation/station-geometry-crosscheck.json'
import effect from '../../../data/validation/skyline-effect.json'
import mission from '../../../data/validation/mission-effect.json'
import { MISSION_CHECKS, STEREO_CHECK } from '../lib/evidence'

const c1 = glaser.rows[0]
const crew = mission.summary['all points']['Artemis III crew']
const flips = MISSION_CHECKS.map((v) => v.timestep_lola_disagree)

/** Open the full checks and bring one into view. */
function openCheck(n: number) {
  const more = document.querySelector<HTMLDetailsElement>('.evidence-more')
  if (more) more.open = true
  requestAnimationFrame(() => document.getElementById(`check-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

export function Evidence() {
  return (
    <div className="evidence">
      <details className="planning-limits model-details" id="planning-limits"><summary>What the planning results cover</summary>
        <p>LUNORIZON screens a selected site, date and hardware scenario using the displayed source data. Check the source resolution, time sampling and selected assumptions when using a result.</p>
        <p>Skyline shifts, RMS multipliers and soil factors explore sensitivity; they are not mission-success probabilities. Sub-grid hazards, source registration and measured vehicle performance need separate assessment. A passing screen supports planning rather than landing clearance.</p>
        <p>Radio allocations, relay services, equipment boundaries and uniform soil values are scenarios supplied by the user. Direct Earth visibility is distinct from a booked ground-station link. Diviner annual context is distinct from a forecast for the selected stay. Model-specific details and complete assumptions remain in the relevant reports and exports.</p>
      </details>
      <div className="scorecard" style={{ gridColumn: '1 / -1' }} role="list" aria-label="Validation summary">
        {[
          ['Sun & Earth vs JPL Horizons', `${(horizons.max_abs_elevation_error_deg as number).toFixed(5)}°`, 'largest of 40 differences; terrain timing is checked separately', 1],
          ['Sunlight vs NASA Goddard’s map', `${pgda.summary.rmse_pp} percentage points`, `RMS difference across ${pgda.summary.n} polar points`, 2],
          ['Illumination vs Gläser et al. 2018', '78.1% / 78.1%', 'Connecting Ridge C2, 20-year average', 2],
          ['Blue Ghost’s eclipse, 14 Mar 2025', '≤ 4 min', 'model contacts vs reported, all four', 3],
          ['Odysseus wake-up', '20 Mar 2024', 'model first light = day operators listened', 3],
          ['Terrain check · Artemis III', `${STEREO_CHECK.confirmedDays} / ${STEREO_CHECK.passDays}`, `PASS days confirmed; ${STEREO_CHECK.pointsWithPass} of ${STEREO_CHECK.points} points have passing days`, 4],
        ].map(([k, v, sub, check]) => (
          <button key={k} className="kpi" role="listitem" title={`Open check ${check}`} onClick={() => openCheck(check as number)}>
            <div className="label">{k}</div><div className="value" style={{ fontSize: 20 }}>{v}</div><div className="sub">{sub}</div>
          </button>
        ))}
      </div>

      <div className="panel" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-h"><h3>NASA site-selection criteria</h3></div>
        <div className="panel-b">
          <table>
            <thead><tr><th>Criterion</th><th style={{ textAlign: 'left' }}>LUNORIZON analysis</th></tr></thead>
            <tbody>
              {[
                ['Evaluate constraints together across dates', 'Daily heatmap across compared sites'],
                ['Maintain sunlight throughout the crew stay', '6.25-day crew preset and delay tolerance'],
                ['Prefer greater Earth visibility for direct links', 'Contact windows, gaps, clearance and DSN link budget'],
                ['Retain sufficient low-slope landing area', 'Point-level slope and sunlight within a 500 m touchdown circle'],
                ['Keep multiple regions open for annual availability', 'Combined availability vs the best single site'],
              ].map(([c, f]) => (
                <tr key={c}><td style={{ fontFamily: 'var(--sans)', color: 'var(--muted)', width: '50%' }}>{c}</td><td style={{ fontFamily: 'var(--sans)', textAlign: 'left' }}>{f}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
            Criteria summarized from <a href="https://ntrs.nasa.gov/citations/20250011660" target="_blank" rel="noreferrer">George et al., LPSC 2026</a>. Region outlines follow NASA’s October 2024 figure (about ±3 km).
          </p>
        </div>
      </div>

      <div className="panel" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-h"><h3>Limits: read before you plan</h3></div>
        <div className="panel-b">
          <ul className="cols2">
            <li>Not modelled: features smaller than the terrain grid (Athena’s crater was one), lander tilt/self-shadowing, regolith-temperature evolution or multi-component thermal gradients. An optional equipment-node scenario is available in Power; its fixed boundaries are assumptions, not a thermal survival certification.</li>
            <li>Hourly sampling, interpolated. Against 10-minute steps it changed {Math.min(...flips)}–{Math.max(...flips)} of {crew.point_days} polar mission verdicts per rule preset.</li>
            <li>Near the pole, single sunset times can be off by hours (1 in 10 by {effect.summary.sunset_shift_h_pooled.p90} h or more against 2 m stereo terrain); annual sunlight differences have a median of 0.7 pp, with a largest measured difference of 3.2 pp.</li>
            <li>Sites you add north of 75°S use 1.9 km terrain: a first look, not event times to the hour.</li>
            <li>Battery, heating and equipment temperature are editable engineering scenarios, not models of a specific lander. DSN bookings and relay links are not inferred.</li>
            <li>Not flight-certified mission analysis.</li>
          </ul>
        </div>
      </div>

      <details className="evidence-more" style={{ gridColumn: '1 / -1' }}>
        <summary>The checks in full: numbers, methods, data and sources</summary>
        <div className="evidence">
        <div id="check-1" className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="panel-h"><h3>Check 1 · Sun and Earth positions vs JPL Horizons</h3></div>
          <div className="panel-b">
            <p className="muted" style={{ marginTop: 0 }}>
              Largest elevation difference: <b className="mono">{(horizons.max_abs_elevation_error_deg as number).toFixed(5)}°</b> in {horizons.n} comparisons (4 south-polar sites × 5 dates, 2025–2031, Sun and Earth),
              against NASA/JPL’s Horizons service with an observer on the lunar surface. Azimuth agrees to {(horizons.max_abs_azimuth_error_deg as number) < 0.000005 ? 'better than 0.00001' : (horizons.max_abs_azimuth_error_deg as number).toFixed(5)}°.
              About 1/10,000 of the Sun’s width.
            </p>
            <p className="muted">Reference DSN antennas DSS-24 / DSS-54 / DSS-34: the largest Moon-centre receiving-elevation difference against Horizons is <b className="mono">{Math.max(...Object.values(dsn.max_abs_error_deg)).toFixed(5)}°</b> across {dsn.rows.length} samples, 2025–2031. This checks a separate JPL service, not flight measurements; related ephemeris/Earth-rotation models may be shared.</p>
            <p className="muted">Browser transmit aim and signal-arrival receiving geometry also match complete SPICE fixed-lander observers within <b className="mono">{Math.max(stationError.lunar_az_deg, stationError.lunar_el_deg, stationError.receiver_el_deg).toFixed(5)}°</b> in {stationSamples} cases, 2023–2031. That is an approximation check against the same kernels. Earth rotation from 30 Jan 2027 uses a low-accuracy prediction; the small sample differences do not establish its real future accuracy.</p>
          </div>
        </div>

        <div id="check-2" className="panel">
          <div className="panel-h"><h3>Check 2 · Sunlight vs NASA Goddard and a published study</h3></div>
          <div className="panel-b">
            <p className="muted" style={{ marginTop: 0 }}>
              <b>Whole region.</b> At {pgda.summary.n} random points between 85°S and the pole, the share of 18.6 years with any of the Sun above our skyline matches NASA Goddard’s
              LOLA sunlight map (PGDA, AVGVISIB 60 m): r = <b className="mono">{pgda.summary.r.toFixed(3)}</b>, RMSE <b className="mono">{pgda.summary.rmse_pp} pp</b>,
              median difference <b className="mono">{pgda.summary.median_abs_pp} pp</b>, bias {pgda.summary.bias_pp > 0 ? '+' : ''}{pgda.summary.bias_pp} pp (we look from 2 m up; the map from the ground).
              {' '}{Math.round(pgda.summary.share_within_3x3_range * 100)}% fall inside the range of the map’s 3×3 pixels; the rest sit on steep slopes where one pixel differs from the next by tens of points.
            </p>
            <p className="muted"><b>Named peaks</b>, against Gläser et al. (2018):</p>
            <table>
              <thead>
                <tr><th>Site (2 m above ground, 2017–2037)</th><th>Published</th><th>LUNORIZON</th><th>Longest shadow pub. / ours (±0.1° skyline)</th></tr>
              </thead>
              <tbody>
                {glaser.rows.map((r) => (
                  <tr key={r.site}>
                    <td style={{ fontFamily: 'var(--sans)' }}>{r.site}</td>
                    <td>{r.reference.avg_illumination_pct.toFixed(1)}%</td>
                    <td>{r.ours_best_within_100m.avg_illumination_pct.toFixed(1)}%</td>
                    <td>{r.reference.max_shadow_h} h / {r.ours_best_within_100m.max_shadow_h} h ({r.ours_best_within_100m.max_shadow_h_skyline_lower}–{r.ours_best_within_100m.max_shadow_h_skyline_higher})</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
              <a href="https://pgda.gsfc.nasa.gov/products/69" target="_blank" rel="noreferrer">PGDA product 69</a> (Mazarico et al. 2011 method).
              Gläser: average visible solar disk over 20 years, hourly. Reference: Gläser, Oberst, Neumann, Mazarico, Speyerer &amp; Robinson (2018),
              Planet. Space Sci. 162, Table 2 (<a href="https://ntrs.nasa.gov/citations/20170007365" target="_blank" rel="noreferrer">NASA NTRS</a>).
              Their maxima sit on a track-adjusted LOLA grid; ours on the public PDS grid, so we report the best point within 100 m.
              Average sunlight is robust; the longest shadow on a sharp peak is not. Within 100 m of Connecting Ridge C1 it ranges from {c1.max_shadow_h_range_within_100m[0]} to {c1.max_shadow_h_range_within_100m[1]} h,
              and with the skyline 0.1° lower the shortest is {c1.min_max_shadow_h_within_100m_skyline_lower} h, against the published 112 h. At Connecting Ridge C2 it barely moves.
            </p>
          </div>
        </div>

        <div id="check-3" className="panel">
          <div className="panel-h"><h3>Check 3 · Against what flew</h3></div>
          <div className="panel-b">
            <table className="text">
              <thead><tr><th>Lander</th><th>Model</th><th>Reported</th><th>Reading</th></tr></thead>
              <tbody>
                <tr><td>Odysseus (IM-1)</td><td>first light after the night 20 Mar 2024; slope 14°</td><td>listening began 20 Mar 2024; ~12° slope</td><td className="good">match</td></tr>
                <tr><td>Chandrayaan-3</td><td>sunset 4 Sep 2023 ~07:40 UTC</td><td>put to sleep ~02:30 UTC</td><td className="good">consistent</td></tr>
                <tr><td>Blue Ghost M1</td><td>Earth eclipses the Sun 14 Mar 2025 05:01–09:51 UTC, total 06:18–08:34</td><td>05:00–09:52, total from 06:18, “diamond ring” photo 08:30</td><td className="good">match, ≤ 4 min</td></tr>
                <tr><td>Blue Ghost M1</td><td>sunset 16 Mar 2025 19:53 UTC ± 12 min</td><td>last contact 23:25 UTC</td><td>gap is battery, not terrain</td></tr>
                <tr><td>Chang’e 4 and 6</td><td>Earth in view 0% of 2027</td><td>flown via Queqiao relays</td><td className="good">match</td></tr>
                <tr><td>Athena (IM-2)</td><td>~2 weeks of Sun, even on 4 m terrain</td><td>ended in hours, in a small crater</td><td className="bad">below resolution</td></tr>
              </tbody>
            </table>
            <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>Sources on the case files. Matching dates shows the geometry is right; it does not prove lander-level prediction.</p>
          </div>
        </div>

        <div id="check-4" className="panel">
          <div className="panel-h"><h3>Check 4 · How far to trust the skyline</h3></div>
          <div className="panel-b">
            <p className="muted" style={{ marginTop: 0 }}>
              <b>Terrain model.</b> Where LROC stereo terrain exists (4 m at Athena, 3 m at Chandrayaan-3), the LOLA skyline differs from it by a median
              of <b className="mono">0.003–0.009°</b>; 90% of azimuths are within <b className="mono">0.07–0.12°</b>, the worst 0.3°. Every sunset on the page therefore carries
              a sensitivity range for a skyline 0.1° higher or lower: about ±1 h at the flown sites, far more near the pole, where the Sun skims the horizon.
              Sites you add on the coarse whole-Moon grid use a 1° sensitivity shift instead.
            </p>
            <p className="muted">
              <b>Polar ridges and rims are harder.</b> DLR’s 2 m stereo models of the Connecting Ridge, Shackleton’s rim and Malapert’s peak, at {effect.summary.points} points:
              the annual share of sunlight moves by a median <b className="mono">{effect.summary.sun_pct_abs_diff_median_all} pp</b>, so maps and averages hold.
              Single sunsets do not always: of {effect.summary.sunsets_pooled} sunsets in 2027, <b className="mono">{effect.summary.sunset_within_1h_pct}%</b> agree within an hour, but 1 in 10 moves by
              {' '}<b className="mono">{effect.summary.sunset_shift_h_pooled.p90} h</b> or more. Metre-scale bumps LOLA cannot see decide when a Sun that skims the ridge goes out.
              {' '}At the {effect.summary.flat_points} points with slope ≤10°, the 90th-percentile sunset shift is {effect.summary.sunset_shift_h_pooled_flat.p90} h.
              Near the pole, keep days of margin. The check below measures mission decisions in a limited sample; it does not establish a confidence level for another site.
            </p>
            <p className="muted">
              <b>Mission decisions, not just averages.</b> Every 2027 landing day at {mission.rows.length} points was checked at 2 m height, with the selected slope threshold,
              Earth-centre visibility and eclipses included. The sample includes C1, Shackleton rim, Athena and 15 ridge/rim/peak points. LOLA uses hourly samples;
              the 2–4 m stereo reference uses 10-minute samples. Under Artemis III rules, only {crew.points_with_any_pass} points have any passing days.
              Of {crew.lola_pass_days} nominal PASS point-days, {crew.lola_pass_stereo_fail} fail on the finer reference; another {crew.lola_fail_stereo_pass} pass only there.
            </p>
            <table>
              <thead><tr><th>Rules</th><th>LOLA PASS days</th><th>Not confirmed</th><th>Missed passes</th><th>Largest annual count difference</th></tr></thead>
              <tbody>{MISSION_CHECKS.map((check) => <tr key={check.name}><td>{check.name}</td><td>{check.lola_pass_days}</td><td>{check.lola_pass_stereo_fail}</td><td>{check.lola_fail_stereo_pass}</td><td>{check.annual_days_abs_diff_max} d</td></tr>)}</tbody>
            </table>
            <p className="faint">Each “day” is one site + date, not an independent region. Hourly vs 10-minute sampling changed {Math.min(...flips)}–{Math.max(...flips)} of {crew.point_days} decisions per preset.
              The sample is clustered in three stereo areas plus Athena; modelled slopes change some decisions too. The {crew.raised_pass_confirmed_pct}% confirmation of raised-skyline Artemis passes describes this sample only.
              A Fragile flag means the selected skyline shift changes a verdict; it is not a probability of failure.</p>
            <p className="muted">
              <b>The map.</b> The light-and-shadow layer marches 80 m terrain toward the Sun from every pixel; at four polar sites and 800 random hours it calls lit or dark like the sites’ 20 m horizons 99.1% of the time.
            </p>
            <p className="muted">
              <b>Sites you add.</b> Median skyline difference from the pipeline: <b className="mono">0.006–0.06°</b> near the pole (80 m terrain, four sites);
              <b className="mono"> 0.02–0.9°</b>, worst 4°, elsewhere (1.9 km whole-Moon grid, 11 sites). Slopes from the 80 m grid match the 40 m pipeline median within 1°
              but flag about half as many points steeper than 10°.
            </p>
          </div>
        </div>

        <div id="check-5" className="panel">
          <div className="panel-h"><h3>Check 5 · Consistency with NASA’s case for several regions</h3></div>
          <div className="panel-b">
            <p className="muted" style={{ margin: 0 }}>
              NASA’s site-selection team says one region alone rarely has enough viable days. With the Artemis III crew preset
              (6.25 days of unbroken Sun, Earth in view half the time, slope ≤ 8°), the best region qualifies on <b className="mono">133</b> of the 365 landing days from 7 Jan 2027;
              any of the nine on <b className="mono">283</b>, and <b className="mono">279</b> with every skyline 0.1° higher (the 12 January 2028 eclipse, total at the pole, rules out the stays that span it). Launch, transfer and landing constraints are left out, so this is not NASA’s analysis.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-h"><h3>How it works</h3></div>
          <div className="panel-b">
            <ul>
              <li><b>Horizon:</b> 720 rays (every 0.5°) out to 300 km, including the curvature of the Moon. Finest terrain first: LROC NAC 3–4 m at Athena and Chandrayaan-3; LOLA 20 m within 10 km of other polar sites, then 80 m and 240 m; elsewhere LOLA 59 m within 25 km, then 474 m. Sites you add use 80/480 m south of 75°S and 1.9 km elsewhere, computed in your browser.</li>
              <li><b>Sun and Earth:</b> JPL DE440 via NASA NAIF SPICE, light time and aberration, per-site parallax, hourly 2023–2031.</li>
              <li><b>Sunlight:</b> visible fraction of the solar disk; darkness = none of it. When Earth passes in front of the Sun (a lunar eclipse seen from Earth) only the part of the disk both above the skyline and outside Earth counts: the two coverings can overlap, so their shares are not multiplied. An eclipse counts as darkness but not as a sunset.</li>
              <li><b>Earth in view:</b> Earth’s centre above the skyline by the chosen margin. With <b>+ DSN</b> it also needs Goldstone, Madrid or Canberra to see the Moon at 10° or more (line of sight both ends).</li>
              <li><b>Downlink:</b> a link budget per planned contact hour to one reference DSN 34 m antenna, with path loss from the hourly Earth distance and the Moon’s own radio glow in the antenna beam (189 K at X band), which costs about 10 dB. A dish’s gain follows the band (a 0.5 m dish: 30 dBi at X, 19 dBi at S). The radio reserves 3.3 W per RF watt from the same battery during planned contact. Without a payload model the volume is powered channel capacity. With it, simultaneous powered acquisition and finite storage determine delivered, pending and discarded data. Downlink geometry uses DSS-24, DSS-54 and DSS-34: each eligible link must clear lunar terrain and that antenna’s elevation mask, while RF performance uses a generic 34 m budget. All results assume your allocation is available.</li>
              <li><b>Polar maps:</b> share of 2027 with Earth above each point’s own terrain skyline, 2 km grid to 200 km from the pole. Earth never rises over 40% of that ground. Curated sites are local highs, so their map cell reads lower than the site itself.</li>
              <li><b>Whole-Moon Earth map:</b> Earth above a flat horizon through 2027. Thanks to libration, 39% of the surface never sees Earth and 39% always does.</li>
            </ul>
          </div>
        </div>

        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="panel-h"><h3>Data and sources</h3></div>
          <div className="panel-b">
            <ul>
              <li>NASA LRO Lunar Orbiter Laser Altimeter (LOLA) gridded polar DEMs LDEM_80S_20M, LDEM_80S_80M, LDEM_75S_240M, LDEM_60S_240M, and global grids LDEM_512 (59 m), LDEM_64 (474 m) and LDEM_16 (1.9 km) — <a href="https://pds-geosciences.wustl.edu/missions/lro/lola.htm" target="_blank" rel="noreferrer">PDS Geosciences Node</a> (Smith et al., GSFC).</li>
              <li>JPL planetary ephemeris DE440 (de440s.bsp), lunar orientation moon_pa_de440_200625.bpc and frames moon_de440_250416.tf, naif0012.tls, pck00011.tpc — <a href="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/" target="_blank" rel="noreferrer">NASA NAIF</a>.</li>
              <li>Lander outcomes: <a href="https://www.space.com/the-universe/moon/farewell-blue-ghost-private-moon-lander-goes-dark-to-end-record-breaking-commercial-lunar-mission" target="_blank" rel="noreferrer">Blue Ghost goes dark after sunset (Space.com)</a>; other lander sources are on each case file.</li>
              <li>LROC NAC stereo terrain models NAC_DTM_NOBILE03 (4 m) and NAC_DTM_VIKRAMSITE1 (3 m), and for the polar check the DLR 2 m models NAC_DTM_ESALL_CR1, _SR12 and _MP1 — <a href="https://data.lroc.im-ldi.com/lroc/rdr_product_select?filter%5Btext%5D=NAC_DTM" target="_blank" rel="noreferrer">LROC RDR archive</a> (NASA / Arizona State University).</li>
              <li>Independent checks: <a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noreferrer">JPL Horizons</a> API; NASA Goddard <a href="https://pgda.gsfc.nasa.gov/products/69" target="_blank" rel="noreferrer">PGDA south-pole sunlight map</a> (AVGVISIB_85S_060M).</li>
              <li>Reference DSN antenna positions and velocities (DSS-24, DSS-54, DSS-34): DSN 810-005 module 301, via NAIF’s <a href="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/stations/earthstns_itrf93_260814.cmt" target="_blank" rel="noreferrer">ITRF93 station kernel</a>. Earth orientation: recent binary PCK, then the <a href="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/earth_1962_260806_2126_combined.cmt" target="_blank" rel="noreferrer">long-term prediction</a>. Generic 34 m gain and system temperature: <a href="https://deepspace.jpl.nasa.gov/dsndocs/810-005/104/104L.pdf" target="_blank" rel="noreferrer">DSN 810-005 module 104 Rev. L</a> (not antenna-specific RF qualification); lunar noise: Morabito, <a href="https://ipnpr.jpl.nasa.gov/progress_report/42-166/166C.html" target="_blank" rel="noreferrer">IPN Progress Report 42-166</a> (2006).</li>
              <li>Upcoming missions: NASA CLPS and provider announcements as summarised on each row’s linked page; Reiner Gamma centre from the <a href="https://planetarynames.wr.usgs.gov/Feature/4987" target="_blank" rel="noreferrer">IAU Gazetteer</a>.</li>
              <li>Sun and Earth photos: <a href="https://images.nasa.gov/details/GSFC_20171208_Archive_e000923" target="_blank" rel="noreferrer">SDO/HMI visible-light Sun, 23 Oct 2014</a> (NASA/SDO) and <a href="https://images.nasa.gov/details/as17-148-22727" target="_blank" rel="noreferrer">“Blue Marble”, Apollo 17, AS17-148-22727</a> (NASA). Earth’s night side is shaded from the computed phase; the photo’s continents do not follow Earth’s rotation.</li>
              <li>Site coordinates: NASA/LROC for IM-1 and IM-2, IAU for Statio Shiv Shakti, Gläser et al. (2018) for the ridge and rim points, a 2024 Acta Astronautica study for Nobile Rim 2 DM2, <a href="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html" target="_blank" rel="noreferrer">NASA NSSDCA</a> for the Apollo Lunar Modules, NASA LROC for SLIM and Chang’e 4, 5 and 6, and Firefly for Blue Ghost.</li>
            </ul>
          </div>
        </div>
        </div>
      </details>
    </div>
  )
}
