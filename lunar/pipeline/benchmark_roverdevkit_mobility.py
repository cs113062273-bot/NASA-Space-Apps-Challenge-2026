"""Execute only the reviewed, pinned MIT wheel kernel for a capability probe.

This is a comparator sub-model run, not a full-tool/UI benchmark or independent
verification of its physical validity. No package installation or surrogate is
needed. Our current fixed-drive input cannot represent these soil/load cases.
"""
from pathlib import Path
from datetime import datetime, timezone
from dataclasses import asdict
import csv
import hashlib
import importlib.util
import json
import math
import sys
import numpy as np
import scipy
from scipy.optimize import brentq

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    source_path = ROOT / 'data/validation/competitor-roverdevkit-source.json'
    source = json.loads(source_path.read_text(encoding='utf-8'))
    files = {f['path']: f for f in source['files']}
    for f in files.values():
        if sha(ROOT / f['cache']) != f['sha256']:
            raise ValueError('Comparator source changed: ' + f['path'])
    kernel = ROOT / files['roverdevkit/terramechanics/bekker_wong.py']['cache']
    # The complete wheel kernel was read before this runner was introduced.
    # Load that file directly; do not import the unreviewed full evaluator or
    # install its package/build hooks, web backend, optimizers or ML artifacts.
    spec = importlib.util.spec_from_file_location('reviewed_roverdevkit_wheel', kernel)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    with (ROOT / files['data/soil_simulants.csv']['cache']).open(encoding='utf-8', newline='') as stream:
        soils = {r['simulant']: r for r in csv.DictReader(stream)}
    assumptions = {'massKg': 20., 'gravityMps2': 1.62, 'wheels': 4, 'radiusM': .1, 'widthM': .05,
                   'grouserHeightM': .005, 'grouserCount': 12, 'forwardSpeedMps': .01, 'motorEfficiency': .8, 'peakHubTorqueNm': 2.}
    wheel = module.WheelGeometry(assumptions['radiusM'], assumptions['widthM'], assumptions['grouserHeightM'], assumptions['grouserCount'])
    cases = []
    for name in ['Apollo_regolith_nominal', 'Apollo_regolith_loose', 'Apollo_regolith_dense']:
        row = soils[name]
        soil = module.SoilParameters(float(row['n']), float(row['k_c_kN_per_m_n_plus_1']), float(row['k_phi_kN_per_m_n_plus_2']), float(row['cohesion_kPa']), float(row['friction_angle_deg']))
        for slope in [0., 5., 10., 20., 30.]:
            angle = math.radians(slope)
            weight = assumptions['massKg'] * assumptions['gravityMps2'] / assumptions['wheels']
            normal = weight * math.cos(angle)
            required = weight * math.sin(angle)

            def residual(slip):
                return module.single_wheel_forces(wheel, soil, normal, slip).drawbar_pull_n - required

            record = {'soil': name, 'publisherSoilCitation': row['citation'], 'slopeDeg': slope, 'normalPerWheelN': normal, 'requiredDrawbarPerWheelN': required,
                      'soilParameters': asdict(soil), 'lastlightSupport': 'Not represented: no soil, wheel, load or motor/traction model in the current constant-drive input.'}
            lo, hi = residual(-.9), residual(.95)
            record['residualAtBracketN'] = [lo, hi]
            if lo * hi > 0:
                record.update(status='no-slip-root-in-publisher-bracket', slip=None, perWheel=None, driveDcW=None)
            else:
                slip = float(brentq(residual, -.9, .95, xtol=1e-10))
                force = module.single_wheel_forces(wheel, soil, normal, slip)
                omega = assumptions['forwardSpeedMps'] / (wheel.radius_m * (1 - slip))
                dc = assumptions['wheels'] * force.driving_torque_nm * omega / assumptions['motorEfficiency']
                record.update(status='hub-torque-exceeded' if force.driving_torque_nm > assumptions['peakHubTorqueNm'] else 'steady-state-root', slip=slip,
                              perWheel=asdict(force), driveDcW=dc, wheelOmegaRadS=omega, balanceResidualN=residual(slip))
            cases.append(record)
    report = {'schema': 1, 'checkedUTC': datetime.now(timezone.utc).isoformat(), 'repository': source['repository'], 'commit': source['commit'],
              'sourceManifestSha256': sha(source_path), 'runnerSha256': sha(__file__), 'assumptions': assumptions, 'cases': cases,
              'environment': {'python': sys.version.split()[0], 'numpy': np.__version__, 'scipy': scipy.__version__},
              'method': 'Reviewed publisher wheel kernel executed directly from verified immutable source. Runner solves constant-slope per-wheel drawbar balance in the publisher slip bracket and computes torque-times-angular-speed / efficiency for an explicitly prescribed speed.',
              'limits': ['A sub-model capability probe, not the full evaluator, UI, NSGA-II, timing or human-task benchmark.',
                         'Soil table values/citations belong to the publisher and were not independently measured or validated here. Kernel heuristics and model-form uncertainty remain.',
                         'Chosen mass, wheels, speed, efficiency and motor capacity are illustrative assumptions, not a NASA rover specification or validated mobility prediction.',
                         'No physical or numerical superiority follows: LASTLIGHT currently lacks equivalent wheel/soil inputs, so the probe records an actual missing capability rather than a matched numeric win.',
                         'Static slope, equal load and steady-state straight travel omit dynamics, turns, load transfer, rocks and registration; no route-level or flight feasibility follows.']}
    path = ROOT / 'data/validation/competitor-roverdevkit-mobility.json'
    path.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'cases': len(cases), 'steadyStateRoots': sum(c['status'] == 'steady-state-root' for c in cases),
                      'noSlipRoot': sum(c['status'] == 'no-slip-root-in-publisher-bracket' for c in cases),
                      'dcRangeWAmongRoots': [min(c['driveDcW'] for c in cases if c['driveDcW'] is not None), max(c['driveDcW'] for c in cases if c['driveDcW'] is not None)]}))


if __name__ == '__main__':
    main()
