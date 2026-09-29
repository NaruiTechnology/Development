"""Pin what a dwell value means in the gateware.

The DwellTime docstring says the gateware "emits dwell_time + 1 cycles". An
end-to-end run measured exactly that: dwell_time D takes D + 1 ADC conversions
per pixel (1, 2, 3, 4, 8 conversions for D = 0, 1, 2, 3, 7).

Upstream OBI hides this in its GUI, which sends ``dwell - 1``. Nothing in the
local UI -> backend -> service path subtracts one (see
glasgow_service/tests/test_dwell_boundary.py), so a UI dwell of N really takes
(N + 1) conversions. These tests make that fact explicit: if the gateware or the
convention changes, they fail and the UI help/timing text must be revisited.
"""
import unittest

from amaranth import Signal
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.supersampler import Supersampler


class DwellSemanticsTest(unittest.TestCase):
    def conversions_for(self, dwell_time):
        dut = Supersampler()
        sim = Simulator(dut)
        sim.add_clock(1e-6)
        counted = []

        async def bench(ctx):
            ctx.set(dut.super_dac_stream.ready, 1)
            ctx.set(dut.dac_stream.payload.dwell_time, dwell_time)
            ctx.set(dut.dac_stream.valid, 1)
            await ctx.tick()
            ctx.set(dut.dac_stream.valid, 0)
            for _ in range(dwell_time + 20):
                if ctx.get(dut.super_dac_stream.valid):
                    counted.append(ctx.get(dut.super_dac_stream.payload.last))
                    if counted[-1]:
                        return
                await ctx.tick()

        sim.add_testbench(bench)
        sim.run()
        return len(counted), (counted[-1] if counted else None)

    def test_dwell_time_takes_one_more_conversion_than_its_value(self):
        for dwell_time in (0, 1, 2, 3, 7, 15):
            with self.subTest(dwell_time=dwell_time):
                count, last = self.conversions_for(dwell_time)
                self.assertEqual(count, dwell_time + 1)
                self.assertEqual(last, 1, "the final conversion of a pixel is flagged last")


if __name__ == "__main__":
    unittest.main()
