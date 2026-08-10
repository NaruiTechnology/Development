"""Build one FPGA image containing independent X and Y stepper applets."""
import asyncio
from types import SimpleNamespace

from ...glasgowLib.glasgow.abstract import GlasgowPin
from ...glasgowLib.glasgow.applet import PinArgument
from ...glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from ...glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
from ...glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from ...glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .stepperApplet import ControlStepperApplet


class SampleStageLauncher:
    def __init__(self, device_id, voltage, axes):
        if not device_id:
            raise ValueError("sample-stage Glasgow.Device1.Id is required")
        if set(axes) != {"X", "Y"}:
            raise ValueError("sample stage requires X and Y axes")
        self.device_id = device_id
        self.voltage = float(voltage)
        self.axes = axes

    @staticmethod
    def _pin(pin):
        port, number = pin[0].upper(), int(pin[1:])
        if port not in {"A", "B"} or not 0 <= number <= 7:
            raise ValueError(f"invalid Glasgow pin: {pin}")
        return PinArgument(number if port == "A" else 8 + number)

    async def start(self):
        device = GlasgowDevice(self.device_id)
        try:
            target = GlasgowHardwareTarget(
                revision=device.revision, multiplexer_cls=DirectMultiplexer
            )
            applets = {}
            args_by_axis = {}
            all_pins = []
            for axis_name in ("X", "Y"):
                axis = self.axes[axis_name]
                pins = axis["pins"]
                all_pins.extend(pins.values())
                applet = ControlStepperApplet({
                    "stepperCarrier": {
                        "timing": {"pulseHighUs": axis["pulseHighUs"]}
                    }
                })
                args = SimpleNamespace(
                    port_spec="AB",
                    voltage_map={"A": self.voltage, "B": self.voltage},
                    pins=GlasgowPin.parse(",".join(pins.values())),
                    pin_step=self._pin(pins["step"]),
                    pin_dir=self._pin(pins["dir"]),
                    pin_en=self._pin(pins["en"]),
                    buffer_size=4096,
                )
                applet.build(target, args)
                applets[axis_name] = applet
                args_by_axis[axis_name] = args

            if len(set(all_pins)) != len(all_pins):
                raise ValueError("sample-stage Glasgow pins must be unique")
            await device.download_target(target.build_plan(), reload=True)
            device.demultiplexer = DirectDemultiplexer(
                device, target.multiplexer.pipe_count
            )
            await device.set_voltage("AB", self.voltage)
            await asyncio.sleep(3.0)
            status = await device._status()
            if not status & ST_FPGA_RDY:
                raise RuntimeError(f"sample-stage FPGA target is not ready; status={status:#04x}")
            await asyncio.sleep(1.2)
            interfaces = {
                name: await applets[name].run(device, args_by_axis[name])
                for name in ("X", "Y")
            }
            return device, interfaces
        except BaseException:
            device.close()
            raise
