"""Protocol and arithmetic edge cases identified in the full OBI review."""
from types import SimpleNamespace
import unittest

from amaranth import Signal
from amaranth.sim import Simulator
from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget, _ZERO_FILL
from GlasgowDataIO.IobeamControl.applet.supersampler import Supersampler
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    SynchronizeCommand, VectorPixelCommand, RasterRegionCommand, RasterPixelFillCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode, DACCodeRange


class LowLevelReviewTest(unittest.TestCase):
    def run_commands(self, commands, expected):
        tx = SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
        rx = SimpleNamespace(w_data=Signal(8), w_rdy=Signal(), w_en=Signal())
        dut = IobeamDataSubtarget(ports=SimpleNamespace(), out_fifo=tx, in_fifo=rx,
                                 loopback=True, sim_image=_ZERO_FILL)
        sim = Simulator(dut)
        sim.add_clock(1/48e6)
        data = b"".join(bytes(command) for command in commands)

        async def bench(ctx):
            sent, received = 0, bytearray()
            for tick in range(6000):
                ctx.set(tx.r_rdy, sent < len(data) and tick % 5 != 0)
                ctx.set(tx.r_data, data[sent] if sent < len(data) else 0)
                ctx.set(rx.w_rdy, tick % 17 >= 8)
                if ctx.get(tx.r_rdy) and ctx.get(tx.r_en):
                    sent += 1
                if ctx.get(rx.w_rdy) and ctx.get(rx.w_en):
                    received.append(ctx.get(rx.w_data))
                await ctx.tick()
            self.assertEqual(sent, len(data))
            self.assertEqual(received, expected)

        sim.add_testbench(bench)
        sim.run()

    def test_sync_is_four_bytes_in_every_output_mode_and_drains_old_pixels(self):
        commands = []
        expected = bytearray()
        for cookie, mode in enumerate((OutputMode.SixteenBit, OutputMode.EightBit,
                                       OutputMode.NoOutput, OutputMode.SixteenBit), 1):
            commands.append(SynchronizeCommand(cookie=cookie, output=mode, raster=False))
            expected += b"\xff\xff" + cookie.to_bytes(2, "big")
            commands += [VectorPixelCommand(1, 2, 0) for _ in range(3)]
            expected += bytes(3 * {OutputMode.SixteenBit: 2, OutputMode.EightBit: 1,
                                   OutputMode.NoOutput: 0}[mode])
        self.run_commands(commands, expected)

    def test_raster_fill_retires_exact_roi_before_synchronization(self):
        self.run_commands([
            SynchronizeCommand(cookie=1, output=OutputMode.SixteenBit, raster=True),
            RasterRegionCommand(DACCodeRange(0, 2, 256), DACCodeRange(0, 2, 256)),
            RasterPixelFillCommand(dwell_time=0),
            SynchronizeCommand(cookie=2, output=OutputMode.SixteenBit, raster=True),
        ], b"\xff\xff\x00\x01" + bytes(8) + b"\xff\xff\x00\x02")

    def test_full16_average_and_maximum_dwell_count(self):
        dut = Supersampler()
        sim = Simulator(dut)
        sim.add_clock(1/48e6)

        async def bench(ctx):
            ctx.set(dut.adc_stream.ready, 0)
            for values, expected in (([2, 4, 100], 3), ([65535] * 32768, 65535),
                                     ([65535] * 65536, 65535)):
                for index, value in enumerate(values):
                    ctx.set(dut.super_adc_stream.valid, 1)
                    ctx.set(dut.super_adc_stream.payload.adc_code, value)
                    ctx.set(dut.super_adc_stream.payload.last, index == len(values)-1)
                    self.assertEqual(ctx.get(dut.super_adc_stream.ready), 1)
                    await ctx.tick()
                ctx.set(dut.super_adc_stream.valid, 0)
                for _ in range(3):
                    self.assertEqual(ctx.get(dut.adc_stream.valid), 1)
                    self.assertEqual(ctx.get(dut.adc_stream.payload.adc_code), expected)
                    await ctx.tick()
                ctx.set(dut.adc_stream.ready, 1)
                await ctx.tick()
                ctx.set(dut.adc_stream.ready, 0)

        sim.add_testbench(bench)
        sim.run()
