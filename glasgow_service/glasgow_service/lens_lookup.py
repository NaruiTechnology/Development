"""Lens reference data and unit-explicit calculations. This module never controls hardware."""
from __future__ import annotations
import json
import math
import os
from pathlib import Path
import re
from .config import find_config_path


def _number(value, name, *, zero=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or (value < 0 if zero else value <= 0):
        raise ValueError(f"{name} must be a finite {'nonnegative' if zero else 'positive'} number")
    return value


def _reference(value, name, *, bound=False, star=False):
    if isinstance(value, str):
        pattern = (r"<?" if bound else "") + r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)" + (r"\*?" if star else "")
        if re.fullmatch(pattern, value) is None:
            raise ValueError(f"Invalid {name} qualifier")
        return _number(float(value.lstrip("<").rstrip("*")), name)
    return _number(value, name)


def validate_lens_lookup(table):
    if not isinstance(table, dict) or table.get("schemaVersion") != 1 or not isinstance(table.get("rows"), list) or not table["rows"]:
        raise ValueError("LensLookup needs schemaVersion 1 and nonempty rows")
    source = table.get("source", {})
    if not isinstance(source, dict) or not all(isinstance(source.get(k), str) and source[k] for k in ("file", "sheet", "range", "sha256")):
        raise ValueError("LensLookup needs source provenance")
    if not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
        raise ValueError("Invalid lens source SHA256")
    headers = table.get("sourceHeaders")
    if not isinstance(table.get("name"), str) or not isinstance(table.get("interpolation"), str) or not isinstance(headers, list) or len(headers) != 6 or not all(isinstance(h, str) for h in headers):
        raise ValueError("Invalid lens table metadata")
    ids, anchors = set(), set()
    for row in table["rows"]:
        if not isinstance(row, dict):
            raise ValueError("Invalid lens row")
        index = row.get("sourceRow")
        if type(index) is not int or index <= 0 or index in ids:
            raise ValueError("Lens source rows must be unique positive integers")
        ids.add(index)
        voltage = _number(row.get("beamVoltageKV"), "beamVoltageKV")
        current = row.get("beamCurrentPA")
        _reference(current, "beamCurrentPA", bound=True)
        key = (voltage, current)
        if key in anchors:
            raise ValueError("Duplicate voltage/current lens reference")
        anchors.add(key)
        _reference(row.get("apertureDiameterUM"), "apertureDiameterUM", bound=True)
        _reference(row.get("lens1KV"), "lens1KV", star=True)
        _number(row.get("spotSizeAngstrom"), "spotSizeAngstrom")
        steps = row.get("stepsBetweenApertures")
        if steps is not None:
            _number(steps, "stepsBetweenApertures")
    notes = table.get("notes")
    if not isinstance(notes, list) or any(not isinstance(n, dict) or not isinstance(n.get("text"), str) or not isinstance(n.get("sourceRow"), int) for n in notes):
        raise ValueError("Invalid lens notes")
    return table


def catalogue_path(path=None):
    if path is not None:
        return Path(path)
    configured = os.environ.get("PROCESSING_PATTERNS_CONFIG", "").strip()
    if configured:
        return Path(configured)
    config = find_config_path(required=False)
    if config is not None:
        # The lookup follows the selected deployment, never a different checkout.
        return Path(config).parent / "processingPatterns.json"
    return Path(__file__).resolve().parents[2] / "GlasgowDataIO/Json/processingPatterns.json"


def load_lens_lookup(path=None):
    data = json.loads(catalogue_path(path).read_text())
    return validate_lens_lookup(data.get("LensLookup"))


def lookup_spot_size(table, beam_voltage_kv, beam_current_pa, *, interpolate=False):
    validate_lens_lookup(table)
    _number(beam_voltage_kv, "beam voltage")
    _number(beam_current_pa, "beam current")
    rows = sorted((row for row in table["rows"] if row["beamVoltageKV"] == beam_voltage_kv and isinstance(row["beamCurrentPA"], (int, float))), key=lambda r: r["beamCurrentPA"])
    result = {"beamVoltageKV": beam_voltage_kv, "beamCurrentPA": beam_current_pa, "status": "unavailable", "spotSizeNM": None, "spotSizeUM": None, "sourceRows": [], "requiresSLF": False}
    selected, angstrom = [], None
    for row in rows:
        if row["beamCurrentPA"] == beam_current_pa:
            selected, angstrom = [row], row["spotSizeAngstrom"]
            result["status"] = "exact"
            break
    if angstrom is None and interpolate:
        for lo, hi in zip(rows, rows[1:]):
            if lo["beamCurrentPA"] < beam_current_pa < hi["beamCurrentPA"]:
                ratio = (beam_current_pa-lo["beamCurrentPA"]) / (hi["beamCurrentPA"]-lo["beamCurrentPA"])
                angstrom = lo["spotSizeAngstrom"] + ratio*(hi["spotSizeAngstrom"]-lo["spotSizeAngstrom"])
                selected = [lo, hi]
                result["status"] = "interpolated"
                break
    if angstrom is None:
        result["reason"] = "No supported current reference at this voltage. Bounded rows are reference only; extrapolation and interpolation between voltages are disabled."
    else:
        result.update(spotSizeNM=angstrom/10, spotSizeUM=angstrom/10000, sourceRows=[r["sourceRow"] for r in selected], requiresSLF=any(isinstance(r["lens1KV"], str) and r["lens1KV"].endswith("*") for r in selected))
    return result


def estimate_milling_depth(beam_current_pa, exposure_time_s, area_um2, removal_rate_um3_per_nc):
    """Uniform removal estimate; requires an independently calibrated material/beam rate.

    This uses beam-on exposure time, not USB/host elapsed time. The lens table
    provides no removal rates. Image brightness ratios are not removal rates.
    """
    _number(beam_current_pa, "beam current", zero=True)
    _number(exposure_time_s, "beam-on exposure time", zero=True)
    _number(area_um2, "area")
    _number(removal_rate_um3_per_nc, "calibrated removal rate")
    charge = beam_current_pa * exposure_time_s / 1000
    volume = charge * removal_rate_um3_per_nc
    if not math.isfinite(volume) or not math.isfinite(volume / area_um2):
        raise ValueError("Milling estimate overflow")
    return {"chargeNC": charge, "volumeUM3": volume, "depthUM": volume / area_um2}
