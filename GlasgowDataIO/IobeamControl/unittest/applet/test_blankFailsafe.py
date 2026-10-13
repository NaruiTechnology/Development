"""Fail-safe blanking: the ion beam is never left unblanked on one spot.

Production wired the scan board's blank straight to the column with the
instrument's BLANK unplugged. Then nothing but this gateware blanks the
beam, so:

* released (no external control: before, between and after scans) -> blanked;
* takeover: blanked until the first pixel's inline unblank (the host sends
  Blank(on) before ExternalCtrl(on), see macros);
* hand-back: blanked from the moment the relays start to drop;
* holding control but no new pixel for stall_blank_cycles (host crashed,
  service killed, USB stalled) -> blanked until the next pixel.
"""
from types import SimpleNamespace
import unittest

from amaranth import Signal
from amaranth.lib import io
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget
from GlasgowDataIO.IobeamControl.scanConfiguration import BEAM_PORTS
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.gateware.ports import PortGroup
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    ExternalCtrlCommand, BeamSelectCommand, BlankCommand, VectorPixelCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import BeamType

SWITCH = 40   # relay switch delay, cycles
STALL = 300   # stall watchdog, cycles


def run(bench, **kwargs):
    pads = {name: io.SimulationPort("o", 2) for name in BEAM_PORTS}
    tx = SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
    rx = SimpleNamespace(w_data=Signal(8), w_rdy=Signal(init=1), w_en=Signal())
    dut = IobeamDataSubtarget(ports=PortGroup(**pads), out_fifo=tx, in_fifo=rx,
                              loopback=True, ext_switch_delay=SWITCH, **kwargs)
    sim = Simulator(dut)
    sim.add_clock(1 / 48e6)

    async def tb(ctx):
        def ion_blanked():
            return ctx.get(pads["ibeam_blank"].o) == 3

        def relay_released():
            return ctx.get(pads["ibeam_blank_enable"].o) == 0

        async def send(command, watch=None):
            for byte in bytes(command):
                ctx.set(tx.r_data, byte)
                ctx.set(tx.r_rdy, 1)
                for _ in range(500):
                    ready = ctx.get(tx.r_en)
                    if watch is not None:
                        watch.append(ion_blanked())
                    await ctx.tick()
                    if ready:
                        break
                else:
                    raise AssertionError("command input stalled")
            ctx.set(tx.r_rdy, 0)

        async def idle(n, watch=None):
            for _ in range(n):
                if watch is not None:
                    watch.append(ion_blanked())
                await ctx.tick()

        await bench(ctx, send, idle, ion_blanked, relay_released)

    sim.add_testbench(tb)
    sim.run()


async def take_over(send, idle, watch=None):
    """The host's takeover sequence (macros/raster.py, macros/vector.py)."""
    await send(BeamSelectCommand(BeamType.Ion), watch)
    await send(BlankCommand(True), watch)
    await send(ExternalCtrlCommand(True), watch)
    await idle(2 * SWITCH, watch)


class BlankFailsafeTest(unittest.TestCase):
    def test_blanked_from_reset_and_through_the_takeover(self):
        seen = []

        async def bench(ctx, send, idle, ion_blanked, relay_released):
            await idle(5, seen)
            await take_over(send, idle, seen)

        run(bench, stall_blank_cycles=STALL)
        self.assertTrue(seen and all(seen), "beam unblanked before the first pixel")

    def test_blanked_from_the_moment_control_is_released(self):
        trace = []

        async def bench(ctx, send, idle, ion_blanked, relay_released):
            await take_over(send, idle)
            await send(BlankCommand(False, inline=True))
            for i in range(5):
                await send(VectorPixelCommand(x_coord=100 * i, y_coord=100 * i, dwell_time=4))
            # Host hand-back (transfer/abc.py): Blank(on), ExternalCtrl(off),
            # queued right behind the last pixels.
            await send(BlankCommand(True))
            await send(ExternalCtrlCommand(False))
            for _ in range(6 * SWITCH):
                trace.append((relay_released(), ion_blanked()))
                await idle(1)

        run(bench, stall_blank_cycles=STALL)
        released_at = next(i for i, (released, _) in enumerate(trace) if released)
        self.assertTrue(all(blanked for _, blanked in trace[released_at:]),
                        "beam on after the relay started to release")
        self.assertTrue(trace[-1][1], "beam not blanked once fully released")

    def test_stalled_scan_blanks_and_resumes(self):
        log = {}

        async def bench(ctx, send, idle, ion_blanked, relay_released):
            await take_over(send, idle)
            await send(BlankCommand(False, inline=True))
            for i in range(3):
                await send(VectorPixelCommand(x_coord=10 * i, y_coord=10 * i, dwell_time=4))
            await idle(40)
            log["scanning"] = ion_blanked()
            await idle(STALL + 20)                 # host stops sending
            log["stalled"] = ion_blanked()
            await send(VectorPixelCommand(x_coord=500, y_coord=500, dwell_time=4))
            await idle(20)
            log["resumed"] = ion_blanked()

        run(bench, stall_blank_cycles=STALL)
        self.assertEqual(log, {"scanning": False, "stalled": True, "resumed": False})

    def test_short_gaps_do_not_blank(self):
        seen = []

        async def bench(ctx, send, idle, ion_blanked, relay_released):
            await take_over(send, idle)
            await send(BlankCommand(False, inline=True))
            await send(VectorPixelCommand(x_coord=0, y_coord=0, dwell_time=4))
            await idle(40)
            for i in range(5):
                await idle(STALL // 2, seen)       # host gap under the limit
                await send(VectorPixelCommand(x_coord=10 * i, y_coord=0, dwell_time=4), seen)

        run(bench, stall_blank_cycles=STALL)
        self.assertFalse(any(seen), "watchdog blanked during a normal host gap")

    def test_watchdog_off_keeps_upstream_behaviour(self):
        log = {}

        async def bench(ctx, send, idle, ion_blanked, relay_released):
            await take_over(send, idle)
            await send(BlankCommand(False, inline=True))
            await send(VectorPixelCommand(x_coord=0, y_coord=0, dwell_time=4))
            await idle(STALL * 2)
            log["stalled"] = ion_blanked()

        run(bench, stall_blank_cycles=0)
        self.assertEqual(log, {"stalled": False})


if __name__ == "__main__":
    unittest.main()
