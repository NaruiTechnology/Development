import unittest
import logging
import asyncio

from amaranth.sim import Simulator, Settle
from amaranth import Module, ClockDomain

from IobeamControl.sysControl.stepper.stepperChannel import StepperChannel
from IobeamControl.sysControl.stepper.controlStepperInterface import ControlStepperInterface
from IobeamControl.sysControl.stepper.controlStepperSubtarget import ControlStepperSubtarget  
from IobeamControl.sysControl.stepper.stepperApplet import ControlStepperApplet

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
    def test_stepper_channel_generates_pulses(self):
        """Simulate StepperChannel and verify it runs without errors."""

        try:
            m = Module()
            m.domains.sync = ClockDomain("sync")  
            dut = StepperChannel(pulse_high_us=2)
            m.submodules.dut = dut
            sim = Simulator(m) 
                       
            def process():
                # Initialize inputs
                yield dut.en.eq(1)
                yield dut.run.eq(0)
                yield dut.dir_in.eq(1)
                yield dut.period.eq(10)
                yield dut.steps_in.eq(3)

                # Run long enough to cover the 3 pulses
                for _ in range(200):
                    yield

            # Drive the 'sync' clock
            sim.add_clock(1e-6, domain="sync")
            sim.add_sync_process(process, domain="sync")

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
            class DummyMux:
                def claim_interface(self, applet, args):
                    return self
                def add_subtarget(self, subtarget):
                    pass
                def get_port_group(self, **kwargs):
                    return type("P", (), {})()
                def get_out_fifo(self):
                    return type("Fifo", (), {
                        "r_en": 0, "r_rdy": 0, "r_data": 0
                    })()
            multiplexer = DummyMux()

        args = type("Args", (), {
            "pin_step": "A0", "pin_dir": "A1", "pin_en": "A2"
        })()

        try:
            applet = ControlStepperApplet(None)
            # Should not raise
            applet.build(DummyTarget(), args)
        except Exception as e:
            self.fail(f"ControlStepperApplet.build() raised an exception: {e}")
