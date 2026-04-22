import asyncio
import logging
from .abc import Stream, Connection
from ..IobeamLauncher import IobeamLauncher
from IobeamControl.glasgowLib.glasgow.support.logging import dump_hex

logger = logging.getLogger('GlasgowStream')


class GlasgowStream(Stream):
    def __init__(self, iface):
        if iface is None:
            raise RuntimeError("Cannot initialize GlasgowStream with None interface")
        self.lower = iface

    async def write(self, data):
        logger.debug(f"send: data=<{dump_hex(data)}>")
        await self.lower.write(data)
        logger.debug(f"send: done")

    async def flush(self):
        logger.debug(f"flush")
        await self.lower.flush()
        logger.debug(f"flush: done")

    async def read(self, length):
        before = len(self.lower._in_buffer)
        print(f"[GlasgowStream.read] requested={length}  in_buffer_before={before}", flush=True)
        try:
            data = await self.lower.read(length)
            after = len(self.lower._in_buffer)
            got = len(data) if data is not None else 0
            print(f"[GlasgowStream.read] returned={got}  in_buffer_after={after}", flush=True)
            return data
        except Exception as e:
            after = len(self.lower._in_buffer)
            print(f"[GlasgowStream.read] EXCEPTION  in_buffer_at_fail={after}  type={type(e).__name__}", flush=True)
            raise

    async def readexactly(self, length):
        return await self.lower.read(length)

    async def readuntil(self, separator=b'\n', *, flush=True, max_count=False):
        # ------------------------------------------------------------------ #
        # NOTE: The original implementation used find_sep() which only
        # searched within the current ChunkedFIFO chunk. The 4-byte sync
        # separator (\xff\xff + 2-byte cookie) almost always arrives split
        # across two USB transfer chunks, so find_sep() returned -1 forever
        # even though all bytes were present — causing the 20s timeout.
        #
        # This implementation accumulates bytes into a local bytearray and
        # searches the full accumulated content, correctly handling separators
        # that span chunk boundaries.
        # ------------------------------------------------------------------ #
        seplen = len(separator)
        if seplen == 0:
            raise ValueError('Separator must be at least one byte')

        # Flush any pending writes before waiting for a response.
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
                logger.error(f"Failed to wait for USB data: {e}")
                raise ConnectionError(
                    "Hardware I/O Error: The Glasgow interface disconnected.") from e

        result    = accumulated[:isep + seplen]
        remainder = accumulated[isep + seplen:]

        if remainder:
            self.lower._in_buffer.write(bytes(remainder))

        return memoryview(bytes(result))


class GlasgowConnection(Connection):
    def __init__(self, config):
        super(GlasgowConnection, self).__init__()
        self._stream = None
        self._config = config

    def connect(self, stream):
        self._stream = stream

    async def _connect(self):
        assert not self.connected
        launcher = IobeamLauncher(self._config)
        iface = await launcher.start()
        if iface is None:
            raise ConnectionError("Launcher failed to start: Interface is None")
        self._stream = GlasgowStream(iface)
        logger.debug("Successfully connected and wrapped GlasgowStream")