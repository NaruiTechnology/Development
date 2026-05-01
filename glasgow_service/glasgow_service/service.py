"""Hardware-facing service. Lazy single-connection model.

Lifecycle decisions and the reasoning behind them:

* We do NOT connect to the Glasgow during uvicorn lifespan startup.
  IobeamLauncher.run() flashes the FPGA, opens the applet run gate, and
  pipelines 16 reads on the IN endpoint. Sitting in that armed-but-idle
  state for tens of seconds (while the user navigates Swagger) causes the
  FX2 FIFO state to go stale and the next bulk_write fails with
  "device disconnected". Connecting on the first scan request mirrors the
  pattern used by tests/test_raster.py, which works.

* Once connected, we KEEP the connection across requests. The library's
  Connection._disconnect() only nulls a Python reference; it does not
  release the USB interface, cancel demultiplexer tasks, or close the FX2
  handle. So opening a second GlasgowConnection while a previous one is
  still alive results in libusb LIBUSB_ERROR_BUSY on claimInterface(0).
  Reusing the same connection avoids that entirely.

* On any USB-related exception during transfer_multiple, we drop our
  reference to the connection so the NEXT request opens a fresh one. This
  recovers from transient USB drops without needing /admin/reconnect.

* /admin/reconnect just nulls the connection reference. Because the library
  has no clean teardown path, the previous USB handle hangs around until
  Python GCs it. If the very next reconnect fires before that GC happens,
  it can fail with LIBUSB_ERROR_BUSY. If that happens repeatedly, restart
  the uvicorn process.
"""
import asyncio
import csv
import io
import math
import time
from pathlib import Path
from typing import AsyncIterator, Iterable, List, Optional, Tuple

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.automation_log import AutomationLog

from .models import (
    DeviceState, ServiceStatus, RasterRequest, VectorRequest, VectorPattern,
    ScanResult, ScanValidation, ValidationCheck,
)

LOG_NAME = r'GlasgowService'
logger      = AutomationLog.GetLogger(LOG_NAME)

class DeviceBusy(RuntimeError):     ...
class DeviceNotReady(RuntimeError): ...


def _default_vector_iter() -> Iterable[Tuple[int, int, int]]:
    for x in range(2048):
        for y in range(2048):
            yield x, y, 1


# Exception types that indicate the USB connection is dead and we should
# drop our reference so the next request reconnects. Matched by name to
# avoid importing classes that might not be public.
_FATAL_EXC_NAMES = {
    "GlasgowDeviceError",     # "device disconnected"
    "USBError", "USBErrorBusy", "USBErrorNoDevice", "USBErrorIO",
    "ConnectionError",
}


def _is_fatal_usb_error(exc: BaseException) -> bool:
    return type(exc).__name__ in _FATAL_EXC_NAMES


