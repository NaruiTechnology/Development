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


@pytest.mark.parametrize("failure", ["start", "close"])
def test_lifespan_always_closes_emulator_on_controller_failure(tmp_path, monkeypatch, failure):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    import glasgow_service.sbc_vacuum_app as module

    source = tmp_path / "vacuum.json"
    source.write_text("{}")
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    emulator = SimpleNamespace(close=Mock())
    controller = SimpleNamespace(
        emulator=emulator, requires_remote_authority=False,
        start=AsyncMock(side_effect=RuntimeError("startup failed") if failure == "start" else None),
        close=AsyncMock(side_effect=RuntimeError("shutdown failed") if failure == "close" else None),
    )
    monkeypatch.setattr(module, "VacuumController", lambda *args, **kwargs: controller)
    monkeypatch.setattr(module, "remote_authority_from_environment", lambda: None)
    with pytest.raises(RuntimeError, match="startup failed" if failure == "start" else "shutdown failed"):
        with TestClient(module.create_app(config_loader=lambda _: SimpleNamespace(enabled=True))):
            pass
    controller.close.assert_awaited_once()
    emulator.close.assert_called_once()


@pytest.mark.parametrize("method, route, payload", [
    ("GET", "/emulator", None),
    ("POST", "/emulator/estop", {"pressed": False}),
    ("POST", "/emulator/inputs/1", {"on": True}),
    ("POST", "/emulator/tool", {"connected": True}),
    ("POST", "/emulator/faults/heartbeat_stuck", {"active": False}),
])
def test_emulator_inspection_does_not_block_controller_event_loop(tmp_path, monkeypatch, method, route, payload):
    import asyncio
    import threading
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    import httpx
    import glasgow_service.sbc_vacuum_app as module

    entered = threading.Event()
    release = threading.Event()
    def slow_snapshot():
        entered.set()
        release.wait(5.0)  # Bound failure so the old implementation cannot hang.
        return {"time_s": 1.0}

    source = tmp_path / "vacuum.json"
    source.write_text("{}")
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    controller = SimpleNamespace(
        emulator=SimpleNamespace(
            snapshot=slow_snapshot, close=Mock(), set_estop=Mock(), jumper=Mock(), connect_tool=Mock(),
            clock=SimpleNamespace(lock=threading.RLock()),
            plant=SimpleNamespace(all_turbos=[], utilities=SimpleNamespace()),
            board=SimpleNamespace(faults=SimpleNamespace(stuck_heartbeat=False)),
        ),
        requires_remote_authority=False, start=AsyncMock(), close=AsyncMock(),
    )
    monkeypatch.setattr(module, "VacuumController", lambda *args, **kwargs: controller)
    monkeypatch.setattr(module, "remote_authority_from_environment", lambda: None)
    monkeypatch.delenv("SBC_VACUUM_TOKEN", raising=False)
    app = module.create_app(config_loader=lambda _: SimpleNamespace(enabled=True))

    async def scenario():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                pending = asyncio.create_task(client.request(method, route, json=payload))
                try:
                    assert await asyncio.to_thread(entered.wait, 5.0)
                    # A snapshot waiting for the rig lock must not stop health
                    # requests or the controller's poll/lease-renewal coroutines.
                    assert (await client.get("/health/live")).status_code == 200
                    assert not pending.done(), "inspection blocked the event loop until its lock was released"
                finally:
                    release.set()
                    response = await pending
                assert response.json() == {"time_s": 1.0}

    asyncio.run(scenario())


@pytest.mark.parametrize("stale_simulate", [True, False])
def test_production_missing_sbc_never_constructs_emulator(tmp_path, monkeypatch, stale_simulate):
    import asyncio
    import glasgow_service.vacuum as vacuum
    import glasgow_service.vacuum_io_board as board

    profile = CONFIG_PATH.with_name("vacuumSystem.rpi5-io.example.json")
    payload = json.loads(profile.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=stale_simulate)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    stream = tmp_path / "streamData.json"
    stream.write_text(json.dumps({"IsProduction": True}))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("GLASGOW_CONFIG", str(stream))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    calls = []
    def no_emulator(*args, **kwargs):
        pytest.fail("production constructed an emulator")
    def missing_hardware(*args, **kwargs):
        calls.append("hardware")
        raise RuntimeError("SBC hardware disconnected")
    monkeypatch.setattr("glasgow_service.emulation.rig.VacuumRig", no_emulator)
    monkeypatch.setattr(board, "LgpioHAL", missing_hardware)
    config = vacuum.load_runtime_vacuum_config(source)
    assert config.is_production and not config.simulate and not config.uses_emulator
    async def start():
        app = create_app()
        async with app.router.lifespan_context(app):
            pytest.fail("production startup succeeded without SBC")
    with pytest.raises(RuntimeError, match="SBC hardware disconnected"):
        asyncio.run(start())
    assert calls == ["hardware"]


def test_runtime_pump_list_comes_only_from_canonical_config(tmp_path, monkeypatch):
    payload = json.loads(CONFIG_PATH.read_text())
    payload["VacuumPumps"] = [pump for pump in payload["VacuumPumps"]
                              if pump["name"] != "UHVacuumPump_1"]
    payload.update(Enable=True, IsProduction=False, Simulate=True)
    source = tmp_path / "vacuumSystem.json"
    source.write_text(json.dumps(payload))
    (tmp_path / "streamData.json").write_text(json.dumps({"IsProduction": False}))
    # A separate example must never add equipment to the selected profile.
    (tmp_path / "vacuumSystem.rpi5-io.example.json").write_text("{}")
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    with TestClient(create_app()) as client:
        status = client.get("/vacuum").json()
        assert [pump["name"] for pump in status["pumps"]] == [
            pump["name"] for pump in payload["VacuumPumps"]]
        assert "UHVacuumPump_1" not in [pump["name"] for pump in status["pumps"]]
        assert client.post("/vacuum/pumps/UHVacuumPump_1/power", json={"power": True}).status_code == 404


def test_emulator_excursion_endpoint_requires_board_emulator(tmp_path, monkeypatch):
    """GPIO-simulator profiles have no emulator: the endpoint is 404."""
    payload = json.loads(CONFIG_PATH.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=True)
    profile = tmp_path / "vacuum.json"
    profile.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(profile))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.delenv("SBC_VACUUM_TOKEN", raising=False)
    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        response = client.post("/emulator/excursion/TurboVacuumPump", json={"mbar": 1e-2})
        assert response.status_code == 404
