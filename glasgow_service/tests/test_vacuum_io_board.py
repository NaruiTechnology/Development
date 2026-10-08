"""The production board driver and controller logic, run on the emulator.

The controller, driver and config are the production code; only the Linux
I2C/GPIO endpoints are emulated (``glasgow_service.emulation``).
"""
import asyncio
import json
from pathlib import Path

import pytest

from glasgow_service import pfeiffer
from glasgow_service.emulation.raspberry_pi import PiSpec
from glasgow_service.emulation.rig import VacuumRig
from glasgow_service.vacuum import VacuumConfig, VacuumController, load_runtime_vacuum_config, load_vacuum_config
from glasgow_service.vacuum_io_board import GaugeChannel, RPi5VacuumIODevice

EXAMPLE = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.rpi5-io.example.json"


@pytest.fixture(autouse=True)
def isolated_scan_configuration(monkeypatch):
    monkeypatch.delenv("GLASGOW_CONFIG", raising=False)
    monkeypatch.delenv("SBC_VACUUM_ENABLE_CONFIG", raising=False)


def jumper_gauges():
    """Example gauges with the reading check off.

    The WIRING.md commissioning test bridges the ready inputs with jumpers
    and has no gauges connected, so it runs with ``"Interlock": false``.
    """
    gauges = json.loads(EXAMPLE.read_text())["SBC"]["Gauges"]
    return {pin: {**gauge, "Interlock": False} for pin, gauge in gauges.items()}


def board_config(**sbc_updates):
    payload = json.loads(EXAMPLE.read_text())
    payload["Enable"] = True
    payload["Simulate"] = False
    payload["SBC"].update(sbc_updates)
    return VacuumConfig.model_validate(payload)


def run(coro):
    return asyncio.run(coro)


async def poll(controller, rig, count=3, dt=0.2):
    for _ in range(count):
        await controller.poll_once()
        rig.advance(dt)


def relays(rig):
    return [rig.board.relay_closed(n) for n in range(1, 6)]


# ------------------------------------------------------------------ config

def test_example_config_parses_in_board_mode():
    config = board_config()
    assert config.sbc.board == "RPi5VacuumIO-A"
    assert config.sbc.pi_model == "4B"
    assert config.sbc.channels["A0"] == "K1"
    assert config.sbc.gauges["B1"].slope == pytest.approx(1.667)


@pytest.mark.parametrize("update, message", [
    ({"Channels": {"A0": "DI1"}}, "relay K1..K8"),
    ({"Faults": {"B0": "DI1"}}, "distinct DI"),
    ({"GPIO": {"A0": 17}}, "exactly one of GPIO"),
])
def test_board_config_validation(update, message):
    payload = json.loads(EXAMPLE.read_text())
    payload["Enable"] = True
    payload["SBC"].update(update)
    if "Channels" in update:
        payload["SBC"]["Channels"] = {**json.loads(EXAMPLE.read_text())["SBC"]["Channels"],
                                     **update["Channels"]}
    with pytest.raises(ValueError, match=message):
        VacuumConfig.model_validate(payload)


def test_gauge_laws():
    pirani = GaugeChannel(ain=1, slope=1.0, offset=-5.5)
    assert pirani.pressure(5.5) == pytest.approx(1.0)
    assert pirani.pressure(0.3) is None            # sensor error
    pkr = GaugeChannel(ain=2, slope=1.667, offset=-11.33)
    assert pkr.pressure((-3 + 11.33) / 1.667) == pytest.approx(1e-3, rel=1e-6)
    linear = GaugeChannel(ain=3, law="linear", slope=2.0, offset=1.0)
    assert linear.pressure(2.0) == pytest.approx(5.0)


# ------------------------------------------------------------------ commissioning