class DeviceService:
    """One scan at a time. One USB connection, lazily opened, dropped on error."""

    def __init__(self, config_path: str):
        self._config_path = config_path
        self._config = AutomationConfig(config_path)

        action = util.GetStateConfigByName(self._config, "streamData")[Consts.ACTION_DATA]
        self._raster_defaults = action.get("rasterScan", {}) or {}
        self._vector_defaults = action.get("vectorScan", {}) or {}

        self._conn: Optional[GlasgowConnection] = None
        self._lock = asyncio.Lock()
        self._status = ServiceStatus(state=DeviceState.IDLE)  # IDLE = "ready, not yet connected"

        # In-memory cache of the most recent completed scan. Populated by
        # both run_raster/run_vector (validated) AND the streaming
        # generators (live), so the browser can pull a CSV or PNG figure
        # from /scan/last/* regardless of which path produced the data.
        # Worst case ~16 MB (2048x2048 vector + 2048x2048 raster).
        self._last: Optional[dict] = None

    # -------- lifecycle ---------------------------------------------------

    async def start(self) -> None:
        """No hardware action. Connection is opened lazily on first scan."""
        self._status.state = DeviceState.IDLE
        logger.debug("service ready (lazy connect on first scan)")

    async def stop(self) -> None:
        """Best-effort: drop the reference. The library has no clean USB
        teardown, so we rely on process exit / GC for actual release."""
        self._conn = None
        self._status.state = DeviceState.DISCONNECTED
        logger.debug("service stopped (connection reference dropped)")
        logger.info("service stopped (connection reference dropped)")

    async def reconnect(self) -> None:
        """Drop the current connection so the next scan opens a fresh one."""
        async with self._lock:
            self._conn = None
            self._status.state = DeviceState.IDLE
            self._status.last_error = None
        logger.debug("connection dropped; next scan will reconnect")

    def status(self) -> ServiceStatus:
        return self._status.model_copy()

    def defaults(self) -> dict:
        return {
            "raster": dict(self._raster_defaults),
            "vector": dict(self._vector_defaults),
        }

    # -------- internal: lazy connect / drop-on-error ----------------------

    async def _ensure_conn(self) -> GlasgowConnection:
        """Return a live connection, opening one if we don't have it."""
        if self._conn is not None and self._conn.connected:
            return self._conn

        logger.debug("opening Glasgow connection")
        self._status.state = DeviceState.CONNECTING
        try:
            self._conn = GlasgowConnection(self._config)
            await self._conn._connect()
            if not self._conn.connected:
                raise DeviceNotReady(
                    "GlasgowConnection._connect() reported not connected")
        except Exception as e:
            self._conn = None
            self._status.state = DeviceState.ERROR
            self._status.last_error = repr(e)
            raise

        self._status.state = DeviceState.IDLE
        return self._conn

    def _drop_conn_on_error(self, exc: BaseException) -> None:
        """Called from a scan's exception path. If the exception looks like
        a USB problem, drop the connection so the next request reconnects."""
        if _is_fatal_usb_error(exc):
            logger.warning("dropping connection after %s: %s",
                        type(exc).__name__, exc)
            self._conn = None

    # -------- streaming (for WebSocket) -----------------------------------

    async def raster_scan(self, req: RasterRequest) -> AsyncIterator[bytes]:
        # Buffer chunks for the /scan/last/* download endpoints. We hold
        # references to the chunks already-yielded; the bytes are still
        # in memory anyway because the WebSocket frame keeps them until
        # the network layer flushes.
        captured: List = []
        async with self._acquire("raster"):
            conn = await self._ensure_conn()
            cmd = self._build_raster_cmd(req)
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=req.latency_bytes):
                    self._status.chunks_in_flight += 1
                    captured.append(chunk)
                    yield bytes(chunk)
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            finally:
                # On normal completion AND on cancellation (Pause/Stop),
                # snapshot whatever we got. Partial captures are still
                # downloadable — better than nothing for a paused scan.
                self._last = {
                    "kind": "raster",
                    "chunks": captured,
                    "resolution": req.resolution,
                    "dwell": req.dwell,
                    "latency_bytes": req.latency_bytes,
                    "source": "stream",
                }

    async def vector_scan(self, req: VectorRequest) -> AsyncIterator[bytes]:
        captured: List = []
        async with self._acquire("vector"):
            conn = await self._ensure_conn()
            cmd = self._build_vector_cmd(req)
            if req.pre_process:
                cmd._pre_process_chunks(latency=req.latency_bytes)
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=req.latency_bytes):
                    self._status.chunks_in_flight += 1
                    captured.append(chunk)
                    yield bytes(chunk)
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            finally:
                self._last = {
                    "kind": "vector",
                    "chunks": captured,
                    "latency_bytes": req.latency_bytes,
                    "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                    "points": req.points,
                    "source": "stream",
                }

    # -------- blocking wet-run (for REST + pytest) ------------------------

    async def run_raster(self, req: RasterRequest) -> ScanResult:
        chunks: List = []
        async with self._acquire("raster"):
            conn = await self._ensure_conn()
            cmd = self._build_raster_cmd(req)
            logger.debug("[raster] %dx%d dwell=%d latency=%d frame_blank=%s",
                     req.resolution, req.resolution, req.dwell,
                     req.latency_bytes, req.frame_blank)
            t0 = time.perf_counter()
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=req.latency_bytes):
                    chunks.append(chunk)
                    self._status.chunks_in_flight += 1
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            send_time = time.perf_counter() - t0

        pixels_per_chunk = math.ceil(req.latency_bytes / req.dwell)
        total_pixels     = req.resolution * req.resolution
        expected_chunks  = math.ceil(total_pixels / pixels_per_chunk)
        total_bytes      = sum(len(c) * 2 for c in chunks)

        # Cache for /scan/last/csv and /scan/last/figure.
        if chunks:
            self._last = {
                "kind": "raster",
                "chunks": chunks,
                "resolution": req.resolution,
                "dwell": req.dwell,
                "latency_bytes": req.latency_bytes,
                "source": "validated",
            }

        validation = None
        if req.do_validate:
            validation = self._validate_raster(
                chunks, pixels_per_chunk, expected_chunks)

        return ScanResult(
            kind="raster",
            chunks=len(chunks),
            bytes=total_bytes,
            resolution=req.resolution,
            dwell=req.dwell,
            expected_chunks=expected_chunks,
            pixels_per_chunk=pixels_per_chunk,
            send_time_s=send_time,
            has_data=bool(chunks),
            validation=validation,
        )

    async def run_vector(self, req: VectorRequest) -> ScanResult:
        chunks: List = []
        process_time = 0.0

        async with self._acquire("vector"):
            conn = await self._ensure_conn()
            cmd = self._build_vector_cmd(req)

            if req.pre_process:
                t0 = time.perf_counter()
                cmd._pre_process_chunks(latency=req.latency_bytes)
                process_time = time.perf_counter() - t0
                logger.debug("[vector] pre-process %.4fs", process_time)

            logger.debug("[vector] latency=%d pattern=%s pre_process=%s",
                     req.latency_bytes, req.pattern, req.pre_process)
            t0 = time.perf_counter()
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=req.latency_bytes):
                    chunks.append(chunk)
                    self._status.chunks_in_flight += 1
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            send_time = time.perf_counter() - t0

        total_bytes = sum(len(c) * 2 for c in chunks)

        if chunks:
            self._last = {
                "kind": "vector",
                "chunks": chunks,
                "latency_bytes": req.latency_bytes,
                "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                "points": req.points,
                "source": "validated",
            }

        validation = None
        if req.do_validate:
            validation = self._validate_vector(chunks)

        return ScanResult(
            kind="vector",
            chunks=len(chunks),
            bytes=total_bytes,
            process_time_s=process_time if req.pre_process else None,
            send_time_s=send_time,
            has_data=bool(chunks),
            validation=validation,
        )

    # -------- command construction (unchanged) ----------------------------

    def _build_raster_cmd(self, req: RasterRequest) -> RasterScanCommand:
        rng = DACCodeRange.from_resolution(req.resolution)
        return RasterScanCommand(
            cookie=req.cookie,
            x_range=rng, y_range=rng,
            dwell_time=req.dwell,
            frame_blank=req.frame_blank,
        )

    def _build_vector_cmd(self, req: VectorRequest) -> VectorScanCommand:
        if req.pattern is VectorPattern.custom:
            if not req.points:
                raise ValueError("pattern=custom requires non-empty `points`")
            iter_points: Iterable[Tuple[int, int, int]] = iter(req.points)
        else:
            iter_points = _default_vector_iter()

        try:
            output_mode = OutputMode[req.output_mode]
        except KeyError:
            raise ValueError(f"unknown output_mode {req.output_mode!r}; "
                             f"valid: {[m.name for m in OutputMode]}")

        return VectorScanCommand(
            cookie=req.cookie,
            output_mode=output_mode,
            iter_points=iter_points,
            # Optional override from streamData.json -> vectorScan.drainFloorPixels.
            # Missing/None falls back to VectorScanCommand's module default.
            drain_floor_pixels=self._vector_defaults.get("drainFloorPixels"),
        )

    # -------- on-demand download bytes (CSV / PNG figure) -----------------

    def has_last(self) -> bool:
        return self._last is not None and bool(self._last.get("chunks"))

    def last_meta(self) -> Optional[dict]:
        """Lightweight metadata for the UI to display next to the buttons."""
        if not self.has_last():
            return None
        last = self._last
        return {
            "kind": last["kind"],
            "chunks": len(last["chunks"]),
            "source": last.get("source"),
            "resolution": last.get("resolution"),
            "latency_bytes": last.get("latency_bytes"),
            "pattern": last.get("pattern"),
        }

    def last_csv_filename(self) -> str:
        if not self.has_last():
            return "scan.csv"
        last = self._last
        if last["kind"] == "raster":
            r = last.get("resolution") or 0
            return f"raster_{r}x{r}.csv"
        return f"vector_latency{last.get('latency_bytes') or 0}.csv"

    def last_csv_bytes(self) -> bytes:
        """Render the last scan as CSV (UTF-8). Format identical to the
        on-disk CSV the previous `save_csv=True` code path produced, so
        downstream tooling that already parses those files keeps working."""
        if not self.has_last():
            raise DeviceNotReady("no scan data cached")
        last = self._last
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter=" ")

        if last["kind"] == "raster":
            res = last["resolution"]
            all_pixels: list = []
            for chunk in last["chunks"]:
                all_pixels.extend(chunk)
            for row_idx in range(res):
                start = row_idx * res
                row = all_pixels[start:start + res]
                if not row:
                    break
                writer.writerow(row)
        else:
            for chunk in last["chunks"]:
                writer.writerow(chunk)

        return buf.getvalue().encode("utf-8")

    def last_figure_filename(self) -> str:
        if not self.has_last():
            return "scan.png"
        last = self._last
        if last["kind"] == "raster":
            r = last.get("resolution") or 0
            return f"raster_{r}x{r}.png"
        return f"vector_latency{last.get('latency_bytes') or 0}.png"

    def last_figure_png(self) -> bytes:
        """Render the last scan as a publication-quality PNG using
        matplotlib. Mirrors the layout of the matplotlib figures the
        operator was generating manually before this endpoint existed."""
        if not self.has_last():
            raise DeviceNotReady("no scan data cached")

        # Imported lazily so the service still boots without matplotlib
        # installed — only this endpoint will fail.
        import numpy as np
        import matplotlib
        matplotlib.use("Agg")  # headless backend; required when no display
        import matplotlib.pyplot as plt

        last = self._last
        if last["kind"] == "raster":
            res = last["resolution"]
            flat = np.fromiter(
                (v for chunk in last["chunks"] for v in chunk),
                dtype=np.uint16,
                count=res * res if sum(len(c) for c in last["chunks"]) >= res * res else -1,
            )
            # If the scan was truncated (paused mid-frame), pad with zeros
            # so reshape works; downstream display tools tolerate zeros.
            if flat.size < res * res:
                pad = np.zeros(res * res - flat.size, dtype=np.uint16)
                flat = np.concatenate([flat, pad])
            else:
                flat = flat[: res * res]
            img = flat.reshape(res, res)
            display = (img >> 8).astype(np.uint8)  # 8-bit display value

            fig, ax = plt.subplots(figsize=(7, 7))
            im = ax.imshow(display, cmap="gray", vmin=0, vmax=255)
            ax.set_title(f"Raster scan: {res}x{res}")
            ax.set_xlabel("X (pixels)")
            ax.set_ylabel("Y (pixels)")
            cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
            cbar.set_label("ADC sample (8-bit)")
        else:
            # Vector: reconstruct image from sample order. Default sweep
            # walks for x: for y:; custom uses the host point list.
            edge = 2048
            samples = np.fromiter(
                (v for chunk in last["chunks"] for v in chunk),
                dtype=np.uint16,
            )
            img = np.zeros((edge, edge), dtype=np.uint16)
            pattern = last.get("pattern", "default")
            points = last.get("points")
            if pattern == "custom" and points:
                n = min(len(samples), len(points))
                xs = np.fromiter((p[0] for p in points[:n]), dtype=np.int32, count=n)
                ys = np.fromiter((p[1] for p in points[:n]), dtype=np.int32, count=n)
                mask = (xs >= 0) & (xs < edge) & (ys >= 0) & (ys < edge)
                img[ys[mask], xs[mask]] = samples[:n][mask]
            else:
                # Default sweep: sample i -> (col=i//edge, row=i%edge)
                n = min(samples.size, edge * edge)
                idx = np.arange(n)
                cols = idx // edge
                rows = idx % edge
                img[rows, cols] = samples[:n]

            display = (img >> 8).astype(np.uint8)
            fig, ax = plt.subplots(figsize=(7, 7))
            im = ax.imshow(display, cmap="gray", vmin=0, vmax=255)
            ax.set_title(f"Vector scan: {samples.size} points")
            ax.set_xlabel("X (DAC code)")
            ax.set_ylabel("Y (DAC code)")
            cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
            cbar.set_label("ADC sample (8-bit)")

        out = io.BytesIO()
        fig.tight_layout()
        fig.savefig(out, format="png", dpi=120, bbox_inches="tight")
        plt.close(fig)
        return out.getvalue()

    # -------- validation (unchanged) --------------------------------------

    def _validate_raster(self, chunks: List, pixels_per_chunk: int,
                         expected_chunks: int) -> ScanValidation:
        checks: List[ValidationCheck] = []
        checks.append(ValidationCheck(
            name="chunk_count",
            passed=len(chunks) == expected_chunks,
            detail=f"expected {expected_chunks}, got {len(chunks)}",
        ))
        full_bytes = pixels_per_chunk * 2
        bad_sizes = [(i, len(c) * 2) for i, c in enumerate(chunks[:-1])
                     if len(c) * 2 != full_bytes]
        checks.append(ValidationCheck(
            name="full_chunk_sizes",
            passed=not bad_sizes,
            detail=(f"all non-tail chunks = {full_bytes} bytes"
                    if not bad_sizes
                    else f"mismatched chunks: {bad_sizes[:5]}"),
        ))
        if chunks:
            tail = len(chunks[-1]) * 2
            checks.append(ValidationCheck(
                name="tail_chunk_size",
                passed=0 < tail <= full_bytes,
                detail=f"tail = {tail} bytes (max {full_bytes})",
            ))
        if len(chunks) >= 2:
            first16 = bytes(chunks[1])[:16]
            checks.append(ValidationCheck(
                name="no_padding_leak",
                passed=first16 != b"\x00" * 16,
                detail="chunk 2 must not begin with 16 zero bytes",
            ))
        return ScanValidation(passed=all(c.passed for c in checks), checks=checks)

    def _validate_vector(self, chunks: List) -> ScanValidation:
        checks: List[ValidationCheck] = []
        checks.append(ValidationCheck(
            name="non_zero_chunks", passed=len(chunks) > 0,
            detail=f"received {len(chunks)} chunks"))
        empties = [i for i, c in enumerate(chunks) if len(c) == 0]
        checks.append(ValidationCheck(
            name="all_chunks_non_empty", passed=not empties,
            detail=("all non-empty" if not empties
                    else f"empty chunk indices: {empties[:5]}")))
        if len(chunks) >= 2:
            first16 = bytes(chunks[1])[:16]
            checks.append(ValidationCheck(
                name="no_padding_leak", passed=first16 != b"\x00" * 16,
                detail="chunk 2 must not begin with 16 zero bytes"))
        return ScanValidation(passed=all(c.passed for c in checks), checks=checks)

    # -------- state lock --------------------------------------------------

    def _acquire(self, kind: str):
        svc = self
        class _Ctx:
            async def __aenter__(self):
                if svc._status.state is DeviceState.BUSY:
                    raise DeviceBusy("a scan is already running")
                # IDLE, ERROR, DISCONNECTED are all OK to start from — the
                # _ensure_conn() call inside the scan will (re)open as needed.
                if svc._status.state is DeviceState.CONNECTING:
                    raise DeviceNotReady("device is connecting")
                await svc._lock.acquire()
                svc._status.state = DeviceState.BUSY
                svc._status.chunks_in_flight = 0
                logger.debug("scan start kind=%s", kind)
                return svc
            async def __aexit__(self, exc_type, exc, tb):
                if exc is None:
                    svc._status.scans_completed += 1
                else:
                    svc._status.last_error = f"{type(exc).__name__}: {exc}"
                # If we still have a connection, we're IDLE; otherwise reflect that.
                if svc._conn is None:
                    svc._status.state = DeviceState.ERROR if exc else DeviceState.IDLE
                else:
                    svc._status.state = DeviceState.IDLE
                svc._status.chunks_in_flight = 0
                svc._lock.release()
                logger.debug("scan end kind=%s ok=%s", kind, exc is None)
                return False
        return _Ctx()
