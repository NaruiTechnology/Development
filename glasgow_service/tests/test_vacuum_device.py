import asyncio
from pathlib import Path

import pytest

from glasgow_service.vacuum_device import (
    RaspberryPiGPIODevice,
    SimulatedVacuumDevice,
    VacuumDevice,
)


class FakeGpioLine:
    def __init__(self, value=False):
        self.value = value

    def off(self):
        self.value = False


def test_raspberry_pi_device_maps_bcm_lines_and_reads_physical_state():
    created = {}

    def factory(kind, bcm, **kwargs):
        line = FakeGpioLine(kwargs.get("initial_value", False))
        created[(kind, bcm)] = line
        return line

    async def scenario():
        device = RaspberryPiGPIODevice(
            {"A0": 17, "A1": 22},
            {"B0": 27, "B1": 23},
            initial_outputs={"A0": True},
            gpio_factory=factory,
        )
        assert device.output_level("A0") is True
        created[("input", 27)].value = True
        assert await device.read_port_b() == {"B0": 1, "B1": 0}
        await device.write("A1", True)
        assert created[("output", 22)].value is True
        # Mutating the fake driver proves output_level reads hardware state.
        created[("output", 22)].value = False
        assert device.output_level("A1") is False
        await device.close()
        assert all(not line.value for (kind, _), line in created.items() if kind == "output")

    asyncio.run(scenario())


def test_raspberry_pi_device_rejects_duplicate_bcm_assignments():
    with pytest.raises(ValueError, match="unique"):
        RaspberryPiGPIODevice(
            {"A0": 17},
            {"B0": 17},
            gpio_factory=lambda *_args, **_kwargs: FakeGpioLine(),
        )


def test_simulated_device_is_deterministic_and_satisfies_protocol():
    async def scenario():
        device = SimulatedVacuumDevice(["A0", "A1"], ["B0", "B1"])
        assert isinstance(device, VacuumDevice)
        await device.write("A0", True)
        await device.write_comparator("B0", True)
        assert device.output_level("A0") is True
        assert device.output_level("A1") is False
        assert await device.read_port_b() == {"B0": 1, "B1": 0}
        assert device.history == [
            ("write", "A0", True),
            ("write_comparator", "B0", True),
            ("read", None, None),
        ]

    asyncio.run(scenario())


def test_simulated_device_supports_disconnect_and_one_shot_faults():
    async def scenario():
        device = SimulatedVacuumDevice(["A0"], ["B0"])
        device.disconnect()
        with pytest.raises(ConnectionError, match="disconnected"):
            await device.read_port_b()

        device.reconnect()
        device.fail_next("read", RuntimeError("injected read fault"))
        with pytest.raises(RuntimeError, match="injected read fault"):
            await device.read_port_b()
        assert await device.read_port_b() == {"B0": 0}

        await device.close()
        with pytest.raises(RuntimeError, match="closed"):
            await device.write("A0", True)
        device.reconnect()
        await device.write("A0", True)
        assert device.output_level("A0") is True

    asyncio.run(scenario())


def test_controller_accepts_injected_hardware_neutral_device():
    from glasgow_service.vacuum import VacuumController, load_vacuum_config

    async def scenario():
        config_path = (
            Path(__file__).parents[2]
            / "GlasgowDataIO"
            / "Json"
            / "vacuumSystem.json"
        )
        config = load_vacuum_config(config_path).model_copy(
            deep=True,
            update={"enabled": True, "simulate": True, "error_range": 0.005},
        )
        device = SimulatedVacuumDevice(
            [pump.write for pump in config.pumps],
            [pump.read for pump in config.pumps],
        )
        controller = VacuumController(config, device=device)
        await controller.start()
        try:
            assert controller.gpio is device
            assert device.output_level("A0") is True
            assert device.output_level("A1") is False
        finally:
            await controller.close()

    asyncio.run(scenario())
