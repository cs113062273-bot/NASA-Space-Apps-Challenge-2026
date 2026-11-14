"""Independent continuous-ODE reference for the equipment node (not a flight correlation).

SciPy DOP853 is separate from the browser's implicit Euler/Newton implementation.
These test cases validate the selected heat balance, not its applicability to a real lander.
"""
from pathlib import Path
import json

import numpy as np
import scipy
from scipy.integrate import solve_ivp
from scipy.optimize import brentq

ROOT = Path(__file__).resolve().parents[1]
SIGMA = 5.670374419e-8
BASE = dict(initialK=283, minK=253, maxK=323, setpointK=273, heatCapacityJPerK=50000,
    solarAbsorptivity=0.2, solarAreaM2=0.25, emissivity=0.8, radiatingAreaM2=1,
    groundViewFactor=0.5, groundK=100, conductanceWPerK=0, baseK=100, wasteHeatFraction=0.8, maxHeaterW=200)


def main():
    definitions = [
        ("passive cold radiation", {}, 0, 24*3600),
        ("warm ground plus internal heat", dict(groundK=350), 100, 12*3600),
        ("mounting conduction", dict(emissivity=0, conductanceWPerK=2, baseK=200), 30, 6*3600),
        ("combined radiation and mounting", dict(conductanceWPerK=0.5, baseK=180), 200, 48*3600),
        ("stiff small node", dict(heatCapacityJPerK=1000, radiatingAreaM2=10, initialK=400, groundK=250), 100, 3600),
        ("linear isolated heating", dict(emissivity=0, conductanceWPerK=0), 50, 6*3600),
    ]
    rows = []
    for name, patch, heat, duration in definitions:
        m = {**BASE, **patch}
        def rate(_, state):
            temperature = state[0]
            radiation = m["emissivity"] * SIGMA * m["radiatingAreaM2"] * (temperature**4 - m["groundViewFactor"]*m["groundK"]**4 - (1-m["groundViewFactor"])*3**4)
            conduction = m["conductanceWPerK"] * (temperature - m["baseK"])
            return [(heat-radiation-conduction) / m["heatCapacityJPerK"]]
        result = solve_ivp(rate, [0, duration], [m["initialK"]], method="DOP853", rtol=1e-11, atol=1e-10, dense_output=True)
        assert result.success
        sample_s = [float(x) for x in np.unique(np.r_[np.arange(0, min(duration, 3600) + 1, 300), np.arange(3600, duration+1, 3600), duration])]
        trajectory = solve_ivp(rate, [0, duration], [m["initialK"]], method="DOP853", rtol=1e-11, atol=1e-10, t_eval=sample_s)
        def time_below(limit):
            start, end = m["initialK"], float(result.y[0,-1])
            if start >= limit and end >= limit:
                return 0.
            if start < limit and end < limit:
                return float(duration)
            crossing = brentq(lambda x: float(result.sol(x)[0])-limit, 0, duration, xtol=1e-8)
            return float(duration-crossing if end < start else crossing)
        rows.append(dict(name=name, model=m, heat_w=heat, duration_s=duration, expected_end_k=float(result.y[0,-1]), rhs_evaluations=result.nfev,
            cold_s=time_below(m["minK"]), hot_s=float(duration)-time_below(m["maxK"]),
            trajectory=[dict(seconds=float(t), kelvin=float(v)) for t,v in zip(trajectory.t, trajectory.y[0])]))
    report = dict(reference="SciPy solve_ivp DOP853, rtol 1e-11, atol 1e-10; continuous constant-input heat equation",
        scipy_version=scipy.__version__, numpy_version=np.__version__,
        scope="Numerical solver verification only; no measured lander, hardware or local regolith calibration",
        browser_max_step_s=300, sample_acceptance_k=0.2, duration_acceptance_s=30,
        browser_local_step_tolerance_k="0.00001 + 0.0000001 * max(start_K, end_K); one-step vs two-half-step difference; not a global error bound",
        cases=rows)
    (ROOT / "data/validation/thermal-node-reference.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    print(json.dumps([{k: row[k] for k in ["name", "expected_end_k", "rhs_evaluations"]} for row in rows], indent=2))


if __name__ == "__main__":
    main()