@pytest.mark.parametrize("model", ["4B", "5"])
def test_wiring_guide_commissioning_table(model):
    """RPi5VacuumIO/WIRING.md step 12, rows 1-8, with tool plugs unplugged."""
    spec = PiSpec() if model == "4B" else PiSpec(model="5", ram_gb=4, psu_amps=5.0)
    rig = VacuumRig(spec=spec, tool_connected=False)

    async def scenario():
        # Row 1-2: 24 V and E-stop on, Pi booted, service not running.
        assert rig.board.leds.d3_24v and rig.board.estop_rail_live
        assert not rig.board.safe_rail_live and relays(rig) == [False] * 5

        controller = VacuumController(board_config(PiModel=model, Gauges=jumper_gauges()),
                                  emulator=rig)
        for di in (5, 6, 7, 8):          # fault inputs wired "healthy"
            rig.jumper(di)
        # Row 3: service starts -> output rail + RUN LED, K1 (mechanical) on.
        await controller.start()
        await poll(controller, rig)
        assert rig.board.safe_rail_live and rig.board.leds.d11_run
        assert relays(rig) == [True, False, False, False, False]
        # Row 4: DI1 jumper -> mechanical ready, K2 (turbo) on.
        rig.jumper(1)
        await poll(controller, rig)
        assert relays(rig) == [True, True, False, False, False]
        # Row 5: DI2 -> K3 and K4 (UH group) on together.
        rig.jumper(2)
        await poll(controller, rig)
        assert relays(rig) == [True, True, True, True, False]
        # Row 6: DI3 + DI4 -> all ready; HV permissive K5 can be enabled.
        rig.jumper(3)
        rig.jumper(4)
        await poll(controller, rig)
        assert controller.isVacuumSystemReady
        await controller.set_high_voltage_power(True)
        rig.advance(0.05)
        assert relays(rig)[4] is True
        # Row 7: remove DI2 -> K3, K4, K5 drop at once; K1 stays.
        rig.jumper(2, False)
        await poll(controller, rig, count=1)
        rig.advance(0.05)
        assert relays(rig) == [True, True, False, False, False]
        assert controller.status().high_voltage_power is False
        # Row 8: open the E-stop -> every relay drops, including K1.
        rig.set_estop(True)
        rig.advance(0.05)
        await poll(controller, rig)
        assert relays(rig) == [False] * 5
        status = controller.status()
        assert status.alarms and "E-stop" in status.alarms[0]
        assert status.connected   # an interlock, not a communication error
        # Releasing the E-stop restarts nothing by itself...
        rig.set_estop(False)
        rig.advance(0.05)
        await poll(controller, rig)
        assert relays(rig) == [False] * 5
        # ...until the operator resumes.
        rig.jumper(2)
        await controller.resume_cascade()
        await poll(controller, rig)
        assert relays(rig) == [True, True, True, True, False]
        await controller.close()
        # Row 9: service stopped -> output rail drops within ~0.1 s.
        rig.advance(0.15)
        assert not rig.board.safe_rail_live

    run(scenario())


# ------------------------------------------------------------------ interlocks

@pytest.fixture
def started():
    rig = VacuumRig(tool_connected=False)
    controller = VacuumController(board_config(Gauges=jumper_gauges()), emulator=rig)
    for di in (1, 2, 3, 4, 5, 6, 7, 8):
        rig.jumper(di)
    run(controller.start())
    run(poll(controller, rig, count=4))
    assert relays(rig)[:4] == [True] * 4
    return rig, controller


def test_pump_fault_input_stops_that_branch_and_latches_the_cascade(started):
    rig, controller = started
    rig.jumper(6, False)                        # TurboVacuumPump error output
    run(poll(controller, rig))
    status = controller.status()
    turbo = next(p for p in status.pumps if p.name == "TurboVacuumPump")
    assert turbo.fault is True and turbo.power is False and turbo.border == "error"
    assert relays(rig)[:4] == [True, False, False, False]
    assert status.cascade_stopped and "TurboVacuumPump fault input open" in status.alarms
    rig.jumper(6)                               # fault clears: still latched
    run(poll(controller, rig))
    assert relays(rig)[1] is False
    run(controller.resume_cascade())
    run(poll(controller, rig, count=4))
    assert relays(rig)[:4] == [True] * 4


