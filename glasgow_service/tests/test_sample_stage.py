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
            "X": {"pins": {"sck": "A0", "cs": "A1", "sdi": "A2", "sdo": "A3"}, "minimum": -50, "maximum": 50, "microstepsPerUnit": 51200, "spi": {"frequencyKHz": 500}, "motion": {}, "registerWrites": {"VMAX": 100000}},
            "Y": {"pins": {"sck": "A4", "cs": "A5", "sdi": "A6", "sdo": "A7"}, "minimum": -50, "maximum": 50, "microstepsPerUnit": 51200, "spi": {"frequencyKHz": 500}, "motion": {}, "registerWrites": {"VMAX": 100000}}
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
    raw["Axes"]["Y"]["pins"]["sck"] = "A0"
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


def test_simulated_five_axis_move_supports_linear_and_angular_axes(tmp_path):
    config(tmp_path)
    source = tmp_path / "stage.json"
    raw = json.loads(source.read_text())
    raw["RequiredAxes"] = ["X", "Y", "Z", "T", "R"]
    raw["Axes"].update({
        "Z": {"unit": "mm", "driver": "EXTERNAL_SERVO", "minimum": 0, "maximum": 10, "microstepsPerUnit": 1, "motion": {}},
        "T": {"unit": "deg", "driver": "EXTERNAL_SERVO", "minimum": -10, "maximum": 60, "microstepsPerUnit": 1, "motion": {}},
        "R": {"unit": "deg", "driver": "EXTERNAL_SERVO", "minimum": -180, "maximum": 180, "continuous": True, "microstepsPerUnit": 1, "motion": {}},
    })
    source.write_text(json.dumps(raw))
    controller = SampleStageController(load_stage_config(source))
    asyncio.run(controller.start())
    status = asyncio.run(controller.move_absolute({"x": 12, "y": -8, "z": 4, "t": 52, "r": 90}))
    assert status["position"] == {"x": 12.0, "y": -8.0, "z": 4.0, "t": 52.0, "r": 90.0}
    assert status["axes"]["t"]["unit"] == "deg"
    status = asyncio.run(controller.move_absolute({"r": 540}))
    assert status["position"]["r"] == 540.0
    assert status["axes"]["r"]["continuous"] is True


def test_axis_specification_is_exposed_from_json(tmp_path):
    config(tmp_path)
    source = tmp_path / "stage.json"
    raw = json.loads(source.read_text())
    raw["Axes"]["X"]["minimum"] = -75
    raw["Axes"]["X"]["maximum"] = 75
    raw["Axes"]["X"]["resolutionMicrometers"] = 1
    source.write_text(json.dumps(raw))
    status = SampleStageController(load_stage_config(source)).status()
    assert status["limits"]["x"] == {"minimum": -75.0, "maximum": 75.0}
    assert status["axes"]["x"]["resolution_micrometers"] == 1.0


def test_micrometer_axis_limits_and_resolution_are_native(tmp_path):
    config(tmp_path)
    source = tmp_path / "stage.json"
    raw = json.loads(source.read_text())
    raw["Axes"]["X"].update({
        "unit": "um",
        "minimum": -75000,
        "maximum": 75000,
        "resolution": 1,
        "microstepsPerUnit": 51.2,
    })
    source.write_text(json.dumps(raw))
    controller = SampleStageController(load_stage_config(source))
    status = asyncio.run(controller.move_absolute({"x": 449}))
    assert status["position"]["x"] == 449.0
    assert status["limits"]["x"] == {"minimum": -75000.0, "maximum": 75000.0}
    assert status["axes"]["x"]["unit"] == "um"
    assert status["axes"]["x"]["resolution_micrometers"] == 1.0


def test_external_axis_rejects_unconfigured_hardware_mode(tmp_path):
    cfg = config(tmp_path, simulate=False)
    source = tmp_path / "stage.json"
    raw = json.loads(source.read_text())
    raw["Axes"]["Z"] = {"unit": "mm", "driver": "EXTERNAL_SERVO", "minimum": 0, "maximum": 10, "microstepsPerUnit": 1, "motion": {}}
    source.write_text(json.dumps(raw))
    controller = SampleStageController(load_stage_config(source))
    with pytest.raises(RuntimeError, match="external stage drivers"):
        asyncio.run(controller.start())


def test_simulated_position_persists_across_controller_processes(tmp_path):
    stage_config = config(tmp_path)
    first = SampleStageController(stage_config)
    asyncio.run(first.start())
    asyncio.run(first.move_absolute({"x": 23.125, "y": -11.75}))

    restored = SampleStageController(load_stage_config(tmp_path / "stage.json"))
    asyncio.run(restored.start())
    assert restored.status()["position"] == {"x": 23.125, "y": -11.75}
    assert restored.status()["position_persisted"] is True


def test_out_of_range_persisted_position_is_not_restored(tmp_path):
    stage_config = config(tmp_path)
    stage_config.state_path.write_text(json.dumps({"position": {"x": 999, "y": 7}}))
    restored = SampleStageController(stage_config)
    assert restored.status()["position"] == {"x": 0.0, "y": 7.0}
