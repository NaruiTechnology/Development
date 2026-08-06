"""Build, load, and connect the Glasgow vacuum-control applet."""

import asyncio
from types import SimpleNamespace

from ...glasgowLib.glasgow.abstract import GlasgowPin
from ...glasgowLib.glasgow.applet import PinArgument
from ...glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from ...glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
from ...glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from ...glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .vacuumControlApplet import VacuumControlApplet


class VacuumControlLauncher:
    def __init__(self, device_id: str, voltage: float, port_a: list[str], port_b: list[str]):
        if len(port_a) != len(port_b) or not port_a:
            raise ValueError("vacuum Port A and Port B pin lists must be non-empty and equal")
        self.device_id = device_id
        self.voltage = float(voltage)
        self.port_a = port_a
        self.port_b = port_b

    @staticmethod
    def _pin_argument(pin: str) -> PinArgument:
        port = pin[0]
        number = int(pin[1:])
        return PinArgument(number if port == "A" else 8 + number)

    async def start(self):
        # Keep device setup identical to IobeamLauncher.  The only vacuum
        # specific part is the pin mapping supplied to VacuumControlApplet.
        device = GlasgowDevice(self.device_id)
        try:
            target = GlasgowHardwareTarget(
                revision=device.revision,
                multiplexer_cls=DirectMultiplexer,
            )
            applet = VacuumControlApplet()
            all_pins = self.port_a + self.port_b
            args = SimpleNamespace(
                port_spec="AB",
                voltage_map={"A": self.voltage, "B": self.voltage},
                pins=GlasgowPin.parse(",".join(all_pins)),
                pin_a=[self._pin_argument(pin) for pin in self.port_a],
                pin_b=[self._pin_argument(pin) for pin in self.port_b],
                buffer_size=4096,
                sample_rate=1_000_000,
            )

            applet.build(target, args)
            plan = target.build_plan()

            # Build/download before creating the demultiplexer.  This is the
            # ordering used by the working scan data-stream path and avoids
            # claiming USB streaming endpoints against the previous FPGA image.
            await device.download_target(plan, reload=True)

            device.demultiplexer = DirectDemultiplexer(device, target.multiplexer.pipe_count)
            await device.set_voltage("AB", self.voltage)
            await asyncio.sleep(3.0)
            status = await device._status()
            if not (status & ST_FPGA_RDY):
                raise RuntimeError(f"vacuum FPGA target is not ready; status={status:#04x}")

            # Match the scan launcher’s post-download settle period before
            # opening the applet interface.
            await asyncio.sleep(1.2)

            return await applet.run(device, args)
        except BaseException:
            device.close()
            raise
