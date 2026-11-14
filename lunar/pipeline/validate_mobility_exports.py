"""Check actual desktop wheel/soil exports against the pinned publisher kernel.

This is numerical agreement on the declared model, not independent soil truth,
hardware qualification or a whole-product competitor/UI performance result.
"""
from pathlib import Path
from datetime import datetime, timezone
import csv
import hashlib
import importlib.util
import json
import math
import sys
import numpy as np
from scipy.optimize import brentq

ROOT = Path(__file__).resolve().parents[1]


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))


def main():
    manifest_path = ROOT / 'data/validation/competitor-roverdevkit-source.json'
    manifest = read(manifest_path)
    entry = next(f for f in manifest['files'] if f['path'] == 'roverdevkit/terramechanics/bekker_wong.py')
    kernel = ROOT / entry['cache']
    if sha(kernel) != entry['sha256']:
        raise ValueError('Pinned publisher kernel changed')
    spec = importlib.util.spec_from_file_location('reviewed_wheel_export_reference', kernel)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    maximum = {}

    def close(actual, expected, tolerance, key):
        if not math.isfinite(actual) or abs(actual - expected) > tolerance:
            raise ValueError(f'{key}: {actual} != {expected}')
        maximum[key] = max(maximum.get(key, 0.), abs(actual - expected))

    cases = []
    for suffix in ['failed', 'passed']:
        path = ROOT / f'app/test-results/moving-mobility-{suffix}.json'
        packet = read(path)
        source = packet['route']['source']['patch']
        raw = ROOT / 'app/public/data/landing-terrain' / source['file']
        if sha(raw) != source['sha256']:
            raise ValueError('Native source checksum differs')
        native = np.fromfile(raw, dtype='<f4').reshape(5, source['rows'], source['cols'])
        nodes = packet['route']['result']['nodes']
        for n in nodes:
            row, col = divmod(n['index'], source['cols'])
            close(n['heightM'], float(native[3, row, col]), 1e-10, 'sourceHeightM')
            close(n['x'], source['x0'] + col * source['stepM'], 1e-10, 'sourceMapM')
            close(n['y'], source['y0'] - row * source['stepM'], 1e-10, 'sourceMapM')
        inp = packet['input']
        settings = inp['settings']
        m = settings['mobility']
        s = m['soil']
        wheel = module.WheelGeometry(m['radiusM'], m['widthM'], m['grouserHeightM'], m['grouserCount'])
        soil = module.SoilParameters(s['n'], s['kC'], s['kPhi'], s['cohesionKpa'], s['frictionDeg'], s['shearLengthM'])
        csv_path = path.with_suffix('.csv')
        csv_rows = list(csv.DictReader(line for line in csv_path.read_text(encoding='utf-8').splitlines() if line and not line.startswith('#')))
        count = 0
        solutions = {}
        for name, csv_name in [('nominal', 'nominal'), ('raised', 'raised'), ('refinedNominal', 'refined_nominal'), ('refinedRaised', 'refined_raised')]:
            run = packet['evaluation'][name]
            rows = [r for r in csv_rows if r['scenario'] == csv_name]
            if len(rows) != len(run['samples']):
                raise ValueError('CSV extent differs')
            drive_wh = 0.
            for sample, row in zip(run['samples'], rows):
                motion = sample.get('mobility')
                drive_wh += sample['driveW'] * sample['seconds'] / 3600
                if not motion:
                    if row['wheel_grade_deg']:
                        raise ValueError('CSV fabricated a motion attempt')
                    continue
                count += 1
                edge = next(i for i, n in enumerate(nodes) if n['distanceM'] > sample['mapDistanceM'] + 1e-7)
                a, b = nodes[edge - 1], nodes[edge]
                grade = math.atan2(b['heightM'] - a['heightM'], b['distanceM'] - a['distanceM'])
                close(motion['gradeDeg'], math.degrees(grade), 1e-9, 'gradeDeg')
                key = (edge, motion['quadrature'])
                if key not in solutions:
                    module._N_QUAD = motion['quadrature']  # declared 100/200-point refinement, no source-file edits
                    normal = m['massKg'] * 1.62 / m['wheelCount'] * math.cos(grade)
                    required = m['massKg'] * 1.62 / m['wheelCount'] * math.sin(grade)
                    with module.traction_perturbation(m['shearScale']):
                        def residual(slip):
                            return module.single_wheel_forces(wheel, soil, normal, slip).drawbar_pull_n - required
                        slip = float(brentq(residual, -.9, .95, xtol=1e-10))
                        force = module.single_wheel_forces(wheel, soil, normal, slip)
                    omega = settings['speedMps'] / math.cos(grade) / (m['radiusM'] * (1 - slip))
                    mechanical = m['wheelCount'] * force.driving_torque_nm * omega
                    solutions[key] = {'slip': slip, 'torqueNm': force.driving_torque_nm, 'sinkageM': force.sinkage_m, 'wheelRpm': omega * 60 / (2 * math.pi),
                                      'driveDcW': max(0., mechanical) / m['efficiency'], 'brakeW': max(0., -mechanical), 'normal': normal, 'required': required}
                expected = solutions[key]
                for field, tolerance in [('slip', 5e-5), ('torqueNm', 5e-5), ('sinkageM', 1e-6), ('wheelRpm', 1e-4), ('driveDcW', 5e-5), ('brakeW', 5e-5)]:
                    close(motion[field], expected[field], tolerance, field)
                close(motion['normalPerWheelN'], expected['normal'], 1e-8, 'normalN')
                close(motion['requiredDrawbarPerWheelN'], expected['required'], 1e-8, 'requiredN')
                issues = []
                for value, limit, label in [(abs(motion['slip']), m['maxAbsSlip'], 'slip limit'), (abs(motion['torqueNm']), m['maxHubTorqueNm'], 'hub torque limit'),
                                            (motion['wheelRpm'], m['maxWheelRpm'], 'wheel speed limit'), (motion['sinkageM'], m['radiusM'] * m['maxSinkageRatio'], 'sinkage limit'),
                                            (motion['brakeW'], m['maxBrakeW'], 'brake dissipation limit')]:
                    if value > limit + 1e-8:
                        issues.append(label)
                if issues != motion['issues'] or motion['feasible'] != (not issues):
                    raise ValueError('Mobility criterion differs')
                if issues:
                    if sample['phase'] != 'halted' or sample['driveW'] != 0:
                        raise ValueError('Rejected edge still receives driving credit')
                else:
                    close(sample['driveW'], expected['driveDcW'], 5e-5, 'scheduledDriveW')
                for column, field in [('wheel_grade_deg', 'gradeDeg'), ('wheel_slip', 'slip'), ('wheel_torque_nm', 'torqueNm'), ('wheel_required_dc_w', 'driveDcW'), ('wheel_quadrature', 'quadrature')]:
                    close(float(row[column]), motion[field], 1e-10, 'csvField')
            close(run['driveWh'], drive_wh, 1e-9, 'driveWh')
            if run['mobility']['firstFailure']:
                failure = run['mobility']['firstFailure']
                close(run['finalDistanceM'], nodes[failure['edgeIndex'] - 1]['distanceM'], 1e-8, 'haltDistanceM')
                if run['arrived']:
                    raise ValueError('Rejected trip claims arrival')
        cases.append({'case': suffix, 'jsonSha256': sha(path), 'csvSha256': sha(csv_path), 'motionRows': count, 'uniqueEdgeQuadratures': len(solutions)})
    replay = read(ROOT / 'app/test-results/moving-mobility-restored.json')
    if replay['resultSha256'] != read(ROOT / 'app/test-results/moving-mobility-passed.json')['resultSha256']:
        raise ValueError('Fresh-context result identity differs')
    report = {'schema': 1, 'checkedUTC': datetime.now(timezone.utc).isoformat(), 'cases': cases, 'maximumAbsoluteDifference': maximum,
              'referenceCommit': manifest['commit'], 'referenceKernelSha256': sha(kernel), 'runnerSha256': sha(__file__),
              'codeSha256': {f: sha(ROOT / f) for f in ['app/src/lib/mobility.ts', 'app/src/lib/traverse.ts', 'app/src/lib/traverse-evaluation.ts', 'app/src/components/MobilityControls.tsx']},
              'limits': ['Actual native-source desktop exports and CSV; numerical agreement with the reviewed publisher model, not independent soil or vehicle truth.',
                         'Reference uses the publisher normal-load solver precision; 100/200-point quadrature is selected at runtime without modifying source files.',
                         'These cases have bracketed roots; separate unit cases cover no-bracket and selected hardware/invalid-input limits. No complete mission/market superiority follows.']}
    (ROOT / 'data/validation/mobility-export-check.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'cases': len(cases), 'motionRows': sum(c['motionRows'] for c in cases), 'maximum': maximum}))


if __name__ == '__main__':
    main()
