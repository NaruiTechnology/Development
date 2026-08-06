import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from glasgow_service import api
from glasgow_service.vacuum import (
    MECHANICAL_PUMP,
    VacuumController,
    load_vacuum_config,
    vacuum_config_enabled,
)
from glasgow_service.comparator_subtarget import ComparatorTarget, VacuumComparatorSubtarget
from glasgow_service.models import DeviceState, ServiceStatus
from glasgow_service.service import DeviceBusy, DeviceService


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


def test_config(**updates):
    """Stable unit-test fixture derived from, but not controlled by, live settings."""
    config = load_vacuum_config(CONFIG_PATH).model_copy(
        deep=True,
        update={"enabled": True, "error_range": 0.005}
    )
    for action_group in config.actions:
        for action in action_group.values():
            action.timeout = 15.0
    return config.model_copy(update=updates)


def simulated_controller():
    config = test_config(simulate=True)
    controller = VacuumController(config)
    commands: list[str] = []
    return controller, commands


async def advance_until(controller, predicate, *, limit=100):
    for _ in range(limit):
        await controller.poll_once()
        if predicate(controller.status()):
            return
    raise AssertionError("simulated vacuum state did not reach the expected condition")


def test_vacuum_config_parses_thresholds_and_port_directions():
    config = test_config()

    assert config.device.id == "C3-20251207T145552Z"
    assert config.device.voltage == 3.3
    assert config.error_range == pytest.approx(0.005)
    assert config.action("writeData").timeout == pytest.approx(15.0)
    assert config.action("readData").timeout == pytest.approx(15.0)
    assert [pump.threshold for pump in config.pumps] == [0.1, 0.002, 0.00003, 0.00003]
    assert all(pump.write.startswith("A") for pump in config.pumps)
    assert all(pump.read.startswith("B") for pump in config.pumps)


def test_live_gpio_timeouts_allow_fpga_generation():
    config = load_vacuum_config(CONFIG_PATH)

    assert config.action("writeData").timeout >= 60.0
    assert config.action("readData").timeout >= 60.0


def test_disabled_vacuum_bypasses_controller_config_validation(tmp_path):
    disabled_config = tmp_path / "vacuum-disabled.json"
    disabled_config.write_text(json.dumps({"Enable": False}))

    assert vacuum_config_enabled(disabled_config) is False


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"Enable": False}, False),
        ({"Enable": True}, True),
        ({}, True),
    ],
)
def test_vacuum_enable_flag_contract(tmp_path, payload, expected):
    config_path = tmp_path / "vacuum-toggle.json"
    config_path.write_text(json.dumps(payload))

    assert vacuum_config_enabled(config_path) is expected


def test_vacuum_enable_flag_ignores_misspelled_legacy_key(tmp_path):
    config_path = tmp_path / "vacuum-toggle-typo.json"
    config_path.write_text(json.dumps({"Enable": False, "Enalble": True}))

    assert vacuum_config_enabled(config_path) is False


def test_vacuum_enable_flag_rejects_non_boolean_values(tmp_path):
    config_path = tmp_path / "vacuum-invalid-toggle.json"
    config_path.write_text(json.dumps({"Enable": "false"}))

    with pytest.raises(ValueError, match="must be true or false"):
        vacuum_config_enabled(config_path)


def test_service_status_and_route_follow_vacuum_toggle(monkeypatch):
    class FakeService:
        def status(self):
            return ServiceStatus(state=DeviceState.IDLE)

    controller = object()
    monkeypatch.setattr(api, "svc", FakeService())

    monkeypatch.setattr(api, "vacuum", None)
    disabled_status = asyncio.run(api.get_status())
    assert disabled_status.vacuum_enabled is False
    with pytest.raises(HTTPException) as disabled_route:
        api.require_vacuum_controller()
    assert disabled_route.value.status_code == 404

    monkeypatch.setattr(api, "vacuum", controller)
    enabled_status = asyncio.run(api.get_status())
    assert enabled_status.vacuum_enabled is True
    assert api.require_vacuum_controller() is controller

    monkeypatch.setattr(api, "vacuum", None)
    toggled_back_status = asyncio.run(api.get_status())
    assert toggled_back_status.vacuum_enabled is False


