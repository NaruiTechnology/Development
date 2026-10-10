"""DeviceService for the desktop app: same scan semantics, persistent session.

Everything that decides *what* is scanned (request validation, ROI -> DAC
ranges, vector paths, adaptive gray feedback, chunk pacing, validation
reports, CSV/figure rendering) is inherited unchanged from
``glasgow_service.service.DeviceService``. Only the connection lifecycle and
the blocking side-work differ:

* ``_ensure_conn`` opens a :class:`PersistentGlasgowConnection` (open once,
  soft reset between scans, reprogram only when the image differs);
* the per-scan DumpData CSV/PNG, which the web service renders
  synchronously on its event loop, is handed to an out-of-process worker;
* the Glasgow ownership lock is held for the whole session, so the web
  service reports "held by the desktop app" instead of a libusb BUSY error.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

from glasgow_service.models import DeviceState
from glasgow_service.service import DeviceNotReady, DeviceService, _is_fatal_usb_error

from .persistent import PersistentGlasgowConnection, SessionStats

log = logging.getLogger("ionbeam_native.engine")


class DesktopDeviceService(DeviceService):
    #: Connection class (tests substitute an emulated Glasgow here).
    connection_cls = PersistentGlasgowConnection

    def __init__(self, config_path: str, *, force_reload: bool = False,
                 dump_sink: Optional[Callable[[dict], None]] = None):
        super().__init__(config_path)
        self.session_stats = SessionStats()
        self.force_reload = force_reload
        self._dump_sink = dump_sink

    # -------- identity -------------------------------------------------------

    def _device_lock_owner(self) -> str:
        return "Ion Beam desktop app"

    @property
    def config(self):
        return self._config

    @property
    def is_production(self) -> bool:
        return bool(getattr(self._config, "IsProduction", True))

    @property
    def session_open(self) -> bool:
        return self._conn is not None and self._conn.connected

    # -------- connection lifecycle ------------------------------------------

    async def _ensure_conn(self):
        if self._conn is not None and self._conn.connected:
            return self._conn
        log.info("desktop session: opening Glasgow (persistent)")
        self._claim_device()
        self._status.state = DeviceState.CONNECTING
        try:
            conn = self.connection_cls(
                self._config, force_reload=self.force_reload, stats=self.session_stats)
            await conn._connect()
            if not conn.connected:
                raise DeviceNotReady("GlasgowConnection._connect() reported not connected")
            self._conn = conn
        except Exception as e:
            self._conn = None
            self._status.state = DeviceState.ERROR
            self._status.last_error = repr(e)
            if _is_fatal_usb_error(e):
                raise DeviceNotReady(str(e)) from e
            raise
        self._status.state = DeviceState.IDLE
        self._status.last_error = None
        log.info("desktop session: open (connect %.3f s, programmed images so far %d)",
                 self.session_stats.last_connect_s, self.session_stats.images_programmed)
        return self._conn

    async def release_device(self) -> None:
        """Close USB and give the Glasgow back (web service can use it again)."""
        async with self._lock:
            conn, self._conn = self._conn, None
            if conn is not None and conn.connected:
                await conn.hard_close()
            self._device_lock.release()
            self._status.state = DeviceState.IDLE

    async def open_session(self) -> None:
        """Pre-open the session so the first scan starts without connect latency."""
        async with self._lock:
            await self._ensure_conn()

    async def reconnect(self) -> None:
        await super().reconnect()

    # -------- off-loop side work ----------------------------------------------

    def _maybe_dump_last_outputs(self) -> None:
        """DumpData CSV/PNG, rendered out of process instead of on the scan loop."""
        if not getattr(self._config, "DumpData", False) or not self.has_last():
            return
        if self._dump_sink is not None:
            self._dump_sink(self.last_snapshot())

    def last_snapshot(self) -> dict:
        """Picklable copy of the last scan cache for the artifact worker.

        Chunks are copied to bytes (one memcpy each) so the next scan can
        reuse nothing by accident; metadata (pydantic models included) is
        passed by reference because it pickles as-is.
        """
        last = dict(self._last or {})
        chunks = last.get("chunks", [])
        last["chunk_typecodes"] = [getattr(chunk, "typecode", "H") for chunk in chunks]
        last["chunks"] = [bytes(chunk) if isinstance(chunk, (bytes, bytearray))
                          else memoryview(chunk).cast("B").tobytes() for chunk in chunks]
        return last
