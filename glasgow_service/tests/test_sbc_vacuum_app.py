import json
from pathlib import Path

import pytest

pytest.importorskip("httpx")
from fastapi.testclient import TestClient

from glasgow_service.sbc_vacuum_app import create_app
from glasgow_service.vacuum import load_vacuum_config


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


@pytest.fixture(autouse=True)
def isolated_scan_configuration(monkeypatch):
    monkeypatch.delenv("GLASGOW_CONFIG", raising=False)
    monkeypatch.delenv("SBC_VACUUM_ENABLE_CONFIG", raising=False)


@pytest.mark.parametrize("production", [True, False])
def test_enable_false_keeps_service_idle_without_touching_hardware(tmp_path, monkeypatch, production):
    import glasgow_service.vacuum_io_board as board_module

    def hardware_forbidden(*args, **kwargs):
        pytest.fail("disabled vacuum tried to initialize SBC hardware")

    monkeypatch.setattr(board_module, "LgpioHAL", hardware_forbidden)
    profile = CONFIG_PATH.with_name("vacuumSystem.rpi5-io.example.json")
    payload = json.loads(profile.read_text())
    payload["Enable"] = False
    source = tmp_path / "vacuumSystem.rpi5-io.example.json"
    source.write_text(json.dumps(payload))
    stream = tmp_path / "streamData.json"
    stream.write_text(json.dumps({"IsProduction": production}))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("GLASGOW_CONFIG", str(stream))
    with TestClient(create_app()) as client:
        assert client.get("/status").json()["vacuum_enabled"] is False
        assert client.get("/status").json()["mode"] == "disabled"
        assert client.get("/status").json()["running"] is False
        assert client.get("/health/ready").status_code == 200
        assert client.get("/vacuum").status_code == 404


def test_standalone_simulation_api_runs_without_executor(tmp_path, monkeypatch):
    payload = json.loads(CONFIG_PATH.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=True)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.setenv("SBC_VACUUM_TOKEN", "test-token")

    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        assert client.get("/vacuum").headers["cache-control"] == "no-store"
        response = client.post(
            "/vacuum/simulation/MechanicalVacuumPump/ready",
            json={"ready": True},
            headers={"Authorization": "Bearer test-token"},
        )
        assert response.status_code == 200
        state = {pump["name"]: pump for pump in response.json()["pumps"]}
        assert state["MechanicalVacuumPump"]["ready"] is True
        assert state["TurboVacuumPump"]["power"] is True


def test_simulation_control_requires_bearer_token(tmp_path, monkeypatch):
    payload = json.loads(CONFIG_PATH.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=True)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.setenv("SBC_VACUUM_TOKEN", "test-token")

    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        response = client.post(
            "/vacuum/simulation/MechanicalVacuumPump/ready",
            json={"ready": True},
        )
        assert response.status_code == 401


def test_high_voltage_api_is_vacuum_interlocked(tmp_path, monkeypatch):
    payload = json.loads(CONFIG_PATH.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=True)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.setenv("SBC_VACUUM_TOKEN", "test-token")
    headers = {"Authorization": "Bearer test-token"}

    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        blocked = client.post(
            "/vacuum/high-voltage/power", json={"power": True}, headers=headers
        )
        assert blocked.status_code == 409
        assert blocked.json()["detail"] == "high voltage requires the vacuum system to be ready"

        for name in (
            "MechanicalVacuumPump",
            "TurboVacuumPump",
            "UHVacuumPump_1",
            "UHVacuumPump_2",
        ):
            response = client.post(
                f"/vacuum/simulation/{name}/ready",
                json={"ready": True},
                headers=headers,
            )
            assert response.status_code == 200

        enabled = client.post(
            "/vacuum/high-voltage/power", json={"power": True}, headers=headers
        )
        assert enabled.status_code == 200
        assert enabled.json()["high_voltage_power"] is True