def test_simulated_vacuum_cascade_and_stop():
    async def scenario():
        controller, commands = simulated_controller()
        await controller.start()
        try:
            assert controller.status().pumps[0].name == MECHANICAL_PUMP
            assert controller.status().control_transport == "glasgow-gpio"
            assert controller.status().pumps[0].power is True
            assert controller.status().pumps[0].port_a_value == pytest.approx(3.3)
            assert controller.status().pumps[0].border == "waiting"
            assert controller.status().pumps[0].value == pytest.approx(0.15)
            assert controller.status().pumps[0].port_b_value == 0
            assert controller.gpio.output_level("A0") is True
            await controller.poll_once()
            assert controller.status().pumps[0].value == pytest.approx(0.148)
            assert all(pump.value is None for pump in controller.status().pumps[1:])

            await advance_until(
                controller,
                lambda status: next(p for p in status.pumps if p.name == "TurboVacuumPump").power,
            )
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["MechanicalVacuumPump"].border == "ready"
            assert states["MechanicalVacuumPump"].port_b_value == pytest.approx(3.3)
            assert states["MechanicalVacuumPump"].value == states["MechanicalVacuumPump"].threshold
            assert states["TurboVacuumPump"].power is True
            assert states["TurboVacuumPump"].border == "waiting"

            await advance_until(
                controller,
                lambda status: next(p for p in status.pumps if p.name == "UHVacuumPump_1").power,
            )
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["MechanicalVacuumPump"].ready is True
            assert states["TurboVacuumPump"].ready is True
            assert states["UHVacuumPump_1"].power is True
            assert states["UHVacuumPump_2"].power is True

            await advance_until(controller, lambda status: status.isVacuumSystemReady)
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["UHVacuumPump_1"].value == states["UHVacuumPump_1"].threshold
            assert states["UHVacuumPump_2"].value == states["UHVacuumPump_2"].threshold
            assert states["UHVacuumPump_1"].port_b_value == pytest.approx(3.3)
            assert states["UHVacuumPump_2"].port_b_value == pytest.approx(3.3)
            assert states["UHVacuumPump_1"].ready is True
            assert states["UHVacuumPump_2"].ready is True
            assert controller.status().isVacuumSystemReady is True

            await controller.stop_non_mechanical()
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["MechanicalVacuumPump"].power is True
            assert states["MechanicalVacuumPump"].border == "ready"
            assert states["MechanicalVacuumPump"].port_b_value == pytest.approx(3.3)
            assert all(
                state.power is False
                and state.border == "off"
                and state.value is None
                for name, state in states.items()
                if name != MECHANICAL_PUMP
            )
            assert controller.status().cascade_stopped is True
            assert controller.status().isVacuumSystemReady is False
            assert controller.gpio.output_level("A0") is True
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_production_subtarget_transport_writes_and_reads_channel_masks():
    class FakeInterface:
        def __init__(self):
            self.outputs = []
            self.targets = []
            self.closed = False

        async def configure_target(self, channel, configured_value, error_range):
            self.targets.append((channel, configured_value, error_range))

        async def set_output(self, channel, enabled):
            self.outputs.append((channel, enabled))

        async def read_status(self):
            return 0b0001, 0b0101

        async def close(self):
            self.closed = True

    class FakeLauncher:
        interface = FakeInterface()
        args = None

        def __init__(self, *args):
            type(self).args = args

        async def start(self):
            return type(self).interface

    async def scenario():
        config = test_config(simulate=False)
        transport = VacuumComparatorSubtarget(
            config.device.id,
            config.device.voltage,
            config.pumps,
            launcher_factory=FakeLauncher,
        )
        pump = config.pumps[0]
        await transport.write_target(ComparatorTarget(
            equipment=pump.name,
            source_pin=pump.write,
            result_pin=pump.read,
            configured_value=pump.threshold,
            error_range=config.error_range,
            high_voltage=config.device.voltage,
            enabled=True,
        ))

        assert FakeLauncher.args == (
            config.device.id,
            config.device.voltage,
            [pump.write for pump in config.pumps],
            [pump.read for pump in config.pumps],
        )
        assert FakeLauncher.interface.outputs == [(0, True)]
        assert FakeLauncher.interface.targets == [(0, pytest.approx(0.1), pytest.approx(0.005))]
        assert await transport.read_inputs() == {"B0": 1, "B1": 0, "B2": 1, "B3": 0}
        assert transport.output_level("A0") is True
        assert transport.output_level("A1") is False
        await transport.close()
        assert FakeLauncher.interface.closed is True

    asyncio.run(scenario())


