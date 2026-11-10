"""Processing patterns: config loading, skip handling, data models (no Qt)."""
import math

import pytest

from ionbeam_native.paths import processing_patterns_path
from ionbeam_native.processing import PatternConfigError, load_config, load_models
from ionbeam_native.processing.config import parse_config


def test_shipped_config_loads_and_skips():
    cfg, models = load_models(processing_patterns_path())
    assert not cfg.errors
    assert list(models) == ["solidBox", "openBox", "line", "stairCut", "cleaningLine", "circle", "ring", "polygon", "freeHand"]
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


def test_line_width_and_four_vertex_polygon():
    from ionbeam_native.processing.models import line_roi, line_endpoints
    _, models = load_models(processing_patterns_path())
    line = models["line"]
    for start, end in [((0, 0), (10, 0)), ((0, 10), (0, 0)), ((0, 0), (6, 8))]:
        line.set_roi(line_roi(start, end, 0.5))
        assert line_endpoints(line.roi) == (start, end)
        assert math.isclose(line.area(), 5)
        assert line.contains((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
        assert not line.contains(50, 50)
    line.set_parameter("lineWidth", 2)
    assert math.isclose(line.area(), 20)
    with pytest.raises(ValueError):
        line_roi((0, 0), (0, 0), 1)
    poly = models["polygon"]
    poly.set_roi({"points": [[0, 0], [4, 0], [1, 1], [0, 4]]})
    assert poly.area() == 4 and poly.contains(0.5, 0.5) and poly.contains(0, 0)
    assert not poly.contains(3, 3)
    for points in [[[0, 0], [1, 0], [1, 1]], [[0, 0], [4, 4], [0, 3], [4, 0]]]:
        with pytest.raises(ValueError):
            poly.set_roi({"points": points})


def test_line_and_polygon_pointer_gestures():
    from types import SimpleNamespace
    from PyQt6.QtCore import Qt
    from ionbeam_native.ui.pattern_tool import PatternTool
    from ionbeam_native.processing.models import line_endpoints
    _, models = load_models(processing_patterns_path())
    panel = SimpleNamespace(active_model=lambda: models["line"], models=models)
    tool = PatternTool(panel)
    canvas = SimpleNamespace(disabled=False, view=SimpleNamespace(setFocus=lambda: None, update=lambda: None),
                             _canvas_point=lambda p: p, _to_dut=lambda p: (p[0] / 2, p[1] / 2))
    def event(x, y, button=Qt.MouseButton.LeftButton):
        return SimpleNamespace(button=lambda: button, position=lambda: (x, y))
    tool.mouse_press(canvas, event(20, 20))
    tool.mouse_move(canvas, event(80, 20))
    assert models["line"].roi is None
    tool.mouse_release(canvas, event(100, 20))
    assert line_endpoints(models["line"].roi) == ((10, 10), (50, 10))
    panel.active_model = lambda: models["polygon"]
    for x, y in [(20, 20), (120, 20), (120, 120)]:
        tool.mouse_press(canvas, event(x, y))
        tool.mouse_release(canvas, event(x, y))
    assert models["polygon"].roi is None
    tool.mouse_leave(canvas)
    tool.mouse_press(canvas, event(20, 120))
    tool.mouse_release(canvas, event(20, 120))
    assert models["polygon"].roi == {"points": [[10, 10], [60, 10], [60, 60], [10, 60]]}
    saved = models["polygon"].roi
    tool.mouse_press(canvas, event(30, 30))
    tool.mouse_press(canvas, event(40, 30))
    tool.mouse_press(canvas, event(50, 30, Qt.MouseButton.RightButton))
    assert not tool.drawing and models["polygon"].roi == saved


def test_numeric_dimensions_sync_with_drawing_and_ring_edits():
    _, models = load_models(processing_patterns_path())
    for model in models.values():
        assert all(name in model.parameters for name in ("depth", "dwell", "overlap"))
        assert set(model.readouts) == {"time", "centerX", "centerY"}
    ring = models["ring"]
    ring.set_roi({"cx": 10, "cy": 20, "r_inner": 2, "r_outer": 5})
    assert ring.parameters["rInner"] == 2 and ring.parameters["rOuter"] == 5
    ring.set_parameter("rOuter", 8)
    assert ring.roi["r_outer"] == 8
    with pytest.raises(ValueError):
        ring.set_parameter("rInner", 9)
    assert ring.roi["r_inner"] == 2 and ring.parameters["rInner"] == 2
    box = models["solidBox"]
    box.set_roi({"x_start":10,"x_end":20,"y_start":30,"y_end":40})
    box.set_parameter("width",20)
    assert box.roi == {"x_start":5,"x_end":25,"y_start":30,"y_end":40}
