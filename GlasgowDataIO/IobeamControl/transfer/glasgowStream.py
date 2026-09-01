import asyncio
import gc
from .abc import Stream, Connection
from ..IobeamLauncher import IobeamLauncher
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex

class GlasgowStream(Stream):
    def __init__(self, iface, config):
        super(GlasgowStream, self).__init__(config)
        if iface is None:
            raise RuntimeError("Cannot initialize GlasgowStream with None interface")
        self.lower = iface

    async def write(self, data):
        self._logger.debug(f"send: data=<{dump_hex(data)}>")
        await self.lower.write(data)
        self._logger.debug(f"send: done")

    async def flush(self):
        self._logger.debug(f"flush")
        await self.lower.flush()
        self._logger.debug(f"flush: done")

    async def read(self, length):
        before = len(self.lower._in_buffer)
        self._logger.debug(f"[GlasgowStream.read] requested={length}  in_buffer_before={before}")
        try:
            data = await self.lower.read(length)
            after = len(self.lower._in_buffer)
            got = len(data) if data is not None else 0
            print(f"[GlasgowStream.read] returned={got}  in_buffer_after={after}", flush=True)
            return data
        except Exception as e:
            after = len(self.lower._in_buffer)
            self._logger.debug(f"[GlasgowStream.read] EXCEPTION  in_buffer_at_fail={after}  type={type(e).__name__}")
            raise

    async def readexactly(self, length):
        return await self.lower.read(length)

    async def readuntil(self, separator=b'\n', *, flush=True, max_count=False):
        seplen = len(separator)
        if seplen == 0:
            raise ValueError('Separator must be at least one byte')

        if flush and len(self.lower._out_buffer) > 0:
            await self.lower.flush(wait=False)

        accumulated = bytearray()

        while True:
            available = len(self.lower._in_buffer)
            if available > 0:
                chunk_data = self.lower._in_buffer.read(available)
                accumulated.extend(bytes(chunk_data))

            isep = accumulated.find(separator)
            if isep != -1:
                break

            if max_count and len(accumulated) >= max_count:
                isep = len(accumulated) - seplen
                break

            try:
                if not self.lower._in_tasks:
                    raise ConnectionError("USB TaskQueue is empty or crashed.")

                await asyncio.wait_for(
                    self.lower._in_tasks.wait_one(), timeout=20.0)

            except (asyncio.TimeoutError, Exception) as e:
                self._logger.error(f"Failed to wait for USB data: {e}")
                raise ConnectionError(
                    "Hardware I/O Error: The Glasgow interface disconnected.") from e

        result    = accumulated[:isep + seplen]
        remainder = accumulated[isep + seplen:]

        if remainder:
            self.lower._in_buffer.write(bytes(remainder))

        return memoryview(bytes(result))


class GlasgowConnection(Connection):
    def __init__(self, config):
        super(GlasgowConnection, self).__init__(config)
        self._stream = None
        self._config = config
        #self._logger = AutomationLog.GetLogger(config.LogName)

    def connect(self, stream):
        self._stream = stream

    async def _connect(self):
        assert not self.connected
        launcher = IobeamLauncher(self._config)
        iface = await launcher.start()
        if iface is None:
            raise ConnectionError("Launcher failed to start: Interface is None")
        self._stream = GlasgowStream(iface, self._config)
        self._logger.debug("Successfully connected and wrapped GlasgowStream")

    async def _hard_close(self) -> None:
        if self._stream is None:
            return

        iface = self._stream.lower
        device = iface.device

        # Read sticky FPGA observations before cancelling USB access. This
        # logs actual internal bus ownership activity from the completed
        # transfer without producing a line on every 48 MHz clock cycle.
        ownership_addr = getattr(iface, "iobeam_bus_ownership_addr", None)
        if ownership_addr is not None:
            try:
                ownership = await device.read_register(ownership_addr)
                adc_driving = bool(ownership & 0x01)
                fpga_driving = bool(ownership & 0x02)
                contention = bool(ownership & 0x04)
                turnaround = bool(ownership & 0x08)
                self._logger.info(
                    "Bus ownership observed: ADC driving "
                    "(adc_oe=1, data_oe=0)=%s; FPGA driving "
                    "(adc_oe=0, data_oe=1)=%s; turnaround=%s; contention=%s",
                    adc_driving, fpga_driving, turnaround, contention,
                )
                if contention:
                    self._logger.error(
                        "Bus ownership fault: adc_oe=1 and data_oe=1 were "
                        "observed simultaneously")
                if not adc_driving or not fpga_driving:
                    self._logger.warning(
                        "Incomplete bus ownership activity: adc_driving=%s "
                        "fpga_driving=%s", adc_driving, fpga_driving)
            except Exception as e:
                self._logger.warning(
                    "Unable to read FPGA bus ownership diagnostics: %s", e)

        # 1) Cancel in-flight bulk_read/bulk_write tasks cleanly, before yanking
        #    the USB handle out from under them. iface.cancel() is the library's
        #    documented way to do this and awaits the cancellations to settle.
        try:
            self._logger.debug("[CLEANUP] hard_close: cancelling demultiplexer tasks")
            await iface.cancel()
        except Exception as e:
            self._logger.debug(f"[CLEANUP] hard_close: iface.cancel() raised "
                f"{type(e).__name__}: {e} (continuing)")

        # 2) Yield once so any orphan background tasks (e.g. the sender task
        #    spawned by RasterScanCommand.transfer via asyncio.create_task) get
        #    a chance to observe the cancelled transfers and exit before the
        #    USB context goes away.
        await asyncio.sleep(0)

        # 3) Now actually close the USB device.
        try:
            self._logger.debug("[CLEANUP] hard_close: calling GlasgowDevice.close()")
            device.close()
            self._logger.debug("[CLEANUP] hard_close: GlasgowDevice.close() returned")
        except Exception as e:
            self._logger.debug(f"[CLEANUP] hard_close: device.close() raised "
                f"{type(e).__name__}: {e} (continuing teardown)")

        self._stream = None
        self._synchronized = False
        gc.collect()
        self._logger.info("[CLEANUP] hard_close: references dropped, GC run")
    
    async def _post_transfer_cleanup(self):
        """Tear down and rebuild the connection between transfers.

        A full disconnect releases the USB handle and cancels every pending
        transfer. On the next IobeamLauncher run, download_target() reuses a
        matching FPGA image, while DirectDemultiplexerInterface._activate()
        pulses the gateware reset so the command parser and FIFOs start clean.
        A changed image is still synthesized and programmed normally.

        Idempotency: this is called from `finally` blocks. If the stream
        is already torn down (prior cleanup, exception during _connect),
        we no-op silently. If hard_close itself raises, we swallow it —
        the next _connect() either succeeds or surfaces a real error.
        """
        if self._stream is None:
            return
        try:
            await self._hard_close()
        except Exception as e:
            self._logger.debug(f"[CLEANUP] _post_transfer_cleanup unexpected error "
                  f"{type(e).__name__}: {e}")
            # Force-clear references regardless.
            self._stream = None
            self._synchronized = False
