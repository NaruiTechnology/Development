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
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16,
        ]
        dut = FakeAdcSimulator(image_data=image_data, image_resolution=4)

        m = Module()
        m.submodules.dut = dut

        sim = Simulator(m)
        observed = []

        async def bench(ctx):
            ctx.set(dut.dac_x_code, 0)
            ctx.set(dut.dac_y_code, 0)
            observed.append(ctx.get(dut.loopback_value))

            ctx.set(dut.dac_x_code, 8192)
            ctx.set(dut.dac_y_code, 4096)
            observed.append(ctx.get(dut.loopback_value))

            ctx.set(dut.dac_x_code, 16383)
            ctx.set(dut.dac_y_code, 16383)
            observed.append(ctx.get(dut.loopback_value))

        sim.add_testbench(bench)
        sim.run()

        self.assertEqual(observed, [1 * 64, 7 * 64, 16 * 64])

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
