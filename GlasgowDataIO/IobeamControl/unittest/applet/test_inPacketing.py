"""IN-endpoint packetisation of a raster stream (DAC staircase regression).

The FX2 crossbar commits an incomplete IN packet whenever `flush` is high and
the FPGA-side FIFO is empty.  With Glasgow's default auto_flush=True (flush
tied high) a streaming scan produces a flood of tiny packets; each one also
ends the host's 16 KB bulk IN transfer, throttling the scan to one host
round trip per FIFO-full and stalling the beam (staircase on the X DAC).
The subtarget must keep packets full-size (512 B) while streaming and still
flush the tail.
"""
from collections import Counter, deque
from types import SimpleNamespace
import unittest

from amaranth import Signal
from amaranth.lib import io
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import (
    IobeamDataSubtarget, IN_FLUSH_IDLE_CYCLES)
from GlasgowDataIO.IobeamControl.scanConfiguration import BEAM_PORTS
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.gateware.ports import PortGroup
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    ExternalCtrlCommand, BeamSelectCommand, BlankCommand, SynchronizeCommand,
    RasterRegionCommand, RasterPixelRunCommand, FlushCommand)
from GlasgowDataIO.IobeamControl.commands.structs import (
    BeamType, DACCodeRange, OutputMode)

PACKET = 512
FIFO_DEPTH = 2048
PIXELS = 48 * 48          # 4608 B of SixteenBit samples = 9 full packets


def run_scan(force_flush_high):
    """Returns the list of IN packet sizes the FX2 model commits."""
    pads = {name: io.SimulationPort("o", 2, invert=(True, False)
                                   if name == "ibeam_blank" else False)
            for name in BEAM_PORTS}
    tx = SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
    rx = SimpleNamespace(w_data=Signal(8), w_rdy=Signal(), w_en=Signal(),
                         flush=Signal(init=1))
    dut = IobeamDataSubtarget(ports=PortGroup(**pads), out_fifo=tx, in_fifo=rx,
                              loopback=True, ext_switch_delay=4)
    xr = DACCodeRange(0, 48, 256 * 8)
    yr = DACCodeRange(0, 48, 256 * 8)
    stream = b"".join(bytes(c) for c in (
        BeamSelectCommand(BeamType.Ion), ExternalCtrlCommand(True),
        BlankCommand(False, inline=True),
        SynchronizeCommand(cookie=123, raster=True, output=OutputMode.SixteenBit),
        RasterRegionCommand(x_range=xr, y_range=yr),
        RasterPixelRunCommand(dwell_time=2, length=PIXELS - 1),
        FlushCommand()))
    packets = []
    received = bytearray()

    sim = Simulator(dut)
    sim.add_clock(1 / 48e6)

    async def bench(ctx):
        fifo = deque()
        queued = 0
        pos = 0
        idle_ticks = 0
        for _ in range(400_000):
            # host -> parser, one byte at a time
            if pos < len(stream):
                ctx.set(tx.r_data, stream[pos]); ctx.set(tx.r_rdy, 1)
            else:
                ctx.set(tx.r_rdy, 0)
            ctx.set(rx.w_rdy, len(fifo) < FIFO_DEPTH)
            w_en = ctx.get(rx.w_en) and len(fifo) < FIFO_DEPTH
            r_en = ctx.get(tx.r_en) and pos < len(stream)
            flush = 1 if force_flush_high else ctx.get(rx.flush)
            w_data = ctx.get(rx.w_data)
            # FX2 side: moves one byte per cycle out of the FPGA FIFO
            if fifo:
                received.append(fifo.popleft()); queued += 1
                if queued == PACKET:
                    packets.append(queued); queued = 0
            elif flush and queued:
                packets.append(queued); queued = 0
            if w_en:
                fifo.append(w_data)
            if r_en:
                pos += 1
            await ctx.tick()
            if not fifo and pos >= len(stream) and queued == 0 and packets:
                idle_ticks += 1
                if idle_ticks > 3 * IN_FLUSH_IDLE_CYCLES:
                    break
            else:
                idle_ticks = 0
        if queued:
            packets.append(queued)

    sim.add_testbench(bench)
    sim.run()
    return packets, len(received)


class InPacketingTest(unittest.TestCase):
    def test_streaming_uses_full_packets_and_tail_is_flushed(self):
        packets, nbytes = run_scan(force_flush_high=False)
        # sync reply (4) + samples (2/pixel) + the last flush/tail
        self.assertGreaterEqual(nbytes, 2 * PIXELS)
        self.assertEqual(sum(packets), nbytes)          # nothing stuck in the FX2
        # [sync reply] + full 512 B packets for the whole streaming body +
        # the tail (the last pixels leave the pipeline one by one; the real
        # driver pushes them out with its drain padding).
        self.assertEqual(packets[0], 4, packets)                  # FFFF + cookie
        self.assertEqual(packets[1:9], [PACKET] * 8, packets)     # streaming body
        self.assertLessEqual(len(packets), 1 + 8 + 5, packets)    # no flood

    def test_default_auto_flush_floods_tiny_packets(self):
        # Documents the failure mode the fix removes.
        packets, _ = run_scan(force_flush_high=True)
        self.assertGreater(len([p for p in packets if p < 16]), 500)


if __name__ == "__main__":
    unittest.main()
