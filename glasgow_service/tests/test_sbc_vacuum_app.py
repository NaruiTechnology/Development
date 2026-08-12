import json
from pathlib import Path

import pytest

pytest.importorskip("httpx")
from fastapi.testclient import TestClient

from glasgow_service.sbc_vacuum_app import create_app


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


def test_standalone_simulation_api_runs_without_executor(tmp_path, monkeypatch):
    payload = json.loads(CONFIG_PATH.read_text())
    payload["Simulate"] = True
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.setenv("SBC_VACUUM_TOKEN", "test-token")

    with TestClient(create_app()) as client:
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
    payload["Simulate"] = True
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.setenv("SBC_VACUUM_TOKEN", "test-token")

    with TestClient(create_app()) as client:
        response = client.post(
            "/vacuum/simulation/MechanicalVacuumPump/ready",
            json={"ready": True},
        )
        assert response.status_code == 401
