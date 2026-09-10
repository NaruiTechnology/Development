import unittest
from types import SimpleNamespace

from amaranth import Fragment, Signal
from amaranth.lib import io
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.adcTiming import AdcTiming
from GlasgowDataIO.IobeamControl.applet.AdcDataStreamApplet import AdcDataSubtarget
from GlasgowDataIO.IobeamControl.applet.busController import BusController


class AdcTimingTest(unittest.TestCase):
    def test_invalid_timing_is_rejected_instead_of_silently_clamped(self):
        for half, settle in ((1, 2), (6, 0)):
            with self.assertRaises(ValueError):
                AdcTiming(half, settle)
        with self.assertRaises(ValueError):
            AdcTiming(5, 2).validate_scan()
        with self.assertRaises(ValueError):
            AdcTiming(2, 2).capture_phases()
        for latch, sample in ((-1, 5), (12, 5), (1, 12)):
            with self.assertRaises(ValueError):
                AdcTiming().capture_phases(latch, sample)
        self.assertEqual(AdcTiming().capture_phases(0, 3), (0, 3))

    def test_scan_latch_and_capture_follow_shared_schedule(self):
        for half, settle in ((6, 2), (7, 3), (8, 4)):
            with self.subTest(half=half, settle=settle):
                timing = AdcTiming(half, settle)
                dut = BusController(adc_half_period=half, adc_latency=8,
                                    adc_settle_cycles=settle)
                sim = Simulator(dut)
                sim.add_clock(1 / 48e6)

                async def bench(ctx):
                    prev_clock = 0
                    conversion = None
                    samples = 0
                    for tick in range(timing.period * 12):
                        clock = ctx.get(dut.bus.adc_clk)
                        if prev_clock and not clock:
                            conversion = tick
                        ctx.set(dut.bus.data_i, tick)
                        before = ctx.get(dut.adc_sample)
                        if conversion is not None and ctx.get(dut.bus.adc_le_clk):
                            self.assertEqual(tick - conversion, timing.latch_phase)
                        prev_clock = clock
                        await ctx.tick()
                        if conversion is not None and ctx.get(dut.adc_sample) != before:
                            self.assertEqual(tick - conversion, timing.sample_phase)
                            self.assertEqual(ctx.get(dut.adc_sample), tick)
                            samples += 1
                    self.assertGreater(samples, 5)

                sim.add_testbench(bench)
                sim.run()

    def test_adc_latches_delayed_conversion_data_and_serializes_under_stalls(self):
        # Behavioral register: conversion data arrives halfway through a
        # sync interval; LE captures only on its rising edge. The model
        # deliberately exposes stale data if LE coincides with conversion.
        # This is a digital propagation assumption, not a board timing spec.
        for half, settle in ((6, 2), (7, 3), (8, 4)):
            with self.subTest(half=half, settle=settle):
                pads = io.SimulationPort("i", 14)

                class Platform:
                    def add_resources(self, resources):
                        pass

                    def request(self, name, *, dir):
                        return pads

                fifo = SimpleNamespace(w_en=Signal(), w_data=Signal(8), w_rdy=Signal())
                enable = Signal()
                dut = AdcDataSubtarget(
                    in_fifo=fifo, capture_enable=enable, capture_status=Signal(8),
                    pin_config={"data": {"pins": " ".join(f"D{i}" for i in range(14))}},
                    adc_half_period=half, adc_settle_cycles=settle, duration_cycles=600)
                sim = Simulator(Fragment.get(dut, Platform()))
                sim.add_clock(1 / 48e6)

                async def bench(ctx):
                    ctx.set(enable, 1)
                    await ctx.tick()
                    previous_clock, previous_le = 1, 0
                    adc = register = 0x3fff
                    conversion = -100
                    captured, received = [], bytearray()
                    for tick in range(550):
                        clock = ctx.get(dut.adc_clk)
                        if previous_clock and not clock:
                            conversion = tick
                        le = ctx.get(dut.adc_le_clk)
                        if le and not previous_le:
                            self.assertGreater(tick, conversion)
                            register = adc
                        ctx.set(pads.i, register)
                        ready = tick % 71 >= 19
                        ctx.set(fifo.w_rdy, ready)
                        if ctx.get(fifo.w_en) and ready:
                            received.append(ctx.get(fifo.w_data))
                        previous_clock, previous_le = clock, le
                        # Data becomes available after the conversion edge,
                        # before the next sync edge and the delayed LE pulse.
                        await ctx.delay(0.25 / 48e6)
                        if tick == conversion:
                            adc = (tick * 13 + 7) & 0x3fff
                        captured.append(register)
                        await ctx.tick()
                    words = [int.from_bytes(received[i:i+2], "big")
                             for i in range(0, len(received)-1, 2)]
                    self.assertGreater(len(set(words)), 10)
                    self.assertNotIn(0x3fff, words)
                    # Each complete USB word must be an actual latched value;
                    # stalls may drop samples but must never mix two words.
                    self.assertTrue(set(words).issubset(set(captured)))

                sim.add_testbench(bench)
                sim.run()
