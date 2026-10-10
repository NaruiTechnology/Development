"""Differential tests against the user's working OBI checkout, not a local model.

Set OBI_REFERENCE_ROOT to another checkout when running outside this workstation.
Only the applet's hardware-independent classes are loaded; Glasgow USB is unused.
"""
import ast
import importlib
import os
from pathlib import Path
import random
import struct
import sys
import types
import unittest

from amaranth import Fragment, Module, Signal
from amaranth.sim import Simulator
from GlasgowDataIO.IobeamControl.applet.busController import BusController
from GlasgowDataIO.IobeamControl.applet.commandExecutor import CommandExecutor
from GlasgowDataIO.IobeamControl.applet.commandParser import CommandParser
from GlasgowDataIO.IobeamControl.commands.structs import Transforms


ROOT = Path(os.environ.get("OBI_REFERENCE_ROOT",
    "/home/vboxuser/Project/Open-Beam-Interface")) / "software"
BUS_FIELDS = ("adc_clk", "adc_le_clk", "adc_oe", "dac_clk",
              "dac_x_le_clk", "dac_y_le_clk", "data_o", "data_oe")


def reference():
    if not ROOT.is_dir():
        raise unittest.SkipTest("OBI_REFERENCE_ROOT checkout is unavailable")
    sys.path.insert(0, str(ROOT))
    # Skip the top-level applet import, which requires Glasgow distribution
    # metadata. All reference gateware modules and command definitions are
    # imported unchanged from disk.
    name = "obi.applet.open_beam_interface"
    if name not in sys.modules:
        package = types.ModuleType(name)
        package.__path__ = [str(ROOT / "obi/applet/open_beam_interface")]
        sys.modules[name] = package
    modules = importlib.import_module(name + ".modules")
    commands = importlib.import_module("obi.commands")
    namespace = {}
    exec("from amaranth import *\nfrom amaranth.build import *\nfrom amaranth.lib import data, stream, wiring, io\n"
         "from amaranth.lib.wiring import In, Out, flipped", namespace)
    namespace.update(vars(commands))
    namespace.update(vars(modules))
    source = ROOT / "obi/applet/open_beam_interface/__init__.py"
    tree = ast.parse(source.read_text())
    classes = [node for node in tree.body if
               (isinstance(node, ast.ClassDef) and node.name in
                ("CommandExecutor", "ImageSerializer", "OBIComponent")) or
               (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                 and target.id == "obi_resources" for target in node.targets))]
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(source), "exec"), namespace)
    return modules, commands, namespace


