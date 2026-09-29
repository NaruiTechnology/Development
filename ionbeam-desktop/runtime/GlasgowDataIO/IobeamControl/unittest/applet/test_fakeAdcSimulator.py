import gc
import unittest
import warnings

from amaranth import Module
from amaranth.hdl import UnusedElaboratable
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.fakeAdcSimulator import FakeAdcSimulator


class FakeAdcSimulatorTest(unittest.TestCase):
    def test_maps_dac_codes_to_row_major_image_values(self):
        image_data = [
            0x0001, 0x0102, 0x0203, 0x0304,
            0x1005, 0x1106, 0x1207, 0x1308,
            0x2009, 0x210A, 0x220B, 0x230C,
            0x300D, 0x310E, 0x320F, 0xFFFF,
        ]
        dut = FakeAdcSimulator(image_data=image_data, image_resolution=4)

        m = Module()
        m.submodules.dut = dut

        sim = Simulator(m)
        sim.add_clock(1e-6)
        observed = []

        async def bench(ctx):
            ctx.set(dut.dac_x_code, 0)
            ctx.set(dut.dac_y_code, 0)
            await ctx.tick()
            observed.append(ctx.get(dut.loopback_value))

            ctx.set(dut.dac_x_code, 8192)
            ctx.set(dut.dac_y_code, 4096)
            await ctx.tick()
            observed.append(ctx.get(dut.loopback_value))

            ctx.set(dut.dac_x_code, 16383)
            ctx.set(dut.dac_y_code, 16383)
            await ctx.tick()
            observed.append(ctx.get(dut.loopback_value))

        sim.add_testbench(bench)
        sim.run()

        self.assertEqual(observed, [0x0001, 0x1207, 0x3FFF])

    def test_rejects_resolution_larger_than_dac_address_space(self):
        was_silenced = UnusedElaboratable._MustUse__silence
        UnusedElaboratable._MustUse__silence = True
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UnusedElaboratable)
                with self.assertRaisesRegex(ValueError, "image_resolution"):
                    FakeAdcSimulator(
                        image_data=[],
                        image_resolution=1 << 15,
                    )
            gc.collect()
        finally:
            UnusedElaboratable._MustUse__silence = was_silenced
