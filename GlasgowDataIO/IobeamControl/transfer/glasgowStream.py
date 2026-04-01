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
        def find_sep(buffer, separator=b'\n', offset=0):
            if buffer._chunk is None:
                if not buffer._queue:
                    raise asyncio.IncompleteReadError
                buffer._chunk  = buffer._queue.popleft()
                buffer._offset = 0
            return buffer._chunk.obj.find(separator)

        if flush and len(self.lower._out_buffer) > 0:
            # Flush the buffer, so that everything written before the read reaches the device.
            await self.lower.flush(wait=False)

        seplen = len(separator)
        if seplen == 0:
            raise ValueError('Separator should be at least one-byte string')
        chunks = []

        # Loop until we find `separator` in the buffer, exceed the buffer size,
        # or an EOF has happened.
        while True:
            buflen = len(self.lower._in_buffer)

            if max_count & (buflen >= max_count):
                break
        
            # Check if we now have enough data in the buffer for `separator` to fit.
            if buflen >= seplen:
                isep = find_sep(self.lower._in_buffer, separator)
                if isep != -1:
                    print(f"found {isep=}")
                    # `separator` is in the buffer. `isep` will be used later
                    # to retrieve the data.
                    break
            else:
                while len(self.lower._in_buffer) < seplen:
                    print(f"{len(self.lower._in_tasks)=}")
                    logger.debug("FIFO: need %d bytes", seplen - len(self.lower._in_buffer))
                    await self.lower._in_tasks.wait_one()

            async with self.lower._in_pushback:
                chunk = self.lower._in_buffer.read()
                self.lower._in_pushback.notify_all()
                chunks.append(chunk)
            
        if not (max_count & (buflen >= max_count)):
            async with self.lower._in_pushback:
                chunk = self.lower._in_buffer.read(isep+seplen)
                self.lower._in_pushback.notify_all()
                chunks.append(chunk)
        
        # Always return a memoryview object, to avoid hard to detect edge cases downstream.
        result = memoryview(b"".join(chunks))
        return result
    
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

