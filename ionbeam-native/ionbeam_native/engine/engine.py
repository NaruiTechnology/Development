"""Acquisition engine: a dedicated thread + asyncio loop that owns the Glasgow.

The UI thread never touches USB and the acquisition loop never paints. The
UI submits jobs; the engine streams samples straight into shared frame
buffers (``frames.py``) and reports lifecycle events through ``post`` (a
callable that marshals a function onto the UI thread). There is no
per-chunk message, no serialisation and no WebSocket in between.

Stream jobs mirror the web's ``/ws/scan/*/stream`` behaviour, including the
error-message shapes the UI displays; "live" jobs repeat a request frame
after frame on the open session (the web's Infinite mode, OBI's live view)
without a round trip through the UI between frames.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import itertools
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from glasgow_service.models import AdcTestRequest, DacRampRequest, RasterRequest, VectorRequest
from glasgow_service.service import DeviceBusy, DeviceNotReady

from .adc_mock import mock_adc_stream
from .frames import AdcTimeline, DacRampFrame, RasterFrame, VectorFrame, as_samples
from .perf import ScanPerf
from .service import DesktopDeviceService

log = logging.getLogger("ionbeam_native.engine")

Post = Callable[[Callable[[], None]], None]

_ECONNRESET = {"", "ECONNRESET", "read ECONNRESET", "Connection reset by peer"}


def stream_error_message(exc: BaseException) -> str:
    """Error text as the web UI renders the ``{"event": "error", ...}`` frame."""
    if isinstance(exc, DeviceBusy):
        return "busy"
    if isinstance(exc, DeviceNotReady):
        detail = str(exc)
        if detail in _ECONNRESET:
            detail = ("ADC/subtarget presence check failed: device transport reset while reading; "
                      "verify the physical ADC subtarget and OE/LE/data wiring")
        if detail.startswith("ADC/subtarget presence check failed:"):
            return f"[FAIL] adc_subtarget_presence: {detail}"
        return detail or "not_ready"
    if isinstance(exc, ValueError):
        return str(exc)
    return repr(exc)


@dataclass
class ScanJob:
    kind: str                       # raster | vector | dac_ramp
    request: dict                   # web request JSON shape
    live: bool = False              # repeat until stopped (Infinite)
    preserve_frame: bool = False
    line_shift_per_x_row: float = 0.0
    on_frame_start: Optional[Callable[[int], None]] = None           # engine thread, must be quick
    on_frame_done: Optional[Callable[[int, dict], None]] = None      # engine thread, must be quick
    id: int = field(default_factory=lambda: next(_JOB_IDS))
    stop_requested: bool = False


_JOB_IDS = itertools.count(1)


class Engine:
    def __init__(self, config_path: str, post: Post, *, force_reload: bool = False,
                 dump_sink: Optional[Callable[[dict], None]] = None, service_cls=DesktopDeviceService):
        self._service_cls = service_cls
        self.config_path = str(config_path)
        self._post = post
        self.raster = RasterFrame()
        self.vector = VectorFrame()
        self.dac_ramp = DacRampFrame()
        self.adc = AdcTimeline()
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, name="ionbeam-acquisition", daemon=True)
        self._ready = threading.Event()
        self._thread.start()
        self._ready.wait()
        self.svc: DesktopDeviceService = self.call(
            self._make_service(force_reload, dump_sink)).result()
        self._active: Optional[ScanJob] = None
        self._adc_stop: Optional[asyncio.Event] = None
        self.last_perf: Optional[ScanPerf] = None

    # ---- thread plumbing -----------------------------------------------------

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.call_soon(self._ready.set)
        self.loop.run_forever()

    def call(self, coro) -> concurrent.futures.Future:
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    async def _make_service(self, force_reload, dump_sink):
        return self._service_cls(self.config_path, force_reload=force_reload, dump_sink=dump_sink)

    def post(self, fn: Callable[[], None]) -> None:
        self._post(fn)

    # ---- status (callable from the UI thread) ---------------------------------

    def status(self) -> dict:
        s = self.svc.status().model_dump()
        s["session_open"] = self.svc.session_open
        s["session"] = self.svc.session_stats.as_dict()
        s["device_lock_held"] = self.svc._device_lock.held
        return s

    def defaults(self) -> dict:
        return self.svc.defaults()

    @property
    def busy(self) -> bool:
        return self._active is not None or self._adc_stop is not None

    # ---- session ---------------------------------------------------------------

    def open_session(self) -> concurrent.futures.Future:
        return self.call(self.svc.open_session())

    def release_device(self) -> concurrent.futures.Future:
        return self.call(self.svc.release_device())

    def reconnect(self) -> concurrent.futures.Future:
        return self.call(self.svc.reconnect())

    # ---- streamed scans --------------------------------------------------------

    def start_stream(self, job: ScanJob, *, on_started: Callable[[], None],
                     on_frame: Callable[[int, dict], None], on_finished: Callable[[dict], None]) -> None:
        if self._active is not None:
            raise RuntimeError("a scan is already running")
        self._active = job
        self.call(self._stream(job, on_started, on_frame, on_finished))

    def stop(self) -> None:
        """Stop the active stream or ADC test (idempotent, like POST /scan/abort)."""
        job = self._active
        if job is not None:
            job.stop_requested = True
            self.loop.call_soon_threadsafe(self.svc.abort_active_scan)
        if self._adc_stop is not None:
            self.loop.call_soon_threadsafe(self._adc_stop.set)

    def _model(self, job: ScanJob):
        payload = {k: v for k, v in job.request.items() if k != "preview"}
        if job.kind == "raster":
            return RasterRequest(**payload)
        if job.kind == "vector":
            return VectorRequest(**payload)
        return DacRampRequest(**payload)

    def _generator(self, job: ScanJob, model):
        if job.kind == "raster":
            return self.svc.raster_scan(model, native_samples=True)
        if job.kind == "vector":
            return self.svc.vector_scan(model, native_samples=True)
        return self.svc.dac_ramp_scan(model, native_samples=True)

    def _prepare_frame(self, job: ScanJob, model, frame_index: int) -> None:
        if job.kind == "raster":
            self.raster.reset(model.resolution, preserve_frame=job.preserve_frame or frame_index > 0)
        elif job.kind == "vector":
            req = job.request
            bitmap = req.get("simulation_bitmap")
            if req.get("pattern") == "custom" and bitmap:
                edge = max(int(bitmap["width"]), int(bitmap["height"]))
            elif req.get("pattern") == "custom":
                edge = 2048
            else:
                edge = int(req.get("vector_resolution", 2048))
            self.vector.setup(pattern=req.get("pattern", "default"), scan_path=req.get("scan_path"),
                              points=req.get("points"), edge=edge, roi=req.get("roi"),
                              simulation_bitmap=bitmap)
        else:
            self.dac_ramp.reset()

    def _sink(self, kind: str):
        return {"raster": self.raster, "vector": self.vector, "dac_ramp": self.dac_ramp}[kind]

    async def _stream(self, job: ScanJob, on_started, on_frame, on_finished) -> None:
        outcome: dict = {"event": "done", "chunks": 0}
        try:
            model = self._model(job)
        except Exception as exc:  # pydantic validation -> same text the service returns
            self._active = None
            message = str(exc)
            self.post(lambda: on_finished({"event": "error", "message": message, "recoverable": False}))
            return
        output_mode = getattr(model, "output_mode", "SixteenBit")
        sink = self._sink(job.kind)
        self.post(on_started)
        frame_index = 0
        try:
            while True:
                self._prepare_frame(job, model, frame_index)
                if job.on_frame_start is not None:
                    job.on_frame_start(frame_index)
                perf = ScanPerf.begin(job.kind, job.request, self.svc)
                chunks = 0
                gen = self._generator(job, model)
                try:
                    async for chunk in gen:
                        samples = as_samples(chunk, output_mode)
                        perf.chunk(samples.size)
                        sink.append(samples, samples.nbytes if output_mode != "EightBit" else samples.size)
                        chunks += 1
                finally:
                    await gen.aclose()
                perf.finish(self.svc, chunks, stopped=job.stop_requested)
                self.last_perf = perf
                log.info("%s", perf.summary())
                log.info("[session] %s", self.svc.session_stats.as_dict())
                if job.stop_requested:
                    outcome = {"event": "stopped", "chunks": chunks}
                    break
                if job.kind == "vector" and job.line_shift_per_x_row:
                    self.vector.correct_line_shift(job.line_shift_per_x_row)
                frame_result = {"event": "done", "chunks": chunks, "frame": frame_index,
                                "perf": perf.as_dict()}
                if job.on_frame_done is not None:
                    job.on_frame_done(frame_index, frame_result)
                self.post(lambda r=frame_result: on_frame(r["frame"], r))
                outcome = frame_result
                if not job.live or job.stop_requested:
                    break
                frame_index += 1
        except Exception as exc:
            log.warning("stream %s failed: %s", job.kind, exc, exc_info=not isinstance(exc, (DeviceBusy, DeviceNotReady)))
            # Transport-level failures (the web proxy closes with 1011/1006
            # for these) get one automatic reconnect + restart in the UI;
            # device/validation errors are reported as they are.
            recoverable = not isinstance(exc, (DeviceBusy, DeviceNotReady, ValueError))
            outcome = {"event": "error", "message": stream_error_message(exc), "recoverable": recoverable}
            if job.stop_requested:
                outcome = {"event": "stopped", "chunks": 0}
        finally:
            self._active = None
            self.post(lambda: on_finished(outcome))

    # ---- validated (blocking) runs ----------------------------------------------

    def run_validated(self, kind: str, request: dict) -> concurrent.futures.Future:
        async def run():
            payload = {k: v for k, v in request.items() if k != "preview"}
            model = RasterRequest(**payload) if kind == "raster" else VectorRequest(**payload)
            result = await (self.svc.run_raster(model) if kind == "raster" else self.svc.run_vector(model))
            return result.model_dump()
        return self.call(run())

    def abort_validated(self) -> None:
        self.loop.call_soon_threadsafe(self.svc.abort_active_scan)

    # ---- ADC test ---------------------------------------------------------------

    def start_adc(self, *, duration_minutes: int, simulation: bool, seed: int, chunk_bytes: int = 65536,
                  on_started: Callable[[], None], on_finished: Callable[[dict], None]) -> None:
        if self.busy:
            raise RuntimeError("a scan is already running")
        self.adc.reset(duration_minutes)

        async def run():
            stop = self._adc_stop = asyncio.Event()
            outcome: dict = {"event": "done"}
            started = None
            try:
                if simulation:
                    source = mock_adc_stream(duration_minutes, seed, stop)
                else:
                    req = AdcTestRequest(duration_minutes=duration_minutes, simulation=False, seed=seed,
                                         chunk_bytes=chunk_bytes)
                    source = self.svc.adc_stream(req)
                chunks = 0
                try:
                    async for data in source:
                        if started is None:
                            started = time.monotonic()
                            self.post(on_started)
                        if stop.is_set():
                            break
                        self.adc.append_bytes(bytes(data), time.monotonic() - started)
                        chunks += 1
                finally:
                    await source.aclose()
                outcome = {"event": "done", "chunks": chunks}
            except Exception as exc:
                detail = stream_error_message(exc)
                outcome = {"event": "error", "detail": detail}
            finally:
                self._adc_stop = None
                self.post(lambda: on_finished(outcome))

        self.call(run())

    # ---- shutdown ---------------------------------------------------------------

    def shutdown(self, timeout: float = 10.0) -> None:
        self.stop()
        try:
            self.call(self.svc.stop()).result(timeout=timeout)
        except Exception as exc:
            log.warning("engine shutdown: %s", exc)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=timeout)
