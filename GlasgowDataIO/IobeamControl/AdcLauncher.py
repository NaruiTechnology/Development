"""Launcher for the isolated ADC-only FPGA image."""

import time
from types import SimpleNamespace

import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.definitions import Consts

from .IobeamLauncher import IobeamLauncher
from .applet.AdcDataStreamApplet import AdcDataStreamApplet
from .glasgowLib.glasgow.abstract import GlasgowPin


class AdcLauncher(IobeamLauncher):
    def __init__(self, config, *, duration_minutes=5, simulation=False, seed=1,
                 duration_cycles=None):
        super().__init__(config)
        self.duration_minutes = int(duration_minutes)
        self.simulation = bool(simulation)
        self.seed = int(seed)
        self.duration_cycles = duration_cycles

    async def start(self, deviceId=None):
        started = time.monotonic()
        state = util.GetStateConfigByName(self._config, Consts.STREAM_DATA)
        action = state.get(Consts.ACTION_DATA, {}) or {}
        resolved_device_id = deviceId or self._config.Glasgow.get("DeviceId")
        applet = AdcDataStreamApplet(
            self._config,
            duration_minutes=self.duration_minutes,
            simulation=self.simulation,
            seed=self.seed,
            duration_cycles=self.duration_cycles,
        )
        pin_list = [
            f"{port.get('port')}{number}"
            for port in action.get("ports", [])
            for number in port.get("pinList", [])
        ]
        args = SimpleNamespace(
            voltage_map={"A": action.get("voltage", 3.3),
                         "B": action.get("voltage", 3.3)},
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            pipes="PQ",
            buffer_size=int(eval(str(action.get("bufferSize", "1024*1024")),
                                 {"__builtins__": {}}, {})),
            sample_rate=1_000_000,
            action_data=action,
            clock_hz=48_000_000,
        )

        async def prepare(device):
            # Arm from a known disabled edge. The applet's hardware timer will
            # release physical OE even if the host disappears mid-capture.
            await device.write_register(applet.addr_capture_enable, 0)
            await device.write_register(applet.addr_capture_enable, 1)

        iface, programmed = await self._launch_applet(
            applet, args, deviceId=resolved_device_id, prepare=prepare)
        iface.adc_capture_enable_addr = applet.addr_capture_enable
        iface.adc_capture_status_addr = applet.addr_capture_status
        iface.adc_duration_minutes = self.duration_minutes
        self._logger.info(
            "AdcLauncher ready in %.3fs (%s image, simulation=%s, duration=%dm)",
            time.monotonic() - started,
            "programmed" if programmed else "cached",
            self.simulation,
            self.duration_minutes,
        )
        return iface

