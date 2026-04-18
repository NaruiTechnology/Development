import asyncio
import logging
from types import SimpleNamespace

import usb1

from .applet.DataStreamApplet import DataStreamApplet
from .glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
from .glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from .glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer

import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from IobeamControl.glasgowLib.glasgow.abstract import GlasgowPin

logger = logging.getLogger(__name__)


class IobeamLauncher:
    def __init__(self, config):
        self._config = config

    async def start(self, deviceId=None):
        return await self.run()

    async def run(self):
        stateConfig  = util.GetStateConfigByName(self._config, Consts.STREAM_DATA)
        deviceId     = self._config.Glasgow.get("DeviceId")
        actionConfig = stateConfig.get(Consts.ACTION_DATA)

        # ------------------------------------------------------------------ #
        # 1.  Open device and build Amaranth design                           #
        # ------------------------------------------------------------------ #
        device = GlasgowDevice(deviceId)
        target = GlasgowHardwareTarget(revision=device.revision,
                                       multiplexer_cls=DirectMultiplexer)
        applet = DataStreamApplet()

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
        # 2.  Synthesise bitstream                                            #
        #                                                                     #
        # plan.execute() is NOT called here explicitly.                       #
        # download_target() calls plan.get_bitstream() which calls            #
        # execute() internally, caches the result, and passes the bytes       #
        # directly to download_bitstream().  No file path is needed.          #
        #                                                                     #
        # If you need to inspect top.v / top.bin after the build, change      #
        # reload=True  to also pass  debug=True to get_bitstream, or call:    #
        #   bitstream = await plan.get_bitstream(debug=True)                  #
        #   logger.info("build dir: %s", plan.buildDir)                       #
        # ------------------------------------------------------------------ #
        device.demultiplexer = DirectDemultiplexer(device,
                                                   target.multiplexer.pipe_count)
        plan = target.build_plan()

        # reload=True forces re-flash even when bitstream_id hasn't changed.
        # Keep this True while iterating on HDL; switch to False in production.
        await device.download_target(plan, reload=True)
        await device.set_voltage("AB", action_voltage)

        # ------------------------------------------------------------------ #
        # 3.  Claim the streaming interface                                   #
        # ------------------------------------------------------------------ #
        iface = await device.demultiplexer.claim_interface(
            applet, applet.mux_interface, applet_args,
            read_buffer_size  = applet_args.buffer_size,
            write_buffer_size = applet_args.buffer_size,
        )

        # Give the FPGA a moment to finish initialising after the bitstream
        # download before touching registers.
        await asyncio.sleep(1.5)

        # ------------------------------------------------------------------ #
        # 4.  Verify FPGA is alive and open the run gate                      #
        # ------------------------------------------------------------------ #
        status = await device._status()
        if not (status & ST_FPGA_RDY):
            raise RuntimeError(
                "FPGA is not ready after bitstream download. "
                f"Status register = {status:#04x}")

        """ # Read the magic register (addr_magic, initialised to 0xa5 in HDL).
        # If this times out the Glasgow register slave is missing from the
        # bitstream — check that BuildScriptUtil is NOT in the build path.
        logger.info("addr_magic=%d  addr_reset=%d",
                    applet.addr_magic, applet.addr_reset)
        try:
            magic = await asyncio.wait_for(
                device.read_register(applet.addr_magic),
                timeout=3.0)
        except asyncio.TimeoutError:
            raise RuntimeError(
                "Timed out reading magic register — the FPGA bitstream does not "
                "contain the Glasgow register slave.  Verify that BuildScriptUtil "
                "is not overwriting Amaranth's generated top.v in the build pipeline.")

        if magic != 0xa5:
            raise RuntimeError(
                f"Magic register returned {hex(magic)}, expected 0xa5. "
                "FPGA register bus is alive but the HDL value is wrong.")

        logger.info("Magic register OK (0xa5) — opening run gate")

        # Write 1 to addr_reset to assert run_enable in the subtarget,
        # which gates in_fifo.w_en and allows data to flow back to the host.
        await device.write_register(applet.addr_reset, 1)
 """        
        await asyncio.sleep(1.2)

        logger.info("IobeamLauncher: initialisation complete — returning interface")
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
