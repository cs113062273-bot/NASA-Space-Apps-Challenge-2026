"""Package checked reference geometry for the desktop planner; never infer provider service."""
import hashlib
import json
from datetime import datetime
from pathlib import Path

import build_relay_geometry as geometry
import fetch_relay_sources as sources
import fetch_limb_dem


def digest(p:Path):return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    orbit,checks,cache=geometry.verified_trajectory();cache.close()
    root=sources.ROOT/'data/validation'
    refinement=json.loads((root/'relay-geometry-refinement.json').read_text(encoding='utf-8'))
    dem_source=fetch_limb_dem.verify()
    stress_path=root/'lunar-limb-checks.json'
    stress=json.loads(stress_path.read_text(encoding='utf-8'))
    if stress['source_files']!=dem_source['files'] or stress['maximum_moving_frame_error_m']>1 or stress['near_limb_rays']<20 or len(stress['exact_local_checks'])!=12 or max(r['difference_m'] for r in stress['exact_local_checks'])>10 or len(stress['spice_spherical_intercept_checks'])!=160 or any(r['spice_hit']==r['ray_clear'] for r in stress['spice_spherical_intercept_checks']):
        raise ValueError('Limb stress checks/source do not support the packaged terrain model')
    for filename,sha in stress['code_sha256'].items():
        if digest(Path(geometry.__file__).parent/filename)!=sha:raise ValueError('Limb stress checks are stale')
    cases=[]
    for site in ['c1','change6']:
        name=f'relay-geometry-{site}-sv1';p=root/f'{name}.json';r=json.loads(p.read_text(encoding='utf-8'))
        if digest(p)!=refinement['retained_geometry_reports'][name] or r['builder_sha256']!=digest(Path(geometry.__file__)):
            raise ValueError('Geometry checks or generator no longer match the packaged report')
        if r['orbit_checks_sha256']!=digest(root/'relay-orbit-checks.json') or r['cadence_utc_s']!=15:
            raise ValueError('Only the checked fine-cadence examples may be packaged')
        terrain=r['limb_terrain']
        if terrain['source']!=dem_source or terrain['frame']!='MOON_ME_DE421' or terrain['step_m']!=12.5 or terrain['radial_guard_m']!=100 or terrain['statistics']['maximum_moving_frame_check_error_m']>1:
            raise ValueError('Limb terrain model/source/checks differ from the verified fine geometry')
        for filename,sha in terrain['code_sha256'].items():
            if digest(Path(geometry.__file__).parent/filename)!=sha:raise ValueError('Limb terrain code changed after geometry checks')
        csv=sources.ROOT/r['csv']['path']
        if digest(csv)!=r['csv']['sha256']:raise ValueError('Reference contact CSV changed')
        cases.append({'id':f'{site}-sv1','site':r['site'],'spacecraft':r['spacecraft'],'startUnix':datetime.fromisoformat(r['start_utc'].replace('Z','+00:00')).timestamp(),
            'hours':len(r['hourly']),'cadenceS':r['cadence_utc_s'],'reportSha256':digest(p),'csvSha256':r['csv']['sha256'],
            'orbitChecksSha256':r['orbit_checks_sha256'],'horizonCentideg':r['horizon_centideg'],'hourly':r['hourly'],'passes':r['passes'],'accessChecks':r['access_check_samples'],
            'accessKbps':r['access_kbps_assumed'],'backhaulKbps':r['backhaul_kbps_assumed'],
            'accessHours':r['access_hours'],'backhaulHours':r['backhaul_hours'],'limitations':r['limitations'],
            'limbTerrain':{'product':dem_source['metadata']['product'],'url':dem_source['files']['ldem_64.img']['url'],
                'sha256':dem_source['files']['ldem_64.img']['sha256'],'frame':terrain['frame'],
                'gridM':473.802,'stepM':terrain['step_m'],'guardM':terrain['radial_guard_m'],
                'maximumStressMovingFrameCheckErrorM':stress['maximum_moving_frame_error_m'],'validationSha256':digest(stress_path),
                'maximumRefinementDifferenceM':refinement['limb_terrain_refinement']['maximum_clearance_reduction_m'],
                'removedStationSamples':terrain['statistics']['sphere_guard_pass_terrain_fail_samples']},
            'numerics':{'maximum30DayPositionDifferenceM':1000*max(checks['thirty_day_tighter_dop853']['maximum_position_difference_km_by_sv']),
                'maximumHermiteMidpointDifferenceM':1000*checks['state_interpolation']['maximum_midpoint_position_difference_km']},
            'source':{'url':sources.SOURCES['lcrns-reference-3.1.pdf'],'sha256':orbit['provenance']['relay_sources']['sources']['lcrns-reference-3.1.pdf']['sha256'],
                'epochUtc':orbit['epoch_utc'],'model':'DE421 / GRGM900C 25x25 / differential point masses / spherical SRP',
                'terrainFrame':r['terrain_frame'],'forceFrame':r['force_frame'],'horizonConvention':r['horizon_convention']}})
    output=sources.ROOT/'app/public/data/relay-reference.json'
    output.write_text(json.dumps({'schema':1,'cases':cases},indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Packaged {len(cases)} reference cases: {output.stat().st_size:,} bytes',flush=True)


if __name__=='__main__':main()
