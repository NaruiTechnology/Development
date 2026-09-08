import unittest

from amaranth import Module
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.busController import BusController


class BusControllerAdcCaptureTest(unittest.TestCase):
    def test_clocked_external_register_preserves_samples_during_stalls(self):
        # Independent board-side model: latch X/Y from the shared bus,
        # advance conversions on the physical clock edge, capture the ADC
        # register only on LE, and expose it only while OE is enabled.
        # adc_latency models the configured complete path (including DAC
        # and analog delay); it is not the ADC silicon latency alone.
        for half_period, settle in ((6, 2), (7, 3), (8, 4)):
            with self.subTest(half_period=half_period, settle=settle):
                latency = 8
                dut = BusController(adc_half_period=half_period,
                                    adc_latency=latency,
                                    adc_settle_cycles=settle)
                sim = Simulator(dut)
                sim.add_clock(1 / 48_000_000)

                async def bench(ctx):
                    count = 48
                    sent, expected, received = 0, [], []
                    pipeline = [0] * latency
                    x = y = register = 0
                    prev_clock = prev_le = 0
                    period = half_period * 2
                    for tick in range(period * 240):
                        # Long stalls force all pending conversions to drain
                        # into the skid buffer before new work is accepted.
                        ctx.set(dut.adc_stream.ready,
                                not (period * 15 <= tick < period * 40 or
                                     period * 55 <= tick < period * 80))
                        valid = sent < count and tick % (period * 5) >= period
                        ctx.set(dut.dac_stream.valid, valid)
                        ctx.set(dut.dac_stream.payload.dac_x_code, sent * 17 + 3)
                        ctx.set(dut.dac_stream.payload.dac_y_code, sent * 31 + 7)
                        ctx.set(dut.dac_stream.payload.last, sent % 3 == 2)

                        clock = ctx.get(dut.bus.adc_clk)
                        if prev_clock and not clock:
                            pipeline = [((x * 3) ^ y) & 0x3fff] + pipeline[:-1]
                        le = ctx.get(dut.bus.adc_le_clk)
                        if le and not prev_le:
                            register = pipeline[-1]
                        if ctx.get(dut.bus.dac_x_le_clk):
                            self.assertEqual(ctx.get(dut.bus.data_oe), 1)
                            x = ctx.get(dut.bus.data_o)
                        if ctx.get(dut.bus.dac_y_le_clk):
                            self.assertEqual(ctx.get(dut.bus.data_oe), 1)
                            y = ctx.get(dut.bus.data_o)
                        # A read outside the enabled window sees poison.
                        ctx.set(dut.bus.data_i, register if ctx.get(dut.bus.adc_oe)
                                and not ctx.get(dut.bus.data_oe) else 0x3fff)
                        if valid and ctx.get(dut.dac_stream.ready):
                            expected.append(((((sent * 17 + 3) * 3) ^
                                              (sent * 31 + 7)) & 0x3fff,
                                             int(sent % 3 == 2)))
                            sent += 1
                        if ctx.get(dut.adc_stream.valid) and ctx.get(dut.adc_stream.ready):
                            received.append((ctx.get(dut.adc_stream.payload.adc_code),
                                             ctx.get(dut.adc_stream.payload.last)))
                        prev_clock, prev_le = clock, le
                        await ctx.tick()
                    self.assertEqual(sent, count)
                    self.assertEqual(received, expected)

                sim.add_testbench(bench)
                sim.run()

    def test_one_bus_transaction_per_conversion_and_xy_setup(self):
        # Model the physical clock polarity in streamData.json: logical
        # falling edges are the converter/DAC rising edges. Unlike the
        # OE-triggered loopback, this observes the independent clock.
        for half_period, settle in ((6, 2), (7, 3), (8, 4)):
            with self.subTest(half_period=half_period, settle=settle):
                dut = BusController(adc_half_period=half_period,
                                    adc_latency=8, adc_settle_cycles=settle)
                sim = Simulator(dut)
                sim.add_clock(1 / 48_000_000)

                async def bench(ctx):
                    ctx.set(dut.adc_stream.ready, 1)
                    ctx.set(dut.dac_stream.valid, 1)
                    ctx.set(dut.dac_stream.payload.last, 1)
                    latch_ticks, read_ticks = [], []
                    previous_clock = 0
                    previous_owners = (0, 0)
                    x_written = y_written = False
                    conversions = 0
                    for tick in range(half_period * 2 * 24):
                        clock = ctx.get(dut.bus.adc_clk)
                        owners = (ctx.get(dut.bus.adc_oe),
                                  ctx.get(dut.bus.data_oe))
                        self.assertNotEqual(owners, (1, 1))
                        if owners == (1, 0):
                            self.assertNotEqual(previous_owners, (0, 1))
                        if owners == (0, 1):
                            self.assertNotEqual(previous_owners, (1, 0))
                        if ctx.get(dut.bus.adc_le_clk):
                            latch_ticks.append(tick)
                            # Allow a full FPGA cycle after conversion data
                            # changes before clocking the external register.
                            self.assertFalse(previous_clock and not clock)
                        if ctx.get(dut.dac_stream.ready):
                            read_ticks.append(tick)
                        if previous_clock and not clock:
                            conversions += 1
                            self.assertTrue(x_written and y_written,
                                            f"XY not ready at conversion {tick}")
                            x_written = y_written = False
                        x_written |= bool(ctx.get(dut.bus.dac_x_le_clk))
                        y_written |= bool(ctx.get(dut.bus.dac_y_le_clk))
                        previous_clock, previous_owners = clock, owners
                        await ctx.tick()
                    self.assertGreater(conversions, 10)
                    self.assertEqual(set(b - a for a, b in
                                         zip(latch_ticks, latch_ticks[1:])),
                                     {half_period * 2})
                    self.assertEqual(set(b - a for a, b in
                                         zip(read_ticks, read_ticks[1:])),
                                     {half_period * 2})

                sim.add_testbench(bench)
                sim.run()

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
