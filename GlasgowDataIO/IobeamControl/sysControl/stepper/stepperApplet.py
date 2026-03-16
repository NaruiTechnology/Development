from amaranth import *
from amaranth.lib.wiring import In, Out

from glasgow.applet import GlasgowApplet
from IobeamControl.sysControl.stepper.controlStepperSubtarget import ControlStepperSubtarget
from IobeamControl.sysControl.stepper.controlStepperInterface import ControlStepperInterface

import logging

class ControlStepperApplet(GlasgowApplet):
    logger = logging.getLogger(__name__)
    help = "control stepper motors via STEP/DIR/EN signals"
    description = """
    Simple stepper motor controller generating STEP pulses with configurable direction and period.
    - STEP pulse high time is fixed (default 5 µs).
    - Period is specified in microseconds between successive step rising edges.
    - Supports finite moves (`run_steps`) and continuous run (`run_continuous`).
    """
    required_revision = "C0"

    @classmethod
    def add_build_arguments(cls, parser, access):
        super().add_build_arguments(parser, access)
        access.add_pin_argument(parser, "step", default=True)
        access.add_pin_argument(parser, "dir",  default=True)
        access.add_pin_argument(parser, "en",   default=True)

    def build(self, target, args):
        self.mux_interface = iface = target.multiplexer.claim_interface(self, args)
        iface.add_subtarget(ControlStepperSubtarget(
            ports=iface.get_port_group(step=args.pin_step, dir=args.pin_dir, en=args.pin_en),
            out_fifo=iface.get_out_fifo(),
        ))

    async def run(self, device, args):
        iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args)
        return ControlStepperInterface(iface, self.logger)

    @classmethod
    def tests(cls):
        # placeholder hook for your test suite (optional)
        return []