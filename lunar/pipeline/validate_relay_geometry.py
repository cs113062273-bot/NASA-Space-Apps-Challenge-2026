"""Refine geometric sampling without claiming continuous visibility or real service."""
from datetime import datetime,timezone
import hashlib
import json
import numpy as np

import build_relay_geometry as geometry
import fetch_relay_sources as sources


def main():
    coarse=geometry.build('c1',0,7,30)
    coarse_samples=np.load(sources.ROOT/coarse['samples']['path'])
    retained={key:coarse_samples[key].copy() for key in coarse_samples.files}
    coarse_samples.close()
    fine=geometry.build('c1',0,7,15,limb_step_m=12.5)
    samples=np.load(sources.ROOT/fine['samples']['path'])
    # A finer time grid preserves all shared-epoch geometry; no metadata-dependent drift.
    np.testing.assert_array_equal(retained['utc_unix'],samples['utc_unix'][::2])
    differences={}
    for field in ['access_clearance_deg','receiver_elevation_deg','lunar_limb_clearance_deg']:
        differences[field]=float(np.max(abs(retained[field]-samples[field][::2])))
        if differences[field]>1e-10:raise ValueError('Shared sample geometry changed under cadence refinement')
    terrain_delta=retained['terrain_limb_clearance_m']-samples['terrain_limb_clearance_m'][::2]
    if np.min(terrain_delta)<-1e-6:raise ValueError('Nested finer ray grid increased minimum terrain clearance')
    # Both temporal and ray grids retain all old samples, so finer sampling can
    # remove a grant but cannot create one at an already failing shared epoch.
    if np.any((samples['eligible_station_mask'][::2]&~retained['eligible_station_mask'])!=0):
        raise ValueError('Refinement added a failing shared-epoch antenna grant')
    terrain_refinement={'coarse_maximum_step_m':25,'fine_maximum_step_m':12.5,
        'maximum_clearance_reduction_m':float(np.max(terrain_delta)),
        'minimum_clearance_reduction_m':float(np.min(terrain_delta)),
        'changed_station_samples':int(np.sum(retained['terrain_limb_pass']!=samples['terrain_limb_pass'][::2]))}
    samples.close()
    # Refinement may remove a coarse-hour grant, but must never create one when the old
    # grid was already failing. Counts and actual changed hours remain in the report.
    def grants(plan,leg):
        hours=set()
        for p in plan['passes']:
            if p['leg']==leg:hours.update(range(int(p['startUnix']),int(p['endUnix']),3600))
        return hours
    differences_hours={}
    for leg in ['access','backhaul']:
        old,new=grants(coarse,leg),grants(fine,leg)
        if new-old:raise ValueError('Finer all-sample screen added an already failing hour')
        differences_hours[leg]={'coarse_hours':len(old),'fine_hours':len(new),'removed_utc_unix':sorted(old-new)}
    # Also derive a genuinely far-side case, retaining separate per-node contacts.
    far=geometry.build('change6',0,7,15,limb_step_m=12.5)
    report={'schema':1,'checked_utc':datetime.now(timezone.utc).isoformat(),
        'coarse_cadence_s':30,'fine_cadence_s':15,'shared_epoch_maximum_difference_deg':differences,
        'limb_terrain_refinement':terrain_refinement,
        'contact_refinement':differences_hours,'coarse_csv_sha256':coarse['csv']['sha256'],'fine_csv_sha256':fine['csv']['sha256'],
        'retained_geometry_reports':{name:hashlib.sha256((sources.ROOT/'data/validation'/f'{name}.json').read_bytes()).hexdigest() for name in ['relay-geometry-c1-sv1','relay-geometry-change6-sv1']},
        'far_side':{'site':far['site'],'access_hours':far['access_hours'],'backhaul_hours':far['backhaul_hours'],'csv_sha256':far['csv']['sha256']},
        'limitations':['Shared SPICE/model/source inputs; this does not independently validate physical trajectories',
            '15-second sampling is not a proof of visibility between samples','Rates, RF, booking and actual provider relay capability remain unverified']}
    out=sources.ROOT/'data/validation/relay-geometry-refinement.json'
    out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Wrote {out.relative_to(sources.ROOT)}',flush=True)


if __name__=='__main__':main()