def test_mechanical_pump_cannot_be_turned_off():
    async def scenario():
        controller, _commands = simulated_controller()
        await controller.start()
        try:
            assert controller.status().pumps[0].power is True
            with pytest.raises(ValueError, match="must remain powered on"):
                await controller.set_power(MECHANICAL_PUMP, False)
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_manual_power_on_obeys_upstream_port_b_interlocks():
    async def scenario():
        controller, _commands = simulated_controller()
        await controller.start()
        try:
            states = {pump.name: pump for pump in controller.status().pumps}
            mechanical = controller._states[MECHANICAL_PUMP]
            turbo = controller._states["TurboVacuumPump"]

            with pytest.raises(ValueError, match="MechanicalVacuumPump Port B at 3.3 V"):
                await controller.set_power("TurboVacuumPump", True)
            assert controller.gpio.output_level("A1") is False

            mechanical.port_b_value = controller.config.device.voltage
            await controller.set_power("TurboVacuumPump", True)
            assert controller.gpio.output_level("A1") is True

            with pytest.raises(ValueError, match="TurboVacuumPump Port B at 3.3 V"):
                await controller.set_power("UHVacuumPump_1", True)
            assert controller.gpio.output_level("A2") is False

            turbo.port_b_value = controller.config.device.voltage
            await controller.set_power("UHVacuumPump_1", True)
            await controller.set_power("UHVacuumPump_2", True)
            assert controller.gpio.output_level("A2") is True
            assert controller.gpio.output_level("A3") is True

            assert states[MECHANICAL_PUMP].power is True
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_stopping_all_downstream_preserves_mechanical_readiness():
    async def scenario():
        controller, _commands = simulated_controller()
        await controller.start()
        try:
            await advance_until(controller, lambda status: status.isVacuumSystemReady)

            await controller.set_power("UHVacuumPump_1", False)
            await controller.set_power("UHVacuumPump_2", False)
            await controller.set_power("TurboVacuumPump", False)
            for _ in range(5):
                await controller.poll_once()

            states = {pump.name: pump for pump in controller.status().pumps}
            mechanical = states[MECHANICAL_PUMP]
            assert mechanical.power is True
            assert mechanical.ready is True
            assert mechanical.border == "ready"
            assert mechanical.port_b_value == pytest.approx(3.3)
            assert all(
                state.power is False
                for name, state in states.items()
                if name != MECHANICAL_PUMP
            )
            assert controller.status().cascade_stopped is True
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_reacquire_resets_simulated_cascade_to_initial_state():
    async def scenario():
        controller, _commands = simulated_controller()
        await controller.start()
        await advance_until(controller, lambda status: status.isVacuumSystemReady)
        await controller.close()

        await controller.start()
        try:
            states = {pump.name: pump for pump in controller.status().pumps}
            mechanical = states[MECHANICAL_PUMP]
            assert mechanical.power is True
            assert mechanical.border == "waiting"
            assert mechanical.value == pytest.approx(0.15)
            assert mechanical.port_b_value == 0
            assert all(
                state.power is False
                and state.border == "off"
                and state.value is None
                for name, state in states.items()
                if name != MECHANICAL_PUMP
            )
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_simulated_comparator_goes_high_when_analog_value_reaches_tolerance():
    async def scenario():
        controller, commands = simulated_controller()
        await controller.start()
        try:
            for _ in range(55):
                await controller.poll_once()
            mechanical = controller.status().pumps[0]
            assert mechanical.value == pytest.approx(mechanical.threshold)
            assert mechanical.port_b_value == pytest.approx(3.3)
            assert mechanical.ready is True
            assert mechanical.border == "ready"
            assert controller.status().pumps[1].power is True
            assert controller.config.error_range == pytest.approx(0.005)
            assert controller.gpio._comparator_outputs["B0"] is True
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_simulated_comparator_uses_half_percent_configured_value_window():
    controller, _commands = simulated_controller()

    assert controller._comparator_matches(0.10049, 0.1) is True
    assert controller._comparator_matches(0.09951, 0.1) is True
    assert controller._comparator_matches(0.10051, 0.1) is False
    assert controller._comparator_matches(0.09949, 0.1) is False


