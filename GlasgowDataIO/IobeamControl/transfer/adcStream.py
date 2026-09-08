"""Host connection for the isolated ADC data stream."""

import gc
import asyncio
import time
from array import array
import sys

from AutomationPy.buildingblocks.automation_log import AutomationLog

from ..AdcLauncher import AdcLauncher


class AdcConnection:
    def __init__(self, config, *, duration_minutes=5, simulation=False, seed=1,
                 chunk_bytes=65536, duration_cycles=None):
        self._config = config
        self.duration_minutes = int(duration_minutes)
        self.simulation = bool(simulation)
        self.seed = int(seed)
        self.chunk_bytes = max(2, int(chunk_bytes)) & ~1
        self.duration_cycles = duration_cycles
        self.iface = None
        self._logger = AutomationLog.GetLogger(config.LogName)
        self._bytes = 0
        self._started = None

    @property
    def connected(self):
        return self.iface is not None

    async def connect(self):
        launcher = AdcLauncher(
            self._config,
            duration_minutes=self.duration_minutes,
            simulation=self.simulation,
            seed=self.seed,
            duration_cycles=self.duration_cycles,
        )
        self.iface = await launcher.start()
        self._started = time.monotonic()

    async def log_status(self, reason):
        if self.iface is None:
            return
        try:
            status = await self.iface.device.read_register(self.iface.adc_capture_status_addr)
            self._logger.info(
                "ADC FPGA %s: status=0x%02x running=%s complete=%s started=%s "
                "sampled=%s fifo_written=%s fifo_stalled=%s sample_dropped=%s received_bytes=%d",
                reason, status, *(bool(status & (1 << bit)) for bit in range(7)), self._bytes)
        except Exception as exc:
            self._logger.warning("ADC FPGA status unavailable (%s): %s: %s",
                                 reason, type(exc).__name__, exc)

    async def chunks(self, *, stop=None):
        if self.iface is None:
            await self.connect()
        pending = bytearray()
        next_log = 0
        stop_task = asyncio.create_task(stop.wait()) if stop is not None else None
        read_task = None
        try:
            while stop is None or not stop.is_set():
                # Consume available USB data instead of waiting for 64 KiB.
                # Carry odd packet tails so sample/sentinel alignment survives.
                read_task = asyncio.create_task(self.iface.read())
                if stop_task is not None:
                    await asyncio.wait((read_task, stop_task), return_when=asyncio.FIRST_COMPLETED)
                    if stop_task.done():
                        return
                data = bytes(await read_task)
                read_task = None
                pending.extend(data)
                while len(pending) >= 2:
                    length = min(len(pending) & ~1, self.chunk_bytes)
                    chunk = bytes(pending[:length])
                    del pending[:length]
                    marker = _aligned_sentinel(chunk)
                    if marker is not None:
                        chunk = chunk[:marker]
                    self._bytes += len(chunk)
                    elapsed = time.monotonic() - self._started
                    if chunk and elapsed >= next_log:
                        samples = array('H')
                        samples.frombytes(chunk)
                        if sys.byteorder == 'little':
                            samples.byteswap()
                        self._logger.info(
                            "ADC receive: elapsed=%.3fs bytes=%d chunk_samples=%d "
                            "min=0x%04x max=0x%04x first=%s",
                            elapsed, self._bytes, len(samples), min(samples), max(samples),
                            ','.join(f'{value:04x}' for value in samples[:8]))
                        next_log = elapsed + 5
                    if chunk:
                        yield chunk
                    if marker is not None:
                        await self.log_status("end-marker")
                        return
        except Exception as exc:
            self._logger.error("ADC read failed: %s: %s received_bytes=%d",
                               type(exc).__name__, exc, self._bytes)
            await self.log_status("read-error")
            raise
        finally:
            tasks = [task for task in (read_task, stop_task) if task is not None]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self):
        await self.log_status("close")
        iface, self.iface = self.iface, None
        if iface is None:
            return
        try:
            await iface.device.write_register(iface.adc_capture_enable_addr, 0)
        except Exception as exc:
            self._logger.warning("ADC disable failed: %s: %s", type(exc).__name__, exc)
        finally:
            try:
                await iface.cancel()
            except Exception as exc:
                # TaskQueue.cancel re-raises errors from already-failed USB
                # transfers. The read path reports those with FPGA status;
                # cleanup must not replace that error or a normal user stop.
                self._logger.warning("ADC USB cleanup: %s: %s", type(exc).__name__, exc)
            finally:
                iface.device.close()
                gc.collect()


def _aligned_sentinel(data):
    for index in range(0, len(data) - 1, 2):
        if data[index:index + 2] == b"\xff\xff":
            return index
    return None
