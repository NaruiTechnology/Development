import unittest

from amaranth import Module
from amaranth.lib import wiring
from amaranth.lib.wiring import flipped
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.busController import BusController
from GlasgowDataIO.IobeamControl.applet.fakeAdcSimulator import FakeAdcSimulator
from GlasgowDataIO.IobeamControl.applet.pipelinedLoopbackAdapter import (
    PipelinedLoopbackAdapter,
)


class FakeAdcLoopbackTimingTest(unittest.TestCase):
    def test_fake_adc_samples_bus_controller_latched_dac_codes(self):
        adc_latency = 1
        bus = BusController(adc_half_period=3, adc_latency=adc_latency)
        fake = FakeAdcSimulator(
            image_data=[
                10, 20, 30, 40,
                50, 60, 70, 80,
                90, 100, 110, 120,
                130, 140, 150, 160,
            ],
            image_resolution=4,
        )
        loopback = PipelinedLoopbackAdapter(adc_latency=adc_latency)

        m = Module()
        m.submodules.bus = bus
        m.submodules.fake = fake
        m.submodules.loopback = loopback

        wiring.connect(m, bus.bus, flipped(loopback.bus))
        m.d.comb += [
            fake.dac_x_code.eq(bus.dac_x_code_transformed),
            fake.dac_y_code.eq(bus.dac_y_code_transformed),
            loopback.loopback_stream.eq(fake.loopback_value),
        ]

        sim = Simulator(m)
        sim.add_clock(1e-6)

        samples = [
            (0, 0),
            (4096, 0),
            (8192, 0),
            (12288, 0),
        ]
        observed = []

        async def bench(ctx):
            ctx.set(bus.adc_stream.ready, 1)
            ctx.set(bus.dac_stream.valid, 0)

            sent = 0
            for _ in range(160):
                if sent < len(samples):
                    x_code, y_code = samples[sent]
                    ctx.set(bus.dac_stream.payload.dac_x_code, x_code)
                    ctx.set(bus.dac_stream.payload.dac_y_code, y_code)
                    ctx.set(bus.dac_stream.payload.blank, 0)
                    ctx.set(bus.dac_stream.payload.delay, 0)
                    ctx.set(bus.dac_stream.payload.last, 1)
                    ctx.set(bus.dac_stream.valid, 1)
                else:
                    ctx.set(bus.dac_stream.valid, 0)

                ready = ctx.get(bus.dac_stream.ready)
                valid = ctx.get(bus.dac_stream.valid)
                await ctx.tick()

                if valid and ready:
                    sent += 1

                if ctx.get(bus.adc_stream.valid):
                    observed.append(ctx.get(bus.adc_stream.payload.adc_code))
                    if len(observed) == len(samples):
                        break

        sim.add_testbench(bench)
        sim.run()

        self.assertEqual(observed, [10, 20, 30, 40])
