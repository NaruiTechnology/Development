import asyncio
from pathlib import Path

import pytest

from glasgow_service.vacuum_device import SimulatedVacuumDevice, VacuumDevice


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

