from abc import abstractmethod, ABCMeta
import asyncio
import random
import struct

import logging
logger = logging.getLogger()

from GlasgowDataIO.IobeamControl.commands.low_level_commands import SynchronizeCommand, FlushCommand
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from AutomationPy.buildingblocks.automation_log import AutomationLog

class TransferError(Exception):
    pass

class Stream(metaclass = ABCMeta):
    def __init__(self, config):
        self._logger = AutomationLog.GetLogger(config.LogName) if config is not None else logger.getChild("Stream")
    
    @abstractmethod
    async def write(self, data: bytes | bytearray | memoryview):
        ...
    @abstractmethod
    async def flush(self):
        ...
    @abstractmethod
    async def read(self, length: int) -> memoryview:
        ...
    @abstractmethod
    async def readuntil(self, separator=b'\n', *, flush=True, max_count=False) -> memoryview:
        ...

class Connection(metaclass = ABCMeta):
    def __init__(self, config = None):
        self._logger = self._logger = AutomationLog.GetLogger(config.LogName) if config is not None else logger.getChild("Connection")
        self._stream = None
        self._synchronized = False
        self._next_cookie = random.randrange(0, 0x10000, 2)

    @property
    def connected(self):
        return self._stream is not None

    @property
    def synchronized(self):
        return self._synchronized

    @abstractmethod
    async def _connect(self):
        ...

    def _disconnect(self):
        if not self.connected:
            return
        self._stream = None
        self._synchronized = False

    async def _post_transfer_cleanup(self):
        """Hook called after every transfer*() call returns or raises.

        Subclasses with hardware state that must be cycled between transfers
        override this. The default is a no-op so MockConnection and any
        non-hardware backend stays clean.

        Implementations MUST be idempotent and tolerant of being called when
        the stream is already torn down — they run in `finally` blocks.
        """
        return

    async def _synchronize(self):
        if not self.connected:
            await self._connect()
        if self.synchronized:
            self._logger.debug("already synced")
            return

        cookie, self._next_cookie = self._next_cookie, (self._next_cookie + 2) & 0xffff
        self._logger.debug(f'synchronizing with cookie {cookie:#06x}')

        cmd = bytearray()
        cmd.extend(bytes(SynchronizeCommand(raster=True, output=OutputMode.SixteenBit, cookie=cookie)))
        cmd.extend(bytes(FlushCommand()))
        await self._stream.write(cmd)
        await self._stream.flush()
        res = struct.pack(">HH", 0xffff, cookie)
        data = await self._stream.readuntil(res)
        if not bytes(data).endswith(res):
            self._logger.error(f"unexpected synchronization response: {data!r} (expected to end with {res!r})")
            raise TransferError("synchronization failed")

        self._synchronized = True
        self._logger.debug("synchronization complete")

    def _handle_incomplete_read(self, exc):
        self._disconnect()
        raise TransferError("connection closed") from exc

    def get_cookie(self):
        cookie, self._next_cookie = (self._next_cookie + 1) & 0xffff, (self._next_cookie + 2) & 0xffff
        self._logger.debug(f"allocating cookie {cookie:#06x}")
        return cookie

    async def transfer(self, command, **kwargs):
        self._logger.debug(f"transfer {command!r}")
        try:
            if not self.synchronized:
                await self._synchronize()
            return await command.transfer(self._stream, **kwargs)
        except asyncio.IncompleteReadError as e:
            self._handle_incomplete_read(e)
        finally:
            await self._post_transfer_cleanup()

    async def transfer_multiple(self, command, **kwargs):
        self._logger.debug(f"transfer multiple {command!r}")
        try:
            if not self.synchronized:
                await self._synchronize()
            self._logger.debug(f"synchronize transfer_multiple")
            async for value in command.transfer(self._stream, **kwargs):
                yield value
                self._logger.debug(f"yield transfer_multiple")
        except asyncio.IncompleteReadError as e:
            self._handle_incomplete_read(e)
        finally:
            await self._post_transfer_cleanup()

    async def transfer_raw(self, command, flush:bool = False, **kwargs):
        self._logger.debug(f"transfer {command!r}")
        try:
            await self._synchronize()
            await self._stream.write(bytes(command))
            await self._stream.flush()
        finally:
            await self._post_transfer_cleanup()

    async def transfer_bytes(self, data:bytes, flush:bool = False, **kwargs):
        try:
            if not self.synchronized:
                await self._synchronize()
            await self._stream.write(data)
            await self._stream.flush()
        finally:
            await self._post_transfer_cleanup()