def test_keepalive_trip_drops_output_rail_but_keeps_backing_pump(started):
    rig, controller = started
    rig.advance(3.5)                            # control loop stalled
    assert controller.gpio.check_keepalive()
    rig.advance(0.2)
    assert not rig.board.safe_rail_live and rig.board.relay_closed(1)
    run(controller.poll_once())
    status = controller.status()
    assert "keep-alive" in status.last_error
    assert [p.power for p in status.pumps] == [True, False, False, False]
    run(controller.resume_cascade())
    run(poll(controller, rig, count=4))
    assert rig.board.safe_rail_live and relays(rig)[:4] == [True] * 4


def test_expander_reset_is_detected_and_reported_as_all_off(started):
    rig, controller = started
    rig.board.u1._por()                         # brown-out of U1
    run(controller.poll_once())
    status = controller.status()
    assert "expander reset" in status.last_error
    assert [p.power for p in status.pumps] == [False] * 4
    assert status.board["expander_resets"] == 1


def test_i2c_failure_de_energizes_downstream_and_keeps_backing_pump(started):
    rig, controller = started
    rig.pi.i2c1.inject_nack(0x21)
    run(controller.poll_once())
    rig.advance(0.05)
    status = controller.status()
    assert "Remote I/O error" in status.last_error and not status.connected
    assert relays(rig)[:4] == [True, False, False, False]


def test_status_exposes_board_readback(started):
    _rig, controller = started
    status = controller.status()
    assert status.control_transport == "rpi5-vacuum-io-emulator"
    assert status.board["estop_ok"] and status.board["output_rail_ok"]
    assert status.board["relays"]["K1"] is True
    assert status.board["inputs"]["DI1"] is True


def test_stale_readings_are_not_ready_and_cannot_enable_high_voltage(started):
    _rig, controller = started
    assert controller.isVacuumSystemReady
    controller._last_poll_monotonic -= controller.READING_MAX_AGE_SECONDS + 1
    status = controller.status()
    assert not status.connected and not status.isVacuumSystemReady
    assert "stale" in status.last_error
    assert all(p.value is None and not p.ready and p.port_b_value == 0 for p in status.pumps)
    with pytest.raises(ValueError, match="vacuum system to be ready"):
        run(controller.set_high_voltage_power(True))
    run(controller.poll_once())
    assert controller.status().connected and controller.isVacuumSystemReady


# ------------------------------------------------------------------ with the DB235 plant

def test_full_pumpdown_with_gauge_interlocks_reaches_ready():
    payload = json.loads(EXAMPLE.read_text())
    payload["Enable"] = True
    payload["Simulate"] = False
    for gauge in payload["SBC"]["Gauges"].values():
        gauge["Interlock"] = True
    config = VacuumConfig.model_validate(payload)
    rig = VacuumRig()
    controller = VacuumController(config, emulator=rig)

    async def scenario():
        await controller.start()
        for _ in range(500):
            await controller.poll_once()
            rig.advance(1.0)
            if controller.isVacuumSystemReady:
                break
        assert controller.isVacuumSystemReady
        values = {p.name: p.value for p in controller.status().pumps}
        assert values["MechanicalVacuumPump"] <= 0.1 * 1.01
        assert values["TurboVacuumPump"] <= 2e-3 * 1.01
        await controller.set_high_voltage_power(True)
        rig.advance(0.05)
        assert rig.plant.hv_permitted
        # A real fore-vacuum failure: the mechanical pump trips.
        rig.plant.mechanical.thermal_trip = True
        for _ in range(60):
            await controller.poll_once()
            rig.advance(1.0)
        status = controller.status()
        assert not rig.plant.hv_permitted
        assert not any(p.power for p in status.pumps if p.name != "MechanicalVacuumPump")
        assert "MechanicalVacuumPump fault input open" in status.alarms

    run(scenario())


def test_pfeiffer_rs485_over_the_board():
    rig = VacuumRig()
    rig.plant.turbo.hz = 640.0
    hal = rig.gpio_hal()
    hal.setup_output(18, False)
    client = pfeiffer.PfeifferClient(rig.serial("/dev/ttyAMA0"),
                                     lambda on: hal.write(18, on), sleep=rig.sleep)
    assert client.actual_speed_hz(1) == 640
    assert client.error_code(2) == "no Err"
    client.set_pumping_station(3, False)
    assert rig.plant.uh_turbos[1].serial_on is False


