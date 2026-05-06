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
import array
import csv
import io
import math
import sys
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


def _default_vector_iter(edge: int = 2048) -> Iterable[Tuple[int, int, int]]:
    """Yield (x, y, dwell) triples for a default sweep at the given edge
    resolution. Coverage is always the full 14-bit DAC range; smaller
    edge values produce sparser sampling with stride = 16384 // edge.
    Caller is responsible for passing an edge that divides 2048 evenly
    (the Pydantic validator on VectorRequest.vector_resolution enforces
    this for the public API)."""
    stride = 16384 // edge
    for x in range(edge):
        for y in range(edge):
            yield x * stride, y * stride, 1


def _roi_bounds(roi) -> Optional[Tuple[int, int, int, int]]:
    if roi is None:
        return None
    x0, x1 = sorted((int(roi.x_start), int(roi.x_end)))
    y0, y1 = sorted((int(roi.y_start), int(roi.y_end)))
    return x0, x1, y0, y1


def _dac_range_for_bounds(start: int, end: int, count: int) -> DACCodeRange:
    lo, hi = sorted((int(start), int(end)))
    span = max(1, hi - lo + 1)
    return DACCodeRange(start=lo, count=count, step=max(1, int((span / count) * 256)))


def _roi_vector_iter(edge: int, roi) -> Iterable[Tuple[int, int, int]]:
    bounds = _roi_bounds(roi)
    if bounds is None:
        yield from _default_vector_iter(edge)
        return
    x0, x1, y0, y1 = bounds
    x_range = _dac_range_for_bounds(x0, x1, edge)
    y_range = _dac_range_for_bounds(y0, y1, edge)
    for x_idx in range(edge):
        x = x_range.start + ((x_idx * x_range.step) >> 8)
        for y_idx in range(edge):
            y = y_range.start + ((y_idx * y_range.step) >> 8)
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


def _percentile_clip_uint16(values, lo_pct: float = 1.0, hi_pct: float = 99.0):
    """Return (lo, hi) cut-off values for percentile-based display
    auto-leveling. Pure helper, used by the matplotlib figure renderer
    to set imshow's vmin/vmax. numpy is imported lazily by the caller.

    Returns (0, 1) when given an empty array, so downstream imshow
    doesn't error. When all values are equal, returns (v, v+1) so the
    image renders as uniform mid-gray rather than blowing up the
    color-mapper.
    """
    import numpy as np
    arr = np.asarray(values)
    if arr.size == 0:
        return 0, 1
    lo = int(np.percentile(arr, lo_pct))
    hi = int(np.percentile(arr, hi_pct))
    if hi <= lo:
        hi = lo + 1
    return lo, hi


