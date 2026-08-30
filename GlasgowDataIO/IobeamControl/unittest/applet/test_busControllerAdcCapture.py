import unittest

from amaranth import Module
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.busController import BusController


class BusControllerAdcCaptureTest(unittest.TestCase):
    def test_registers_sample_before_shared_bus_turnaround(self):
        dut = BusController(
            adc_half_period=6,
            adc_latency=1,
            adc_settle_cycles=2,
        )

        m = Module()
        m.submodules.dut = dut

        sim = Simulator(m)
        sim.add_clock(1e-6)

        async def bench(ctx):
            ctx.set(dut.adc_stream.ready, 1)
            ctx.set(dut.dac_stream.valid, 0)
            ctx.set(dut.bus.data_i, 0x3456)
            observed = []
            for _ in range(24):
                observed.append((
                    ctx.get(dut.bus.adc_oe),
                    ctx.get(dut.bus.data_oe),
                ))
                await ctx.tick()

            self.assertEqual(ctx.get(dut.adc_sample), 0x3456)
            self.assertNotIn((1, 1), observed)
            self.assertTrue(any(
                observed[index:index + 3] == [(1, 0), (0, 0), (0, 1)]
                for index in range(len(observed) - 2)
            ), observed)

        sim.add_testbench(bench)
        sim.run()


if __name__ == "__main__":
    unittest.main()
