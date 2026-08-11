import asyncio
import json
from pathlib import Path

import pytest
from glasgow_service.vacuum import (
    MECHANICAL_PUMP,
    VacuumConfig,
    VacuumController,
    load_vacuum_config,
    vacuum_config_enabled,
)
from glasgow_service.vacuum_device import SimulatedVacuumDevice, VacuumDevice


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


def make_config(**updates):
    """Stable unit-test fixture derived from, but not controlled by, live settings."""
    payload = json.loads(CONFIG_PATH.read_text())
    config = VacuumConfig.model_validate(payload).model_copy(
        update={"enabled": True, "error_range": 0.005})
    return config.model_copy(update=updates)


def simulated_controller():
    config = make_config(simulate=True)
    controller = VacuumController(config)
    commands: list[str] = []
    return controller, commands


def test_vacuum_config_parses_thresholds_and_port_directions():
    config = make_config()

    assert config.device.id == "raspberry-pi-vacuum"
    assert config.device.voltage == 3.3
    assert config.error_range == pytest.approx(0.005)
    assert [pump.threshold for pump in config.pumps] == [0.1, 0.002, 0.00003, 0.00003]
    assert all(pump.write.startswith("A") for pump in config.pumps)
    assert all(pump.read.startswith("B") for pump in config.pumps)


def test_vacuum_equipment_count_is_configuration_driven_with_minimum_three():
    payload = json.loads(CONFIG_PATH.read_text())

    three = json.loads(json.dumps(payload))
    three["VacuumPumps"] = three["VacuumPumps"][:3]
    parsed_three = VacuumConfig.model_validate(three)
    assert len(parsed_three.pumps) == 3

    five = json.loads(json.dumps(payload))
    five["VacuumPumps"].append({
        "name": "UHVacuumPump_3",
        "power": "off",
        "value": "4.0e-5",
        "write": "A4",
        "read": "B4",
    })
    five["SBC"]["GPIO"].update({"A4": 12, "B4": 13})
    parsed_five = VacuumConfig.model_validate(five)
    assert [pump.name for pump in parsed_five.pumps][-1] == "UHVacuumPump_3"

    two = json.loads(json.dumps(payload))
    two["VacuumPumps"] = two["VacuumPumps"][:2]
    with pytest.raises(ValueError, match="at least 3"):
        VacuumConfig.model_validate(two)


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


def test_vacuum_enable_flag_ignores_misspelled_key(tmp_path):
    config_path = tmp_path / "vacuum-toggle-typo.json"
    config_path.write_text(json.dumps({"Enable": False, "Enalble": True}))

    assert vacuum_config_enabled(config_path) is False


def test_vacuum_enable_flag_rejects_non_boolean_values(tmp_path):
    config_path = tmp_path / "vacuum-invalid-toggle.json"
    config_path.write_text(json.dumps({"Enable": "false"}))

    with pytest.raises(ValueError, match="must be true or false"):
        vacuum_config_enabled(config_path)


