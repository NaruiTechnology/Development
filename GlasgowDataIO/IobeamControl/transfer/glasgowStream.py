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
        # 1. Define finding logic locally to avoid scope errors
        def find_sep(buffer, separator):
            if buffer._chunk is None:
                if not buffer._queue:
                    return -1
                buffer._chunk  = buffer._queue.popleft()
                buffer._offset = 0
            # Search within the current active chunk
            return buffer._chunk.obj.find(separator)

        # 2. Pre-calculate lengths
        seplen = len(separator)
        if seplen == 0:
            raise ValueError('Separator must be at least one byte')

        # 3. Handle pending writes
        if flush and len(self.lower._out_buffer) > 0:
            await self.lower.flush(wait=False)

        # 4. The main wait loop
        while True:
            buflen = len(self.lower._in_buffer)
            
            # Check for separator or max_count as before
            if buflen >= seplen:
                isep = find_sep(self.lower._in_buffer, separator)
                if isep != -1:
                    break
            
            if max_count and buflen >= max_count:
                isep = buflen - seplen
                break

            # PROTECT LINE #73 OF TASK_QUEUE.PY
            # Instead of a direct await, we verify the queue is still healthy.
            # If libusb has crashed, _in_tasks will often raise an exception here.
            try:
                if not self.lower._in_tasks:
                    # The queue has been cleared/cancelled due to an I/O error
                    raise ConnectionError("USB TaskQueue is empty or crashed.")
                
                # We use a timeout to prevent an infinite hang if the hardware 
                # stops responding without raising a clean exception.
                await asyncio.wait_for(self.lower._in_tasks.wait_one(), timeout=5.0)
                
            except (asyncio.TimeoutError, Exception) as e:
                logger.error(f"Failed to wait for USB data: {e}")
                # This catches the LIBUSB_ERROR_IO bubbling up from the queue
                raise ConnectionError("Hardware I/O Error: The Glasgow interface disconnected.") from e

        # Final extraction
        chunk = self.lower._in_buffer.read(isep + seplen)
        return memoryview(chunk)
                 
class GlasgowConnection(Connection):
    def __init__(self, config):
        super(GlasgowConnection, self).__init__()
        self._stream = None
        self._config = config

    def connect(self, stream):
        self._stream = stream

    async def _connect(self):
        assert not self.connected
        """ launcher  = IobeamLauncher(self._config)
        self._stream = GlasgowStream(await launcher.start()) """
        # Gemimi suggests that we should separate the concerns of launching and connecting, so that we can have more control over the connection lifecycle. This also allows us to handle cases where the launcher might fail to start or return a None interface.
        launcher = IobeamLauncher(self._config)
        iface = await launcher.start()
        if iface is None:
            raise ConnectionError("Launcher failed to start: Interface is None")
        
        # Crucial: Assign the wrapped stream
        self._stream = GlasgowStream(iface)
        logger.debug("Successfully connected and wrapped GlasgowStream")

