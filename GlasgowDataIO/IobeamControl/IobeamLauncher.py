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

        # Record the exact Python/config provenance for field diagnostics. A
        # bitstream ID alone is not enough when multiple source trees are
        # installed on the host.
        self._logger.info(
            "IobeamLauncher: source=%s config=%s",
            __file__, getattr(self._config, "_jsonFile", "<inline>"))

        # ------------------------------------------------------------------ #
        # 1.  Open device and build Amaranth design                           #
        # ------------------------------------------------------------------ #
        applet = DataStreamApplet(self._config)

        buffer_size    = eval(actionConfig.get("bufferSize", "1024*1024"))
        pin_list       = [
            f"{p.get('port')}{n}"
            for p in actionConfig.get("ports", [])
            for n in p.get("pinList", [])
        ]
        self._logger.info("IobeamLauncher: stream pins=%s", ",".join(pin_list) or "<none>")
        self._logger.info(
            "Scan acquisition: production=%s adc_half_period=%s adc_settle_cycles=%s "
            "adc_latch_cycles=%s bus_turnaround_cycles=%s dac_data_setup_cycles=%s "
            "dac_latch_cycles=%s nominal_adc_hz=%.1f adc_clock_inverted=%s dac_clock_inverted=%s",
            getattr(self._config, "IsProduction", None),
            actionConfig.get("adcHalfPeriod", 4), actionConfig.get("adcSettleCycles", 1),
            actionConfig.get("adcLatchCycles", 1),
            actionConfig.get("busTurnaroundCycles", 1),
            actionConfig.get("dacDataSetupCycles", 1),
            actionConfig.get("dacLatchCycles", 1),
            48_000_000 / (2 * int(actionConfig.get("adcHalfPeriod", 4))),
            next((p.get("invert", False) for p in actionConfig.get("pins", {}).get(
                "control", {}).get("subsignals", []) if p.get("name") == "adc_clk"), None),
            next((p.get("invert", False) for p in actionConfig.get("pins", {}).get(
                "control", {}).get("subsignals", []) if p.get("name") == "dac_clk"), None))

        applet_args = SimpleNamespace(
            pins         = GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            buffer_size  = buffer_size,
            sample_rate  = 1_000_000,
        )

        async def prepare(device):
            # Open the applet run gate before claiming the interface so the
            # FPGA may send data as soon as _activate() releases reset.
            await device.write_register(applet.addr_reset, 1)
            await device.write_register(applet.addr_bus_ownership_clear, 1)
            await device.write_register(applet.addr_bus_ownership_clear, 0)
            self._logger.info("Run gate open")

        iface, image_programmed = await self._launch_applet(
            applet, applet_args, deviceId=deviceId, prepare=prepare)
        iface.iobeam_bus_ownership_addr = applet.addr_bus_ownership
        iface.iobeam_power_good_addr = applet.addr_power_good

        if image_programmed:
            await asyncio.sleep(0.5)
        self._logger.info(
            "IobeamLauncher: initialisation complete in %.3fs (%s image)",
            time.monotonic() - connect_started,
            "programmed" if image_programmed else "cached",
        )
        return iface

    async def _launch_applet(self, applet, applet_args, *, deviceId=None,
                             prepare=None):
        """Shared Glasgow build/download/claim lifecycle for Iobeam applets."""
        device = GlasgowDevice(deviceId)
        target = GlasgowHardwareTarget(
            revision=device.revision, multiplexer_cls=DirectMultiplexer)
        applet.build(target, applet_args)
        plan = target.build_plan()
        self._logger.info("launcher: building bitstream %s", plan.bitstream_id.hex())
        image_programmed = await device.download_target(plan, reload=True)
        self._logger.info("launcher: loaded bitstream %s (build_dir=%s)",
                          plan.bitstream_id.hex(), plan.buildDir)
        device.demultiplexer = DirectDemultiplexer(
            device, target.multiplexer.pipe_count)
        if image_programmed:
            await asyncio.sleep(3.0)
        status = await device._status()
        if not (status & ST_FPGA_RDY):
            device.close()
            raise RuntimeError(
                "FPGA is not ready after bitstream download. "
                f"Status register = {status:#04x}")
        if image_programmed:
            await asyncio.sleep(1.2)
        if prepare is not None:
            await prepare(device)
        iface = await device.demultiplexer.claim_interface(
            applet, applet.mux_interface, applet_args,
            read_buffer_size=applet_args.buffer_size,
            write_buffer_size=applet_args.buffer_size,
            pull_high=getattr(applet_args, "beam_pull_high", []),
        )
        return iface, image_programmed


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