def test_simulated_vacuum_cascade_and_stop():
    async def scenario():
        controller, commands = simulated_controller()
        await controller.start()
        try:
            assert controller.status().pumps[0].name == MECHANICAL_PUMP
            assert controller.status().control_transport == "sbc-simulation"
            assert controller.status().pumps[0].power is True
            assert controller.status().pumps[0].port_a_value == pytest.approx(3.3)
            assert controller.status().pumps[0].border == "waiting"
            assert controller.status().pumps[0].value == pytest.approx(0.15)
            assert controller.status().pumps[0].port_b_value == 0
            assert controller.gpio.output_level("A0") is True
            await controller.poll_once()
            assert controller.status().pumps[0].value == pytest.approx(0.148)
            assert all(pump.value is None for pump in controller.status().pumps[1:])

            await controller.set_simulated_read("MechanicalVacuumPump", True)
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["MechanicalVacuumPump"].border == "ready"
            assert states["MechanicalVacuumPump"].port_b_value == pytest.approx(3.3)
            assert states["MechanicalVacuumPump"].value == states["MechanicalVacuumPump"].threshold
            assert states["TurboVacuumPump"].power is True
            assert states["TurboVacuumPump"].border == "waiting"

            await controller.set_simulated_read("MechanicalVacuumPump", False)
            mechanical = controller.status().pumps[0]
            assert mechanical.border == "waiting"
            assert mechanical.value is not None
            assert mechanical.port_b_value == 0
            assert mechanical.simulation_read is False
            await controller.set_simulated_read("MechanicalVacuumPump", True)

            await controller.set_simulated_read("TurboVacuumPump", True)
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["MechanicalVacuumPump"].ready is True
            assert states["TurboVacuumPump"].ready is True
            assert states["UHVacuumPump_1"].power is True
            assert states["UHVacuumPump_2"].power is True

            await controller.set_simulated_read("UHVacuumPump_1", True)
            await controller.set_simulated_read("UHVacuumPump_2", True)
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["UHVacuumPump_1"].value == states["UHVacuumPump_1"].threshold
            assert states["UHVacuumPump_2"].value == states["UHVacuumPump_2"].threshold
            assert states["UHVacuumPump_1"].port_b_value == pytest.approx(3.3)
            assert states["UHVacuumPump_2"].port_b_value == pytest.approx(3.3)
            assert states["UHVacuumPump_1"].ready is True
            assert states["UHVacuumPump_2"].ready is True
            assert controller.status().isVacuumSystemReady is True

            await controller.set_simulated_read("TurboVacuumPump", False)
            assert controller.status().pumps[1].power is False
            assert controller.status().pumps[0].ready is True
            await controller.set_simulated_read("UHVacuumPump_1", False)
            assert controller.status().pumps[2].power is False
            assert controller.status().pumps[0].ready is True
            await controller.set_simulated_read("UHVacuumPump_2", False)
            states = {pump.name: pump for pump in controller.status().pumps}
            assert states["MechanicalVacuumPump"].power is True
            assert states["MechanicalVacuumPump"].border == "waiting"
            assert states["MechanicalVacuumPump"].simulation_read is False
            assert states["MechanicalVacuumPump"].value == pytest.approx(0.15)
            assert states["MechanicalVacuumPump"].port_b_value == 0
            assert all(
                state.power is False
                and state.border == "off"
                and state.value is None
                and state.simulation_read is False
                for name, state in states.items()
                if name != MECHANICAL_PUMP
            )
            assert controller.status().cascade_stopped is True
            assert controller.status().isVacuumSystemReady is False
            assert controller.gpio.output_level("A0") is True
            assert (await controller.gpio.read_port_b())["B0"] == 0
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_simulated_read_control_is_read_only_for_hardware():
    async def scenario():
        config = make_config(simulate=False)
        device = SimulatedVacuumDevice(
            (pump.write for pump in config.pumps),
            (pump.read for pump in config.pumps),
        )
        controller = VacuumController(config, device=device)
        with pytest.raises(ValueError, match="read-only"):
            await controller.set_simulated_read("MechanicalVacuumPump", True)

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


def test_reacquire_resets_simulated_cascade_to_initial_state():
    async def scenario():
        controller, _commands = simulated_controller()
        await controller.start()
        await controller.set_simulated_read("MechanicalVacuumPump", True)
        await controller.set_simulated_read("TurboVacuumPump", True)
        await controller.set_simulated_read("UHVacuumPump_1", True)
        await controller.set_simulated_read("UHVacuumPump_2", True)
        await controller.close()

        await controller.start()
        try:
            states = {pump.name: pump for pump in controller.status().pumps}
            mechanical = states[MECHANICAL_PUMP]
            assert mechanical.power is True
            assert mechanical.border == "waiting"
            assert mechanical.value == pytest.approx(0.15)
            assert mechanical.port_b_value == 0
            assert mechanical.simulation_read is False
            assert all(
                state.power is False
                and state.border == "off"
                and state.value is None
                and state.simulation_read is False
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
            assert (await controller.gpio.read_port_b())["B0"] == 1
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


def test_simulation_maps_port_a_equipment_values_to_configured_gpio_voltage():
    async def scenario():
        controller, commands = simulated_controller()

        await controller.gpio.write("A0", True)
        await controller.gpio.write("A1", True)

        assert isinstance(controller.gpio, SimulatedVacuumDevice)
        assert isinstance(controller.gpio, VacuumDevice)
        assert controller.gpio.output_level("A0") is True
        assert controller.gpio.output_level("A1") is True

    asyncio.run(scenario())


def test_port_b_levels_are_reported_as_configured_pin_voltage():
    async def scenario():
        config = make_config(simulate=False)
        device = SimulatedVacuumDevice(
            (pump.write for pump in config.pumps),
            (pump.read for pump in config.pumps),
        )
        controller = VacuumController(config, device=device)

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
        config = make_config(simulate=False)
        device = SimulatedVacuumDevice(
            (pump.write for pump in config.pumps),
            (pump.read for pump in config.pumps),
        )
        controller = VacuumController(config, device=device)
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
