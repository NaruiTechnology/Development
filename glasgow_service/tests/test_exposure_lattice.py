import itertools
import json
import math
from pathlib import Path

import pytest

from glasgow_service.exposure_lattice import (
    Rect, Ellipse, Polygon, build_lattice, count_spots, spot_centres, lattice_points, total_points, make_shape,
    MAX_COUNT_CELLS,
)

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "lattice_golden.json").read_text())


def shape_from_roi(model, roi):
    if model == "CircleModel":
        return Ellipse(roi["cx"], roi["cy"], roi["radius"], roi["radius"])
    if model == "RingModel":
        return Ellipse(roi["cx"], roi["cy"], roi["r_outer"], roi["r_outer"], roi["r_inner"], roi["r_inner"])
    if model == "FreeHandModel":
        return Polygon(tuple(map(tuple, roi["points"])))
    return Rect(roi["x_start"], roi["x_end"], roi["y_start"], roi["y_end"])


@pytest.mark.parametrize("case", GOLDEN, ids=[c["name"] for c in GOLDEN])
def test_python_lattice_matches_typescript_golden(case):
    """The browser planner (exposurePlan.ts) and the service must agree spot for spot."""
    e = case["expected"]
    shape = shape_from_roi(case["model"], case["roi"])
    lat = build_lattice(shape, case["pitch"], axis=case["axis"])
    spots = list(spot_centres(shape, lat))
    assert (lat.nx, lat.ny, lat.axis, len(spots)) == (e["nx"], e["ny"], e["axis"], e["spotCount"])
    assert count_spots(shape, lat) == (e["count"], True)
    assert lat.pitch_x == pytest.approx(e["pitchX"]) and lat.pitch_y == pytest.approx(e["pitchY"])
    for got, want in zip(spots[:6], e["head"]):
        assert got == pytest.approx(want)
    for got, want in zip(spots[-6:], e["tail"]):
        assert got == pytest.approx(want)


def test_serpentine_order_reverses_each_row():
    lat = build_lattice(Rect(0, 1, 0, 0.5), 0.25)
    assert list(lat.cells()) == [(0, 0), (1, 0), (2, 0), (3, 0), (3, 1), (2, 1), (1, 1), (0, 1)]


def test_points_are_lazy_and_do_not_materialise_the_pattern():
    # ~100 million cells: building the stream and taking a few points must be instant.
    shape = Rect(0, 16000, 0, 16000)
    lat = build_lattice(shape, 1.6)
    stream = lattice_points(shape, lat, 3, passes=3)
    first = list(itertools.islice(stream, 5))
    assert len(first) == 5 and all(p[2] == 3 and p[3] is False and p[4] == 1 for p in first)
    assert count_spots(shape, lat)[1] is False  # too large to enumerate; area estimate


def test_count_estimate_for_huge_lattice_uses_area():
    shape = Rect(0, 16000, 0, 16000)
    lat = build_lattice(shape, 2.0)
    n, exact = count_spots(shape, lat)
    assert not exact and n == 8000 * 8000
    assert lat.nx * lat.ny > MAX_COUNT_CELLS


def test_passes_repeat_the_same_stream():
    shape = Rect(0, 8, 0, 4)
    lat = build_lattice(shape, 1.0)
    one = list(lattice_points(shape, lat, 5, passes=1))
    three = list(lattice_points(shape, lat, 5, passes=3))
    assert three == one * 3
    assert total_points(shape, lat, 3) == 3 * 32


def test_sub_dac_pitch_merges_codes_and_preserves_dwell():
    shape = Rect(10, 12, 10, 11)
    lat = build_lattice(shape, 0.25)             # 8 x 4 spots over a 2 x 1 code area
    pts = list(lattice_points(shape, lat, 7))
    ticks = sum(p[2] + 1 for p in pts)           # conversions delivered
    assert ticks == len(list(spot_centres(shape, lat))) * 8
    assert len(pts) < len(list(spot_centres(shape, lat)))
    assert all(0 <= p[0] <= 16383 and 0 <= p[1] <= 16383 for p in pts)


def test_dwell_merge_saturates_at_16_bits():
    shape = Rect(10, 11, 10, 11)
    lat = build_lattice(shape, 0.01)
    pts = list(lattice_points(shape, lat, 65000))
    assert all(p[2] <= 65535 for p in pts)


def test_validation():
    with pytest.raises(ValueError):
        build_lattice(Rect(0, 1, 0, 1), 0)
    with pytest.raises(ValueError):
        build_lattice(Rect(0, 0, 0, 1), 0.1)
    with pytest.raises(ValueError):
        build_lattice(Rect(0, 1, 0, 1), 0.1, axis="z")
    with pytest.raises(ValueError):
        list(lattice_points(Rect(0, 1, 0, 1), build_lattice(Rect(0, 1, 0, 1), 0.5), 70000))
    with pytest.raises(ValueError):
        list(lattice_points(Rect(0, 1, 0, 1), build_lattice(Rect(0, 1, 0, 1), 0.5), 1, passes=0))
    with pytest.raises(ValueError):
        make_shape("blob")


def test_unequal_xy_pitch_for_anisotropic_dac_scale():
    shape = Rect(0, 100, 0, 100)
    lat = build_lattice(shape, 10, 20)
    assert (lat.nx, lat.ny) == (10, 5)