def test_pfeiffer_protocol_checksum_matches_manual_example():
    assert pfeiffer.query(1, 309) == b"0010030902=?107\r"
    telegram = pfeiffer.decode(b"0010030902=?107\r")
    assert telegram.is_query and telegram.parameter == 309
    with pytest.raises(pfeiffer.PfeifferProtocolError):
        pfeiffer.decode(b"0010030902=?108\r")


def test_driver_rejects_overlapping_ready_and_fault_inputs():
    rig = VacuumRig()
    with pytest.raises(ValueError, match="distinct"):
        RPi5VacuumIODevice({"A0": "K1"}, {"B0": "DI1"}, faults={"B0": "DI1"},
                           bus_factory=rig.smbus, gpio=rig.gpio_hal())


# ------------------------------------------------------------------ HTTP API in emulator mode

def test_realtime_accelerated_pumpdown_does_not_latch_spurious_faults():
    import time

    rig = VacuumRig(realtime=True, speed=20)
    controller = VacuumController(board_config(), emulator=rig)

    async def scenario():
        try:
            await controller.start()
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                await asyncio.sleep(0.1)
                status = controller.status()
                assert not status.cascade_stopped, status.last_error or status.alarms
                assert not status.last_error
                if controller.isVacuumSystemReady:
                    break
            assert controller.isVacuumSystemReady
            assert relays(rig)[:4] == [True] * 4
        finally:
            await controller.close()

    try:
        run(scenario())
    finally:
        rig.close()


def test_sbc_api_runs_the_production_driver_on_the_realtime_emulator(tmp_path, monkeypatch):
    import time

    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from glasgow_service.sbc_vacuum_app import create_app

    payload = json.loads(EXAMPLE.read_text())
    payload["Enable"] = True
    payload["Simulate"] = False
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    monkeypatch.setenv("SBC_VACUUM_TOKEN", "test-token")
    monkeypatch.setenv("SBC_VACUUM_EMULATOR", "1")
    monkeypatch.setenv("SBC_VACUUM_EMULATOR_SPEED", "20")
    auth = {"Authorization": "Bearer test-token"}

    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        assert client.get("/status").json()["mode"] == "board-emulator"
        state = client.get("/vacuum").json()
        assert state["control_transport"] == "rpi5-vacuum-io-emulator"
        rig = client.get("/emulator").json()
        assert rig["pi"]["model"] == "Raspberry Pi 4 Model B"
        # The physical relay has an operate delay after its output is set.
        deadline = time.monotonic() + 1
        while not rig["board"]["relays"]["K1"] and time.monotonic() < deadline:
            time.sleep(0.01)
            rig = client.get("/emulator").json()
        assert rig["board"]["relays"]["K1"] is True     # backing pump started
        assert client.post("/emulator/estop", json={"pressed": True}).status_code == 401
        client.post("/emulator/estop", json={"pressed": True}, headers=auth)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = client.get("/vacuum").json()
            if state["alarms"]:
                break
            time.sleep(0.1)
        assert state["alarms"] and "E-stop" in state["alarms"][0]
        assert state["connected"] is True
        assert client.get("/emulator").json()["board"]["relays"]["K1"] is False


def test_persistent_uh_fault_does_not_block_healthy_stages_after_resume(started):
    rig, controller = started
    rig.jumper(7, False)                        # UHVacuumPump_1 faulted, stays faulted
    run(poll(controller, rig))
    assert relays(rig)[:4] == [True, True, False, True]
    assert controller.status().cascade_stopped
    run(controller.resume_cascade())
    run(poll(controller, rig, count=4))
    status = controller.status()
    assert relays(rig)[:4] == [True, True, False, True]   # UH1 never restarted
    assert not status.cascade_stopped
    assert status.alarms == ["UHVacuumPump_1 fault input open"]
    assert not controller.isVacuumSystemReady
    rig.jumper(8, False)                        # a new fault latches again
    run(poll(controller, rig))
    assert controller.status().cascade_stopped