def _uint16_chunk_to_wire_bytes(chunk) -> bytes:
    """Return explicit big-endian uint16 sample bytes for WebSocket frames.

    Unit tests and CSV paths work with array('H') numeric values. Calling
    bytes(array('H')) directly serializes in host byte order, which is
    little-endian on the dev machine and makes the browser decode swapped
    samples. The FPGA/ImageSerializer wire contract is high byte first, so
    normalize chunks here without mutating the captured array used by CSV
    and validation.
    """
    if isinstance(chunk, (bytes, bytearray, memoryview)):
        return bytes(chunk)
    out = array.array("H", chunk)
    if sys.byteorder == "little":
        out.byteswap()
    return out.tobytes()


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
                    yield _uint16_chunk_to_wire_bytes(chunk)
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            finally:
                # On normal completion AND on cancellation (Pause/Stop),
                # snapshot whatever we got. Partial captures are still
                # downloadable — better than nothing for a paused scan.
                self._set_last_scan({
                    "kind": "raster",
                    "chunks": captured,
                    "resolution": req.resolution,
                    "dwell": req.dwell,
                    "latency_bytes": req.latency_bytes,
                    "source": "stream",
                })

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
                    yield _uint16_chunk_to_wire_bytes(chunk)
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            finally:
                self._set_last_scan({
                    "kind": "vector",
                    "chunks": captured,
                    "latency_bytes": req.latency_bytes,
                    "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                    "points": req.points,
                    "vector_resolution": req.vector_resolution,
                    "roi": req.roi,
                    "source": "stream",
                })

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
            self._set_last_scan({
                "kind": "raster",
                "chunks": chunks,
                "resolution": req.resolution,
                "dwell": req.dwell,
                "latency_bytes": req.latency_bytes,
                "source": "validated",
            })

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
            self._set_last_scan({
                "kind": "vector",
                "chunks": chunks,
                "latency_bytes": req.latency_bytes,
                "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                "points": req.points,
                "vector_resolution": req.vector_resolution,
                "roi": req.roi,
                "source": "validated",
            })

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
        bounds = _roi_bounds(req.roi)
        if bounds is None:
            x_rng = y_rng = DACCodeRange.from_resolution(req.resolution)
        else:
            x0, x1, y0, y1 = bounds
            x_rng = _dac_range_for_bounds(x0, x1, req.resolution)
            y_rng = _dac_range_for_bounds(y0, y1, req.resolution)
        return RasterScanCommand(
            cookie=req.cookie,
            x_range=x_rng, y_range=y_rng,
            dwell_time=req.dwell,
            frame_blank=req.frame_blank,
        )

    def _build_vector_cmd(self, req: VectorRequest) -> VectorScanCommand:
        if req.pattern is VectorPattern.custom:
            if not req.points:
                raise ValueError("pattern=custom requires non-empty `points`")
            iter_points: Iterable[Tuple[int, int, int]] = iter(req.points)
        else:
            iter_points = _roi_vector_iter(req.vector_resolution, req.roi)

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

    def _set_last_scan(self, last: dict) -> None:
        self._last = last
        self._maybe_dump_last_csv()

    def _dump_csv_filename(self) -> str:
        if not self.has_last():
            return "scan.csv"
        last = self._last
        if last["kind"] == "raster":
            r = last.get("resolution") or 0
            return f"raster_{r}x{r}.csv"
        return f"vector_latency{last.get('latency_bytes') or 0}.csv"

    def _maybe_dump_last_csv(self) -> None:
        """Mirror the unit-test DumpData behavior for service/UI scans."""
        if not getattr(self._config, "DumpData", False):
            return
        if not self.has_last():
            return
        try:
            downloads_dir = Path.home() / "Downloads"
            downloads_dir.mkdir(parents=True, exist_ok=True)
            csv_path = downloads_dir / self._dump_csv_filename()
            csv_path.write_bytes(self.last_csv_bytes())
            logger.info("wrote CSV dump: %s", csv_path)
        except Exception as exc:
            logger.warning("failed to write CSV dump: %s", exc)

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
            "vector_resolution": last.get("vector_resolution"),
        }

    def last_csv_filename(self) -> str:
        if not self.has_last():
            return "scan.csv"
        last = self._last
        ts = time.strftime("%Y%m%d_%H%M%S")
        if last["kind"] == "raster":
            r = last.get("resolution") or 0
            return f"raster_{r}x{r}_{ts}.csv"
        return f"vector_latency{last.get('latency_bytes') or 0}_{ts}.csv"

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
        ts = time.strftime("%Y%m%d_%H%M%S")
        if last["kind"] == "raster":
            r = last.get("resolution") or 0
            return f"raster_{r}x{r}_{ts}.png"
        return f"vector_latency{last.get('latency_bytes') or 0}_{ts}.png"

    def last_figure_png(self, render_mode: str = "decimated",
                        view: str = "figure") -> bytes:
        """Render the last scan as a publication-quality PNG using
        matplotlib. Mirrors the layout of the matplotlib figures the
        operator was generating manually before this endpoint existed.

        `render_mode` is "native" or "decimated" (vector only; raster
        scans ignore it):
          - native:   render a 2048x2048 image with stride-block fill
                      so the image is dense even for low-resolution scans.
                      Pixel coords correspond to DAC codes 1:1.
          - decimated: render an edge x edge image where edge is the
                       scan's vector_resolution. Pixel coords correspond
                       to scan indices, NOT DAC codes — but we use
                       imshow's `extent=` to keep the axis labels in DAC
                       coordinates so the figure stays legible.
        """
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
            dwell = int(last.get("dwell") or self._raster_defaults.get("dwell") or 0)
            adc_latency = int(self._raster_defaults.get("adcLatency", 8))
            line_shift_per_row = ((adc_latency - 1) / dwell) if dwell else 0
            if line_shift_per_row:
                corrected = np.empty_like(img)
                for y in range(res):
                    corrected[y] = np.roll(img[y], int(round(y * line_shift_per_row)))
                img = corrected

            fig, ax = plt.subplots(figsize=(6, 6))
            im = ax.imshow(img >> 8, cmap="gray", interpolation="nearest",
                           aspect="equal", vmin=0, vmax=255)
            if view == "texture":
                ax.set_axis_off()
                fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
            else:
                ax.set_title(f"Raster scan: {res}x{res}")
                ax.set_xlabel("X (pixels)")
                ax.set_ylabel("Y (pixels)")
                fig.colorbar(im, ax=ax, label="ADC sample (8-bit)")
        else:
            # ---------- vector ----------------------------------------
            DAC_RANGE = 16384
            DEFAULT_EDGE = 2048
            edge = int(last.get("vector_resolution") or DEFAULT_EDGE)
            samples = np.fromiter(
                (v for chunk in last["chunks"] for v in chunk),
                dtype=np.uint16,
            )
            pattern = last.get("pattern", "default")
            points = last.get("points")
            if pattern == "custom" and points:
                iter_list = list(points)
            else:
                iter_list = list(_roi_vector_iter(edge, last.get("roi")))
                if len(iter_list) < samples.size and edge != DEFAULT_EDGE:
                    iter_list = list(_roi_vector_iter(DEFAULT_EDGE, last.get("roi")))

            if len(iter_list) < samples.size:
                samples = samples[:len(iter_list)]
            elif len(iter_list) > samples.size:
                iter_list = iter_list[:samples.size]

            line_shift = self._vector_defaults.get("lineShiftPerXRow", 0)
            if line_shift and iter_list:
                first_x = iter_list[0][0]
                row_len = 0
                for point in iter_list:
                    if point[0] != first_x:
                        break
                    row_len += 1
                if row_len > 0 and len(iter_list) % row_len == 0:
                    rows = len(iter_list) // row_len
                    corrected = samples.reshape((rows, row_len)).copy()
                    for x_row in range(rows):
                        corrected[x_row] = np.roll(
                            corrected[x_row],
                            int(round(x_row * float(line_shift))),
                        )
                    samples = corrected.reshape(samples.shape)

            xs = np.fromiter((p[0] for p in iter_list), dtype="float32",
                             count=len(iter_list))
            ys = np.fromiter((p[1] for p in iter_list), dtype="float32",
                             count=len(iter_list))
            cs = (samples >> 8).astype("uint8")
            fig, ax = plt.subplots(figsize=(6, 6))
            im = ax.scatter(xs, ys, c=cs, cmap="gray", s=2, vmin=0, vmax=255,
                            marker="s")
            ax.set_xlim(0, self._vector_defaults.get("xResolution") or 16384)
            ax.set_ylim(self._vector_defaults.get("yResolution") or 16384, 0)
            ax.set_aspect("equal")
            if view == "texture":
                ax.set_axis_off()
                fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
            else:
                ax.set_title(f"Vector scan: {len(iter_list)} points")
                ax.set_xlabel("X (DAC code)")
                ax.set_ylabel("Y (DAC code)")
                fig.colorbar(im, ax=ax, label="ADC sample (8-bit)")

        out = io.BytesIO()
        if view != "texture":
            fig.tight_layout()
        fig.savefig(
            out,
            format="png",
            dpi=120,
            bbox_inches=None if view == "texture" else "tight",
            pad_inches=0 if view == "texture" else 0.1,
            transparent=view == "texture",
        )
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
