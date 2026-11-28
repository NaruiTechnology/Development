"""Calculate SMH electrode targets in volts for offline calibration."""

import argparse
import json
import math
from pathlib import Path
import re


CORRECTION_ROLES = {"clock", "data", "select", "update"}


def validate_smh_config(settings, beam_pins=()):
    if not isinstance(settings, dict):
        raise ValueError("smhDeflection must be an object")
    coefficient = settings.get("mixCoefficient")
    if (isinstance(coefficient, bool) or not isinstance(coefficient, (int, float))
            or not 0 < coefficient < 1):
        raise ValueError("smhDeflection.mixCoefficient must be between 0 and 1")
    plan = settings.get("correctionDacPinPlan", {})
    if not isinstance(plan, dict) or (plan and set(plan) != CORRECTION_ROLES):
        raise ValueError("correctionDacPinPlan requires clock, data, select and update")
    allocated = set(beam_pins)
    for role, pin in plan.items():
        if not isinstance(pin, str) or not re.fullmatch(r"[AB][0-7]", pin):
            raise ValueError(f"correctionDacPinPlan.{role} requires a single A/B pin")
        if pin in allocated:
            raise ValueError(f"correctionDacPinPlan.{role} reuses pin {pin}")
        allocated.add(pin)
    return coefficient


def electrode_targets(vx, vy, *, vox=0, voy=0, va=0, vb=0, coefficient=0.414,
                      slave_scale=None):
    """Return opposite-pair components and plate voltages in electrode order 1–8."""
    if not 0 < coefficient < 1:
        raise ValueError("coefficient must be between 0 and 1")
    values = (vx, vy, vox, voy, va, vb)
    if not all(map(math.isfinite, values)) or (
        slave_scale is not None and not math.isfinite(slave_scale)
    ):
        raise ValueError("voltage inputs and slave scale must be finite")
    x, y = vx + vox, vy + voy
    ax, ay = coefficient * x, coefficient * y
    halves = (-x + ay, -ax + y, ax + y, x + ay)
    averages = (va, vb, -va, -vb)
    master = tuple(m + h for m, h in zip(averages, halves)) + tuple(
        m - h for m, h in zip(averages, halves)
    )
    targets = {"master_volts": master, "pair_half_difference_volts": halves,
               "pair_average_volts": averages}
    if slave_scale is not None:
        targets["slave_volts"] = tuple(slave_scale * voltage for voltage in master)
    if not all(math.isfinite(value) for vector in targets.values() for value in vector):
        raise ValueError("calculated electrode targets exceed the numeric range")
    return targets


def compare_electrodes(targets, measured, tolerance):
    """Compare a measured electrode vector against one deflector's targets."""
    if len(targets) != 8 or len(measured) != 8 or not all(map(math.isfinite, measured)):
        raise ValueError("expected eight finite measured plate voltages in electrode order")
    if tolerance is None or not math.isfinite(tolerance) or tolerance < 0:
        raise ValueError("measurement comparison requires a nonnegative tolerance in volts")
    errors = [actual - target for target, actual in zip(targets, measured)]
    max_error = max(map(abs, errors))
    if not math.isfinite(max_error):
        raise ValueError("measurement errors exceed the numeric range")
    opposite = list(zip(errors[:4], errors[4:]))
    return {
        "electrode_error_volts": errors,
        "pair_half_difference_error_volts": [a / 2 - b / 2 for a, b in opposite],
        "pair_average_error_volts": [a / 2 + b / 2 for a, b in opposite],
        "max_absolute_error_volts": max_error,
        "within_tolerance": max_error <= tolerance,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="Path to streamData.json")
    parser.add_argument("--vx", type=float, required=True)
    parser.add_argument("--vy", type=float, required=True)
    for name in ("vox", "voy", "va", "vb"):
        parser.add_argument(f"--{name}", type=float, default=0)
    parser.add_argument("--slave-scale", type=float, help="Measured signed scale k")
    parser.add_argument("--measured-master", nargs=8, type=float, metavar="V")
    parser.add_argument("--measured-slave", nargs=8, type=float, metavar="V")
    parser.add_argument("--tolerance", type=float, help="Allowed absolute error per plate in volts")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        action = next(entry["streamData"]["actionData"] for entry in config["Actions"]
                      if "streamData" in entry)
        coefficient = validate_smh_config(action["smhDeflection"])
        targets = electrode_targets(args.vx, args.vy, vox=args.vox, voy=args.voy,
                                    va=args.va, vb=args.vb, coefficient=coefficient,
                                    slave_scale=args.slave_scale)
        comparisons = {}
        for deflector, measured in (("master", args.measured_master), ("slave", args.measured_slave)):
            if measured is not None:
                if deflector == "slave" and args.slave_scale is None:
                    raise ValueError("--measured-slave requires --slave-scale")
                comparisons[deflector] = compare_electrodes(
                    targets[f"{deflector}_volts"], measured, args.tolerance)
        if comparisons:
            targets["measurements"] = comparisons
        elif args.tolerance is not None:
            raise ValueError("--tolerance requires measured plate voltages")
    except (OSError, ValueError, TypeError, KeyError, StopIteration) as error:
        parser.error(f"invalid SMH inputs or configuration ({error or 'missing streamData action'})")
    print(json.dumps(targets, indent=2, allow_nan=False))
    return int(any(not result["within_tolerance"] for result in comparisons.values()))


if __name__ == "__main__":
    raise SystemExit(main())
