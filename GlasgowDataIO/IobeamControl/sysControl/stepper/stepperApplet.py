from amaranth import *
from amaranth.lib.wiring import In, Out

from ...glasgowLib.glasgow.applet import GlasgowApplet, PinArgument
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
    required_revision = "C3"

    def __init__(self, config=None):
        self._config = config

    @staticmethod
    def _as_mapping(value):
        if isinstance(value, dict):
            return value
        return {}

    def _stepper_config(self):
        config = self._as_mapping(self._config)
        for key in ("stepper", "stepperCarrier", "carrier"):
            section = config.get(key)
            if isinstance(section, dict):
                return section
        return {}

    @staticmethod
    def _pin_argument_from_spec(spec, fallback):
        if spec is None:
            return fallback
        if isinstance(spec, PinArgument):
            return spec
        if isinstance(spec, int):
            return PinArgument(spec)
        if isinstance(spec, str):
            invert = spec.endswith("#")
            number = spec.rstrip("#")
            if number.isdigit():
                return PinArgument(int(number), invert=invert)
        if isinstance(spec, dict):
            number = spec.get("number", spec.get("pin"))
            if number is None:
                return fallback
            invert = bool(spec.get("invert", False))
            return PinArgument(int(number), invert=invert)
        return fallback

    def _timing_from_config(self, default_pulse_high_us=5):
        config = self._stepper_config()
        timing = config.get("timing", {})
        if not isinstance(timing, dict):
            timing = {}
        pulse_high_us = int(timing.get("pulseHighUs", timing.get("pulse_high_us", default_pulse_high_us)))
        if pulse_high_us < 1:
            pulse_high_us = 1
        return pulse_high_us

    @classmethod
    def add_build_arguments(cls, parser, access):
        super().add_build_arguments(parser, access)
        access.add_pin_argument(parser, "step", default=True)
        access.add_pin_argument(parser, "dir",  default=True)
        access.add_pin_argument(parser, "en",   default=True)

    def build(self, target, args):
        self.mux_interface = iface = target.multiplexer.claim_interface(self, args)
        step_pin = self._pin_argument_from_spec(
            self._stepper_config().get("pins", {}).get("step") if self._stepper_config() else None,
            args.pin_step,
        )
        dir_pin = self._pin_argument_from_spec(
            self._stepper_config().get("pins", {}).get("dir") if self._stepper_config() else None,
            args.pin_dir,
        )
        en_pin = self._pin_argument_from_spec(
            self._stepper_config().get("pins", {}).get("en") if self._stepper_config() else None,
            args.pin_en,
        )
        self._subtarget = ControlStepperSubtarget(
            ports=iface.get_port_group(step=step_pin, dir=dir_pin, en=en_pin),
            out_fifo=iface.get_out_fifo(),
            pulse_high_us=self._timing_from_config(),
        )
        iface.add_subtarget(self._subtarget)

    async def run(self, device, args):
        iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args)
        return ControlStepperInterface(iface, self.logger)

    @classmethod
    def tests(cls):
        # placeholder hook for your test suite (optional)
        return []
