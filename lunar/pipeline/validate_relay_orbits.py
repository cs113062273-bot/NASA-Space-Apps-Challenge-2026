"""Numerical/source checks for the reference model, not measured orbit validation.

Compare published-data spherical forces against an independent Cartesian potential;
compare 30-day DOP853 with a tighter integration and 3 days against RK45. Also audit
Table 1/2 residuals rather than concealing frame differences with fitted rotations.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from scipy.interpolate import CubicHermiteSpline

import fetch_relay_sources as sources
from relay_orbits import INITIAL_STATES
from propagate_relay import ReferenceDynamics, integrate


def deviations(reference: np.ndarray, actual: np.ndarray) -> dict:
    d=reference-actual
    return {'maximum_position_difference_km_by_sv':np.max(np.linalg.norm(d[:,:,:3],axis=2),axis=0).tolist(),
        'maximum_velocity_difference_km_s_by_sv':np.max(np.linalg.norm(d[:,:,3:],axis=2),axis=0).tolist()}


def main():
    started=time.perf_counter()
    path=sources.ROOT/'data/validation/relay-propagation.json'
    report=json.loads(path.read_text(encoding='utf-8'))
    for name,sha in report['code_sha256'].items():
        if hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest()!=sha:
            raise ValueError('Propagation source changed; regenerate before validation')
    artifact=sources.ROOT/report['artifact']
    if hashlib.sha256(artifact.read_bytes()).hexdigest()!=report['artifact_sha256']:
        raise ValueError('Propagation artifact checksum mismatch')
    cache=np.load(artifact);times=cache['tdb_elapsed_s'];nominal=cache['states_icrf_km_kms']
    if report['days']!=30:raise ValueError('The full numerical check requires a 30-day baseline')
    model=ReferenceDynamics()
    np.testing.assert_array_equal(nominal[0],INITIAL_STATES)
    # A separate Cartesian recurrence and complex-step gradient, evaluated on real GRGM data.
    rng=np.random.default_rng(421);q=rng.normal(size=(40,3));q*=rng.uniform(2000,22000,(40,1))/np.linalg.norm(q,axis=1)[:,None]
    q=np.r_[q,[[0,0,4000],[0,0,-4000],[1e-3,1e-3,4000]]]
    analytic=model.gravity.acceleration(q)
    cartesian=np.array([model.gravity.cartesian_gradient(v) for v in q])
    force_error=float(np.max(np.linalg.norm(analytic-cartesian,axis=1)))
    if force_error>1e-13:raise ValueError(f'Gravity gradient disagreement: {force_error}')
    print(f'43 real-field force checks: max {force_error:g} km/s^2',flush=True)
    # Check both rounding-cell sensitivity and observed Table 1/2 residuals, without fitting.
    table_audit=[]
    for row in report['table_cross_check']:
        delta=np.array(row['minus_table1']);lo=np.array(row['printed_state_corner_sensitivity_min']);hi=np.array(row['printed_state_corner_sensitivity_max'])
        # Table 1 also prints six decimals in each column. Corners are sampled sensitivity,
        # not rigorous interval arithmetic; 'outside' is therefore a diagnostic, not proof.
        outside=(-delta<lo-.5e-6)|(-delta>hi+.5e-6)
        table_audit.append({'spacecraft':row['spacecraft'],'residual_outside_sampled_quantization_sensitivity':outside.tolist()})
    print('Starting tighter 30-day DOP853 check',flush=True)
    fine_times,fine=integrate(model,30,report['output_step_tdb_s'],rtol=3e-14,max_step=150,position_atol=1e-11,velocity_atol=1e-14)
    np.testing.assert_array_equal(fine_times,times)
    fine_states=fine.y.T.reshape(len(times),5,6)
    convergence=deviations(fine_states,nominal)
    if max(convergence['maximum_position_difference_km_by_sv'])>.02:
        raise ValueError(f'30-day numerical convergence exceeds 20 m: {convergence}')
    print(f'30-day convergence: {convergence}',flush=True)
    # Independent integration family, using identical physical force inputs.
    print('Starting 3-day RK45 check',flush=True)
    rk_model=ReferenceDynamics()
    rk_times,rk=integrate(rk_model,3,report['output_step_tdb_s'],method='RK45',rtol=1e-12,max_step=60,position_atol=1e-10,velocity_atol=1e-13)
    rk_states=rk.y.T.reshape(len(rk_times),5,6)
    rk_difference=deviations(rk_states,nominal[:len(rk_times)])
    if max(rk_difference['maximum_position_difference_km_by_sv'])>.005:
        raise ValueError(f'3-day independent integration disagreement exceeds 5 m: {rk_difference}')
    # Assess 300-second state products at withheld midpoints against dense fine integration.
    mid=.5*(times[:-1]+times[1:])
    spline=CubicHermiteSpline(times,nominal[:,:,:3],nominal[:,:,3:],axis=0)
    mid_actual=fine.sol(mid).T.reshape(len(mid),5,6)[:,:,:3]
    interpolation=float(np.max(np.linalg.norm(spline(mid)-mid_actual,axis=2)))
    # This is a measured interpolation error in these samples, not a global guaranteed bound.
    if interpolation>.05:raise ValueError(f'300 s Hermite midpoint error exceeds 50 m: {interpolation} km')
    output={'schema':1,'checked_utc':datetime.now(timezone.utc).isoformat(),'elapsed_s':time.perf_counter()-started,
        'baseline_report_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'baseline_artifact_sha256':report['artifact_sha256'],'code_sha256':report['code_sha256'],
        'gravity_gradient':{'samples':len(q),'maximum_vector_difference_km_s2':force_error,
            'methods':'analytic spherical derivatives vs Cartesian solid-harmonic recurrence/complex step'},
        'thirty_day_tighter_dop853':{'rtol':3e-14,'max_step_s':150,'position_atol_km':1e-11,'velocity_atol_km_s':1e-14,'force_calls':model.calls,**convergence},
        'three_day_rk45':{'rtol':1e-12,'max_step_s':60,'position_atol_km':1e-10,'velocity_atol_km_s':1e-13,'force_calls':rk_model.calls,**rk_difference},
        'state_interpolation':{'method':'cubic Hermite from positions/velocities; comparison with fine dense integration at all withheld bin midpoints',
            'output_step_s':report['output_step_tdb_s'],'maximum_midpoint_position_difference_km':interpolation},
        'table1_table2_residual_audit':table_audit,
        'limitations':['Numerical checks share the same force model and initial states, not physical orbit truth',
            'Some PA element residuals exceed sampled printed-rounding sensitivities; exact generating frame/constants remain unresolved',
            'No empirical rotation/element correction applied; published ICRF Cartesian states are retained verbatim',
            'No measured trajectory, provider ephemeris, covariance, station keeping, terrain/RF or service validation']}
    destination=sources.ROOT/'data/validation/relay-orbit-checks.json'
    destination.write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Wrote {destination.relative_to(sources.ROOT)}; max Hermite midpoint difference {interpolation:g} km',flush=True)


if __name__=='__main__':main()