def test_vacuum_system_ready_requires_every_configured_port_b_pin_high():
    controller, _commands = simulated_controller()

    assert controller.isVacuumSystemReady is False
    assert controller.status().isVacuumSystemReady is False
    for state in controller._states.values():
        state.port_b_value = controller.config.device.voltage
    assert controller.isVacuumSystemReady is True
    assert controller.status().isVacuumSystemReady is True
    controller._states[MECHANICAL_PUMP].port_b_value = 0
    assert controller.status().isVacuumSystemReady is False


def test_production_uses_control_gpio_for_real_comparator_pins():
    async def scenario():
        config = test_config(simulate=False)
        controller = VacuumController(config)
        commands: list[str] = []

        async def fake_run(command: str, _timeout: float) -> str:
            commands.append(command)
            return " ".join(f"B{index}={index % 2}" for index in range(4))

        controller.gpio._run = fake_run
        await controller.gpio.write("A0", True)
        readings = await controller.gpio.read_port_b()

        assert readings == {f"B{index}": index % 2 for index in range(4)}
        assert len(commands) == 2
        assert all("glasgow run control-gpio" in command for command in commands)
        assert any("A0=1" in command for command in commands)
        assert any("B0" in command and "B3" in command for command in commands)

    asyncio.run(scenario())


def test_simulation_maps_port_a_equipment_values_to_configured_gpio_voltage():
    async def scenario():
        controller, commands = simulated_controller()

        await controller.gpio.write("A0", True)
        await controller.gpio.write("A1", True)

        assert controller.gpio.comparator_subtarget.targets() == ()
        assert controller.gpio.output_level("A0") is True
        assert controller.gpio.output_level("A1") is True

    asyncio.run(scenario())


def test_port_b_levels_are_reported_as_configured_pin_voltage():
    async def scenario():
        config = test_config(simulate=False)
        controller = VacuumController(config)

        async def fake_read_port_b() -> dict[str, int]:
            return {"B0": 1, "B1": 0, "B2": 1, "B3": 0}

        controller.gpio.read_port_b = fake_read_port_b
        await controller.poll_once()
        states = {state.read: state for state in controller.status().pumps}

        assert states["B0"].port_b_value == pytest.approx(config.device.voltage)
        assert states["B1"].port_b_value == 0.0
        assert states["B2"].port_b_value == pytest.approx(config.device.voltage)
        assert states["B3"].port_b_value == 0.0
        assert controller.status().isVacuumSystemReady is False

    asyncio.run(scenario())


def test_port_b_read_failure_clears_stale_voltage_and_readiness():
    async def scenario():
        config = test_config(simulate=False)
        controller = VacuumController(config)
        for state in controller._states.values():
            state.power = True
            state.port_b_value = config.device.voltage
            state.ready = True

        async def failed_read_port_b() -> dict[str, int]:
            raise RuntimeError("GPIO read failed")

        controller.gpio.read_port_b = failed_read_port_b
        await controller.poll_once()

        assert controller.status().isVacuumSystemReady is False
        assert all(state.port_b_value == 0.0 for state in controller.status().pumps)
        assert all(state.ready is False for state in controller.status().pumps)

    asyncio.run(scenario())


def test_vacuum_exclusive_ownership_hard_closes_scan_connection():
    class FakeConnection:
        closed = False

        async def _hard_close(self):
            self.closed = True

    async def scenario():
        service = DeviceService.__new__(DeviceService)
        connection = FakeConnection()
        service._conn = connection
        service._lock = asyncio.Lock()
        service._exclusive_owner = None
        service._status = ServiceStatus(state=DeviceState.IDLE)

        await service.acquire_exclusive("vacuum")
        assert connection.closed is True
        assert service._conn is None
        assert service._exclusive_owner == "vacuum"
        assert service._lock.locked() is True
        assert service.status().state is DeviceState.BUSY

        with pytest.raises(DeviceBusy, match="reserved by vacuum"):
            async with service._acquire("raster"):
                pass

        await service.release_exclusive("vacuum")
        assert service._exclusive_owner is None
        assert service._lock.locked() is False
        assert service.status().state is DeviceState.IDLE

    asyncio.run(scenario())