# ------------------------------------------------------------------ IsProduction switch

def _payload(**top):
    payload = json.loads(EXAMPLE.read_text())
    payload["Enable"] = True
    payload.update(top)
    return payload


def _forbid_hardware(monkeypatch):
    import glasgow_service.vacuum_io_board as board_module

    def no_hardware(*args, **kwargs):
        raise AssertionError("real GPIO opened")
    monkeypatch.setattr(board_module, "LgpioHAL", no_hardware)


def test_is_production_defaults_to_true_when_missing():
    payload = _payload(Simulate=False)
    payload.pop("IsProduction")
    assert VacuumConfig.model_validate(payload).is_production is True


def test_is_production_false_activates_the_emulator_and_never_opens_hardware(monkeypatch):
    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    _forbid_hardware(monkeypatch)
    config = VacuumConfig.model_validate(_payload(IsProduction=False, Simulate=False))
    assert config.uses_emulator
    controller = VacuumController(config)
    try:
        assert controller.emulator is not None and controller.emulator.runner is not None
        assert controller.gpio.transport == "rpi5-vacuum-io-emulator"
        assert controller.status().is_production is False
    finally:
        controller.emulator.close()


def test_is_production_true_uses_hardware(monkeypatch):
    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    _forbid_hardware(monkeypatch)
    config = VacuumConfig.model_validate(_payload(IsProduction=True, Simulate=False))
    assert not config.uses_emulator
    with pytest.raises(AssertionError, match="real GPIO opened"):
        VacuumController(config)


def test_simulate_true_wins_over_is_production_false(monkeypatch):
    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    config = VacuumConfig.model_validate(_payload(IsProduction=False, Simulate=True))
    controller = VacuumController(config)
    assert controller.emulator is None
    assert controller.status().control_transport == "sbc-simulation"


def test_is_production_false_with_a_gpio_config_selects_the_simulator(monkeypatch):
    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    gpio_config = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"
    payload = json.loads(gpio_config.read_text())
    payload.update(IsProduction=False, Simulate=False)
    config = VacuumConfig.model_validate(payload)
    assert config.simulate is True
    controller = VacuumController(config)
    assert controller.status().simulation is True


def test_api_switches_to_emulator_when_is_production_is_false(tmp_path, monkeypatch):
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from glasgow_service.sbc_vacuum_app import create_app

    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    _forbid_hardware(monkeypatch)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(_payload(IsProduction=False, Simulate=False)))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")
    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        status = client.get("/status").json()
        assert status["mode"] == "board-emulator" and status["is_production"] is False
        assert client.get("/vacuum").json()["is_production"] is False
        assert client.get("/emulator").status_code == 200


# ------------------------------------------------------------------ mode-tagged logging

def test_emulator_mode_logs_are_tagged(monkeypatch, caplog):
    import logging

    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    rig = VacuumRig(tool_connected=False)
    caplog.set_level(logging.INFO, logger="glasgow_service.vacuum")
    controller = VacuumController(board_config(), emulator=rig)
    assert controller.log_tag == "[VACUUM-EMU]"

    async def scenario():
        await controller.start()
        await poll(controller, rig)
        rig.set_estop(True)
        rig.advance(0.05)
        await poll(controller, rig)

    run(scenario())
    lines = [r.getMessage() for r in caplog.records if r.name == "glasgow_service.vacuum"]
    assert lines and all(line.startswith("[VACUUM-EMU] ") for line in lines)
    assert any("mode=emulator IsProduction=false" in line for line in lines)
    assert any("MechanicalVacuumPump (A0/K1) ON" in line for line in lines)
    assert any("ALARM raised: E-stop loop open" in line for line in lines)
    assert all(getattr(r, "vacuum_mode", None) == "emulator" for r in caplog.records
               if r.name == "glasgow_service.vacuum")


def test_simulator_mode_logs_are_tagged(monkeypatch, caplog):
    import logging

    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    caplog.set_level(logging.INFO, logger="glasgow_service.vacuum")
    config = VacuumConfig.model_validate(_payload(Simulate=True))
    controller = VacuumController(config)
    assert controller.log_tag == "[VACUUM-SIM]"
    assert any(r.getMessage().startswith("[VACUUM-SIM] no real equipment is driven")
               for r in caplog.records)