class UpstreamEquivalenceTest(unittest.TestCase):
    def test_reference_elaborate_is_copied_without_logic_changes(self):
        import inspect
        import textwrap
        from GlasgowDataIO.IobeamControl.applet.upstreamBusController import UpstreamBusController
        upstream, _, _ = reference()
        local = ast.parse(textwrap.dedent(inspect.getsource(UpstreamBusController.elaborate)))
        ref = ast.parse(textwrap.dedent(inspect.getsource(upstream.BusController.elaborate)))
        self.assertEqual(ast.dump(local), ast.dump(ref))

    def test_controller_pins_handshakes_samples_and_tags_match_upstream(self):
        upstream, _, _ = reference()
        for flags in ((False, False, False), (True, False, True), (False, True, True)):
            with self.subTest(transforms=flags):
                local = BusController(adc_half_period=3, adc_latency=8,
                                      transforms=Transforms(*flags))
                ref = upstream.BusController(adc_half_period=3, adc_latency=8,
                                             transforms=upstream.Transforms(*flags))
                m = Module()
                m.submodules.local, m.submodules.ref = local, ref
                sim = Simulator(m)
                sim.add_clock(1 / 48e6)

                async def bench(ctx):
                    rng = random.Random(724)
                    accepted = emitted = 0
                    for tick in range(2500):
                        ready = not (160 <= tick % 600 < 410)
                        valid = rng.randrange(4) != 0
                        value = rng.randrange(0x4000)
                        for dut in (local, ref):
                            ctx.set(dut.bus.data_i, value)
                            ctx.set(dut.dac_stream.valid, valid)
                            ctx.set(dut.adc_stream.ready, ready)
                            ctx.set(dut.dac_stream.payload.dac_x_code, tick * 13 & 0x3fff)
                            ctx.set(dut.dac_stream.payload.dac_y_code, tick * 31 & 0x3fff)
                            ctx.set(dut.dac_stream.payload.last, tick % 3 == 0)
                            ctx.set(dut.dac_stream.payload.blank.enable, tick % 7 == 0)
                            ctx.set(dut.dac_stream.payload.blank.request, tick % 9 == 0)
                        for field in BUS_FIELDS:
                            self.assertEqual(ctx.get(getattr(local.bus, field)),
                                             ctx.get(getattr(ref.bus, field)), (tick, field))
                        self.assertEqual(ctx.get(local.dac_stream.ready), ctx.get(ref.dac_stream.ready))
                        self.assertEqual(ctx.get(local.adc_stream.valid), ctx.get(ref.adc_stream.valid))
                        self.assertEqual(ctx.get(local.inline_blank.as_value()), ctx.get(ref.inline_blank.as_value()))
                        if ctx.get(ref.adc_stream.valid):
                            self.assertEqual(ctx.get(local.adc_stream.payload.adc_code), ctx.get(ref.adc_stream.payload.adc_code))
                            self.assertEqual(ctx.get(local.adc_stream.payload.last), ctx.get(ref.adc_stream.payload.last))
                            emitted += ready
                        accepted += bool(valid and ctx.get(ref.dac_stream.ready))
                        await ctx.tick()
                    self.assertGreater(accepted, 30)
                    self.assertGreater(emitted, 30)

                sim.add_testbench(bench)
                sim.run()

    def test_parser_executor_scan_bus_and_blanking_match_upstream(self):
        upstream, commands, namespace = reference()
        ReferenceExecutor = namespace["CommandExecutor"]
        for raster, array_mode in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(raster=raster, array_mode=array_mode):
                local, ref = CommandExecutor(ext_switch_delay=4), ReferenceExecutor(ext_delay_cyc=4)
                lp, rp = CommandParser(), upstream.CommandParser()
                m = Module()
                m.submodules.local, m.submodules.ref = local, ref
                m.submodules.lp, m.submodules.rp = lp, rp
                from amaranth.lib import wiring
                wiring.connect(m, lp.cmd_stream, local.cmd_stream)
                wiring.connect(m, rp.cmd_stream, ref.cmd_stream)
                cmd = [commands.ExternalCtrlCommand(True),
                       commands.BeamSelectCommand(commands.BeamType.Ion),
                       commands.BlankCommand(False),
                       commands.BlankCommand(True, inline=True)]
                if raster:
                    cmd += [commands.RasterRegionCommand(commands.DACCodeRange(9, 3, 256),
                                                        commands.DACCodeRange(17, 2, 256))]
                    if array_mode:
                        cmd += [commands.ArrayCommand(commands.CmdType.RasterPixel, 5),
                                b"".join(struct.pack(">H", i % 3) for i in range(6))]
                    else:
                        cmd += [commands.RasterPixelCommand(dwell_time=i % 3) for i in range(6)]
                else:
                    if array_mode:
                        cmd += [commands.ArrayCommand(commands.CmdType.VectorPixel, 5),
                                b"".join(struct.pack(">HHH", 10 + i * 7, 30 + i * 13, i % 3) for i in range(6))]
                    else:
                        cmd += [commands.VectorPixelCommand(10 + i * 7, 30 + i * 13, i % 3) for i in range(6)]
                cmd += [commands.BlankCommand(True), commands.FlushCommand()]
                wire = b"".join(bytes(c) for c in cmd)
                sim = Simulator(m)
                sim.add_clock(1 / 48e6)

                async def bench(ctx):
                    sent = received = 0
                    for tick in range(1200):
                        for parser in (lp, rp):
                            ctx.set(parser.usb_stream.valid, sent < len(wire) and tick % 5 != 0)
                            ctx.set(parser.usb_stream.payload, wire[sent] if sent < len(wire) else 0)
                        for dut in (local, ref):
                            ctx.set(dut.img_stream.ready, tick % 47 >= 18)
                            ctx.set(dut.bus.data_i, tick * 37 & 0x3fff)
                        self.assertEqual(ctx.get(lp.usb_stream.ready), ctx.get(rp.usb_stream.ready), tick)
                        for field in BUS_FIELDS:
                            self.assertEqual(ctx.get(getattr(local.bus, field)), ctx.get(getattr(ref.bus, field)), (tick, field))
                        for field in ("blank_enable", "ext_ctrl_enable", "ext_ctrl_enabled", "beam_type", "flush"):
                            self.assertEqual(ctx.get(getattr(local, field)), ctx.get(getattr(ref, field)), (tick, field))
                        self.assertEqual(ctx.get(local.img_stream.valid), ctx.get(ref.img_stream.valid), tick)
                        if ctx.get(ref.img_stream.valid):
                            self.assertEqual(ctx.get(local.img_stream.payload), ctx.get(ref.img_stream.payload))
                            received += bool(ctx.get(ref.img_stream.ready))
                        if ctx.get(lp.usb_stream.valid) and ctx.get(lp.usb_stream.ready):
                            sent += 1
                        await ctx.tick()
                    self.assertEqual(sent, len(wire))
                    self.assertEqual(received, 6)

                sim.add_testbench(bench)
                sim.run()

    def test_physical_buffers_and_usb_samples_match_upstream(self):
        from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget
        from GlasgowDataIO.IobeamControl.unittest.applet.test_physicalDataPath import PadPlatform
        from GlasgowDataIO.IobeamControl.unittest.applet.test_obiPinMapping import pin_config
        _, commands, namespace = reference()
        for raster in (False, True):
            with self.subTest(raster=raster):
                tx = types.SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
                rx = types.SimpleNamespace(w_data=Signal(8), w_rdy=Signal(), w_en=Signal())
                local = IobeamDataSubtarget(ports=types.SimpleNamespace(), out_fifo=tx,
                                           in_fifo=rx, pin_config=pin_config("streamData.json"))
                ref = namespace["OBIComponent"](types.SimpleNamespace(), False, False, False)
                lp, rp = PadPlatform(), PadPlatform()
                m = Module()
                m.submodules.local = Fragment.get(local, lp)
                m.submodules.ref = Fragment.get(ref, rp)
                cmd = [commands.SynchronizeCommand(cookie=123, output=commands.OutputMode.SixteenBit, raster=raster)]
                if raster:
                    cmd += [commands.RasterRegionCommand(commands.DACCodeRange(5, 3, 256),
                                                        commands.DACCodeRange(9, 2, 256))]
                    cmd += [commands.RasterPixelCommand(dwell_time=i % 3) for i in range(6)]
                else:
                    cmd += [commands.VectorPixelCommand(31 + i, 49 + i, i % 3) for i in range(6)]
                wire = b"".join(bytes(c) for c in cmd)
                sim = Simulator(m)
                sim.add_clock(1 / 48e6)

                async def bench(ctx):
                    sent, local_bytes, ref_bytes = 0, bytearray(), bytearray()
                    for tick in range(1500):
                        valid = tick > 4 and tick % 5 != 0 and sent < len(wire)
                        byte = wire[sent] if sent < len(wire) else 0
                        ctx.set(tx.r_rdy, valid)
                        ctx.set(tx.r_data, byte)
                        ctx.set(ref.i_stream.valid, valid)
                        ctx.set(ref.i_stream.payload, byte)
                        ctx.set(rx.w_rdy, tick % 43 >= 13)
                        ctx.set(ref.o_stream.ready, tick % 43 >= 13)
                        for platform, oe_name in ((lp, "adc_oe"), (rp, "a_enable")):
                            data = platform.ports["data"]
                            enabled = not ctx.get(getattr(platform.ports["control"], oe_name).o)
                            self.assertFalse(enabled and ctx.get(data.oe))
                            ctx.set(data.i, (tick * 37 & 0x3fff) if enabled else 0x3fff)
                        for lname, rname in (("adc_clk", "a_clock"), ("adc_le_clk", "a_latch"),
                            ("adc_oe", "a_enable"), ("dac_clk", "d_clock"),
                            ("dac_x_le_clk", "x_latch"), ("dac_y_le_clk", "y_latch")):
                            self.assertEqual(ctx.get(getattr(lp.ports["control"], lname).o),
                                             ctx.get(getattr(rp.ports["control"], rname).o), (tick, lname))
                        self.assertEqual(ctx.get(lp.ports["data"].o), ctx.get(rp.ports["data"].o), tick)
                        self.assertEqual(ctx.get(lp.ports["data"].oe), ctx.get(rp.ports["data"].oe), tick)
                        self.assertEqual(ctx.get(tx.r_en), ctx.get(ref.i_stream.ready), tick)
                        if valid and ctx.get(tx.r_en):
                            sent += 1
                        if ctx.get(rx.w_en) and ctx.get(rx.w_rdy):
                            local_bytes.append(ctx.get(rx.w_data))
                        if ctx.get(ref.o_stream.valid) and ctx.get(ref.o_stream.ready):
                            ref_bytes.append(ctx.get(ref.o_stream.payload))
                        await ctx.tick()
                    self.assertEqual(sent, len(wire))
                    self.assertEqual(local_bytes[:4], b"\xff\xff\x00\x7b")
                    self.assertEqual(local_bytes[:4], ref_bytes[:4])
                    self.assertEqual(len(local_bytes), 16)
                    self.assertEqual(len(local_bytes), len(ref_bytes))
                    for offset in range(4, len(local_bytes), 2):
                        self.assertEqual(int.from_bytes(local_bytes[offset:offset+2], "big"),
                                         int.from_bytes(ref_bytes[offset:offset+2], "big"))

                sim.add_testbench(bench)
                sim.run()
