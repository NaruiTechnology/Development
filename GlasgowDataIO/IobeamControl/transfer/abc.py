from abc import abstractmethod, ABCMeta
import asyncio
import logging
import random
import struct

logger = logging.getLogger()

from GlasgowDataIO.IobeamControl.commands.low_level_commands import SynchronizeCommand, FlushCommand
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from AutomationPy.buildingblocks.automation_log import AutomationLog


class TransferError(Exception):
    pass


class Stream(metaclass=ABCMeta):
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


# ---------------------------------------------------------------------------- #
# Auto-save hook for transfer_multiple
#
# Why this lives here instead of in the FastAPI handler:
# --------------------------------------------------------------------
# The display-save logic was previously written as a top-level helper
# (`save_scan_from_config`) that the FastAPI handler / pytest runner /
# any other call site had to invoke explicitly. In practice nobody
# wires it up, because it's easy to drop the helper file into the tree
# and forget the one-line invocation. Result: scans complete, return
# 200 OK, and no PNG appears.
#
# Hooking the save into Connection.transfer_multiple removes the
# requirement entirely. The connection ALREADY has self._config (an
# AutomationConfig) from when the caller constructed it, and it
# ALREADY sees every chunk go past on its way to the caller. So we
# accumulate chunks, yield them transparently to the caller, and once
# the generator exhausts we read display.* from streamData.json and
# save the PNG. Zero changes anywhere else.
#
# Failure is always silent: if matplotlib isn't installed, if the
# JSON has no `display` block, if `display.enabled` is false, if
# `saveAs` is empty -- the scan still succeeds, the caller still
# gets every chunk, and a single WARNING line is logged at most.
# A scan succeeding without producing a PNG is annoying; a scan
# FAILING because the PNG save raised would be much worse.
# --------------------------------------------------------------------

def _kind_for_command(command):
    """Map a command instance to a kind string for save_scan_from_config().

    Uses class-name matching rather than isinstance() so we don't
    introduce a circular import on macros.raster / macros.vector.
    Returns None for commands whose output isn't a scan image.
    """
    name = type(command).__name__
    if name == "RasterScanCommand":
        return "raster"
    if name == "VectorScanCommand":
        return "vector"
    return None


def _scan_config_for_kind(connection_config, kind):
    """Pull the rasterScan / vectorScan dict out of the AutomationConfig.

    Mirrors the lookup pattern the unit tests already use:
        util.GetStateConfigByName(config, 'streamData')[Consts.ACTION_DATA]
            .get('rasterScan' | 'vectorScan')
    Returns None on any missing piece -- the saver treats None as opt-out.
    """
    if connection_config is None:
        return None
    try:
        # Imported lazily so this module still imports on machines that
        # don't have AutomationPy on the path (e.g. simulation-only sims).
        import AutomationPy.buildingblocks.utils as util
        from AutomationPy.buildingblocks.definitions import Consts
    except ImportError:
        return None
    try:
        state_cfg = util.GetStateConfigByName(connection_config, Consts.STREAM_DATA)
        action    = state_cfg.get(Consts.ACTION_DATA, {}) or {}
    except Exception:
        return None
    return action.get("rasterScan" if kind == "raster" else "vectorScan")


def _vector_iter_points(command):
    """Best-effort recovery of the (x, y, dwell) iterator for a vector scan.

    VectorScanCommand stores its iterator on `_iter_points`; once
    `transfer()` has run, that generator is exhausted. If the user
    pre-processed the chunks (`_pre_process_chunks(...)`) we can't
    reconstruct the per-pixel coords from `_processed_points` (it only
    holds the raw command bytes). So we fall back to default_iter()
    if no usable iterator survived. For deterministic vector scans
    this happens to be correct; for custom iterators the scatter plot
    will be misaligned. Users who want exact custom-iterator display
    should pass display.enabled=true AND ensure their iterator can be
    re-instantiated, or call save_scan_from_config() explicitly.
    """
    try:
        from GlasgowDataIO.IobeamControl.macros.vector import default_iter
    except ImportError:
        return None
    return default_iter()


