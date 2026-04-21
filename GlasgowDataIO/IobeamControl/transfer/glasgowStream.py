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
        return await self.lower.read(length)

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
            # Drain everything currently available in the in_buffer into
            # our local accumulator so we can search across chunk boundaries.
            available = len(self.lower._in_buffer)
            if available > 0:
                chunk_data = self.lower._in_buffer.read(available)
                accumulated.extend(bytes(chunk_data))

            # Search the full accumulated content for the separator.
            isep = accumulated.find(separator)
            if isep != -1:
                break

            # max_count support: if we have enough data, stop searching
            # and return up to max_count bytes.
            if max_count and len(accumulated) >= max_count:
                isep = len(accumulated) - seplen
                break

            # Need more data — wait for the next IN transfer to complete.
            try:
                if not self.lower._in_tasks:
                    raise ConnectionError("USB TaskQueue is empty or crashed.")

                await asyncio.wait_for(
                    self.lower._in_tasks.wait_one(), timeout=20.0)

            except (asyncio.TimeoutError, Exception) as e:
                logger.error(f"Failed to wait for USB data: {e}")
                raise ConnectionError(
                    "Hardware I/O Error: The Glasgow interface disconnected.") from e

        # Separator found at isep. Return everything up to and including it.
        result    = accumulated[:isep + seplen]
        remainder = accumulated[isep + seplen:]

        # Put any bytes that arrived after the separator back into the
        # in_buffer so the next read() call sees them.
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
