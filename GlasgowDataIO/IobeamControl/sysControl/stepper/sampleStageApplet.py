"""Two-axis sample-stage applet for the dedicated second Glasgow device."""
from .stepperApplet import ControlStepperApplet
from .sampleStageSubtarget import SampleStageSubtarget


class SampleStageAxisApplet(ControlStepperApplet):
    """One axis within the combined sample-stage FPGA image."""

    def __init__(self, axis, config=None):
        super().__init__(config)
        self.axis = str(axis).upper()

    def build(self, target, args):
        self.mux_interface = iface = target.multiplexer.claim_interface(self, args)
        stage = self._stepper_config()
        pins = stage.get("pins", {}) if stage else {}
        step_pin = self._pin_argument_from_spec(pins.get("step"), args.pin_step)
        dir_pin = self._pin_argument_from_spec(pins.get("dir"), args.pin_dir)
        en_pin = self._pin_argument_from_spec(pins.get("en"), args.pin_en)
        self._subtarget = SampleStageSubtarget(
            axis=self.axis,
            ports=iface.get_port_group(step=step_pin, dir=dir_pin, en=en_pin),
            out_fifo=iface.get_out_fifo(),
            pulse_high_us=self._timing_from_config(),
        )
        iface.add_subtarget(self._subtarget)


class SampleStageApplet:
    """Build and open the X/Y axis interfaces as one hardware target."""

    def __init__(self, axes):
        self.axes = axes
        self._applets = {
            name: SampleStageAxisApplet(name, {
                "stepperCarrier": {
                    "pins": axis["pins"],
                    "timing": {"pulseHighUs": axis["pulseHighUs"]},
                }
            })
            for name, axis in axes.items()
        }

    def build(self, target, args_by_axis):
        for name in ("X", "Y"):
            self._applets[name].build(target, args_by_axis[name])

    async def run(self, device, args_by_axis):
        return {
            name: await self._applets[name].run(device, args_by_axis[name])
            for name in ("X", "Y")
        }
