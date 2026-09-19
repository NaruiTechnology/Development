"""Configurable OBI-compatible timing and ADC capture contracts."""
import unittest
from types import SimpleNamespace
from amaranth import Signal
from amaranth.sim import Simulator
from GlasgowDataIO.IobeamControl.applet.adcTiming import AdcTiming
from GlasgowDataIO.IobeamControl.applet.AdcDataStreamApplet import AdcDataSubtarget

class AdcTimingTest(unittest.TestCase):
    def test_complete_scan_timing_configuration(self):
        timing = AdcTiming.from_action({
            "adcHalfPeriod": 8, "adcLatchCycles": 2,
            "adcSettleCycles": 3, "busTurnaroundCycles": 1,
            "dacDataSetupCycles": 2, "dacLatchCycles": 2,
        })
        self.assertEqual(timing.period, 16)
        self.assertEqual(timing.capture_phases(), (8, 12))
        self.assertEqual(timing.scan_required_cycles, 14)
        timing.validate_scan()
        with self.assertRaises(ValueError):
            AdcTiming(6, 3, 2, 1, 2, 2).validate_scan()

    def test_defaults_match_upstream_six_cycle_transaction(self):
        timing = AdcTiming.from_action({})
        self.assertEqual(
            (timing.half_period, timing.settle_cycles, timing.latch_cycles,
             timing.bus_turnaround_cycles, timing.dac_data_setup_cycles,
             timing.dac_latch_cycles),
            (3, 1, 1, 0, 1, 1))
        self.assertEqual(timing.scan_required_cycles, 6)
        self.assertEqual(timing.period, 6)
        self.assertEqual(timing.capture_phases(), (3, 4))
        self.assertTrue(timing.uses_upstream_sequence)
        timing.validate_scan()
        with self.assertRaisesRegex(ValueError, "at least 0"):
            AdcTiming(4, 1, 1, -1, 1, 1).validate_scan()

    def test_capture_overrides_are_bounded(self):
        timing=AdcTiming()
        for phases in ((-1,5),(4,8),(8,5)):
            with self.assertRaises(ValueError):
                timing.capture_phases(*phases)
        self.assertEqual(timing.capture_phases(0,3),(0,3))

    def test_standalone_latches_on_obi_clock_edge(self):
        fifo=SimpleNamespace(w_en=Signal(),w_data=Signal(8),w_rdy=Signal(init=1))
        dut=AdcDataSubtarget(in_fifo=fifo,capture_enable=Signal(init=1),
            capture_status=Signal(8),simulation=True,duration_cycles=200)
        sim=Simulator(dut); sim.add_clock(1/48e6)
        async def bench(ctx):
            previous_clock=0
            starts=[]
            for tick in range(160):
                if ctx.get(dut.adc_le_clk):
                    self.assertEqual(ctx.get(dut.adc_clk),1)
                    self.assertEqual(previous_clock,0)
                    starts.append(tick)
                if ctx.get(dut.running):
                    self.assertEqual(ctx.get(dut.adc_oe),1)
                previous_clock=ctx.get(dut.adc_clk)
                await ctx.tick()
            self.assertGreaterEqual(len(starts),20)
            self.assertEqual(set(b-a for a,b in zip(starts,starts[1:])),{6})
        sim.add_testbench(bench); sim.run()
