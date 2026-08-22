import asyncio
import time
from types import SimpleNamespace
from .applet.DataStreamApplet import DataStreamApplet
from .glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
from .glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from .glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer

import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.automation_log import AutomationLog
from .glasgowLib.glasgow.abstract import GlasgowPin

class IobeamLauncher:
    def __init__(self, config):
        self._config = config
        self._logger = AutomationLog.GetLogger(name=config.LogName)

    async def start(self, deviceId=None):
        return await self.run()

    async def run(self):
        connect_started = time.monotonic()
        stateConfig  = util.GetStateConfigByName(self._config, Consts.STREAM_DATA)
        deviceId     = self._config.Glasgow.get("DeviceId")
        actionConfig = stateConfig.get(Consts.ACTION_DATA)

        # ------------------------------------------------------------------ #
        # 1.  Open device and build Amaranth design                           #
        # ------------------------------------------------------------------ #
        device = GlasgowDevice(deviceId)
        target = GlasgowHardwareTarget(revision=device.revision,
                                       multiplexer_cls=DirectMultiplexer)
        applet = DataStreamApplet(self._config)

        action_voltage = actionConfig.get("voltage", 2.5)
        buffer_size    = eval(actionConfig.get("bufferSize", "1024*1024"))
        pin_list       = [
            f"{p.get('port')}{n}"
            for p in actionConfig.get("ports", [])
            for n in p.get("pinList", [])
        ]

        applet_args = SimpleNamespace(
            voltage_map  = {"A": action_voltage, "B": action_voltage},
            pins         = GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            buffer_size  = buffer_size,
            sample_rate  = 1_000_000,
        )

        # build() populates target with the subtarget and registers the
        # multiplexer interface.  It must be called before build_plan().
        applet.build(target, applet_args)

        # ------------------------------------------------------------------ #
        # 2.  Synthesise and flash bitstream                                  #
        # ------------------------------------------------------------------ #
        plan = target.build_plan()

        # The plan ID is deterministic for the generated design. The device
        # retains the ID of the running FPGA image, so download_target() can
        # skip synthesis and programming when the same image is still loaded.
        image_programmed = await device.download_target(plan, reload=False)

        # DirectDemultiplexer is constructed AFTER download_target so the USB
        # configuration switch runs on a fully-enumerated, stable device.
        device.demultiplexer = DirectDemultiplexer(device,
                                                   target.multiplexer.pipe_count)

        await device.set_voltage("AB", action_voltage)
        if image_programmed:
            await asyncio.sleep(3.0)

        # ------------------------------------------------------------------ #
        # 3.  Verify FPGA is alive and open the run gate                      #
        # ------------------------------------------------------------------ #
        status = await device._status()
        if not (status & ST_FPGA_RDY):
            raise RuntimeError(
                "FPGA is not ready after bitstream download. "
                f"Status register = {status:#04x}")

        if image_programmed:
            await asyncio.sleep(1.2)

        # Open the applet run gate (gates in_fifo.w_en in IobeamDataSubtarget).
        # This must be written before claim_interface so the FPGA can send data
        # as soon as the demultiplexer reset is deasserted inside _activate().
        await device.write_register(applet.addr_reset, 1)
        self._logger.info("Run gate open")

        # ------------------------------------------------------------------ #
        # 4.  Claim the streaming interface                                   #
        # ------------------------------------------------------------------ #
        iface = await device.demultiplexer.claim_interface(
            applet, applet.mux_interface, applet_args,
            read_buffer_size  = applet_args.buffer_size,
            write_buffer_size = applet_args.buffer_size,
        )

        if image_programmed:
            await asyncio.sleep(0.5)
        self._logger.info(
            "IobeamLauncher: initialisation complete in %.3fs (%s image)",
            time.monotonic() - connect_started,
            "programmed" if image_programmed else "cached",
        )
        return iface


if __name__ == "__main__":
    import argparse
    import os
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Load FPGA image onto the device.")
    parser.add_argument(
        "-j", dest="jsonfile",
        default=os.path.realpath("./Development/GlasgowDataIO/Json/directIo.json"),
        help="Config JSON file path")
    args = parser.parse_args()

    if not Path(args.jsonfile).is_file():
        raise ValueError(f"Cannot find JSON file: {args.jsonfile}")

    config   = AutomationConfig(args.jsonfile)
    launcher = IobeamLauncher(config) if not config.Simulate else None
    asyncio.run(launcher.start())
