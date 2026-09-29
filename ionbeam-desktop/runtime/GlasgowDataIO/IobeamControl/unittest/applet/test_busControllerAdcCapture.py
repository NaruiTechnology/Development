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
        for half_period, settle, width in ((4, 1, 1),):
            with self.subTest(half_period=half_period, settle=settle, width=width):
                latency = 8
                dut = BusController(adc_half_period=half_period,
                                    adc_latency=latency,
                                    adc_settle_cycles=settle, adc_latch_cycles=width,
                                    bus_turnaround_cycles=1)
                sim = Simulator(dut)
                sim.add_clock(1 / 48_000_000)

                async def bench(ctx):
                    count = 48
                    sent, expected, received = 0, [], []
                    # OBI accepts a DAC request before the next physical
                    # conversion edge. Its 8-cycle tag delay includes that
                    # request-to-conversion interval: seven board stages here.
                    pipeline = [0] * (latency - 1)
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


    def test_safe_eight_cycle_pin_sequence_has_dead_time(self):
        dut = BusController(adc_half_period=4, adc_latency=8, bus_turnaround_cycles=1)
        sim = Simulator(dut)
        sim.add_clock(1 / 48e6)
        # Columns: logical CLK, LE, logical OE, FPGA OE, X LE, Y LE.
        # Safe steady-state sequence. There is a high-impedance cycle between
        # ADC ownership and FPGA ownership, plus the remaining period slot
        # releases the FPGA before the next ADC window.
        expected = [(1,1,1,0,0,0), (1,0,1,0,0,0),
                    (1,0,0,0,0,0), (1,0,0,1,0,0),
                    (0,0,0,1,1,0), (0,0,0,1,0,0),
                    (0,0,0,1,0,1), (0,0,0,0,0,0)]
        async def bench(ctx):
            ctx.set(dut.dac_stream.valid, 1)
            ctx.set(dut.adc_stream.ready, 1)
            for tick in range(123):
                if tick >= 9:
                    actual = tuple(ctx.get(getattr(dut.bus,n)) for n in
                                   ("adc_clk","adc_le_clk","adc_oe","data_oe",
                                    "dac_x_le_clk","dac_y_le_clk"))
                    self.assertEqual(actual, expected[(tick-4)%8], f"tick={tick}")
                await ctx.tick()
        sim.add_testbench(bench)
        sim.run()

    def test_bus_owners_never_switch_without_a_high_impedance_cycle(self):
        dut = BusController(adc_half_period=4, adc_latency=8, bus_turnaround_cycles=1)
        sim = Simulator(dut)
        sim.add_clock(1 / 48e6)

        async def bench(ctx):
            ctx.set(dut.dac_stream.valid, 1)
            ctx.set(dut.adc_stream.ready, 1)
            previous_owner = "none"
            for _ in range(80):
                adc = ctx.get(dut.bus.adc_oe)
                fpga = ctx.get(dut.bus.data_oe)
                self.assertFalse(adc and fpga)
                owner = "adc" if adc else "fpga" if fpga else "none"
                if owner != previous_owner and owner != "none" and previous_owner != "none":
                    self.fail(f"direct bus-owner transition: {previous_owner} -> {owner}")
                previous_owner = owner
                await ctx.tick()

        sim.add_testbench(bench)
        sim.run()

    def test_each_timing_parameter_controls_its_fsm_window(self):
        timing = dict(
            adc_half_period=8, adc_latency=8, adc_latch_cycles=2,
            adc_settle_cycles=3, bus_turnaround_cycles=1,
            dac_data_setup_cycles=2, dac_latch_cycles=2)
        dut = BusController(**timing)
        sim = Simulator(dut)
        sim.add_clock(1 / 48e6)

        async def bench(ctx):
            ctx.set(dut.dac_stream.valid, 1)
            ctx.set(dut.adc_stream.ready, 1)
            observed = []
            started = False
            for _ in range(80):
                row = tuple(ctx.get(getattr(dut.bus, name)) for name in
                            ("adc_le_clk", "adc_oe", "data_oe",
                             "dac_x_le_clk", "dac_y_le_clk"))
                if row[0]:
                    started = True
                if started:
                    observed.append(row)
                    if len(observed) == 14:
                        break
                await ctx.tick()

            self.assertEqual(len(observed), 14)
            self.assertTrue(all(row[0] and row[1] and not row[2]
                                for row in observed[0:2]))
            self.assertTrue(all(not row[0] and row[1] and not row[2]
                                for row in observed[2:5]))
            self.assertEqual(observed[5], (0, 0, 0, 0, 0))
            self.assertTrue(all(row[2] and not row[3]
                                for row in observed[6:8]))
            self.assertTrue(all(row[2] and row[3]
                                for row in observed[8:10]))
            self.assertTrue(all(row[2] and not row[4]
                                for row in observed[10:12]))
            self.assertTrue(all(row[2] and row[4]
                                for row in observed[12:14]))

        sim.add_testbench(bench)
        sim.run()