def test_is_production_true_runs_the_hardware_path_with_hw_tag(monkeypatch, caplog):
    """IsProduction=true end to end through the production hardware code
    path (build_board_device -> LgpioHAL + smbus2.SMBus), with only those two
    Linux endpoints substituted by the emulator."""
    import logging

    import smbus2

    import glasgow_service.vacuum_io_board as board_module

    monkeypatch.delenv("SBC_VACUUM_EMULATOR", raising=False)
    rig = VacuumRig(realtime=True, speed=1.0, tool_connected=False)
    monkeypatch.setattr(board_module, "LgpioHAL", lambda: rig.gpio_hal())
    monkeypatch.setattr(smbus2, "SMBus", lambda bus: rig.smbus(bus))
    caplog.set_level(logging.INFO, logger="glasgow_service.vacuum")
    config = VacuumConfig.model_validate(_payload(IsProduction=True, Simulate=False))
    controller = VacuumController(config)
    try:
        assert controller.emulator is None and controller.log_tag == "[VACUUM-HW]"
        assert controller.status().control_transport == "rpi5-vacuum-io"

        async def scenario():
            await controller.start()
            await controller.poll_once()
            await asyncio.sleep(0.05)
            assert rig.board.relay_closed(1)          # K1 really driven
            await controller.close()

        run(scenario())
    finally:
        rig.close()
    lines = [r.getMessage() for r in caplog.records if r.name == "glasgow_service.vacuum"]
    assert all(line.startswith("[VACUUM-HW] ") for line in lines)
    banner = next(r for r in caplog.records if getattr(r, "event", "") == "vacuum.mode")
    assert banner.levelname == "WARNING" and "LIVE HARDWARE" in banner.getMessage()
    assert "reason=IsProduction=true, Simulate=false" in banner.getMessage()


@pytest.mark.parametrize("simulate", [False, True])
def test_production_cannot_fall_back_to_emulation(monkeypatch, simulate):
    monkeypatch.setenv("SBC_VACUUM_EMULATOR", "1")
    _forbid_hardware(monkeypatch)
    config = VacuumConfig.model_validate(_payload(IsProduction=True, Simulate=simulate))
    assert not config.simulate and not config.uses_emulator
    with pytest.raises(AssertionError, match="real GPIO opened"):
        VacuumController(config)


def test_production_api_fails_startup_without_sbc_hardware(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from glasgow_service.sbc_vacuum_app import create_app
    import glasgow_service.vacuum_io_board as board_module

    def missing_hardware():
        raise RuntimeError("SBC GPIO hardware unavailable")

    monkeypatch.setattr(board_module, "LgpioHAL", missing_hardware)
    monkeypatch.setenv("SBC_VACUUM_EMULATOR", "1")
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(_payload(IsProduction=True, Simulate=True)))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    with pytest.raises(RuntimeError, match="SBC GPIO hardware unavailable"):
        with TestClient(create_app()):
            pytest.fail("production service started without hardware")


@pytest.mark.parametrize("scan_production", [False, True])
@pytest.mark.parametrize("simulate", [False, True])
def test_runtime_ignores_stale_simulator_flag(tmp_path, monkeypatch, scan_production, simulate):
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(_payload(Enable=True, IsProduction=True, Simulate=simulate)))
    stream = tmp_path / "streamData.json"
    stream.write_text(json.dumps({"IsProduction": scan_production}))
    monkeypatch.setenv("GLASGOW_CONFIG", str(stream))
    config = load_runtime_vacuum_config(source)
    assert config.is_production is scan_production
    assert config.simulate is False
    assert config.uses_emulator is (not scan_production)


