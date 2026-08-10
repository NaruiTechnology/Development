import asyncio
import json

import pytest

from glasgow_service.sample_stage import SampleStageController, load_stage_config


def config(tmp_path, *, simulate=True):
    path = tmp_path / "stage.json"
    path.write_text(json.dumps({
        "Enable": True,
        "Simulate": simulate,
        "Safety": {"maximumTravelInches": 15},
        "Glasgow": {"Device1": {"Id": "stage-device", "voltage": 3.3}},
        "Axes": {
            "X": {"pins": {"step": "A0", "dir": "A1", "en": "A2"}, "minimum": -50, "maximum": 50, "stepsPerUnit": 200, "periodUs": 1000, "pulseHighUs": 5},
            "Y": {"pins": {"step": "A3", "dir": "A4", "en": "A5"}, "minimum": -50, "maximum": 50, "stepsPerUnit": 200, "periodUs": 1000, "pulseHighUs": 5}
        }
    }))
    return load_stage_config(path)


def test_simulated_absolute_move(tmp_path):
    controller = SampleStageController(config(tmp_path))
    asyncio.run(controller.start())
    status = asyncio.run(controller.move_absolute({"x": 12.5, "y": -8}))
    assert status["position"] == {"x": 12.5, "y": -8.0}
    assert status["simulation"] is True


def test_travel_limit_is_enforced(tmp_path):
    controller = SampleStageController(config(tmp_path))
    asyncio.run(controller.start())
    with pytest.raises(ValueError, match="outside"):
        asyncio.run(controller.move_absolute({"x": 51, "y": 0}))


def test_duplicate_pins_are_rejected(tmp_path):
    cfg = config(tmp_path)
    source = tmp_path / "stage.json"
    raw = json.loads(source.read_text())
    raw["Axes"]["Y"]["pins"]["step"] = "A0"
    source.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="duplicate"):
        load_stage_config(source)


def test_axis_span_cannot_exceed_fifteen_inches(tmp_path):
    config(tmp_path)
    source = tmp_path / "stage.json"
    raw = json.loads(source.read_text())
    raw["Axes"]["X"]["minimum"] = -191
    raw["Axes"]["X"]["maximum"] = 191
    source.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="exceeds 15 in"):
        load_stage_config(source)
