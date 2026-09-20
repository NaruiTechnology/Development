"""Exercise the real input-buffer branch through the scan USB FIFOs.

SimulationPort replaces electrical pads only; parser, executor, bus capture,
supersampler and serializer are the production modules, with loopback disabled.
"""
import unittest
from types import SimpleNamespace

from amaranth import Fragment, Signal
from amaranth.lib import io
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    SynchronizeCommand, VectorPixelCommand, RasterRegionCommand, RasterPixelCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import DACCodeRange, OutputMode, Transforms
from GlasgowDataIO.IobeamControl.unittest.applet.test_obiPinMapping import pin_config


class PadPlatform:
    def add_resources(self, resources):
        self.ports = {"led": io.SimulationPort("o", 1)}
        for resource in resources:
            if resource.name == "data":
                self.ports["data"] = io.SimulationPort("io", 14)
            elif resource.name == "control":
                self.ports["control"] = SimpleNamespace(**{
                    sub.name: io.SimulationPort(sub.ios[0].dir, 1, invert=sub.ios[0].invert)
                    for sub in resource.ios
                })

    def request(self, name, *, dir):
        return self.ports[name]


class PhysicalDataPathTest(unittest.TestCase):
    def test_raw_samples_reach_usb_in_both_scan_modes_with_backpressure(self):
        for raster in (False, True):
            for mode in (OutputMode.SixteenBit, OutputMode.EightBit):
                for code in (0, 1, 0x1234, 0x3fff):
                    with self.subTest(raster=raster, mode=mode, code=code):
                        self.check_path(raster, mode, code)

    def test_stretched_timing_profile_reaches_usb_path(self):
        for raster in (False, True):
            with self.subTest(raster=raster):
                self.check_path(raster, OutputMode.SixteenBit, 0x1234,
                                adc_half_period=8, adc_settle_cycles=4,
                                adc_latch_cycles=4)

    def check_path(self, raster, mode, code, **timing):
        pins = pin_config("streamData.json")
        tx = SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
        rx = SimpleNamespace(w_data=Signal(8), w_rdy=Signal(), w_en=Signal())
        platform = PadPlatform()
        dut = IobeamDataSubtarget(ports=SimpleNamespace(), out_fifo=tx,
                                 in_fifo=rx, pin_config=pins,
                                 **timing,
                                 transforms=Transforms(False, False, False))
        sim = Simulator(Fragment.get(dut, platform))
        sim.add_clock(1 / 48_000_000)
        commands = [SynchronizeCommand(cookie=0x1234, output=mode, raster=raster)]
        if raster:
            commands.append(RasterRegionCommand(DACCodeRange(0, 4, 256), DACCodeRange(0, 1, 256)))
            commands.extend(RasterPixelCommand(dwell_time=3) for _ in range(4))
        else:
            commands.extend(VectorPixelCommand(i, i, 3) for i in range(4))
        command_bytes = b"".join(bytes(cmd) for cmd in commands)
        obi_code = code << 2
        expected = (b"\xff\xff\x12\x34" + obi_code.to_bytes(2, "big") * 4
                    if mode == OutputMode.SixteenBit else b"\xff\xff\x12\x34" + bytes([obi_code >> 8] * 4))

        async def bench(ctx):
            sent = 0
            received = bytearray()
            observed_adc_window = False
            for tick in range(2500):
                ctx.set(tx.r_rdy, sent < len(command_bytes) and tick % 5 != 0)
                ctx.set(tx.r_data, command_bytes[sent] if sent < len(command_bytes) else 0)
                ctx.set(rx.w_rdy, tick % 11 >= 5)
                data = platform.ports["data"]
                oe = platform.ports["control"].adc_oe
                adc_owns_bus = ctx.get(oe.o) == 0
                if adc_owns_bus:
                    observed_adc_window = True
                    self.assertEqual(ctx.get(data.oe), 0)
                # Poison outside the actual active-low physical OE window.
                ctx.set(data.i, code if adc_owns_bus else code ^ 0x3fff)
                if ctx.get(tx.r_rdy) and ctx.get(tx.r_en):
                    sent += 1
                if ctx.get(rx.w_rdy) and ctx.get(rx.w_en):
                    received.append(ctx.get(rx.w_data))
                await ctx.tick()
            self.assertTrue(observed_adc_window)
            self.assertEqual(sent, len(command_bytes))
            self.assertEqual(bytes(received), expected)

        sim.add_testbench(bench)
        sim.run()
