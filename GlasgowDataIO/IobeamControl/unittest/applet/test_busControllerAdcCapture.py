import unittest

from amaranth import Module
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.busController import BusController


class BusControllerAdcCaptureTest(unittest.TestCase):
    def test_registers_sample_before_shared_bus_turnaround(self):
        dut = BusController(
            adc_half_period=4,
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

            # Wait for ADC_Wait to assert the active-high internal enable.
            for _ in range(16):
                if ctx.get(dut.bus.adc_oe):
                    break
                await ctx.tick()
            else:
                self.fail("ADC read window did not start")

            self.assertEqual(ctx.get(dut.bus.adc_le_clk), 1)
            self.assertEqual(ctx.get(dut.bus.data_oe), 0)

            # First complete settling cycle.
            ctx.set(dut.bus.data_i, 0x1111)
            await ctx.tick()
            self.assertEqual(ctx.get(dut.bus.adc_oe), 1)
            self.assertEqual(ctx.get(dut.bus.adc_le_clk), 0)

            # Second complete settling cycle; ADC_Capture follows it.
            ctx.set(dut.bus.data_i, 0x2222)
            await ctx.tick()
            self.assertEqual(ctx.get(dut.bus.adc_oe), 1)

            # The capture register samples this value on the next edge.
            ctx.set(dut.bus.data_i, 0x3456)
            await ctx.tick()
            self.assertEqual(ctx.get(dut.adc_sample), 0x3456)
            self.assertEqual(ctx.get(dut.bus.adc_oe), 1)
            self.assertEqual(ctx.get(dut.bus.data_oe), 0)

            # Changing the external bus during ADC_Read cannot alter the
            # registered sample. The following state releases the ADC side
            # before enabling the FPGA outputs for the X DAC write.
            ctx.set(dut.bus.data_i, 0x3FFF)
            await ctx.tick()
            self.assertEqual(ctx.get(dut.adc_sample), 0x3456)
            self.assertEqual(ctx.get(dut.bus.adc_oe), 0)
            self.assertEqual(ctx.get(dut.bus.data_oe), 1)

        sim.add_testbench(bench)
        sim.run()


if __name__ == "__main__":
    unittest.main()
