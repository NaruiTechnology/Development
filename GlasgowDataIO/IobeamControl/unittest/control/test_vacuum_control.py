import asyncio
import logging
from types import SimpleNamespace

from amaranth import Fragment, Signal
from amaranth.lib import io

from IobeamControl.sysControl.vacuum.vacuumControlInterface import VacuumControlInterface
from IobeamControl.sysControl.vacuum.vacuumControlLauncher import VacuumControlLauncher
from IobeamControl.sysControl.vacuum.vacuumControlSubtarget import VacuumControlSubtarget


class MockLower:
    def __init__(self):
        self.writes = []
        self.read_data = bytes([VacuumControlSubtarget.STATUS_TAG, 0x05, 0x0A])

    async def write(self, data):
        self.writes.append(bytes(data))

    async def flush(self):
        pass

    async def read(self, length):
        return self.read_data[:length]


def test_vacuum_interface_encodes_atomic_masks_and_reads_status():
    async def scenario():
        lower = MockLower()
        interface = VacuumControlInterface(lower, logging.getLogger("test"))

        await interface.configure_target(0, 1.0e-1, 0.005)
        await interface.set_output(0, True)
        await interface.set_output(2, True)
        outputs, inputs = await interface.read_status()

        assert lower.writes == [
            bytes([0x03, 0x00]) + (100_000_000).to_bytes(4, "little") + (500_000).to_bytes(4, "little"),
            bytes([0x01, 0x01]),
            bytes([0x01, 0x05]),
            bytes([0x02]),
        ]
        assert outputs == 0x05
        assert inputs == 0x0A

    asyncio.run(scenario())


def test_vacuum_interface_rejects_bad_status_tag():
    async def scenario():
        lower = MockLower()
        lower.read_data = bytes([0x00, 0x00, 0x00])
        interface = VacuumControlInterface(lower)
        try:
            await interface.read_status()
        except RuntimeError as exc:
            assert "invalid status tag" in str(exc)
        else:
            raise AssertionError("invalid status tag was accepted")

    asyncio.run(scenario())


def test_vacuum_subtarget_elaborates_with_four_channels():
    ports = SimpleNamespace(
        port_a=io.SimulationPort("o", 4, name="vacuum_a"),
        port_b=io.SimulationPort("i", 4, name="vacuum_b"),
    )
    out_fifo = SimpleNamespace(r_en=Signal(), r_rdy=Signal(), r_data=Signal(8))
    in_fifo = SimpleNamespace(w_en=Signal(), w_rdy=Signal(), w_data=Signal(8))
    target = VacuumControlSubtarget(ports, out_fifo, in_fifo, 4)

    Fragment.get(target, platform=None)


def test_vacuum_launcher_maps_port_names_to_direct_mux_indices():
    assert VacuumControlLauncher._pin_argument("A0").number == 0
    assert VacuumControlLauncher._pin_argument("A7").number == 7
    assert VacuumControlLauncher._pin_argument("B0").number == 8
    assert VacuumControlLauncher._pin_argument("B3").number == 11
