import { Ephemeris, timeOf } from './astro'
import { SiteRecord } from './data'
import { MissionBudget, Radio } from './link'
import { Track, earthVisible } from './metrics'
import { PowerSystem, storageModel } from './power'
import type {TerrainPointScreen} from './terrain-constraint'

/** Nominal hourly observations and the exact selected bus/storage/downlink simulation. */
export function hourlyAnalysisCsv(eph: Ephemeris, site: SiteRecord, t: Track, i0: number, len: number,
  observerM: number, budget?: MissionBudget | null, power?: PowerSystem, restoreUrl?: string, radio?: Radio,terrainConstraint?:TerrainPointScreen): string {
  const a = Math.round(i0), b = a + Math.round(len)
  const header = [`# LUNORIZON export: ${site.name}; lat ${site.lat}; lon ${site.lon}; viewpoint ${observerM} m; Earth margin ${t.earthMinClear} deg; DSN required: ${t.requireDsn}`,
    `# terrain: ${site.dem}; ephemeris: JPL DE440 (NAIF SPICE), MOON_ME frame; interval ${eph.stepS} seconds; nominal skyline`]
  if (power) header.push(`# power: ${JSON.stringify({ ...power, storage: storageModel(power) })}`)
  if(site.localSky)header.push(`# mixed_terrain_skyline: ${JSON.stringify(site.localSky)}; source-specific stationary point; background map shades and touchdown grids are separate`)
  if (radio) header.push(`# radio_and_operations: ${JSON.stringify(radio)}`)
  if(terrainConstraint)header.push(`# terrain_point_requirement: ${JSON.stringify(terrainConstraint)}; projected map metres; static screen at exact mission centre, not the largest nearby disc; unknown/loading cannot pass; hourly Sun/Earth/power are centre samples; restore URL does not pin an immutable model/data release`)
  if(budget?.relay) header.push('# route: assumed relay service contacts; orbit/geometry/RF/booking unverified; link_rate_bps is access capacity, downlink_bits is powered access capacity, not Earth arrival; new access arrivals admitted at bin end and eligible next bin; direct Earth-view rules unchanged')
  if(budget?.relayService)header.push(`# relay_scope_and_rf: ${JSON.stringify({setupPass:budget.relayService.setupPass,issues:budget.relayService.issues,rfMode:budget.relayService.rfMode,rfAssumptions:budget.relayService.rfAssumptions,requirements:budget.relayService.requirements,reference:budget.relayService.binding,skylineShiftDeg:budget.relayService.skylineShiftDeg})}; RF values are scenario assumptions; scope mismatch receives no service credit`)
  if (site.surfaceContext) header.push(`# diviner_annual_context: ${JSON.stringify(site.surfaceContext)}; context only, not a mission-date or equipment temperature; no automatic boundary or pass/fail`)
  if (site.surfaceContextError) header.push(`# diviner_annual_context_unavailable: ${JSON.stringify(site.surfaceContextError)}; no background inferred; core mission inputs are independent`)
  if (t.stations) header.push('# station_geometry: DSS-24, DSS-54, DSS-34 (mask bits 1,2,4); moving NAIF ITRF93 reference antennas; transmission aim and signal-arrival receiver geometry; generic 34m RF budget; no actual booking',
    `# station_asset_sha256: ${eph.stations?.sha256 ?? 'not provided'}; earth_orientation: ${JSON.stringify(eph.stations?.orientation)}; stress inputs are sensitivity, not confidence bounds; nominal run`)
  if (budget?.delivery) header.push(`# downlink_bits is powered channel capacity; payload_delivered_bits is finite-queue ${budget.relay ? 'lander-to-relay delivery, not Earth arrival (use relay_earth_arrived_bits)' : 'Earth delivery'}; payload acquisition stops when full bus demand is unmet`)
  if (budget?.power.thermal) header.push('# equipment temperature: single-node fixed-boundary scenario, not ground-temperature forecast; hourly heater control, <=300s implicit heat-balance steps; only full-bus intervals credit heater/internal heat; replaces darkness-only heater')
  if (restoreUrl) header.push(`# restore_url: ${restoreUrl}`)
  const columns = ['utc', 'sun_elevation_deg', 'skyline_at_sun_deg', 'sun_disk_visible_fraction', 'earth_elevation_deg', 'skyline_at_earth_deg', 'earth_in_view']
  if (budget) columns.push('array_power_w', 'bus_demand_w', 'battery_above_floor_wh', 'full_power_fraction', 'contact_state', 'link_rate_bps', 'downlink_bits', 'planned_receiving_complex_mask', 'chosen_reference_antenna_mask')
  if (t.stations) for (const id of ['dss24', 'dss54', 'dss34']) columns.push(`${id}_terrain_clearance_deg`, `${id}_receiver_elevation_deg`, `${id}_range_km`)
  if (budget?.delivery) columns.push('payload_produced_bits', 'payload_delivered_bits', 'payload_overflow_bits', 'payload_stored_bits')
  if (budget?.power.thermal) columns.push('equipment_temperature_start_k', 'equipment_temperature_end_k', 'full_supply_temperature_end_k', 'heater_requested_w', 'heater_delivered_wh')
  if(budget?.relay) columns.push('relay_received_bits','relay_earth_arrived_bits','relay_overflow_bits','relay_stored_bits','relay_earth_active_fraction','relay_backhaul_rate_bps')
  const rows = [columns.join(',')]
  for (let i = a; i < b; i++) {
    const j = i - a
    const row: (string | number)[] = [new Date(timeOf(eph, i) * 1000).toISOString().slice(0, 16) + 'Z',
      t.sunEl[i].toFixed(3), (t.sunEl[i] - t.sunClear[i]).toFixed(3), t.sunFrac[i].toFixed(6),
      t.earthEl[i].toFixed(3), (t.earthEl[i] - t.earthClear[i]).toFixed(3), earthVisible(t, i) ? 1 : 0]
    if (budget) row.push(budget.power.series[j].toFixed(6), budget.power.load[j].toFixed(6), budget.power.soc[j].toFixed(6),
      budget.power.metFrac[j].toFixed(8), budget.link.state[j], budget.link.rate[j].toFixed(6),
      (budget.link.rate[j] * eph.stepS * budget.power.metFrac[j]).toFixed(3), budget.link.receivingMask[j], budget.link.chosenStation[j])
    if (t.stations) for (let k = i * 3; k < i * 3 + 3; k++) row.push(t.stations.clear[k].toFixed(6), t.stations.groundEl[k].toFixed(6), t.stations.distance[k].toFixed(3))
    if (budget?.delivery) row.push(budget.delivery.produced[j].toFixed(3), budget.delivery.delivered[j].toFixed(3), budget.delivery.lost[j].toFixed(3), budget.delivery.buffer[j].toFixed(3))
    if (budget?.power.thermal) {
      const th = budget.power.thermal
      row.push(th.temperatureK[j].toFixed(5), th.temperatureK[j + 1].toFixed(5), th.fullPowerK[j + 1].toFixed(5), th.heaterW[j].toFixed(5), th.deliveredHeaterWh[j].toFixed(5))
    }
    if(budget?.relay) {
      const r=budget.relay
      row.push(r.received[j].toFixed(3),r.delivered[j].toFixed(3),r.lost[j].toFixed(3),r.buffer[j].toFixed(3),r.earthActiveFrac[j].toFixed(8),budget.relayService?.backhaul[j].toFixed(6)??'')
    }
    rows.push(row.join(','))
  }
  return [...header, ...rows].join('\n') + '\n'
}
