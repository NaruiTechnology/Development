"""Launcher for the isolated ADC-only FPGA image."""

import asyncio
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
            port_spec="AB",
            voltage=float(action.get("voltage", 3.3)),
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            pipes="PQ",
            buffer_size=int(eval(str(action.get("bufferSize", "1024*1024")),
                                 {"__builtins__": {}}, {})),
            sample_rate=1_000_000,
            action_data=action,
            clock_hz=48_000_000,
        )

        async def prepare(device):
            # Keep capture disabled throughout interface/FIFO reset.
            await device.write_register(applet.addr_capture_enable, 0)

        iface, programmed = await self._launch_applet(
            applet, args, deviceId=resolved_device_id, prepare=prepare)
        iface.adc_capture_enable_addr = applet.addr_capture_enable
        iface.adc_capture_status_addr = applet.addr_capture_status
        iface.iobeam_power_good_addr = applet.addr_power_good
        iface.adc_duration_minutes = self.duration_minutes
        try:
            # Start only after _activate has reset the FIFOs, queued USB reads
            # and released the multiplexer reset. Verify the producer instead
            # of discovering a failed start through a bulk-transfer timeout.
            await iface.device.write_register(applet.addr_capture_enable, 1)
            status = 0
            for _ in range(20):
                status = await iface.device.read_register(applet.addr_capture_status)
                if status & 0x05 == 0x05 or status & 0x06 == 0x06:
                    break
                await asyncio.sleep(0.01)
            else:
                raise RuntimeError(f"ADC capture did not start: FPGA status=0x{status:02x}")
            self._logger.info(
                "ADC capture armed: enable_addr=%d status_addr=%d status=0x%02x "
                "half_period=%d settle=%d source=%s",
                applet.addr_capture_enable, applet.addr_capture_status, status,
                int(action.get("adcHalfPeriod", 6)),
                int(action.get("adcSettleCycles", 2)), __file__)
        except BaseException:
            try:
                await iface.device.write_register(applet.addr_capture_enable, 0)
            except Exception as exc:
                self._logger.warning("ADC startup disable: %s: %s", type(exc).__name__, exc)
            finally:
                try:
                    await iface.cancel()
                except Exception as exc:
                    self._logger.warning("ADC startup cleanup: %s: %s", type(exc).__name__, exc)
                finally:
                    iface.device.close()
            raise
        self._logger.info(
            "AdcLauncher ready in %.3fs (%s image, simulation=%s, duration=%dm)",
            time.monotonic() - started,
            "programmed" if programmed else "cached",
            self.simulation,
            self.duration_minutes,
        )
        return iface