async def _auto_save_scan(command, chunks, connection_config):
    """Best-effort PNG save after transfer_multiple completes.

    Never raises; logs and returns on any error. Called from the
    successful exit path of transfer_multiple.
    """
    if not chunks:
        return

    kind = _kind_for_command(command)
    if kind is None:
        return

    scan_config = _scan_config_for_kind(connection_config, kind)
    if not scan_config:
        return

    # Cheap pre-check: if display.enabled is false we don't even need
    # to import scan_display. The scan_display helper does the same
    # check internally, but skipping the import keeps the hot path free.
    display_cfg = scan_config.get("display") or {}
    if not display_cfg.get("enabled"):
        return

    try:
        from GlasgowDataIO.IobeamControl.macros.scan_display import save_scan_from_config
    except ImportError as exc:
        logger.warning(f"auto-save: scan_display unavailable: {exc}")
        return

    try:
        if kind == "raster":
            # Resolution comes from the command itself, not the JSON,
            # so an out-of-date `rasterScan.resolution` in the JSON
            # doesn't desync the imshow grid from the real scan.
            x_res = getattr(command._x_range, "count", None) if hasattr(command, "_x_range") else None
            y_res = getattr(command._y_range, "count", None) if hasattr(command, "_y_range") else None
            saved = save_scan_from_config(
                chunks, "raster", scan_config,
                x_res=x_res, y_res=y_res,
            )
        else:
            saved = save_scan_from_config(
                chunks, "vector", scan_config,
                iter_points=_vector_iter_points(command),
            )
        if saved:
            logger.info(f"auto-save: wrote {kind} scan to {saved}")
    except Exception as exc:
        logger.warning(f"auto-save: failed to save {kind} scan: {exc}")


class Connection(metaclass=ABCMeta):
    def __init__(self, config=None):
        self._logger = AutomationLog.GetLogger(config.LogName) if config is not None else logger.getChild("Connection")
        self._stream = None
        self._synchronized = False
        self._next_cookie = random.randrange(0, 0x10000, 2)
        # Stash the config so transfer_multiple's auto-save hook can
        # find it. Subclasses (GlasgowConnection, MockConnection) also
        # store this themselves; we keep our own reference here to
        # avoid relying on subclass behaviour.
        self._config = config

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
        the stream is already torn down -- they run in `finally` blocks.
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
        """Stream chunks from `command` and (best-effort) save a PNG.

        Auto-save behaviour:
          * Activates when self._config is an AutomationConfig that
            carries a `streamData.action.<rasterScan|vectorScan>.display`
            block with `enabled: true` and a non-empty `saveAs` path.
          * Path is expanded ($VARS + ~) by save_scan_from_config.
          * Save failure never breaks the scan; chunks are yielded to
            the caller exactly as before.
        """
        self._logger.debug(f"transfer multiple {command!r}")

        # Accumulator for the auto-save hook. We append a reference to
        # each yielded value (typically array.array('H')) -- no copies,
        # cheap. If the caller iterates with `async for ch in ...:`
        # the same `ch` object is both yielded and stored.
        captured_chunks = []
        command_iter = None

        try:
            if not self.synchronized:
                await self._synchronize()
            self._logger.debug(f"synchronize transfer_multiple")
            command_iter = command.transfer(self._stream, **kwargs)
            async for value in command_iter:
                if value is not None:
                    captured_chunks.append(value)
                yield value
                self._logger.debug(f"yield transfer_multiple")
        except asyncio.IncompleteReadError as e:
            self._handle_incomplete_read(e)
        else:
            # Success path only: save the assembled frame. We swallow
            # everything inside _auto_save_scan, but wrap defensively
            # here too so a freak issue can never poison the cleanup
            # in the finally block below.
            try:
                await _auto_save_scan(command, captured_chunks, self._config)
            except Exception as exc:
                self._logger.warning(f"auto-save unexpected failure: {exc}")
        finally:
            try:
                # Async-for does not guarantee that a nested async generator
                # is closed when this generator is closed at one of its yield
                # points. Propagate WebSocket Stop/cancellation explicitly so
                # command-owned sender tasks exit before USB teardown.
                if command_iter is not None:
                    await command_iter.aclose()
            finally:
                await self._post_transfer_cleanup()

    async def transfer_raw(self, command, flush: bool = False, **kwargs):
        self._logger.debug(f"transfer {command!r}")
        try:
            await self._synchronize()
            await self._stream.write(bytes(command))
            await self._stream.flush()
        finally:
            await self._post_transfer_cleanup()

    async def transfer_bytes(self, data: bytes, flush: bool = False, **kwargs):
        try:
            if not self.synchronized:
                await self._synchronize()
            await self._stream.write(data)
            await self._stream.flush()
        finally:
            await self._post_transfer_cleanup()
