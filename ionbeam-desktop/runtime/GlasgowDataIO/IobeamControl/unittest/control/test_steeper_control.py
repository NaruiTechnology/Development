import unittest
import logging
import asyncio
import gc
import warnings
from types import SimpleNamespace

from amaranth.sim import Simulator
from amaranth import Module, ClockDomain, Fragment, Signal
from amaranth.lib import io
from amaranth.hdl._ir import UnusedElaboratable

from IobeamControl.sysControl.stepper.stepperChannel import StepperChannel
from IobeamControl.sysControl.stepper.controlStepperInterface import ControlStepperInterface
from IobeamControl.sysControl.stepper.controlStepperSubtarget import ControlStepperSubtarget  
from IobeamControl.sysControl.stepper.stepperApplet import ControlStepperApplet
from IobeamControl.sysControl.stepper.sampleStageSubtarget import SampleStageSubtarget

warnings.filterwarnings("ignore", category=UnusedElaboratable)

# ---------------------------------------------------------------------------
# Helper: Mock lower interface
# ---------------------------------------------------------------------------
class MockLower:
    def __init__(self):
        self.commands = []
        self._flushed = False

    async def write(self, data):
        self.commands.append(data)

    async def flush(self):
        self._flushed = True


# ---------------------------------------------------------------------------
# TestCase for Stepper classes
# ---------------------------------------------------------------------------
class ControlStepperTest(unittest.TestCase):
    def test_sample_stage_subtarget_tracks_axis(self):
        ports = SimpleNamespace(
            sck=io.SimulationPort("o", 1, name="stage_x_sck"),
            cs=io.SimulationPort("o", 1, name="stage_x_cs"),
            copi=io.SimulationPort("o", 1, name="stage_x_sdi"),
            cipo=io.SimulationPort("i", 1, name="stage_x_sdo"),
        )
        out_fifo = SimpleNamespace(
            r_en=Signal(), r_rdy=Signal(), r_data=Signal(8)
        )
        in_fifo = SimpleNamespace(
            w_en=Signal(), w_rdy=Signal(), w_data=Signal(8), flush=Signal()
        )
        target = SampleStageSubtarget(
            "X",
            ports=ports,
            out_fifo=out_fifo,
            in_fifo=in_fifo,
            period_cyc=4,
            delay_cyc=48,
            sck_idle=0,
            sck_edge="rising",
        )
        self.assertEqual(target.axis, "X")
        self.assertEqual(target.period_cyc, 4)
        Fragment.get(target, platform=None)
        with self.assertRaises(ValueError):
            SampleStageSubtarget("Z", object(), object())

    def test_stepper_channel_generates_pulses(self):
        """Simulate StepperChannel and verify it runs without errors."""

        try:
            m = Module()
            m.domains.sync = ClockDomain("sync")  
            dut = StepperChannel(pulse_high_us=2)
            m.submodules.dut = dut
            sim = Simulator(m)

            async def bench(ctx):
                ctx.set(dut.en, 1)
                ctx.set(dut.run, 0)
                ctx.set(dut.dir_in, 1)
                ctx.set(dut.period, 10)
                ctx.set(dut.steps_in, 3)
                ctx.set(dut.start, 1)
                await ctx.tick()
                ctx.set(dut.start, 0)

                rising_edges = 0
                previous = 0
                for _ in range(200):
                    await ctx.tick()
                    current = ctx.get(dut.pulse)
                    if current and not previous:
                        rising_edges += 1
                    previous = current
                self.assertEqual(rising_edges, 3)
                self.assertEqual(ctx.get(dut.dir_out), 1)
                self.assertEqual(ctx.get(dut.en_out), 1)

            # Drive the 'sync' clock
            sim.add_clock(1e-6, domain="sync")
            sim.add_testbench(bench)

            sim.run()
            
            
        except Exception as e:
            self.fail(f"StepperChannel simulation raised an exception: {e}")
            
    def test_interface_commands(self):
        """Check that ControlStepperInterface encodes commands correctly."""


        try:
            async def run_test():
                mock = MockLower()
                iface = ControlStepperInterface(mock, logging.getLogger("test"))

                # Enable / disable
                await iface.enable(True)
                await iface.disable()

                # Direction
                await iface.set_direction(1)

                # Period
                await iface.set_period_us(1234)

                # Steps
                await iface.run_steps(500)

                # Continuous
                await iface.run_continuous(True)
                await iface.run_continuous(False)

                # Assertions: each command was emitted at least once
                cmds = [c[0] for c in mock.commands]  # first byte of each command list
                self.assertIn(ControlStepperSubtarget.Command.Enable.value, cmds)
                self.assertIn(ControlStepperSubtarget.Command.Disable.value, cmds)
                self.assertIn(ControlStepperSubtarget.Command.SetDirection.value, cmds)
                self.assertIn(ControlStepperSubtarget.Command.SetPeriodUS.value, cmds)
                self.assertIn(ControlStepperSubtarget.Command.RunSteps.value, cmds)
                self.assertIn(ControlStepperSubtarget.Command.RunContinuous.value, cmds)

            asyncio.run(run_test())
        except Exception as e:
            self.fail(f"ControlStepperInterface test raised an exception: {e}")

    def test_applet_build(self):
        """Smoke test: applet.build() should run with dummy target."""

        class DummyTarget:
            def __init__(self):
                self.multiplexer = self.DummyMux()

            class DummyMux:
                def claim_interface(self, applet, args):
                    return self

                def add_subtarget(self, subtarget):
                    self.subtarget = subtarget

                def get_port_group(self, **kwargs):
                    return type("P", (), {})()

                def get_out_fifo(self):
                    return type("Fifo", (), {
                        "r_en": 0, "r_rdy": 0, "r_data": 0
                    })()

        args = type("Args", (), {
            "pin_step": "A0", "pin_dir": "A1", "pin_en": "A2"
        })()

        try:
            target = DummyTarget()
            applet = ControlStepperApplet(None)
            # Should not raise
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                applet.build(target, args)
                del applet
                del target
                gc.collect()
        except Exception as e:
            self.fail(f"ControlStepperApplet.build() raised an exception: {e}")

    def test_applet_uses_json_config(self):
        """JSON config should override the default pin layout and timing."""

        class DummyTarget:
            def __init__(self):
                self.multiplexer = self.DummyMux()

            class DummyMux:
                def claim_interface(self, applet, args):
                    return self

                def add_subtarget(self, subtarget):
                    self.subtarget = subtarget

                def get_port_group(self, **kwargs):
                    self.kwargs = kwargs
                    return type("P", (), {})()

                def get_out_fifo(self):
                    return type("Fifo", (), {
                        "r_en": 0, "r_rdy": 0, "r_data": 0
                    })()

        cfg = {
            "stepperCarrier": {
                "pins": {
                    "step": {"number": 4, "invert": True},
                    "dir": {"number": 5, "invert": False},
                    "en": {"number": 6, "invert": True},
                },
                "timing": {
                    "pulseHighUs": 9,
                },
            }
        }
        args = type("Args", (), {
            "pin_step": "A0", "pin_dir": "A1", "pin_en": "A2"
        })()

        target = DummyTarget()
        applet = ControlStepperApplet(cfg)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            applet.build(target, args)

        subtarget = target.multiplexer.subtarget
        self.assertEqual(target.multiplexer.kwargs["step"].number, 4)
        self.assertTrue(target.multiplexer.kwargs["step"].invert)
        self.assertEqual(target.multiplexer.kwargs["dir"].number, 5)
        self.assertEqual(target.multiplexer.kwargs["en"].number, 6)
        self.assertTrue(target.multiplexer.kwargs["en"].invert)
        self.assertEqual(subtarget.pulse_high_us, 9)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            del applet
            del target
            del subtarget
            gc.collect()
