"""Replay golden cases produced by the web frontend (tests/parity/web_cases.json).

The fixture is generated from ionbeam-web/frontend/src/lib/*.ts by
``tests/parity/generate.mjs``; every case is re-evaluated with the Python port
and must agree (floats to 1e-9 relative).
"""
import dataclasses
import json
import math
from pathlib import Path

import numpy as np
import pytest

from ionbeam_native.core import display_levels as L
from ionbeam_native.core import helpers as H
from ionbeam_native.core import scan_timing as T

CASES = json.loads((Path(__file__).parent / "parity" / "web_cases.json").read_text())


def _hist(d):
    return L.LevelHistogram(d["min"], d["max"], d["total"], np.asarray(d["bins"], dtype=np.int64))


def _levels(d):
    return L.ResolvedLevels(d["low"], d["high"])


def _dom(d):
    return (d["min"], d["max"])


def _norm(x):
    if dataclasses.is_dataclass(x):
        return {k: _norm(v) for k, v in dataclasses.asdict(x).items()}
    if isinstance(x, np.ndarray):
        return [_norm(v) for v in x.tolist()]
    if isinstance(x, (list, tuple)):
        return [_norm(v) for v in x]
    if isinstance(x, dict):
        return {k: _norm(v) for k, v in x.items()}
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating,)):
        return float(x)
    return x


def _camel(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        parts = k.split("_")
        out[parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])] = v
    return out


ADAPTERS = {
    "sampleToCode": lambda a: L.sample_to_code(*a),
    "codeToSample": lambda a: L.code_to_sample(*a),
    "levelGray": lambda a: L.level_gray(*a),
    "normalizeLevels": lambda a: _norm(L.normalize_levels(*a)),
    "valueToFraction": lambda a: L.value_to_fraction(a[0], _dom(a[1])),
    "fractionToValue": lambda a: L.fraction_to_value(a[0], _dom(a[1])),
    "niceCodeTicks": lambda a: _norm(L.nice_code_ticks(_dom(a[0]))),
    "dragLevels": lambda a: _norm(L.drag_levels(a[0], _levels(a[1]), a[2], a[3])),
    "grayLevelLut": lambda a: _norm(L.gray_level_lut(_levels(a[0]))),
    "buildHistogram": lambda a: _norm(L.build_histogram(a[0], a[1], a[2], np.asarray(a[3]))),
    "histogramPercentile": lambda a: L.histogram_percentile(_hist(a[0]), a[1]),
    "resolveLevels": lambda a: _norm(L.resolve_levels(_hist(a[0]), L.LevelSetting(**a[1]))),
    "wedgeDomain": lambda a: (lambda d: {"min": d[0], "max": d[1]})(
        L.wedge_domain(_hist(a[0]), _levels(a[1]))),
    "samplesPerPixel": lambda a: T.samples_per_pixel(*a),
    "estimateRevC3ScanTiming": lambda a: _camel(_norm(T.estimate_revc3_scan_timing(*a))),
    "revC3DwellPresetOptions": lambda a: _norm(T.revc3_dwell_preset_options()),
    "formatPixelRate": lambda a: T.format_pixel_rate(*a),
    "formatDuration": lambda a: T.format_duration(*a),
    "formatNanoseconds": lambda a: T.format_nanoseconds(*a),
    "clampGrayScale": lambda a: H.clamp_gray_scale(float(a[0])),
    "normalizeGrayScaleSelection": lambda a: _norm(H.normalize_gray_scale_selection(a[0])),
    "formatGrayScaleSelection": lambda a: H.format_gray_scale_selection(a[0]),
    "grayScaleSelectionContains": lambda a: H.gray_scale_selection_contains(a[0], a[1]),
    "vectorScanSampleCount": lambda a: H.vector_scan_sample_count(*a),
    "vectorScanSamplePixel": lambda a: (lambda p: None if p is None else {"x": p[0], "y": p[1]})(
        H.vector_scan_sample_pixel(*a)),
    "repeatCountdownDisplay": lambda a: H.repeat_countdown_display(*a),
    "scaleScanSample": lambda a: H.scale_scan_sample(*a),
}


def _same(expected, got) -> bool:
    if isinstance(expected, dict):
        return isinstance(got, dict) and set(expected) <= set(got) and all(_same(v, got[k]) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(got, list) and len(expected) == len(got) and all(_same(e, g) for e, g in zip(expected, got))
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        return expected == got
    if isinstance(expected, (int, float)):
        if not isinstance(got, (int, float)) or isinstance(got, bool):
            return False
        return math.isclose(expected, got, rel_tol=1e-9, abs_tol=1e-12)
    return expected == got


def test_fixture_covers_every_adapter():
    assert {c["fn"] for c in CASES} == set(ADAPTERS)


@pytest.mark.parametrize("fn", sorted(ADAPTERS))
def test_web_parity(fn):
    failures = []
    for case in (c for c in CASES if c["fn"] == fn):
        got = ADAPTERS[fn](case["args"])
        if not _same(case["out"], got):
            failures.append((case["args"] if len(json.dumps(case["args"])) < 300 else "<large>", case["out"], got))
    assert not failures, f"{len(failures)} mismatches, first: {failures[0]}"