@pytest.mark.parametrize("scan_production", [False, True])
@pytest.mark.parametrize("simulate", [False, True])
def test_enabled_control_selects_mode_from_scan_production(tmp_path, monkeypatch, scan_production, simulate):
    from fastapi.testclient import TestClient
    from glasgow_service.sbc_vacuum_app import create_app

    _forbid_hardware(monkeypatch)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(_payload(Enable=True, IsProduction=False, Simulate=simulate)))
    stream = tmp_path / "streamData.json"
    stream.write_text(json.dumps({"IsProduction": scan_production}))
    monkeypatch.setenv("GLASGOW_CONFIG", str(stream))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    config = load_runtime_vacuum_config(source)
    assert config.enabled and config.is_production is scan_production
    assert config.uses_emulator is (not scan_production)
    if scan_production:
        with pytest.raises(AssertionError, match="real GPIO opened"):
            with TestClient(create_app()):
                pytest.fail("production vacuum control started without hardware")
    else:
        with TestClient(create_app()) as client:
            assert client.get("/status").json()["mode"] == "board-emulator"
            assert client.get("/emulator").status_code == 200


def test_board_profile_owns_its_enable_flag(tmp_path, monkeypatch):
    source = tmp_path / "board-profile.json"
    source.write_text(json.dumps(_payload(Enable=True)))
    (tmp_path / "vacuumSystem.json").write_text(json.dumps({"Enable": False}))
    assert load_runtime_vacuum_config(source).enabled


def test_repeated_close_after_executor_release_is_safe():
    rig = VacuumRig()
    controller = VacuumController(board_config(), emulator=rig)

    async def scenario():
        await controller.start()
        await controller.poll_once()
        await controller.close()  # Executor releases before service shutdown.
        await controller.close()  # Lifespan then shuts down the same controller.
        rig.advance(0.2)
        assert not rig.board.safe_rail_live
        assert relays(rig) == [False] * 5
        # A reset can acquire and start the same controller again.
        await controller.start()
        await controller.poll_once()
        assert controller.status().connected
        await controller.close()

    try:
        run(scenario())
    finally:
        rig.close()


# ------------------------------------------------------------ reading must reach threshold

def test_ready_input_alone_does_not_make_a_pump_ready_without_its_reading():
    """Default gauges: DI1 jumpered but no gauge connected -> stays waiting."""
    rig = VacuumRig(tool_connected=False)
    controller = VacuumController(board_config(), emulator=rig)
    for di in (1, 5, 6, 7, 8):
        rig.jumper(di)

    async def scenario():
        await controller.start()
        await poll(controller, rig)
        mechanical = controller.status().pumps[0]
        assert mechanical.port_b_value == pytest.approx(3.3)   # ready input on
        assert mechanical.value is None                         # no reading
        assert mechanical.ready is False and mechanical.border == "waiting"
        assert relays(rig) == [True, False, False, False, False]  # turbo not started
        await controller.close()

    run(scenario())


def test_every_pump_turns_ready_only_after_its_reading_reaches_its_threshold():
    config = board_config()
    limit = {p.name: p.threshold for p in config.pumps}
    rig = VacuumRig()
    controller = VacuumController(config, emulator=rig)

    async def scenario():
        await controller.start()
        became_ready = {}
        for _ in range(500):
            await controller.poll_once()
            rig.advance(1.0)
            for pump in controller.status().pumps:
                if pump.ready:
                    assert pump.value is not None and pump.value <= limit[pump.name], pump
                    became_ready.setdefault(pump.name, pump.value)
            if controller.isVacuumSystemReady:
                break
        assert controller.isVacuumSystemReady
        assert set(became_ready) == set(limit)
        await controller.close()

    run(scenario())


# ------------------------------------------------------------ isolation valves

def pumped_down(**sbc_updates):
    """Controller + deterministic rig, run until the whole system is ready."""
    rig = VacuumRig()
    controller = VacuumController(board_config(**sbc_updates), emulator=rig)

    async def go():
        await controller.start()
        for _ in range(600):
            await controller.poll_once()
            rig.advance(1.0)
            if controller.isVacuumSystemReady:
                return
        raise AssertionError("pump-down did not complete")

    run(go())
    return rig, controller


def pumps(controller):
    return {p.name: p for p in controller.status().pumps}


