"""Command-to-pad checks for OBI beam blanking and switch sequencing."""
from types import SimpleNamespace
import unittest

from amaranth import Fragment, Signal
from amaranth.lib import io
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget
from GlasgowDataIO.IobeamControl.scanConfiguration import BEAM_PORTS
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.gateware.ports import PortGroup
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    ExternalCtrlCommand, BeamSelectCommand, BlankCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import BeamType


class BeamPinControlTest(unittest.TestCase):
    def test_power_good_status_is_synchronized_and_marks_configured_input(self):
        pg = io.SimulationPort("i", 1)

        class Platform:
            def add_resources(self, resources):
                pass

            def request(self, name, *, dir):
                if name == "led":
                    return io.SimulationPort("o", 1)
                return SimpleNamespace(power_good=pg)

        status = Signal(8)
        dut = IobeamDataSubtarget(
            ports=PortGroup(), loopback=True, power_good_status=status,
            pin_config={"control": {"subsignals": [
                {"name": "power_good", "pin": "K1", "direction": "i"}]}},
            out_fifo=SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal()),
            in_fifo=SimpleNamespace(w_data=Signal(8), w_rdy=Signal(), w_en=Signal()))
        sim = Simulator(Fragment.get(dut, Platform()))
        sim.add_clock(1/48e6)

        async def bench(ctx):
            self.assertEqual(ctx.get(status), 2)
            for level in (1, 0, 1):
                ctx.set(pg.i, level)
                for _ in range(3):
                    await ctx.tick()
                self.assertEqual(ctx.get(status), 2 | level)

        sim.add_testbench(bench)
        sim.run()

    def test_beam_selection_blanking_inversion_and_disable_delay(self):
        pads = {name: io.SimulationPort("o", 2, invert=(True, False)
                                       if name == "ibeam_blank" else False)
                for name in BEAM_PORTS}
        tx = SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
        rx = SimpleNamespace(w_data=Signal(8), w_rdy=Signal(init=1), w_en=Signal())
        dut = IobeamDataSubtarget(ports=PortGroup(**pads), out_fifo=tx,
                                 in_fifo=rx, loopback=True, ext_switch_delay=8)
        sim = Simulator(dut)
        sim.add_clock(1/48e6)

        async def bench(ctx):
            def value(name):
                raw = ctx.get(pads[name].o)
                return raw ^ (1 if name == "ibeam_blank" else 0)

            def check_blank(electron, ion):
                self.assertEqual(value("ebeam_blank"), 3 if electron else 0)
                self.assertEqual(value("ibeam_blank"), 3 if ion else 0)

            async def send(command, settle=100):
                for byte in bytes(command):
                    ctx.set(tx.r_data, byte)
                    ctx.set(tx.r_rdy, 1)
                    for _ in range(100):
                        ready = ctx.get(tx.r_en)
                        await ctx.tick()
                        if ready:
                            break
                    else:
                        self.fail("command input stalled")
                ctx.set(tx.r_rdy, 0)
                for _ in range(settle):
                    await ctx.tick()

            await ctx.tick()
            self.assertEqual(value("ebeam_scan_enable"), 3)
            self.assertEqual(value("ibeam_scan_enable"), 0)
            check_blank(False, False)
            await send(ExternalCtrlCommand(True))
            self.assertEqual(value("ibeam_scan_enable"), 3)
            check_blank(True, True)  # NoBeam
            for beam in (BeamType.Electron, BeamType.Ion):
                await send(BeamSelectCommand(beam))
                await send(BlankCommand(False))
                check_blank(beam != BeamType.Electron, beam != BeamType.Ion)
                await send(BlankCommand(True))
                check_blank(True, True)
            await send(ExternalCtrlCommand(False), settle=0)
            delayed = 0
            for _ in range(100):
                if value("ibeam_scan_enable") == 0 and value("ibeam_blank") == 3:
                    delayed += 1
                await ctx.tick()
            self.assertGreaterEqual(delayed, 8)
            check_blank(False, False)
            self.assertEqual(value("ebeam_scan_enable"), 3)
            self.assertEqual(value("ibeam_scan_enable"), 0)

        sim.add_testbench(bench)
        sim.run()
