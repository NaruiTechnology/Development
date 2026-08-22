"""Build one FPGA image containing independent X and Y stepper applets."""
import asyncio
from types import SimpleNamespace

from ...glasgowLib.glasgow.abstract import GlasgowPin
from ...glasgowLib.glasgow.applet import PinArgument
from ...glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from ...glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
from ...glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from ...glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .sampleStageApplet import SampleStageApplet


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
            args_by_axis = {}
            all_pins = []
            for axis_name in ("X", "Y"):
                axis = self.axes[axis_name]
                pins = axis["pins"]
                all_pins.extend(pins.values())
                args = SimpleNamespace(
                    port_spec="AB",
                    voltage_map={"A": self.voltage, "B": self.voltage},
                    pins=GlasgowPin.parse(",".join(pins.values())),
                    sck=self._pin(pins["sck"]),
                    cs=self._pin(pins["cs"]),
                    copi=self._pin(pins["sdi"]),
                    cipo=self._pin(pins["sdo"]),
                    frequency=int(axis["spiFrequencyKHz"]),
                    sck_idle=int(axis.get("sckIdle", 0)),
                    sck_edge=str(axis.get("sckEdge", "rising")),
                    buffer_size=4096,
                )
                args_by_axis[axis_name] = args

            if len(set(all_pins)) != len(all_pins):
                raise ValueError("sample-stage Glasgow pins must be unique")
            applet = SampleStageApplet(self.axes)
            applet.build(target, args_by_axis)
            # Reuse the running image when its deterministic plan ID matches.
            image_programmed = await device.download_target(
                target.build_plan(), reload=False
            )
            device.demultiplexer = DirectDemultiplexer(
                device, target.multiplexer.pipe_count
            )
            await device.set_voltage("AB", self.voltage)
            if image_programmed:
                await asyncio.sleep(3.0)
            status = await device._status()
            if not status & ST_FPGA_RDY:
                raise RuntimeError(f"sample-stage FPGA target is not ready; status={status:#04x}")
            if image_programmed:
                await asyncio.sleep(1.2)
            interfaces = await applet.run(device, args_by_axis)
            return device, interfaces
        except BaseException:
            device.close()
            raise
