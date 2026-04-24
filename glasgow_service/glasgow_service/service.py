"""Hardware-facing service. No FastAPI dependency — importable from
pytest, Jupyter, or any other driver."""
import asyncio
import csv
import logging
import math
import time
from pathlib import Path
from typing import AsyncIterator, Iterable, List, Optional, Tuple

# Existing project packages (identical paths to your test files):
from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util

from .models import (
    DeviceState, ServiceStatus, RasterRequest, VectorRequest, VectorPattern,
    ScanResult, ScanValidation, ValidationCheck,
)

log = logging.getLogger(__name__)


class DeviceBusy(RuntimeError):     ...
class DeviceNotReady(RuntimeError): ...


def _default_vector_iter() -> Iterable[Tuple[int, int, int]]:
    """Matches vector.default_iter() but created per-call so it can't be
    exhausted across requests."""
    for x in range(2048):
        for y in range(2048):
            yield x, y, 1


class DeviceService:
    """One Glasgow per process. Asyncio-safe; not thread-safe."""

    def __init__(self, config_path: str):
        self._config_path = config_path
        self._config = AutomationConfig(config_path)

        action = util.GetStateConfigByName(self._config, "streamData")[Consts.ACTION_DATA]
        self._raster_defaults = action.get("rasterScan", {}) or {}
        self._vector_defaults = action.get("vectorScan", {}) or {}

        self._conn: Optional[GlasgowConnection] = None
        self._lock = asyncio.Lock()
        self._status = ServiceStatus(state=DeviceState.DISCONNECTED)

    # -------- lifecycle ---------------------------------------------------

    async def start(self) -> None:
        self._status.state = DeviceState.CONNECTING
        try:
            self._conn = GlasgowConnection(self._config)
            await self._conn._connect()
            if not self._conn.connected:
                raise RuntimeError("GlasgowConnection._connect() reported not connected")
            self._status.state = DeviceState.IDLE
            log.info("Glasgow connected, service ready")
        except Exception as e:
            self._status.state = DeviceState.ERROR
            self._status.last_error = repr(e)
            raise

    async def stop(self) -> None:
        if self._conn is not None and self._conn.connected:
            try:
                self._conn._disconnect()
            except Exception:
                log.exception("error during Glasgow disconnect")
        self._status.state = DeviceState.DISCONNECTED
        log.info("Glasgow released")

    async def reconnect(self) -> None:
        await self.stop()
        await self.start()

    def status(self) -> ServiceStatus:
        return self._status.model_copy()

    def defaults(self) -> dict:
        return {
            "raster": dict(self._raster_defaults),
            "vector": dict(self._vector_defaults),
        }

    # -------- streaming (for WebSocket) -----------------------------------

    async def raster_scan(self, req: RasterRequest) -> AsyncIterator[bytes]:
        """Yield raw chunk bytes. CSV/validate flags are ignored — streaming
        callers are expected to do their own bookkeeping."""
        async with self._acquire("raster"):
            cmd = self._build_raster_cmd(req)
            async for chunk in self._conn.transfer_multiple(
                    cmd, latency=req.latency_bytes):
                self._status.chunks_in_flight += 1
                yield bytes(chunk)

    async def vector_scan(self, req: VectorRequest) -> AsyncIterator[bytes]:
        async with self._acquire("vector"):
            cmd = self._build_vector_cmd(req)
            if req.pre_process:
                cmd._pre_process_chunks(latency=req.latency_bytes)
            async for chunk in self._conn.transfer_multiple(
                    cmd, latency=req.latency_bytes):
                self._status.chunks_in_flight += 1
                yield bytes(chunk)

    # -------- blocking wet-run (for REST + pytest) ------------------------

    async def run_raster(self, req: RasterRequest) -> ScanResult:
        """Run a raster scan to completion. Buffers all chunks; optionally
        writes CSV and runs the validation checks from test_raster.py."""
        chunks: List = []
        async with self._acquire("raster"):
            cmd = self._build_raster_cmd(req)
            log.info("[raster] %dx%d dwell=%d latency=%d frame_blank=%s",
                     req.resolution, req.resolution, req.dwell,
                     req.latency_bytes, req.frame_blank)
            t0 = time.perf_counter()
            async for chunk in self._conn.transfer_multiple(
                    cmd, latency=req.latency_bytes):
                chunks.append(chunk)
                self._status.chunks_in_flight += 1
            send_time = time.perf_counter() - t0

        pixels_per_chunk = math.ceil(req.latency_bytes / req.dwell)
        total_pixels     = req.resolution * req.resolution
        expected_chunks  = math.ceil(total_pixels / pixels_per_chunk)
        total_bytes      = sum(len(c) * 2 for c in chunks)

        csv_path = None
        if req.save_csv and chunks:
            csv_path = self._export_raster_csv(chunks, req)

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
            csv_path=str(csv_path) if csv_path else None,
            validation=validation,
        )

    async def run_vector(self, req: VectorRequest) -> ScanResult:
        """Run a vector scan to completion. Optionally pre-processes first
        and times that step separately (mirrors test_vector.py)."""
        chunks: List = []
        process_time = 0.0

        async with self._acquire("vector"):
            cmd = self._build_vector_cmd(req)

            if req.pre_process:
                t0 = time.perf_counter()
                cmd._pre_process_chunks(latency=req.latency_bytes)
                process_time = time.perf_counter() - t0
                log.info("[vector] pre-process %.4fs", process_time)

            log.info("[vector] latency=%d pattern=%s pre_process=%s",
                     req.latency_bytes, req.pattern, req.pre_process)
            t0 = time.perf_counter()
            async for chunk in self._conn.transfer_multiple(
                    cmd, latency=req.latency_bytes):
                chunks.append(chunk)
                self._status.chunks_in_flight += 1
            send_time = time.perf_counter() - t0

        total_bytes = sum(len(c) * 2 for c in chunks)

        csv_path = None
        if req.save_csv and chunks:
            csv_path = self._export_vector_csv(chunks, req)

        validation = None
        if req.do_validate:
            validation = self._validate_vector(chunks)

        return ScanResult(
            kind="vector",
            chunks=len(chunks),
            bytes=total_bytes,
            process_time_s=process_time if req.pre_process else None,
            send_time_s=send_time,
            csv_path=str(csv_path) if csv_path else None,
            validation=validation,
        )

    # -------- command construction ----------------------------------------

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
        )

    # -------- CSV export --------------------------------------------------

    def _csv_dir(self, override: Optional[str]) -> Path:
        p = Path(override) if override else Path.home() / "Downloads"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _export_raster_csv(self, chunks: List, req: RasterRequest) -> Path:
        """One row per raster line, resolution pixels per row.
        Matches test_raster.py._exportDataToCsvFile output format."""
        path = self._csv_dir(req.csv_dir) / f"raster_{req.resolution}x{req.resolution}.csv"

        all_pixels: list = []
        for chunk in chunks:
            all_pixels.extend(chunk)

        with path.open("w", newline="") as f:
            writer = csv.writer(f, delimiter=" ")
            for row_idx in range(req.resolution):
                start = row_idx * req.resolution
                row = all_pixels[start:start + req.resolution]
                if not row:
                    break
                writer.writerow(row)

        log.info("wrote raster CSV %s (%d pixels from %d chunks)",
                 path, len(all_pixels), len(chunks))
        return path

    def _export_vector_csv(self, chunks: List, req: VectorRequest) -> Path:
        """One row per received chunk, space-separated values.
        Matches test_vector.py._exportDataToCsvFile output format."""
        path = self._csv_dir(req.csv_dir) / f"vector_latency{req.latency_bytes}.csv"

        total_values = 0
        with path.open("w", newline="") as f:
            writer = csv.writer(f, delimiter=" ")
            for chunk in chunks:
                writer.writerow(chunk)
                total_values += len(chunk)

        log.info("wrote vector CSV %s (%d values from %d chunks)",
                 path, total_values, len(chunks))
        return path

    # -------- validation --------------------------------------------------

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

        return ScanValidation(
            passed=all(c.passed for c in checks),
            checks=checks,
        )

    def _validate_vector(self, chunks: List) -> ScanValidation:
        checks: List[ValidationCheck] = []

        checks.append(ValidationCheck(
            name="non_zero_chunks",
            passed=len(chunks) > 0,
            detail=f"received {len(chunks)} chunks",
        ))

        empties = [i for i, c in enumerate(chunks) if len(c) == 0]
        checks.append(ValidationCheck(
            name="all_chunks_non_empty",
            passed=not empties,
            detail=("all non-empty" if not empties
                    else f"empty chunk indices: {empties[:5]}"),
        ))

        if len(chunks) >= 2:
            first16 = bytes(chunks[1])[:16]
            checks.append(ValidationCheck(
                name="no_padding_leak",
                passed=first16 != b"\x00" * 16,
                detail="chunk 2 must not begin with 16 zero bytes",
            ))

        return ScanValidation(
            passed=all(c.passed for c in checks),
            checks=checks,
        )

    # -------- state lock --------------------------------------------------

    def _acquire(self, kind: str):
        svc = self
        class _Ctx:
            async def __aenter__(self):
                if svc._status.state is DeviceState.BUSY:
                    raise DeviceBusy("a scan is already running")
                if svc._status.state is not DeviceState.IDLE:
                    raise DeviceNotReady(f"device state={svc._status.state}")
                await svc._lock.acquire()
                svc._status.state = DeviceState.BUSY
                svc._status.chunks_in_flight = 0
                log.info("scan start kind=%s", kind)
                return svc
            async def __aexit__(self, exc_type, exc, tb):
                if exc is None:
                    svc._status.scans_completed += 1
                else:
                    svc._status.last_error = f"{type(exc).__name__}: {exc}"
                svc._status.state = DeviceState.IDLE
                svc._status.chunks_in_flight = 0
                svc._lock.release()
                log.info("scan end kind=%s ok=%s", kind, exc is None)
                return False
        return _Ctx()
