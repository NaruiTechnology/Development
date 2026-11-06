"""Processing patterns: config loading, skip handling, data models (no Qt)."""
import math

import pytest

from ionbeam_native.paths import processing_patterns_path
from ionbeam_native.processing import PatternConfigError, load_config, load_models
from ionbeam_native.processing.config import parse_config


def test_shipped_config_loads_and_skips():
    cfg, models = load_models(processing_patterns_path())
    assert not cfg.errors
    assert list(models) == ["solidBox", "openBox", "stairCut", "cleaningLine", "circle", "ring", "freeHand"]
    assert all(s.skip for s in cfg.specs if s.key not in models)
    assert models["stairCut"].parameters["steps"] == 5


def _cfg(*entries):
    return parse_config({"Patterns": list(entries)})


def test_bad_entries_reported_not_fatal():
    cfg = _cfg({"a": {"model": "NopeModel"}}, {"b": {"model": "SolidBoxModel", "roi": "ring"}},
               {"c": {"model": "SolidBoxModel"}}, {"x": {}, "y": {}})
    assert [s.key for s in cfg.active_specs] == ["c"]
    assert len(cfg.errors) == 3


def test_top_level_errors(tmp_path):
    with pytest.raises(PatternConfigError):
        parse_config({"nope": 1})
    bad = tmp_path / "bad.json"
    bad.write_text("{")
    with pytest.raises(PatternConfigError):
        load_config(bad)
    with pytest.raises(PatternConfigError):
        load_config(tmp_path / "missing.json")


def test_parameters_clamp_and_validate():
    _, m = load_models(processing_patterns_path())
    st = m["stairCut"]
    assert st.set_parameter("steps", "7.4") == 7
    assert st.set_parameter("steps", 999) == 50
    with pytest.raises(ValueError):
        st.set_parameter("steps", "abc")
    with pytest.raises(ValueError):
        st.set_parameter("direction", "sideways")
    with pytest.raises(KeyError):
        st.set_parameter("nope", 1)


def test_rect_models_and_listeners():
    _, m = load_models(processing_patterns_path())
    box, seen = m["solidBox"], []
    box.subscribe(seen.append)
    box.set_roi({"x_start": 5, "x_end": 1, "y_start": 0, "y_end": 2})
    assert box.roi == {"x_start": 1, "x_end": 5, "y_start": 0, "y_end": 2}
    assert box.area() == 8 and box.contains(2, 1) and not box.contains(9, 1)
    with pytest.raises(ValueError):
        box.set_roi({"x_start": 1, "x_end": 1, "y_start": 0, "y_end": 2})
    box.clear_roi()
    assert box.roi is None and len(seen) == 2


def test_stair_and_cleaning_geometry():
    _, m = load_models(processing_patterns_path())
    st = m["stairCut"]
    st.set_roi({"x_start": 0, "x_end": 10, "y_start": 0, "y_end": 10})
    steps = st.step_rects()
    assert len(steps) == 5 and steps[0]["y_end"] == 2 and steps[-1]["y_end"] == 10
    cl = m["cleaningLine"]
    cl.set_roi({"x_start": 0, "x_end": 10, "y_start": 0, "y_end": 1})
    cl.set_parameter("spacing", 0.25)
    assert len(cl.lines()) == 4


def test_circle_is_a_solid_disk():
    _, models = load_models(processing_patterns_path())
    circle = models["circle"]
    assert circle.area() == 0 and not circle.contains(5, 5)
    circle.set_roi({"cx": 5, "cy": 5, "radius": 3})
    assert math.isclose(circle.area(), math.pi * 9)
    assert circle.contains(5, 5) and circle.contains(8, 5) and not circle.contains(9, 5)
    assert circle.to_dict()["model"] == "CircleModel"
    for radius in (0, -1, math.inf, math.nan):
        with pytest.raises(ValueError):
            circle.set_roi({"cx": 5, "cy": 5, "radius": radius})
    with pytest.raises(ValueError):
        circle.set_roi({"cx": 5, "cy": 5})
    circle.clear_roi()
    assert circle.roi is None


def test_ring_is_two_concentric_circles():
    _, m = load_models(processing_patterns_path())
    ring = m["ring"]
    ring.set_roi({"cx": 5, "cy": 5, "r_inner": 4, "r_outer": 2})      # swapped on purpose
    assert ring.roi["r_inner"] == 2 and ring.roi["r_outer"] == 4
    assert math.isclose(ring.area(), math.pi * 12)
    assert ring.contains(5, 8) and not ring.contains(5, 5) and not ring.contains(5, 10)
    with pytest.raises(ValueError):
        ring.set_roi({"cx": 0, "cy": 0, "r_inner": 3, "r_outer": 3})


def test_freehand_polygon():
    _, m = load_models(processing_patterns_path())
    fh = m["freeHand"]
    fh.set_roi({"points": [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]})
    assert len(fh.roi["points"]) == 4 and fh.area() == 16 and fh.contains(2, 2) and not fh.contains(5, 5)
    with pytest.raises(ValueError):
        fh.set_roi({"points": [[0, 0], [1, 1], [2, 2]]})
