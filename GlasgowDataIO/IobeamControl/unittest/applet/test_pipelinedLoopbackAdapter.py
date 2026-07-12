import unittest

from amaranth import Module
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.pipelinedLoopbackAdapter import (
    PipelinedLoopbackAdapter,
)


class PipelinedLoopbackAdapterTest(unittest.TestCase):
    def test_samples_on_adc_oe_rising_edge(self):
        dut = PipelinedLoopbackAdapter(adc_latency=1)

        m = Module()
        m.submodules.dut = dut

        sim = Simulator(m)
        sim.add_clock(1e-6)

        observed = []

        async def bench(ctx):
            ctx.set(dut.bus.adc_oe, 0)
            ctx.set(dut.loopback_stream, 0x1234)
            await ctx.tick()
            observed.append(ctx.get(dut.bus.data_i))

            ctx.set(dut.loopback_stream, 0xABCD)
            ctx.set(dut.bus.adc_oe, 1)
            await ctx.tick()
            observed.append(ctx.get(dut.bus.data_i))

            ctx.set(dut.loopback_stream, 0x0FED)
            ctx.set(dut.bus.adc_oe, 0)
            await ctx.tick()
            observed.append(ctx.get(dut.bus.data_i))

        sim.add_testbench(bench)
        sim.run()

        self.assertEqual(observed, [0, 0xABCD, 0xABCD])