async def poll_until(controller, rig, predicate, limit=600):
    for _ in range(limit):
        await controller.poll_once()
        rig.advance(1.0)
        if predicate():
            return True
    return False


def test_valve_config_validation():
    with pytest.raises(ValueError, match="solenoid V1..V8"):
        board_config(Valves={"B0": "V9"})
    with pytest.raises(ValueError, match="distinct solenoid"):
        board_config(Valves={"B0": "V1", "B1": "V1"})
    with pytest.raises(ValueError, match="unknown channels: B7"):
        board_config(Valves={"B7": "V8"})


def test_valves_closed_at_start_and_open_only_once_each_pump_is_ready():
    rig = VacuumRig()
    controller = VacuumController(board_config(), emulator=rig)

    async def scenario():
        await controller.start()
        state = pumps(controller)
        assert [state[n].valve for n in state] == ["V1", "V2", "V4", "V5"]
        assert not any(p.valve_open for p in state.values())
        assert not any(rig.board.solenoid_on(n) for n in (1, 2, 4, 5))
        for _ in range(600):
            await controller.poll_once()
            rig.advance(1.0)
            for p in controller.status().pumps:
                assert p.valve_open == p.ready, p          # open exactly while ready
            if controller.isVacuumSystemReady:
                break
        assert all(rig.board.solenoid_on(n) for n in (1, 2, 4, 5))
        await controller.close()

    run(scenario())


def test_turbo_excursion_isolates_only_that_pump_until_it_recovers():
    rig, controller = pumped_down()

    async def scenario():
        rig.set_excursion("TurboVacuumPump", 3e-3)         # reading above 2e-3
        assert await poll_until(controller, rig, lambda: pumps(controller)[
            "TurboVacuumPump"].border == "error", limit=5)
        turbo = pumps(controller)["TurboVacuumPump"]
        assert turbo.excursion and turbo.power and not turbo.valve_open
        assert not rig.board.solenoid_on(2)                # V2 closed
        others = [p for p in controller.status().pumps if p.name != "TurboVacuumPump"]
        assert all(p.power and p.valve_open for p in others)   # still running
        assert not controller.isVacuumSystemReady           # HV blocked

        rig.set_excursion("TurboVacuumPump", release=True, recovery_s=30)
        assert await poll_until(controller, rig, lambda: controller.isVacuumSystemReady)
        turbo = pumps(controller)["TurboVacuumPump"]
        assert turbo.value <= turbo.threshold
        assert turbo.border == "ready" and turbo.valve_open and not turbo.excursion
        assert rig.board.solenoid_on(2)
        await controller.close()

    run(scenario())


def test_mechanical_excursion_restarts_like_initialization():
    rig, controller = pumped_down()

    async def scenario():
        rig.set_excursion("MechanicalVacuumPump", 0.2)     # reading above 0.1
        assert await poll_until(controller, rig, lambda: pumps(controller)[
            "MechanicalVacuumPump"].border == "error", limit=5)
        state = pumps(controller)
        assert state["MechanicalVacuumPump"].power         # keeps running to recover
        assert not any(p.power for n, p in state.items() if n != "MechanicalVacuumPump")
        assert not any(p.valve_open for p in state.values())
        assert not any(rig.board.solenoid_on(n) for n in (1, 2, 4, 5))
        assert relays(rig)[1:4] == [False, False, False]

        rig.set_excursion("MechanicalVacuumPump", release=True, recovery_s=30)
        assert await poll_until(controller, rig, lambda: controller.isVacuumSystemReady)
        assert all(p.valve_open and p.border == "ready" for p in controller.status().pumps)
        assert controller.status().cascade_stopped is False
        await controller.close()

    run(scenario())


def test_excursion_recovers_only_while_its_pump_runs():
    rig = VacuumRig()
    plant = rig.plant
    rig.set_excursion("UHVacuumPump_2", 1e-3, release=True, recovery_s=10)
    rig.advance(30.0)                                   # pump off: no recovery
    assert plant.excursion["uh2"] == pytest.approx(1e-3)
    with pytest.raises(KeyError):
        rig.set_excursion("NoSuchPump", 1.0)
