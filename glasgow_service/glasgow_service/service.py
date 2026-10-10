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

import numpy as np

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.macros.vector import (
    AdaptiveGrayFeedbackConfig, VectorScanCommand,
)
from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode, BeamType
from GlasgowDataIO.IobeamControl.applet.adcTiming import AdcTiming
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from GlasgowDataIO.IobeamControl.transfer.adcStream import AdcConnection

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.automation_log import AutomationLog
# Single source of truth for scan parameters — see the module docstring
# in scan_params.py for the design notes. JSON config → params, then
# request → params.override(...) → macro.
from AutomationPy.buildingblocks.scan_params import RasterParams, VectorParams

from .device_lock import DeviceHeld, DeviceLock
from .models import (
    DeviceState, ServiceStatus, RasterRequest, VectorRequest, AdcTestRequest,
    DacRampRequest, DacRampAxis,
    VectorPattern, VectorScanPath,
    ScanResult, ScanValidation, ValidationCheck,
)

LOG_NAME = r'GlasgowService'
logger      = AutomationLog.GetLogger(LOG_NAME)

class DeviceBusy(RuntimeError):     ...
class DeviceNotReady(RuntimeError): ...


# A disconnected revC3 ADC bus is pulled high and therefore reads as full
# scale forever. The normal SixteenBit stream is OBI-compatible left-aligned
# raw14 (0xfffc); EightBit output is its high byte (0xff). Raw right-aligned
# values remain accepted for diagnostics and older captures.
_ADC_FULL_SCALE_VALUES = frozenset((0x3FFF, 0xFFFC, 0xFF, 0x3F))

# The gateware sends every scan sample the way OBI does: the 14-bit ADC code
# left-aligned in 16 bits (code << 2, full scale 0xFFFC). All four hardware-free
# simulators must produce the same convention, or the same input would look
# four times darker through one of them. Use these helpers, not an inline shift.
_OBI_SAMPLE_SHIFT = 2


def _obi_aligned_int(raw14: int) -> int:
    """One raw 14-bit ADC code -> the 16-bit value the gateware sends."""
    return int(raw14) << _OBI_SAMPLE_SHIFT


def _obi_aligned_np(raw14):
    """Raw 14-bit ADC codes (numpy) -> uint16 values as the gateware sends them."""
    import numpy as np
    return (np.asarray(raw14, dtype=np.uint32) << _OBI_SAMPLE_SHIFT).astype(np.uint16)

_ADC_PRESENCE_MIN_SAMPLES = 256
_ADC_DIAGNOSTIC_UNIQUE_LIMIT = 64
_ADC_FULL_SCALE_ARRAY = np.array(sorted(_ADC_FULL_SCALE_VALUES), dtype=np.int64)


def _chunk_as_array(chunk) -> "np.ndarray":
    """Numeric view of a sample chunk (array('H'/'B'), bytes, ndarray or list)."""
    if isinstance(chunk, (bytes, bytearray, memoryview)):
        return np.frombuffer(chunk, dtype=np.uint8)
    return np.asarray(chunk)


def _prefix_blocks(size: int, first: int = 4096):
    """Yield growing [start, stop) blocks covering 0..size (4 Ki, 8 Ki, 16 Ki, ...)."""
    start, width = 0, first
    while start < size:
        stop = min(size, start + width)
        yield start, stop
        start, width = stop, width * 2


def _leading_full_scale_run(values: "np.ndarray") -> int:
    """Length of the leading run of full-scale samples (examines only what it needs)."""
    for start, stop in _prefix_blocks(values.size):
        block = values[start:stop]
        non_full = np.flatnonzero(~np.isin(block, _ADC_FULL_SCALE_ARRAY))
        if non_full.size:
            return start + int(non_full[0])
    return int(values.size)


def _collect_first_distinct(values: "np.ndarray", seen: set, limit: int) -> None:
    """Add distinct values to ``seen`` in first-occurrence order until it holds ``limit``."""
    for start, stop in _prefix_blocks(values.size, first=256):
        block = values[start:stop]
        distinct, first_index = np.unique(block, return_index=True)
        for value in distinct[np.argsort(first_index, kind="stable")]:
            if len(seen) >= limit:
                return
            seen.add(int(value))
        if len(seen) >= limit:
            return


def _simulated_pass_samples(kind: str, req) -> int:
    """Samples in one simulated frame (raster) or pass (vector)."""
    if kind == "raster":
        return req.resolution * req.resolution
    if req.pattern is VectorPattern.custom and req.points is not None:
        return len(req.points)
    bitmap = getattr(req, "simulation_bitmap", None)
    if req.pattern is VectorPattern.custom and bitmap is not None:
        return int(bitmap.width) * int(bitmap.height)
    return req.vector_resolution * req.vector_resolution


class _FrameRing:
    """Chunk capture for a continuous (live) raster stream.

    A live scan never ends on its own, so keeping every chunk (as the
    single-frame path does for /scan/last/*) would grow without bound.
    This keeps only the chunks of the frame in progress plus the last
    complete frame. ``frame()`` returns the last complete frame, or the
    partial first frame if Stop came before one finished.

    Chunk boundaries always coincide with frame boundaries (each frame is
    chunked independently), so counting pixels is enough to find them.
    """

    def __init__(self, frame_pixels: int):
        self.frame_pixels = max(1, int(frame_pixels))
        self._current: List = []
        self._current_pixels = 0
        self._last: Optional[List] = None
        self.frames_completed = 0

    def append(self, chunk) -> None:
        self._current.append(chunk)
        self._current_pixels += len(chunk)
        if self._current_pixels >= self.frame_pixels:
            self._last = self._current
            self._current = []
            self._current_pixels = 0
            self.frames_completed += 1

    def frame(self) -> List:
        return self._last if self._last is not None else list(self._current)

    def __len__(self) -> int:
        return len(self.frame())


class _AdcPresenceMonitor:
    """Detect the disconnected-bus signature while samples are streaming."""

    def __init__(self, *, enabled: bool,
                 minimum_samples: int = _ADC_PRESENCE_MIN_SAMPLES):
        self.enabled = enabled
        self.minimum_samples = minimum_samples
        self.full_scale_samples = 0
        self.conclusive = False
        self.sample_count = 0
        self.minimum = None
        self.maximum = None
        self.first_samples = []
        self.unique_values = set()

    def observe(self, chunk) -> Optional[str]:
        """Update diagnostics with ``chunk``; return a fault message on the
        disconnected-bus signature.

        Vectorised with numpy. The previous per-sample Python loop ran on the
        event loop that also services USB, costing ~0.27 us per sample
        (~1.1 s per 2048x2048 frame), which stalled the FPGA FIFO. The results
        are identical to that loop, including the early return: when the fault
        fires mid-chunk, only the samples up to and including the one that
        completed the full-scale run are counted.
        """
        if not self.enabled:
            return None
        values = _chunk_as_array(chunk)
        if values.size == 0:
            return None

        fault = None
        if not self.conclusive:
            leading = _leading_full_scale_run(values)
            needed = self.minimum_samples - self.full_scale_samples
            if leading >= needed:
                # The run of full-scale samples reaches the threshold inside
                # this chunk: the loop returned right after that sample.
                values = values[:needed]
                self.full_scale_samples += needed
                self.conclusive = True
                fault = (
                    "ADC/subtarget presence check failed: the first "
                    f"{self.full_scale_samples} returned samples were all full "
                    "scale (0xfffc/0x3fff/0xff). This establishes constant "
                    "full-scale data, not its cause; check scan capture timing "
                    "and compare with an independent ADC capture."
                )
            else:
                self.full_scale_samples += leading
                if leading < values.size:
                    # Presence is established for this scan; later chunks and
                    # ordinary clipped regions are not re-examined.
                    self.conclusive = True

        self.sample_count += int(values.size)
        low, high = int(values.min()), int(values.max())
        self.minimum = low if self.minimum is None else min(self.minimum, low)
        self.maximum = high if self.maximum is None else max(self.maximum, high)
        if len(self.first_samples) < 8:
            self.first_samples.extend(int(v) for v in values[:8 - len(self.first_samples)])
        if len(self.unique_values) < _ADC_DIAGNOSTIC_UNIQUE_LIMIT:
            _collect_first_distinct(values, self.unique_values, _ADC_DIAGNOSTIC_UNIQUE_LIMIT)
        return fault

    def summary(self) -> Optional[str]:
        if not self.enabled or not self.sample_count:
            return None
        unique = len(self.unique_values)
        unique_suffix = ">=" if unique >= _ADC_DIAGNOSTIC_UNIQUE_LIMIT else ""
        first = ",".join(f"0x{value:x}" for value in self.first_samples)
        return (
            "ADC sample summary: samples=%d min=0x%x max=0x%x unique=%s%d "
            "full_scale=%d first=[%s]"
            % (self.sample_count, self.minimum, self.maximum, unique_suffix,
               unique, self.full_scale_samples, first)
        )


def _production_adc_fault(chunks: Iterable, *, minimum_samples: int = _ADC_PRESENCE_MIN_SAMPLES) -> Optional[str]:
    """Return a diagnostic as soon as a scan looks like an undriven bus.

    Requiring a sustained, exact full-scale run avoids classifying ordinary
    images containing a few clipped pixels as disconnected.  Very small
    diagnostic scans are intentionally left alone because they do not provide
    enough evidence for a hardware-presence decision.
    """
    monitor = _AdcPresenceMonitor(
        enabled=True, minimum_samples=minimum_samples)
    for chunk in chunks:
        fault = monitor.observe(chunk)
        if fault is not None:
            return fault
    return None


def _assert_production_adc_present(config, chunks: Iterable) -> None:
    if _simulation_enabled(config):
        return
    fault = _production_adc_fault(chunks)
    if fault is not None:
        raise DeviceNotReady(fault)


def _default_vector_iter(edge: int = 2048, dwell: int = 1) -> Iterable[Tuple[int, int, int]]:
    """Yield (x, y, dwell) triples for a default sweep at the given edge
    resolution. Coverage is always the full 14-bit DAC range; smaller
    edge values produce sparser sampling. Custom edge counts are
    distributed as evenly as possible across the full range."""
    x_range = DACCodeRange.from_resolution(edge)
    y_range = DACCodeRange.from_resolution(edge)
    for x_idx in range(edge):
        x = x_range.start + ((x_idx * x_range.step) >> 8)
        for y_idx in range(edge):
            y = y_range.start + ((y_idx * y_range.step) >> 8)
            yield x, y, dwell


# Host-link pacing.
#
# The macros send a scan as chunks and flush the USB OUT pipe after every
# chunk. On the VirtualBox install each chunk costs milliseconds of host/USB
# time (the scope showed ~9 ms flat steps; the 2026-09-23 vector scan
# averaged ~51 ms wall time per chunk including init and dumps), while one
# 8196-dwell chunk is only ~1.1 ms of beam time. The FPGA then executes a
# burst, runs dry and parks the beam until the next chunk lands: the DAC
# shows short ramps separated by flat steps (4 per 2048-point line at 513
# points/chunk) instead of OBI's continuous sawtooth. Upstream OBI avoids
# this by sending a frame as one chunk (latency=65536*65536).
#
# Whether the per-chunk cost is the OUT flush, IN reads or host processing is
# not yet measured; the macros log a "[link]" summary at the end of every
# scan that splits the time up (see transfer/linkStats.py).
#
# Each chunk must therefore carry more beam time than one flush costs. The
# requested latency stays a lower bound; it is raised to cover
# `minChunkBeamTimeMs` (rasterScan / vectorScan in streamData.json).
FPGA_CLOCK_HZ                    = 48_000_000
DEFAULT_MIN_CHUNK_BEAM_TIME_MS   = 100.0
# Streamed vector points cost 6 bytes each on the OUT pipe; cap one chunk so
# max_pipeline chunks in flight stay well under the ~1.5 MB where bulk writes
# were seen to stall (see VectorScanCommand.transfer).
VECTOR_MAX_CHUNK_POINTS          = 32_768


def _command_dwell(cmd) -> int:
    """Dwell the command will run with (raster commands store it; vector
    commands carry it per point, so their effective default is used)."""
    dwell = getattr(cmd, "_dwell", None)
    if dwell is None:
        dwell = getattr(cmd, "link_dwell", None)
    return max(1, int(dwell if dwell is not None else 1))


def _link_chunk_latency(requested: int, dwell: int, conversion_hz: float,
                        min_chunk_ms: float, max_points: Optional[int] = None) -> int:
    """Latency (sum of dwell values per chunk, the macros' unit) such that
    one chunk keeps the FPGA busy for at least `min_chunk_ms`.

    A pixel with dwell d takes d + 1 ADC conversions. `requested` is kept as
    a lower bound so explicit larger values still win."""
    requested = max(1, int(requested))
    if min_chunk_ms <= 0 or conversion_hz <= 0:
        return requested
    dwell = max(0, int(dwell))
    pixels = math.ceil((min_chunk_ms / 1000.0) * conversion_hz / (dwell + 1))
    if max_points is not None:
        pixels = min(pixels, int(max_points))
    return max(requested, pixels * max(1, dwell))


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


def _roi_vector_iter(
    edge: int,
    roi,
    dwell: int = 1,
    scan_path: VectorScanPath = VectorScanPath.vertical_raster,
) -> Iterable[Tuple[int, int, int]]:
    bounds = _roi_bounds(roi)
    if bounds is None:
        x0, x1, y0, y1 = 0, 16383, 0, 16383
    else:
        x0, x1, y0, y1 = bounds
    x_range = _dac_range_for_bounds(x0, x1, edge)
    y_range = _dac_range_for_bounds(y0, y1, edge)
    xs = [x_range.start + ((idx * x_range.step) >> 8) for idx in range(edge)]
    ys = [y_range.start + ((idx * y_range.step) >> 8) for idx in range(edge)]

    if scan_path in (VectorScanPath.horizontal_sawtooth, VectorScanPath.horizontal_triangle):
        for y_idx, y in enumerate(ys):
            row_xs = reversed(xs) if scan_path is VectorScanPath.horizontal_triangle and y_idx % 2 else xs
            for x in row_xs:
                yield x, y, dwell
        return

    for x_idx, x in enumerate(xs):
        column_ys = reversed(ys) if scan_path is VectorScanPath.vertical_serpentine and x_idx % 2 else ys
        for y in column_ys:
            yield x, y, dwell


def _normalize_vector_point(
    point,
) -> Tuple[int, int, int, Optional[bool], Optional[int]]:
    if isinstance(point, tuple) or isinstance(point, list):
        if len(point) < 3:
            raise ValueError("vector point tuples must have at least 3 entries")
        blank = None if len(point) < 4 or point[3] is None else bool(point[3])
        pass_index = None if len(point) < 5 or point[4] is None else int(point[4])
        return int(point[0]), int(point[1]), int(point[2]), blank, pass_index

    x = getattr(point, "x", None)
    y = getattr(point, "y", None)
    dwell = getattr(point, "dwell", None)
    if x is None or y is None or dwell is None:
        raise ValueError("vector points must provide x, y, and dwell")
    blank = getattr(point, "blank", None)
    pass_index = getattr(point, "passIndex", None)
    return (
        int(x),
        int(y),
        int(dwell),
        None if blank is None else bool(blank),
        None if pass_index is None else int(pass_index),
    )


def _log_vector_point_flags(points) -> None:
    if not points:
        return
    blank_true = 0
    blank_false = 0
    blank_none = 0
    pass_one = 0
    pass_two = 0
    other_pass = 0
    for point in points:
        _x, _y, _dwell, blank, pass_index = _normalize_vector_point(point)
        if blank is True:
            blank_true += 1
        elif blank is False:
            blank_false += 1
        else:
            blank_none += 1
        if pass_index == 1:
            pass_one += 1
        elif pass_index == 2:
            pass_two += 1
        elif pass_index is not None:
            other_pass += 1
    logger.debug(
        "[vector] custom point flags total=%d blank_true=%d blank_false=%d "
        "blank_none=%d pass1=%d pass2=%d pass_other=%d",
        len(points), blank_true, blank_false, blank_none,
        pass_one, pass_two, other_pass,
    )


# Exception types that indicate the USB connection is dead and we should
# drop our reference so the next request reconnects. Matched by name to
# avoid importing classes that might not be public.
_FATAL_EXC_NAMES = {
    "GlasgowDeviceError",     # "device disconnected"
    "USBError", "USBErrorBusy", "USBErrorNoDevice", "USBErrorIO",
    "ConnectionError", "ConnectionResetError", "BrokenPipeError", "TimeoutError",
}


def _is_fatal_usb_error(exc: BaseException) -> bool:
    return type(exc).__name__ in _FATAL_EXC_NAMES


def _raster_image_from_chunks(chunks, res, dwell, adc_latency):
    """Assemble raster chunks into a (Y, X) image, one row per scan line.

    The FPGA emits raster pixels row-major with X as the fast axis. That is the
    order the frontend canvas, ``scan_display`` and upstream OBI's frame buffer
    all assume, so the frame is a plain reshape. This function used to
    transpose the frame on the assumption of a column-major stream, which made
    the PNG disagree with the on-screen image (verified end to end against the
    gateware: the stream is row-major).

    The per-row latency correction below is unchanged: each row is rolled by
    ``y * (adc_latency - 1) / dwell`` pixels. It now acts on true scan lines.
    """
    import numpy as np
    total = res * res
    flat = np.fromiter(
        (v for chunk in chunks for v in chunk),
        dtype=np.uint16,
        count=total if sum(len(c) for c in chunks) >= total else -1,
    )
    # If the scan was truncated (paused mid-frame), pad with zeros
    # so reshape works; downstream display tools tolerate zeros.
    if flat.size < total:
        flat = np.concatenate([flat, np.zeros(total - flat.size, dtype=np.uint16)])
    else:
        flat = flat[:total]
    img = flat.reshape(res, res)
    line_shift_per_row = ((adc_latency - 1) / dwell) if dwell else 0
    if line_shift_per_row:
        corrected = np.empty_like(img)
        for y in range(res):
            corrected[y] = np.roll(img[y], int(round(y * line_shift_per_row)))
        img = corrected
    return img


# Figure auto-levels trim this share of pixels at each end (matches the web
# wedge's automatic levels).
_FIGURE_CLIP_LO_PCT = 0.5
_FIGURE_CLIP_HI_PCT = 99.5


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


def _sample_chunk_to_wire_bytes(chunk) -> bytes:
    """Return sample bytes for WebSocket frames.

    SixteenBit chunks are array('H') numeric values, so normalize them to
    explicit big-endian bytes. EightBit chunks are array('B') values and
    already match the ImageSerializer wire contract: one byte per pixel.
    """
    if isinstance(chunk, (bytes, bytearray, memoryview)):
        return bytes(chunk)
    if isinstance(chunk, array.array) and chunk.typecode == "B":
        return chunk.tobytes()
    out = array.array("H", chunk)
    if sys.byteorder == "little":
        out.byteswap()
    return out.tobytes()


def _simulation_enabled(config) -> bool:
    return not bool(getattr(config, "IsProduction", True))


def _production_adc_monitor_enabled(config, adc_valid: bool = True) -> bool:
    """Enable the ADC monitor only for production scans that request it."""
    return bool(adc_valid) and not _simulation_enabled(config)


def _bitmap_sample(bitmap, x_norm: float, y_norm: float) -> int:
    x_norm = min(1.0, max(0.0, x_norm if math.isfinite(x_norm) else 0.0))
    y_norm = min(1.0, max(0.0, y_norm if math.isfinite(y_norm) else 0.0))
    x = min(bitmap.width - 1, max(0, round(x_norm * (bitmap.width - 1))))
    y = min(bitmap.height - 1, max(0, round(y_norm * (bitmap.height - 1))))
    return _bitmap_pixel_sample(bitmap.pixels[y * bitmap.width + x], None)


def _bitmap_sample_point(bitmap, roi, x: int, y: int, transforms=None) -> int:
    if roi is None:
        x_norm, y_norm = x / 0x3FFF, y / 0x3FFF
    else:
        x0, x1 = sorted((int(roi.x_start), int(roi.x_end)))
        y0, y1 = sorted((int(roi.y_start), int(roi.y_end)))
        x_norm = (int(x) - x0) / max(1, x1 - x0)
        y_norm = (int(y) - y0) / max(1, y1 - y0)
    return _bitmap_sample(bitmap, x_norm, y_norm)


def _bitmap_pixel_value(pixel) -> int:
    if isinstance(pixel, int):
        return int(pixel)
    if pixel is None:
        return 0
    return int(getattr(pixel, "value", 0))


def _bitmap_pixel_is_highlighted(pixel) -> bool:
    if isinstance(pixel, int) or pixel is None:
        return False
    return bool(getattr(pixel, "isHighlighted", False))


def _bitmap_pixel_is_skipped(pixel):
    if isinstance(pixel, int) or pixel is None:
        return None
    value = getattr(pixel, "isSkipped", None)
    if value is None:
        return None
    return bool(value)


def _bitmap_pixel_blank(pixel):
    if isinstance(pixel, int) or pixel is None:
        return None
    value = getattr(pixel, "blank", None)
    if value is None:
        return None
    return bool(value)


def _infer_bitmap_mode(bitmap) -> Optional[str]:
    for pixel in bitmap.pixels:
        skipped = _bitmap_pixel_is_skipped(pixel)
        if skipped is not None:
            return "splash" if skipped is False else "skip"
    for pixel in bitmap.pixels:
        if _bitmap_pixel_is_highlighted(pixel):
            return "skip"
    return None


def _bitmap_pixel_sample(pixel, mode: Optional[str]) -> int:
    value = min(_bitmap_pixel_value(pixel) * 64, 0x3FFF)
    blank = _bitmap_pixel_blank(pixel)
    if blank is not None:
        return 0 if blank else value
    skipped = _bitmap_pixel_is_skipped(pixel)
    highlighted = _bitmap_pixel_is_highlighted(pixel)

    if mode == "skip":
        return 0 if skipped is True or (skipped is None and highlighted) else value
    if mode == "splash":
        return value if skipped is False else 0
    return 0 if skipped is True or highlighted else value


def _bitmap_pixel_at(bitmap, x_norm: float, y_norm: float):
    x_norm = min(1.0, max(0.0, x_norm if math.isfinite(x_norm) else 0.0))
    y_norm = min(1.0, max(0.0, y_norm if math.isfinite(y_norm) else 0.0))
    x = min(bitmap.width - 1, max(0, round(x_norm * (bitmap.width - 1))))
    y = min(bitmap.height - 1, max(0, round(y_norm * (bitmap.height - 1))))
    return bitmap.pixels[y * bitmap.width + x]


def _bitmap_raster_chunks(req: RasterRequest, transforms=None) -> Optional[List[array.array]]:
    bitmap = getattr(req, "simulation_bitmap", None)
    if bitmap is None or not bitmap.pixels:
        return None

    bitmap_mode = _infer_bitmap_mode(bitmap)

    pixels_per_chunk = max(1, math.ceil(req.latency_bytes / req.dwell))
    total = req.resolution * req.resolution
    chunks: List[array.array] = []
    for start in range(0, total, pixels_per_chunk):
        samples = array.array("H")
        for idx in range(start, min(start + pixels_per_chunk, total)):
            x = idx % req.resolution
            y = idx // req.resolution
            x_norm = 0.0 if req.resolution <= 1 else x / (req.resolution - 1)
            y_norm = 0.0 if req.resolution <= 1 else y / (req.resolution - 1)
            px = _bitmap_pixel_at(bitmap, x_norm, y_norm)
            samples.append(_obi_aligned_int(_bitmap_pixel_sample(px, bitmap_mode)))
        chunks.append(samples)
    return chunks


# ---------------------------------------------------------------------------
# Hardware-free simulation
# ---------------------------------------------------------------------------
# With IsProduction=false and simulation enabled, a scan must not touch a
# Glasgow at all. It must still *be* a scan: the same lock and abort handling as
# a real one, and chunks delivered one at a time as the frame is "acquired",
# because the frontend paints its live canvas from that chunk stream.
#
# Pixel values come from the same source that feeds the FPGA's FakeAdcSimulator
# (GlasgowDataIO/IobeamControl/applet/imageSource.py), addressed by DAC code the
# way the gateware does it, so a simulated frame equals what the fake ADC would
# have returned.

_SIM_DEFAULT_CHUNK_INTERVAL_S = 0.02


class _SimulatedCommand:
    """Stand-in for a scan macro: the service only needs its abort event."""

    def __init__(self) -> None:
        self.abort = asyncio.Event()


def _simulation_chunk_interval(simulation: dict) -> float:
    """Seconds between simulated chunks (``simulation.chunkIntervalMs``, default 20)."""
    try:
        ms = float((simulation or {}).get(
            "chunkIntervalMs", _SIM_DEFAULT_CHUNK_INTERVAL_S * 1000))
    except (TypeError, ValueError):
        ms = _SIM_DEFAULT_CHUNK_INTERVAL_S * 1000
    return max(0.0, ms) / 1000.0


def _dac_codes(start: int, span: int, count: int):
    """The DAC codes an FPGA counter visits: ``start + ((i * step) >> 8)``.

    ``step`` is ``span / count`` in 8.8 fixed point, exactly as
    ``DACCodeRange.from_resolution`` and ``_dac_range_for_bounds`` build it, but
    without their 16-bit step limit, which hardware-free scans do not need.
    """
    import numpy as np
    step = max(1, int((max(1, span) / count) * 256))
    codes = int(start) + ((np.arange(count, dtype=np.int64) * step) >> 8)
    return np.minimum(codes, 0x3FFF)


def _simulation_sampler(simulation: dict):
    """Return raw 14-bit ``f(x_codes, y_codes)`` samples for simulation."""
    import numpy as np
    mode = str((simulation or {}).get("mode", "image")).lower()
    if mode == "zeros":
        return lambda x, y: np.zeros(np.shape(x), dtype=np.uint16)
    if mode == "loopback":
        return lambda x, y: (np.asarray(x, dtype=np.int64) & 0x3FFF).astype(np.uint16)
    if mode != "image":
        raise ValueError(
            f"unknown simulation mode {mode!r}; valid: image, zeros, loopback")

    from GlasgowDataIO.IobeamControl.applet.imageSource import get_image_data
    data, resolution = get_image_data(simulation)
    side = int(resolution)
    if side < 2 or side & (side - 1):
        raise ValueError(f"simulation imageResolution must be a power of two, got {side}")
    image = np.asarray(data, dtype=np.uint16).reshape(side, side)
    shift = 14 - (side.bit_length() - 1)      # x_idx = dac_x_code >> shift
    return lambda x, y: image[np.asarray(y) >> shift, np.asarray(x) >> shift]


async def _paced_chunks(chunks, *, abort, interval: float):
    """Hand out prebuilt chunks one at a time, yielding to the loop between them."""
    for n, chunk in enumerate(chunks):
        await asyncio.sleep(interval if n else 0)
        if abort.is_set():
            return
        yield chunk


async def _simulated_raster_chunks(req: RasterRequest, simulation: dict, *,
                                   abort, interval: float, transforms=None):
    """Raster stream for the configured simulation source: X fast, one row per line."""
    import numpy as np
    sampler = await asyncio.to_thread(_simulation_sampler, simulation)
    bounds = _roi_bounds(req.roi)
    x0, x1, y0, y1 = bounds if bounds is not None else (0, 0x3FFF, 0, 0x3FFF)
    width = height = req.resolution
    xs = _dac_codes(x0, x1 - x0 + 1, width)
    ys = _dac_codes(y0, y1 - y0 + 1, height)
    total = width * height
    pixels_per_chunk = max(1, math.ceil(req.latency_bytes / req.dwell))
    for n, start in enumerate(range(0, total, pixels_per_chunk)):
        await asyncio.sleep(interval if n else 0)
        if abort.is_set():
            return
        idx = np.arange(start, min(start + pixels_per_chunk, total), dtype=np.int64)
        samples = _obi_aligned_np(sampler(xs[idx % width], ys[idx // width]))
        yield array.array("H", samples.tobytes())


async def _simulated_vector_chunks(req: VectorRequest, simulation: dict, *,
                                   abort, interval: float, transforms=None):
    """Vector stream for the configured simulation source: one sample per point."""
    import numpy as np
    sampler = await asyncio.to_thread(_simulation_sampler, simulation)
    if req.pattern is VectorPattern.custom and req.points is not None:
        iter_points = iter(req.points)
    else:
        iter_points = _roi_vector_iter(
            req.vector_resolution, req.roi, dwell=req.dwell, scan_path=req.scan_path)

    limit = max(1, req.latency_bytes)
    xs: List[int] = []
    ys: List[int] = []
    blanks: List[bool] = []
    total_dwell = 0
    emitted = 0

    def build() -> array.array:
        x = np.clip(np.asarray(xs, dtype=np.int64), 0, 0x3FFF)
        y = np.clip(np.asarray(ys, dtype=np.int64), 0, 0x3FFF)
        samples = _obi_aligned_np(sampler(x, y))
        samples[np.asarray(blanks, dtype=bool)] = 0
        return array.array("H", samples.tobytes())

    for point in iter_points:
        x, y, dwell, blank, _pass_index = _normalize_vector_point(point)
        xs.append(x)
        ys.append(y)
        blanks.append(bool(blank))
        total_dwell += max(1, int(dwell))
        if total_dwell >= limit or len(xs) >= 65536:
            await asyncio.sleep(interval if emitted else 0)
            if abort.is_set():
                return
            yield build()
            emitted += 1
            xs, ys, blanks, total_dwell = [], [], [], 0
    if xs:
        await asyncio.sleep(interval if emitted else 0)
        if not abort.is_set():
            yield build()


def _bitmap_vector_chunks(req: VectorRequest, transforms=None) -> Optional[List[array.array]]:
    bitmap = getattr(req, "simulation_bitmap", None)
    if bitmap is None or not bitmap.pixels:
        return None

    chunks: List[array.array] = []
    samples = array.array("H")
    total_dwell = 0

    def flush() -> None:
        nonlocal samples, total_dwell
        if samples:
            chunks.append(samples)
            samples = array.array("H")
            total_dwell = 0

    if req.pattern is VectorPattern.custom and req.points:
        iter_points = iter(req.points)
        sample_value = lambda x, y, blank: 0 if blank else _bitmap_sample_point(
            bitmap, req.roi, x, y, transforms)
    elif req.pattern is VectorPattern.custom:
        def generated_points():
            for idx in range(bitmap.width * bitmap.height):
                x = idx // bitmap.height
                y = idx % bitmap.height
                yield x, y, req.dwell, False
        iter_points = generated_points()
        def sample_value(x, y, blank):
            if blank:
                return 0
            x_norm = 0.0 if bitmap.width <= 1 else x / (bitmap.width - 1)
            y_norm = 0.0 if bitmap.height <= 1 else y / (bitmap.height - 1)
            return _bitmap_sample(bitmap, x_norm, y_norm)
    else:
        iter_points = _roi_vector_iter(
            req.vector_resolution, req.roi, dwell=req.dwell, scan_path=req.scan_path
        )
        sample_value = lambda x, y, blank: 0 if blank else _bitmap_sample_point(
            bitmap, req.roi, x, y, transforms)

    for point in iter_points:
        x, y, dwell, blank, _pass_index = _normalize_vector_point(point)
        samples.append(_obi_aligned_int(sample_value(x, y, blank)))
        total_dwell += max(1, int(dwell))
        if total_dwell >= max(1, req.latency_bytes) or len(samples) >= 65536:
            flush()
    flush()
    return chunks


def _gray_range_to_u14(gray_range: Tuple[int, int]) -> Tuple[int, int]:
    lo, hi = sorted((int(gray_range[0]), int(gray_range[1])))
    return min(lo * 64, 0x3FFF), min(hi * 64, 0x3FFF)


class DeviceService:
    """One scan at a time. One USB connection, lazily opened, dropped on error."""

    def __init__(self, config_path: str):
        self._config_path = config_path
        self._config = AutomationConfig(config_path)
        # AutomationConfig keeps top-level JSON keys in its backing mapping,
        # while the scan implementation intentionally reads IsProduction as
        # an attribute. Normalize that boundary once; do not add scan-path
        # conditionals or alter the IobeamTech scan algorithm.
        if not hasattr(self._config, "IsProduction"):
            self._config.IsProduction = self._config.__dict__.get("IsProduction", True)

        action = util.GetStateConfigByName(self._config, "streamData")[Consts.ACTION_DATA]
        # Raw JSON blocks kept for backward compat with existing
        # display-render code that pulls camelCase keys directly
        # (lineShiftPerXRow, adcLatency, xResolution, etc.).
        self._raster_defaults = action.get("rasterScan", {}) or {}
        self._vector_defaults = action.get("vectorScan", {}) or {}
        self._simulation_defaults = action.get("simulation", {}) or {}
        self._action_defaults = action or {}

        # Normalized scan params, single source of truth for the macros.
        # JSON's camelCase keys (frameBlank, latency, drainFloorPixels) are
        # accepted alongside the snake_case API spellings, so streamData.json
        # doesn't need to be migrated in lockstep.
        self._raster_params_defaults = RasterParams.from_json(self._raster_defaults)
        self._vector_params_defaults = VectorParams.from_json(self._vector_defaults)
        try:
            self._conversion_hz = FPGA_CLOCK_HZ / AdcTiming.from_action(action).period
        except Exception as exc:  # malformed timing block: keep the requested latency
            logger.warning("ADC timing unreadable (%s); host-link chunk pacing disabled, "
                           "scans use the requested latency", exc)
            self._conversion_hz = 0.0

        self._conn: Optional[GlasgowConnection] = None
        self._adc_conn: Optional[AdcConnection] = None
        # Cross-process USB ownership (see device_lock.py): the native desktop
        # app and this service must not claim the Glasgow at the same time.
        # Created lazily by the _device_lock property.
        self._active_command = None
        self._abort_requested = False
        self._lock = asyncio.Lock()
        self._status = ServiceStatus(state=DeviceState.IDLE)  # IDLE = "ready, not yet connected"

        # In-memory cache of the most recent completed scan. Populated by
        # both run_raster/run_vector (validated) AND the streaming
        # generators (live), so the browser can pull a CSV or PNG figure
        # from /scan/last/* regardless of which path produced the data.
        # Worst case ~16 MB (2048x2048 vector + 2048x2048 raster).
        self._last: Optional[dict] = None

    # -------- lifecycle ---------------------------------------------------

    def _device_lock_owner(self) -> str:
        return "glasgow_service (web UI)"

    @property
    def _device_lock(self) -> DeviceLock:
        lock = self.__dict__.get("_device_lock_obj")
        if lock is None:
            lock = self.__dict__["_device_lock_obj"] = DeviceLock(self._device_lock_owner())
        return lock

    def _claim_device(self) -> None:
        """Take cross-process ownership of the Glasgow before opening USB."""
        try:
            self._device_lock.acquire()
        except DeviceHeld as exc:
            raise DeviceNotReady(
                f"{exc}. Close the scan in that application (or release the device "
                "there) and try again.") from None

    def _release_device_if_idle(self) -> None:
        conn = getattr(self, "_conn", None)
        if (conn is None or not conn.connected) and getattr(self, "_adc_conn", None) is None:
            self._device_lock.release()

    async def start(self) -> None:
        """No hardware action. Connection is opened lazily on first scan."""
        self._status.state = DeviceState.IDLE
        logger.debug("service ready (lazy connect on first scan)")

    async def stop(self) -> None:
        """Best-effort: drop the reference. The library has no clean USB
        teardown, so we rely on process exit / GC for actual release."""
        if self._adc_conn is not None:
            await self._adc_conn.close()
            self._adc_conn = None
        if self._conn is not None:
            await self._conn._hard_close()
            self._conn = None
        self._device_lock.release()
        self._status.state = DeviceState.DISCONNECTED
        logger.debug("service stopped (connection reference dropped)")
        logger.info("service stopped (connection reference dropped)")

    async def reconnect(self) -> None:
        """Drop the current connection so the next scan opens a fresh one."""
        async with self._lock:
            if self._adc_conn is not None:
                await self._adc_conn.close()
                self._adc_conn = None
            if self._conn is not None:
                await self._conn._hard_close()
                self._conn = None
            self._device_lock.release()
            self._status.state = DeviceState.IDLE
            self._status.last_error = None
        logger.debug("connection dropped; next scan will reconnect")

    def status(self) -> ServiceStatus:
        return self._status.model_copy()

    def abort_active_scan(self) -> bool:
        """Cooperatively stop the active FPGA command without closing USB."""
        if not self._lock.locked():
            return False
        self._abort_requested = True
        abort = getattr(self._active_command, "abort", None)
        if abort is not None:
            abort.set()
        logger.info("scan abort requested")
        return True

    async def adc_stream(self, req: AdcTestRequest) -> AsyncIterator[bytes]:
        """Stream from the ADC-only image while holding the global device lock.

        Loading this image replaces the scan image. The normal connection is
        therefore closed first and left empty so the next scan reloads its own
        gateware. AdcConnection.close() always clears capture-enable before it
        releases the USB interface.
        """
        async with self._acquire("adc"):
            if self._conn is not None:
                await self._conn._hard_close()
                self._conn = None
            self._claim_device()

            conn = AdcConnection(
                self._config,
                duration_minutes=req.duration_minutes,
                simulation=req.simulation,
                seed=req.seed,
                chunk_bytes=req.chunk_bytes,
            )
            self._adc_conn = conn
            stop = asyncio.Event()

            class _AdcCommand:
                abort = stop

            command = _AdcCommand()
            self._activate_command(command)
            try:
                await conn.connect()
                async for chunk in conn.chunks(stop=stop):
                    if stop.is_set():
                        break
                    self._status.chunks_in_flight += 1
                    yield chunk
            finally:
                self._deactivate_command(command)
                try:
                    await conn.close()
                finally:
                    self._adc_conn = None
                    self._release_device_if_idle()

    def _activate_command(self, command) -> None:
        self._active_command = command
        # Lets the macros' end-of-scan [link] summary estimate beam time.
        if self._conversion_hz > 0:
            try:
                command.link_beam_hz = self._conversion_hz
            except AttributeError:
                pass
        if self._abort_requested:
            command.abort.set()

    # -------- hardware-free simulation --------------------------------------

    def _hardware_free(self, req) -> bool:
        """True when this scan must run without touching a Glasgow.

        That is the case for IsProduction=false when the simulation is enabled
        (``simulation.enabled``, on unless switched off) or the browser supplied
        a ``simulation_bitmap``. IsProduction=true always uses the hardware.
        """
        if not _simulation_enabled(self._config):
            return False
        if getattr(req, "simulation_bitmap", None) is not None:
            return True
        return bool(self._simulation_settings(req).get("enabled", True))

    def _simulation_settings(self, req) -> dict:
        """Resolve a request-scoped browser override without mutating service defaults."""
        override = getattr(req, "simulation", None)
        return dict(override) if isinstance(override, dict) else self._simulation_defaults

    async def _simulated_chunks(self, kind: str, req, command, *, pace: bool):
        """Stand-in for ``conn.transfer_multiple(cmd)`` that needs no device."""
        simulation = self._simulation_settings(req)
        interval = _simulation_chunk_interval(simulation) if pace else 0.0
        build_bitmap = _bitmap_raster_chunks if kind == "raster" else _bitmap_vector_chunks
        # Building a bitmap frame is pure Python; keep it off the event loop.
        transforms = self._action_defaults.get("transforms", {}) or {}
        bitmap_chunks = await asyncio.to_thread(build_bitmap, req, transforms)
        # Live raster (Infinite): repeat frames back to back on the same
        # stream until Stop, exactly like the hardware continuous command.
        continuous = pace and bool(getattr(req, "continuous", False))
        while True:
            if bitmap_chunks is not None:
                source = _paced_chunks(bitmap_chunks, abort=command.abort, interval=interval)
            elif kind == "raster":
                source = _simulated_raster_chunks(
                    req, simulation, abort=command.abort, interval=interval,
                    transforms=transforms)
            else:
                source = _simulated_vector_chunks(
                    req, simulation, abort=command.abort, interval=interval,
                    transforms=transforms)
            async for chunk in source:
                yield chunk
            if not continuous or command.abort.is_set():
                return
            # Keep the chunk cadence across the frame boundary.
            await asyncio.sleep(interval)

    def _simulated_last_scan(self, kind: str, req, chunks: List, source: str) -> dict:
        if kind == "raster":
            return {
                "kind": "raster",
                "chunks": chunks,
                "resolution": req.resolution,
                "dwell": req.dwell,
                "latency_bytes": req.latency_bytes,
                "simulation_bitmap": req.simulation_bitmap,
                "source": source,
            }
        return {
            "kind": "vector",
            "chunks": chunks,
            "latency_bytes": req.latency_bytes,
            "dwell": req.dwell,
            "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
            "scan_path": req.scan_path.value,
            "points": req.points,
            "vector_resolution": req.vector_resolution,
            "roi": req.roi,
            "simulation_bitmap": req.simulation_bitmap,
            "source": source,
        }

    async def _simulated_scan(self, kind: str, req, *, native_samples: bool = False):
        """A streamed scan with no device: same lock, abort and bookkeeping as a real one."""
        captured: List = []
        if getattr(req, "continuous", False):
            captured = _FrameRing(_simulated_pass_samples(kind, req))
        async with self._acquire(kind):
            command = _SimulatedCommand()
            self._activate_command(command)
            try:
                async for chunk in self._simulated_chunks(kind, req, command, pace=True):
                    self._status.chunks_in_flight += 1
                    captured.append(chunk)
                    yield chunk if native_samples else _sample_chunk_to_wire_bytes(chunk)
            finally:
                self._deactivate_command(command)
                # Like a real scan: keep whatever was captured, even if stopped.
                if isinstance(captured, _FrameRing):
                    captured = captured.frame()
                self._set_last_scan(req, self._simulated_last_scan(kind, req, captured, "stream"))

    async def _simulated_run_chunks(self, kind: str, req) -> List:
        """All chunks of a blocking simulated scan (caller holds the device lock)."""
        command = _SimulatedCommand()
        self._activate_command(command)
        try:
            return [chunk async for chunk in
                    self._simulated_chunks(kind, req, command, pace=False)]
        finally:
            self._deactivate_command(command)

    def _deactivate_command(self, command) -> None:
        if self._active_command is command:
            self._active_command = None
        self._abort_requested = False

    def defaults(self) -> dict:
        """Return the JSON defaults for the UI.

        Both shapes are present:
          * `raster` / `vector` — raw camelCase JSON keys, for back-compat
            with the existing frontend translation in `applyServerDefaults`
            and the display-render code that pulls `lineShiftPerXRow` etc.
          * `raster_params` / `vector_params` — normalized snake_case dicts
            matching the API request shapes, fed by RasterParams /
            VectorParams. New frontend code should prefer these — no
            client-side translation needed.
        """
        return {
            "raster": dict(self._raster_defaults),
            "vector": dict(self._vector_defaults),
            "simulation": dict(self._simulation_defaults),
            "adc": {
                "adcHalfPeriod": self._action_defaults.get("adcHalfPeriod", 3),
                "adcSettleCycles": self._action_defaults.get("adcSettleCycles", 1),
                "adcLatchCycles": self._action_defaults.get("adcLatchCycles", 1),
                "busTurnaroundCycles": self._action_defaults.get("busTurnaroundCycles", 0),
                "dacDataSetupCycles": self._action_defaults.get("dacDataSetupCycles", 1),
                "dacLatchCycles": self._action_defaults.get("dacLatchCycles", 1),
            },
            "mag_calibration": dict(self._action_defaults.get("magCalibration", {}) or {}),
            "raster_params": self._raster_params_defaults.to_public_dict(),
            "vector_params": self._vector_params_defaults.to_public_dict(),
            "selected_beam": (
                "ebeam" if bool(self._action_defaults.get("enableEbeam", False)) else "ion"
            ),
            "is_production": bool(getattr(self._config, "IsProduction", True)),
            "adc_test": bool(getattr(
                self._config, "AdcTest", self._action_defaults.get("AdcTest", True)
            )),
            "version": str(getattr(self._config, "Version", "")),
        }

    # -------- internal: effective params (JSON defaults ⊕ request override) ---

    def _effective_raster_params(self, req: "RasterRequest") -> RasterParams:
        """Merge the JSON defaults with the request, with the request
        winning on every field it explicitly carries. Macro-tuning
        constants (max_pipeline, padding_*) come from JSON only — they're
        not exposed on the request because nothing in the UI needs to set
        them, but a per-build streamData.json override flows through."""
        return self._raster_params_defaults.override(
            resolution    = req.resolution,
            dwell         = req.dwell,
            latency_bytes = req.latency_bytes,
            frame_blank   = req.frame_blank,
            cookie        = req.cookie,
            adc_valid     = req.adc_valid,
            output_mode   = req.output_mode,
            beam_type     = req.beam_type,
            external_control = req.external_control,
        )

    def _effective_vector_params(self, req: "VectorRequest") -> VectorParams:
        # `pattern` is a Pydantic enum; normalize to str for the dataclass.
        pattern_str = req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern)
        return self._vector_params_defaults.override(
            pattern           = pattern_str,
            vector_resolution = req.vector_resolution,
            dwell             = req.dwell,
            latency_bytes     = req.latency_bytes,
            output_mode       = req.output_mode,
            adc_valid         = req.adc_valid,
            beam_type         = req.beam_type,
            external_control  = req.external_control,
            cookie            = req.cookie,
            pre_process       = req.pre_process,
            do_validate       = req.do_validate,
            points            = req.points,
        )

    def _chunk_latency(self, kind: str, requested: int, cmd) -> int:
        """Effective transfer latency for a hardware scan (see _link_chunk_latency).

        ``cmd`` is the command actually being sent, not the request kind: a
        horizontal_sawtooth vector request may have been routed to a
        RasterScanCommand, and then the streamed-vector point cap must not
        apply (the raster generator sends a few bytes per chunk)."""
        dwell = _command_dwell(cmd)
        # The DAC-ramp diagnostic is itself the waveform under test.  Splitting
        # the 16,384-code sweep into host-link chunks inserts a USB/flush gap
        # between ramp segments, which appears on a scope as a staircase or
        # as a much-too-slow waveform.  Match upstream OBI's RampControl and
        # keep the complete sweep in one FPGA command stream.
        if kind == "dac_ramp":
            return max(1, int(requested), 16384 * dwell)

        streamed = isinstance(cmd, VectorScanCommand)
        cfg = self._vector_defaults if kind == "vector" else self._raster_defaults
        min_ms = float(cfg.get("minChunkBeamTimeMs", DEFAULT_MIN_CHUNK_BEAM_TIME_MS))
        latency = _link_chunk_latency(
            requested, dwell, self._conversion_hz, min_ms,
            VECTOR_MAX_CHUNK_POINTS if streamed else None)
        if latency != requested:
            logger.info("[%s] chunk latency %d -> %d (>= %.0f ms beam time per host flush%s)",
                        kind, requested, latency, min_ms,
                        ", streamed-point cap" if streamed else "")
        return latency

    def _adaptive_gray_feedback_config(
        self, req: "VectorRequest"
    ) -> Optional[AdaptiveGrayFeedbackConfig]:
        if not bool(self._vector_defaults.get("PixelFallbackBlank", False)):
            return None
        if getattr(req, "feedback_mode", None) != "adaptive_gray_feedback":
            mode = getattr(req, "feedback_mode", None)
            if getattr(mode, "value", None) != "adaptive_gray_feedback":
                return None
        if req.gray_level_range is None or req.gray_level_skipped is None:
            return None

        gray_min, gray_max = _gray_range_to_u14(req.gray_level_range)
        window_points = int(self._vector_defaults.get("adaptiveFeedbackWindowPoints", 1) or 1)
        pipeline_delay_points = int(
            self._vector_defaults.get("adaptiveFeedbackPipelineDelayPoints", 0) or 0
        )
        return AdaptiveGrayFeedbackConfig(
            gray_min=gray_min,
            gray_max=gray_max,
            blank_when_inside=bool(req.gray_level_skipped),
            window_points=window_points,
            pipeline_delay_points=pipeline_delay_points,
        )

    # -------- internal: lazy connect / drop-on-error ----------------------

    async def _ensure_conn(self) -> GlasgowConnection:
        """Return a live connection, opening one if we don't have it."""
        if self._conn is not None and self._conn.connected:
            return self._conn

        logger.debug("opening Glasgow connection")
        self._claim_device()
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
            if _is_fatal_usb_error(e):
                raise DeviceNotReady(str(e)) from e
            raise

        self._status.state = DeviceState.IDLE
        self._status.last_error = None
        return self._conn

    def _drop_conn_on_error(self, exc: BaseException) -> None:
        """Called from a scan's exception path. If the exception looks like
        a USB problem, drop the connection so the next request reconnects."""
        if _is_fatal_usb_error(exc):
            logger.warning("dropping connection after %s: %s",
                        type(exc).__name__, exc)
            self._conn = None

    # -------- streaming (for WebSocket) -----------------------------------

    async def raster_scan(self, req: RasterRequest, *, native_samples: bool = False):
        transport = "in_process" if native_samples else "websocket"
        if self._hardware_free(req):
            async for wire in self._simulated_scan("raster", req, native_samples=native_samples):
                yield wire
            return

        # Buffer chunks for the /scan/last/* download endpoints. We hold
        # references to the chunks already-yielded; the bytes are still
        # in memory anyway because the WebSocket frame keeps them until
        # the network layer flushes.
        captured: List = []
        scan_started = time.monotonic()
        first_sample_logged = False
        continuous = bool(getattr(req, "continuous", False))
        async with self._acquire("raster", transport=transport):
            conn = await self._ensure_conn()
            cmd = self._build_raster_cmd(req, continuous=continuous)
            latency = self._chunk_latency("raster", req.latency_bytes, cmd)
            if continuous:
                # Live scan: keep only the most recent frame for /scan/last/*
                # instead of every chunk of an unbounded stream.
                captured = _FrameRing(cmd.frame_pixels)
                logger.info("[raster] continuous live scan: %d px/frame, %d chunks/frame",
                            cmd.frame_pixels, cmd.frame_chunk_count(latency))
            self._activate_command(cmd)
            adc_monitor = _AdcPresenceMonitor(
                enabled=_production_adc_monitor_enabled(self._config, req.adc_valid))
            adc_presence_fault = False
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=latency):
                    self._status.chunks_in_flight += 1
                    if not first_sample_logged:
                        first_sample_logged = True
                        logger.info("scan first-sample kind=raster transport=%s elapsed=%.3fs",
                                    transport, time.monotonic() - scan_started)
                    captured.append(chunk)
                    fault = adc_monitor.observe(chunk)
                    if fault is not None:
                        logger.warning("production ADC presence warning: %s", fault)
                        adc_presence_fault = True
                        raise DeviceNotReady(fault)
                    yield chunk if native_samples else _sample_chunk_to_wire_bytes(chunk)
            except BaseException as e:
                adc_presence_fault = adc_presence_fault or (
                    isinstance(e, DeviceNotReady) and
                    str(e).startswith("ADC/subtarget presence check failed:"))
                self._drop_conn_on_error(e)
                raise
            finally:
                self._deactivate_command(cmd)
                summary = adc_monitor.summary()
                if summary is not None:
                    logger.info("%s", summary)
                # On normal completion AND on cancellation (Pause/Stop),
                # snapshot whatever we got. Partial captures are still
                # downloadable — better than nothing for a paused scan.
                if not adc_presence_fault:
                    self._set_last_scan(req, {
                        "kind": "raster",
                        "chunks": (captured.frame() if isinstance(captured, _FrameRing)
                                   else captured),
                        "resolution": req.resolution,
                        "dwell": req.dwell,
                        "latency_bytes": latency,
                        "source": "stream",
                    })

    async def vector_scan(self, req: VectorRequest, *, native_samples: bool = False):
        transport = "in_process" if native_samples else "websocket"
        if self._hardware_free(req):
            async for wire in self._simulated_scan("vector", req, native_samples=native_samples):
                yield wire
            return

        captured: List = []
        scan_started = time.monotonic()
        first_sample_logged = False
        async with self._acquire("vector", transport=transport):
            conn = await self._ensure_conn()
            cmd = self._build_vector_cmd(
                req, continuous=bool(getattr(req, "continuous", False)))
            latency = self._chunk_latency("vector", req.latency_bytes, cmd)
            if getattr(cmd, "continuous", False):
                # Live scan: keep only the most recent pass for /scan/last/*.
                pass_pixels = getattr(cmd, "pass_pixels", None) or cmd.frame_pixels
                captured = _FrameRing(pass_pixels)
                logger.info("[vector] continuous live scan: %d samples/pass (%s)",
                            pass_pixels, type(cmd).__name__)
            self._activate_command(cmd)
            if (req.pre_process and hasattr(cmd, "_pre_process_chunks")
                    and not getattr(cmd, "continuous", False)):
                cmd._pre_process_chunks(latency=latency)
            transfer_iter = conn.transfer_multiple(
                cmd, latency=latency)
            adc_monitor = _AdcPresenceMonitor(
                enabled=_production_adc_monitor_enabled(self._config, req.adc_valid))
            adc_presence_fault = False
            try:
                async for chunk in transfer_iter:
                    self._status.chunks_in_flight += 1
                    if not first_sample_logged:
                        first_sample_logged = True
                        logger.info("scan first-sample kind=vector transport=%s elapsed=%.3fs",
                                    transport, time.monotonic() - scan_started)
                    captured.append(chunk)
                    fault = adc_monitor.observe(chunk)
                    if fault is not None:
                        logger.warning("production ADC presence warning: %s", fault)
                        raise DeviceNotReady(fault)
                    yield chunk if native_samples else _sample_chunk_to_wire_bytes(chunk)
            except BaseException as e:
                adc_presence_fault = isinstance(e, DeviceNotReady) and \
                    str(e).startswith("ADC/subtarget presence check failed:")
                self._drop_conn_on_error(e)
                raise
            finally:
                self._deactivate_command(cmd)
                try:
                    # Ensure Stop/disconnect reaches Connection's cleanup
                    # before the service releases this scan generator.
                    await transfer_iter.aclose()
                finally:
                    summary = adc_monitor.summary()
                    if summary is not None:
                        logger.info("%s", summary)
                    # Preserve the previous known-good scan when this frame
                    # is the disconnected/full-scale signature. Partial
                    # operator-stopped captures remain downloadable.
                    if not adc_presence_fault:
                        self._set_last_scan(req, {
                            "kind": "vector",
                            "chunks": (captured.frame() if isinstance(captured, _FrameRing)
                                       else captured),
                            "latency_bytes": latency,
                            "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                            "scan_path": req.scan_path.value,
                            "points": req.points,
                            "vector_resolution": req.vector_resolution,
                            "roi": req.roi,
                            "source": "stream",
                        })

    async def dac_ramp_scan(self, req: DacRampRequest, *, native_samples: bool = False):
        """Streaming counterpart of run_dac_ramp, same shape as raster_scan/
        vector_scan so the WebSocket path (live UI) and the blocking REST
        path (/scan/dac_ramp/run) share one command builder and never drift.

        No `_hardware_free`/simulation branch: this is a hardware
        diagnostic by definition (checking the physical DAC/ADC path), so
        it always talks to the real device. If simulation-only operation
        is ever needed here, add it deliberately rather than inheriting
        raster/vector's bitmap-simulation machinery, which doesn't apply.
        """
        captured: List = []
        async with self._acquire("dac_ramp"):
            conn = await self._ensure_conn()
            cmd = self._build_dac_ramp_cmd(req)
            latency = self._chunk_latency("dac_ramp", req.latency_bytes, cmd)
            self._activate_command(cmd)
            # Same disconnected-bus detection raster/vector already run:
            # a floating revC3 ADC bus reads as full scale forever, which
            # looks exactly like a flat line pegged at 16383/16384 on the
            # waveform — indistinguishable from "Complete" without this
            # check. Surfacing it as an error (instead of silently
            # finishing) is what actually explains a flat trace to the
            # operator; the DAC ramp itself may well be fine.
            adc_monitor = _AdcPresenceMonitor(
                enabled=_production_adc_monitor_enabled(self._config, req.adc_valid))
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=latency):
                    self._status.chunks_in_flight += 1
                    captured.append(chunk)
                    yield chunk if native_samples else _sample_chunk_to_wire_bytes(chunk)
                    fault = adc_monitor.observe(chunk)
                    if fault is not None:
                        logger.warning("dac_ramp ADC presence warning: %s", fault)
                        raise DeviceNotReady(fault)
            except BaseException as e:
                self._drop_conn_on_error(e)
                raise
            finally:
                self._deactivate_command(cmd)
                if captured:
                    self._set_last_scan(req, {
                        "kind": "dac_ramp",
                        "chunks": captured,
                        "resolution": 16384,
                        "dwell": req.dwell,
                        "latency_bytes": latency,
                        "source": "stream",
                    })

    # -------- blocking wet-run (for REST + pytest) ------------------------

    async def run_raster(self, req: RasterRequest) -> ScanResult:
        if getattr(req, "continuous", False):
            # Blocking REST returns one frame; live streaming is WebSocket-only.
            req = req.model_copy(update={"continuous": False})
        if self._hardware_free(req):
            async with self._acquire("raster"):
                simulated_chunks = await self._simulated_run_chunks("raster", req)
                pixels_per_chunk = math.ceil(req.latency_bytes / req.dwell)
                total_pixels = req.resolution * req.resolution
                expected_chunks = math.ceil(total_pixels / pixels_per_chunk)
                self._set_last_scan(req, {
                    "kind": "raster",
                    "chunks": simulated_chunks,
                    "resolution": req.resolution,
                    "dwell": req.dwell,
                    "latency_bytes": req.latency_bytes,
                    "simulation_bitmap": req.simulation_bitmap,
                    "source": "validated",
                })
                validation = (
                    self._validate_raster(simulated_chunks, pixels_per_chunk, expected_chunks)
                    if req.do_validate else None
                )
                return ScanResult(
                    kind="raster",
                    chunks=len(simulated_chunks),
                    bytes=sum(len(c) * 2 for c in simulated_chunks),
                    resolution=req.resolution,
                    dwell=req.dwell,
                    expected_chunks=expected_chunks,
                    pixels_per_chunk=pixels_per_chunk,
                    send_time_s=0.0,
                    has_data=bool(simulated_chunks),
                    validation=validation,
                )

        chunks: List = []
        async with self._acquire("raster"):
            conn = await self._ensure_conn()
            cmd = self._build_raster_cmd(req)
            latency = self._chunk_latency("raster", req.latency_bytes, cmd)
            # Log effective params (post-override) — what actually goes to
            # the macro — rather than just the raw request. Makes it easy
            # to confirm a streamData.json default landed where it should.
            eff = self._effective_raster_params(req)
            logger.debug(
                "[raster] %dx%d dwell=%d latency=%d frame_blank=%s "
                "output_mode=%s cookie=%d adc_valid=%s max_pipeline=%d",
                eff.resolution, eff.resolution, eff.dwell, eff.latency_bytes,
                eff.frame_blank, eff.output_mode, eff.cookie, eff.adc_valid, eff.max_pipeline,
            )
            t0 = time.perf_counter()
            adc_monitor = _AdcPresenceMonitor(
                enabled=bool(req.adc_valid) and not _simulation_enabled(self._config))
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=latency):
                    chunks.append(chunk)
                    self._status.chunks_in_flight += 1
                    fault = adc_monitor.observe(chunk)
                    if fault is not None:
                        logger.warning("production ADC presence warning: %s", fault)
                        raise DeviceNotReady(fault)
            except BaseException as e:
                self._drop_conn_on_error(e)
                if _is_fatal_usb_error(e):
                    raise DeviceNotReady(str(e)) from e
                raise
            send_time = time.perf_counter() - t0

        pixels_per_chunk = math.ceil(latency / _command_dwell(cmd))
        total_pixels     = req.resolution * req.resolution
        expected_chunks  = math.ceil(total_pixels / pixels_per_chunk)
        total_bytes      = sum(len(c) * 2 for c in chunks)

        # Cache for /scan/last/csv and /scan/last/figure.
        if chunks:
            self._set_last_scan(req, {
                "kind": "raster",
                "chunks": chunks,
                "resolution": req.resolution,
                "dwell": req.dwell,
                "latency_bytes": latency,
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

    async def run_dac_ramp(self, req: DacRampRequest) -> ScanResult:
        """Blocking single-axis DAC ramp/linearity check (production, not
        a side script).

        This is the end-to-end fix for the DAC-output mismatch: upstream
        OBI verifies the DAC via manual_dac_ctrl.RampControl (one axis
        full-range, the other pinned), which was never ported into this
        fork. Without it, the only way to sanity-check DAC output was
        `/scan/vector/run`, whose default `scan_path` (vertical_raster)
        sweeps the *other* axis fast — on a scope the axis under test then
        shows a staircase (one step per full sweep of the other axis),
        which looks like a hardware fault but is a scan-pattern artifact.
        This reuses the same connection/lock/RasterScanCommand path as
        `/scan/raster/run`, just with one axis pinned to a single code.
        """
        chunks: List = []
        async with self._acquire("dac_ramp"):
            conn = await self._ensure_conn()
            cmd = self._build_dac_ramp_cmd(req)
            latency = self._chunk_latency("dac_ramp", req.latency_bytes, cmd)
            logger.debug(
                "[dac_ramp] axis=%s fixed_code=%d dwell=%d latency=%d cookie=%d",
                req.axis.value, req.fixed_code, req.dwell, req.latency_bytes, req.cookie,
            )
            t0 = time.perf_counter()
            adc_monitor = _AdcPresenceMonitor(
                enabled=_production_adc_monitor_enabled(self._config, req.adc_valid))
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=latency):
                    chunks.append(chunk)
                    self._status.chunks_in_flight += 1
                    fault = adc_monitor.observe(chunk)
                    if fault is not None:
                        logger.warning("dac_ramp ADC presence warning: %s", fault)
                        raise DeviceNotReady(fault)
            except BaseException as e:
                self._drop_conn_on_error(e)
                if _is_fatal_usb_error(e):
                    raise DeviceNotReady(str(e)) from e
                raise
            send_time = time.perf_counter() - t0

        total_bytes = sum(len(c) * 2 for c in chunks)

        # Cache for /scan/last/csv and /scan/last/figure, same as raster/vector.
        if chunks:
            self._set_last_scan(req, {
                "kind": "dac_ramp",
                "chunks": chunks,
                "resolution": 16384,
                "dwell": req.dwell,
                "latency_bytes": latency,
                "source": "validated",
            })

        return ScanResult(
            kind="dac_ramp",
            chunks=len(chunks),
            bytes=total_bytes,
            resolution=16384,
            dwell=req.dwell,
            send_time_s=send_time,
            has_data=bool(chunks),
        )

    async def run_vector(self, req: VectorRequest) -> ScanResult:
        if getattr(req, "continuous", False):
            # Blocking REST returns one pass; live streaming is WebSocket-only.
            req = req.model_copy(update={"continuous": False})
        if self._hardware_free(req):
            async with self._acquire("vector"):
                simulated_chunks = await self._simulated_run_chunks("vector", req)
                self._set_last_scan(req, {
                    "kind": "vector",
                    "chunks": simulated_chunks,
                    "latency_bytes": req.latency_bytes,
                    "dwell": req.dwell,
                    "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                    "scan_path": req.scan_path.value,
                    "points": req.points,
                    "vector_resolution": req.vector_resolution,
                    "roi": req.roi,
                    "simulation_bitmap": req.simulation_bitmap,
                    "source": "validated",
                })
                validation = self._validate_vector(simulated_chunks) if req.do_validate else None
                return ScanResult(
                    kind="vector",
                    chunks=len(simulated_chunks),
                    bytes=sum(len(c) * 2 for c in simulated_chunks),
                    dwell=req.dwell,
                    process_time_s=0.0 if req.pre_process else None,
                    send_time_s=0.0,
                    has_data=bool(simulated_chunks),
                    validation=validation,
                )

        chunks: List = []
        process_time = 0.0

        async with self._acquire("vector"):
            conn = await self._ensure_conn()
            cmd = self._build_vector_cmd(req)
            latency = self._chunk_latency("vector", req.latency_bytes, cmd)
            adaptive_feedback = getattr(cmd, "_adaptive_gray_feedback", None)

            if req.pre_process and hasattr(cmd, "_pre_process_chunks"):
                t0 = time.perf_counter()
                cmd._pre_process_chunks(latency=latency)
                process_time = time.perf_counter() - t0
                logger.debug("[vector] pre-process %.4fs", process_time)

            eff = self._effective_vector_params(req)
            logger.debug(
                "[vector] dwell=%d latency=%d pattern=%s vector_resolution=%d "
                "output_mode=%s feedback_mode=%s adaptive_feedback=%s pre_process=%s cookie=%d "
                "max_pipeline=%d drain_floor=%d",
                eff.dwell, eff.latency_bytes, eff.pattern, eff.vector_resolution,
                cmd._output_mode, req.feedback_mode, adaptive_feedback is not None, eff.pre_process, eff.cookie,
                eff.max_pipeline, eff.effective_drain_floor_pixels,
            )
            t0 = time.perf_counter()
            adc_monitor = _AdcPresenceMonitor(
                enabled=not _simulation_enabled(self._config))
            try:
                async for chunk in conn.transfer_multiple(
                        cmd, latency=latency):
                    chunks.append(chunk)
                    self._status.chunks_in_flight += 1
                    fault = adc_monitor.observe(chunk)
                    if fault is not None:
                        logger.warning("production ADC presence warning: %s", fault)
                        raise DeviceNotReady(fault)
            except BaseException as e:
                self._drop_conn_on_error(e)
                if _is_fatal_usb_error(e):
                    raise DeviceNotReady(str(e)) from e
                raise
            send_time = time.perf_counter() - t0

        total_bytes = sum(len(c) * 2 for c in chunks)

        if chunks:
            self._set_last_scan(req, {
                "kind": "vector",
                "chunks": chunks,
                "latency_bytes": latency,
                "dwell": req.dwell,
                "pattern": req.pattern.value if hasattr(req.pattern, "value") else str(req.pattern),
                "scan_path": req.scan_path.value,
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
            dwell=req.dwell,
            process_time_s=process_time if req.pre_process else None,
            send_time_s=send_time,
            has_data=bool(chunks),
            validation=validation,
        )

    # -------- command construction ---------------------------------------

    def _build_raster_cmd(self, req: RasterRequest, *,
                          continuous: bool = False) -> RasterScanCommand:
        """Build the macro command from JSON defaults overridden by the
        request. Every field the macro accepts is passed explicitly —
        nothing falls through to a hardcoded macro default.

        ``continuous`` is passed only by the streaming path (raster_scan);
        blocking /scan/raster/run always scans exactly one frame."""
        params = self._effective_raster_params(req)

        bounds = _roi_bounds(req.roi)
        if bounds is None:
            x_rng = y_rng = DACCodeRange.from_resolution(params.resolution)
        else:
            x0, x1, y0, y1 = bounds
            x_rng = _dac_range_for_bounds(x0, x1, params.resolution)
            y_rng = _dac_range_for_bounds(y0, y1, params.resolution)

        try:
            output_mode = OutputMode[params.output_mode]
        except KeyError:
            raise ValueError(
                f"unknown output_mode {params.output_mode!r}; "
                f"valid: {[m.name for m in OutputMode]}"
            )
        try:
            beam_type = BeamType[params.beam_type]
        except KeyError:
            raise ValueError(
                f"unknown beam_type {params.beam_type!r}; "
                f"valid: {[m.name for m in BeamType]}"
            )

        return RasterScanCommand(
            cookie=params.cookie,
            x_range=x_rng, y_range=y_rng,
            dwell_time=params.dwell,
            output_mode=output_mode,
            beam_type=beam_type,
            external_control=params.external_control,
            frame_blank=params.frame_blank,
            max_pipeline=params.max_pipeline,
            padding_min_pixels=params.padding_min_pixels,
            padding_ratio_denominator=params.padding_ratio_denominator,
            padding_dwell=params.padding_dwell,
            continuous=continuous,
        )

    def _build_dac_ramp_cmd(self, req: DacRampRequest) -> RasterScanCommand:
        """Mirror upstream OBI's manual_dac_ctrl.RampControl.scan(): full
        resolution on the swept axis, count=1 (a single fixed code) on the
        held axis. Goes through the exact same RasterScanCommand /
        UpstreamBusController path as `/scan/raster/run` — the gateware
        side has already been verified bit-for-bit against upstream, so
        this only needs to reproduce the *stimulus*, not re-implement the
        drive logic."""
        full  = DACCodeRange.from_resolution(16384)
        fixed = DACCodeRange(start=req.fixed_code, count=1, step=1)

        if req.axis == DacRampAxis.y:
            x_rng, y_rng = fixed, full
        else:
            x_rng, y_rng = full, fixed

        try:
            beam_type = BeamType[req.beam_type]
        except KeyError:
            raise ValueError(
                f"unknown beam_type {req.beam_type!r}; "
                f"valid: {[m.name for m in BeamType]}"
            )

        return RasterScanCommand(
            cookie=req.cookie,
            x_range=x_rng, y_range=y_rng,
            dwell_time=req.dwell,
            beam_type=beam_type,
            external_control=req.external_control,
        )

    def _build_vector_cmd(self, req: VectorRequest, *, continuous: bool = False):
        """Same shape as raster: every macro tunable comes from the
        effective params object.

        A default-pattern horizontal_sawtooth sweep is a plain X-fast raster
        over the ROI, so it runs on the FPGA's raster generator, exactly like
        upstream OBI images a frame: the host sends a few bytes per chunk
        instead of 6 bytes per point, the gateware produces a continuous
        sawtooth, and the sample order and DAC codes are identical to
        _roi_vector_iter (same DACCodeRange arithmetic). Every other path
        (custom points, triangle/vertical orders, adaptive feedback) still
        streams points.
        """
        params = self._effective_vector_params(req)
        adaptive_feedback = self._adaptive_gray_feedback_config(req)
        if adaptive_feedback is not None and params.dwell < 16:
            params = params.override(dwell=16)

        ranges = None
        if self._vector_runs_on_raster_generator(req, adaptive_feedback):
            x0, x1, y0, y1 = _roi_bounds(req.roi) or (0, 16383, 0, 16383)
            try:
                ranges = (_dac_range_for_bounds(x0, x1, params.vector_resolution),
                          _dac_range_for_bounds(y0, y1, params.vector_resolution))
            except ValueError:
                # Coarser than 256 codes per point: the raster generator's
                # UQ8.8 step can't express it, so stream the points instead.
                ranges = None
        if ranges is not None:
            raster = self._raster_params_defaults
            logger.info("[vector] horizontal_sawtooth %dx%d on the FPGA raster generator",
                        params.vector_resolution, params.vector_resolution)
            return RasterScanCommand(
                cookie=params.cookie,
                x_range=ranges[0],
                y_range=ranges[1],
                dwell_time=params.dwell,
                output_mode=self._parse_output_mode(params.output_mode),
                beam_type=self._parse_beam_type(params.beam_type),
                external_control=params.external_control,
                frame_blank=False,
                max_pipeline=raster.max_pipeline,
                padding_min_pixels=raster.padding_min_pixels,
                padding_ratio_denominator=raster.padding_ratio_denominator,
                padding_dwell=raster.padding_dwell,
                continuous=continuous,
            )

        if req.pattern is VectorPattern.custom:
            if req.points is None and not (
                req.simulation_bitmap is not None
                and req.roi is not None
                and not _simulation_enabled(self._config)
            ):
                raise ValueError("pattern=custom requires `points` or a production bitmap fallback")
            if req.points is not None:
                _log_vector_point_flags(req.points)
                points_factory = lambda: iter(req.points)
                pass_pixels = len(req.points)
            else:
                # Production compatibility for browser ROI bitmap scans:
                # simulation_bitmap is ignored by hardware, so fall back to
                # the regular ROI vector sweep rather than rejecting the
                # request as custom-without-points.
                points_factory = lambda: _roi_vector_iter(
                    params.vector_resolution, req.roi, dwell=params.dwell, scan_path=req.scan_path
                )
                pass_pixels = params.vector_resolution * params.vector_resolution
        else:
            points_factory = lambda: _roi_vector_iter(
                params.vector_resolution, req.roi, dwell=params.dwell, scan_path=req.scan_path
            )
            pass_pixels = params.vector_resolution * params.vector_resolution
        iter_points = points_factory()
        # Live passes re-generate their points; adaptive feedback stays per pass.
        continuous = continuous and adaptive_feedback is None

        try:
            output_mode = OutputMode[params.output_mode]
        except KeyError:
            raise ValueError(
                f"unknown output_mode {params.output_mode!r}; "
                f"valid: {[m.name for m in OutputMode]}"
            )
        try:
            beam_type = BeamType[params.beam_type]
        except KeyError:
            raise ValueError(
                f"unknown beam_type {params.beam_type!r}; "
                f"valid: {[m.name for m in BeamType]}"
            )

        cmd = VectorScanCommand(
            cookie=params.cookie,
            output_mode=OutputMode.SixteenBit if adaptive_feedback is not None else output_mode,
            beam_type=beam_type,
            external_control=params.external_control,
            iter_points=iter_points,
            drain_floor_pixels=params.effective_drain_floor_pixels,
            adaptive_gray_feedback=adaptive_feedback,
            max_pipeline=params.max_pipeline,
            fpga_pipeline_depth_pixels=params.fpga_pipeline_depth_pixels,
            drain_safety_factor=params.drain_safety_factor,
            sender_drain_timeout_s=params.sender_drain_timeout_s,
            continuous=continuous,
            points_factory=points_factory if continuous else None,
        )
        cmd.link_dwell = params.dwell
        cmd.pass_pixels = pass_pixels
        return cmd

    def _vector_runs_on_raster_generator(self, req: VectorRequest, adaptive_feedback) -> bool:
        if not bool(self._vector_defaults.get("sawtoothOnRasterGenerator", True)):
            return False
        if adaptive_feedback is not None or req.scan_path is not VectorScanPath.horizontal_sawtooth:
            return False
        if req.pattern is VectorPattern.default:
            return True
        # custom without points = the production ROI-bitmap fallback, which
        # scans the same ROI sweep (see below)
        return req.pattern is VectorPattern.custom and req.points is None and req.roi is not None

    @staticmethod
    def _parse_output_mode(name: str) -> OutputMode:
        try:
            return OutputMode[name]
        except KeyError:
            raise ValueError(f"unknown output_mode {name!r}; valid: {[m.name for m in OutputMode]}")

    @staticmethod
    def _parse_beam_type(name: str) -> BeamType:
        try:
            return BeamType[name]
        except KeyError:
            raise ValueError(f"unknown beam_type {name!r}; valid: {[m.name for m in BeamType]}")

    # -------- on-demand download bytes (CSV / PNG figure) -----------------

    def _set_last_scan(self, req, last: dict) -> None:
        # Record the parameters this scan actually ran with, so the DumpData
        # files can carry them in their header (see last_dump_csv_bytes).
        last.setdefault("scan_params", self._scan_param_header(req, last))
        self._last = last
        self._maybe_dump_last_outputs()

    def _scan_param_header(self, req, last: dict) -> List[Tuple[str, str]]:
        """Ordered (name, value) pairs describing the scan settings.

        Plain strings only, so the list pickles into the desktop artifact
        worker and is written verbatim into the CSV/PNG dump headers.
        """
        def enum_text(value) -> str:
            return str(getattr(value, "value", value))

        kind = last.get("kind", "")
        params: List[Tuple[str, str]] = [
            ("kind", kind),
            ("written", time.strftime("%Y-%m-%d %H:%M:%S")),
            ("source", str(last.get("source") or "")),
        ]
        if kind == "raster":
            res = getattr(req, "resolution", None)
            params.append(("resolution", f"{res}x{res}"))
        elif kind == "vector":
            pattern = enum_text(getattr(req, "pattern", ""))
            params.append(("pattern", pattern))
            if pattern == "default":
                edge = getattr(req, "vector_resolution", None)
                params.append(("resolution", f"{edge}x{edge}"))
            params.append(("scan_path", enum_text(getattr(req, "scan_path", ""))))
        elif kind == "dac_ramp":
            params.append(("axis", enum_text(getattr(req, "axis", ""))))
            params.append(("fixed_code", str(getattr(req, "fixed_code", ""))))

        dwell = getattr(req, "dwell", None)
        if dwell is not None:
            dwell = int(dwell)
            period_ns = (1e9 / self._conversion_hz) if getattr(self, "_conversion_hz", 0) else 125.0
            params.append(("dwell", f"{dwell} (+1 = {dwell + 1} x {period_ns:.1f} ns = "
                                    f"{(dwell + 1) * period_ns / 1000.0:.3f} us/pixel)"))
        requested_latency = getattr(req, "latency_bytes", None)
        effective_latency = last.get("latency_bytes", requested_latency)
        if effective_latency is not None:
            text = str(effective_latency)
            if requested_latency is not None and requested_latency != effective_latency:
                text += f" (requested {requested_latency})"
            params.append(("latency_bytes", text))
        for name in ("output_mode", "frame_blank", "adc_valid", "beam_type", "cookie"):
            if hasattr(req, name):
                params.append((name, str(getattr(req, name))))

        if kind == "vector":
            feedback = getattr(req, "feedback_mode", None)
            if feedback is not None:
                params.append(("feedback_mode", enum_text(feedback)))
            gray_range = getattr(req, "gray_level_range", None)
            if gray_range is not None:
                lo, hi = gray_range
                params.append(("gray_level_range", f"{lo}..{hi}"))
                skipped = getattr(req, "gray_level_skipped", None)
                if skipped is not None:
                    params.append(("gray_level_mode", "skip" if skipped else "spot"))

        roi = getattr(req, "roi", None)
        if roi is not None:
            params.append(("roi_dac", f"x {roi.x_start:g}..{roi.x_end:g}, y {roi.y_start:g}..{roi.y_end:g}"))
        params.append(("chunks", str(len(last.get("chunks") or []))))
        return [(name, value) for name, value in params if value != ""]

    def last_scan_params(self) -> List[Tuple[str, str]]:
        if not self._last:
            return []
        return [tuple(item) for item in (self._last.get("scan_params") or [])]

    def last_dump_csv_bytes(self) -> bytes:
        """DumpData CSV: the scan parameters as ``#`` comment lines, then
        the same rows as :meth:`last_csv_bytes` (``numpy.loadtxt`` and most
        CSV readers skip ``#`` lines by default)."""
        header = "".join(f"# {name}: {value}\n" for name, value in self.last_scan_params())
        return header.encode("utf-8") + self.last_csv_bytes()

    def last_dump_png_bytes(self) -> bytes:
        """DumpData PNG: the figure with the scan parameters stored as PNG
        text chunks (visible in image viewers' metadata / ``identify -verbose``)."""
        return self.last_figure_png(metadata={
            "Title": f"Ion beam {self._last.get('kind', 'scan')} scan",
            "Description": "; ".join(f"{name}={value}" for name, value in self.last_scan_params()),
            **{f"scan.{name}": value for name, value in self.last_scan_params()},
        })

    def _dump_filename(self, file_type: str, timestamp: str) -> str:
        if not self.has_last():
            return f"scan.{file_type}"
        last = self._last
        return self._last_filename(file_type, timestamp)

    def _last_filename(self, file_type: str, timestamp: str) -> str:
        last = self._last
        if not last:
            return f"scan.{file_type}"
        if last["kind"] == "raster":
            r = last.get("resolution") or 0
            return f"raster_{r}x{r}_{timestamp}.{file_type}"
        return f"vector_latency_{last.get('latency_bytes') or 0}_{timestamp}.{file_type}"

    def _maybe_dump_last_outputs(self) -> None:
        """Mirror the unit-test DumpData behavior for service/UI scans."""
        if not getattr(self._config, "DumpData", False):
            return
        if not self.has_last():
            return
        timestamp = time.strftime("%y%m%d_%H%M%S")
        try:
            output_dir = Path.home() / "Output"
            output_dir.mkdir(parents=True, exist_ok=True)
            csv_path = output_dir / self._dump_filename("csv", timestamp)
            csv_path.write_bytes(self.last_dump_csv_bytes())
            logger.info("wrote CSV dump: %s", csv_path)
        except Exception as exc:
            logger.warning("failed to write CSV dump: %s", exc)
        try:
            output_dir = Path.home() / "Output"
            output_dir.mkdir(parents=True, exist_ok=True)
            png_path = output_dir / self._dump_filename("png", timestamp)
            png_path.write_bytes(self.last_dump_png_bytes())
            logger.info("wrote PNG dump: %s", png_path)
        except Exception as exc:
            logger.warning("failed to write PNG dump: %s", exc)

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
        return self._last_filename("csv", time.strftime("%y%m%d_%H%M%S"))

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
        return self._last_filename("png", time.strftime("%y%m%d_%H%M%S"))

    def last_figure_png(self, render_mode: str = "decimated",
                        view: str = "figure",
                        metadata: Optional[dict] = None) -> bytes:
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
        transforms = self._action_defaults.get("transforms", {}) or {}
        xflip = transforms.get("xflip") is True
        yflip = transforms.get("yflip") is True
        rotate90 = transforms.get("rotate90") is True

        def orient_image(image):
            if rotate90:
                image = np.rot90(image, k=3)
            if xflip:
                image = np.fliplr(image)
            if yflip:
                image = np.flipud(image)
            return image

        def orient_bounds(bounds):
            if bounds is None:
                return None
            x0, x1, y0, y1 = bounds
            if rotate90:
                x0, x1, y0, y1 = 16384 - y1, 16384 - y0, x0, x1
            if xflip:
                x0, x1 = 16384 - x1, 16384 - x0
            if yflip:
                y0, y1 = 16384 - y1, 16384 - y0
            return x0, x1, y0, y1

        simulation_bitmap = last.get("simulation_bitmap")
        if simulation_bitmap is not None and getattr(simulation_bitmap, "pixels", None):
            flat = np.asarray([_bitmap_pixel_value(px) for px in simulation_bitmap.pixels], dtype=np.uint16)
            # 8-bit gray -> OBI-aligned 16-bit (gray * 64 raw 14-bit, << 2), because the
            # display below takes the high byte with ``>> 8``.
            img = flat.reshape(
                int(simulation_bitmap.height),
                int(simulation_bitmap.width),
            ) * 256
            img = orient_image(img)
            fig, ax = plt.subplots(figsize=(6, 6))
            vmin, vmax = _percentile_clip_uint16(img)
            if view == "texture":
                ax.imshow(img, cmap="gray", interpolation="nearest",
                          aspect="equal", vmin=vmin, vmax=vmax)
                ax.set_axis_off()
                fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
            else:
                bounds = orient_bounds(_roi_bounds(last.get("roi")))
                extent = None
                if bounds is not None:
                    x0, x1, y0, y1 = bounds
                    extent = [x0, x1, y1, y0]
                im = ax.imshow(
                    img >> 8,
                    cmap="gray",
                    interpolation="nearest",
                    aspect="equal",
                    vmin=0,
                    vmax=255,
                    extent=extent,
                )
                ax.set_title(f"{last['kind'].title()} scan: extracted ROI source")
                ax.set_xlabel("X (DAC code)" if bounds is not None else "X (pixels)")
                ax.set_ylabel("Y (DAC code)" if bounds is not None else "Y (pixels)")
                fig.colorbar(im, ax=ax, label="ADC sample (14-bit code << 2)")
        elif last["kind"] == "raster":
            res = last["resolution"]
            dwell = int(last.get("dwell") or self._raster_defaults.get("dwell") or 0)
            adc_latency = int(self._raster_defaults.get("adcLatency", 8))
            img = _raster_image_from_chunks(last["chunks"], res, dwell, adc_latency)
            img = orient_image(img)

            fig, ax = plt.subplots(figsize=(6, 6))
            # Stretch to the data (trimming dropout / hot pixels) in both views.
            # The old figure view used a fixed 0..255 window on ``img >> 8``,
            # which squeezed a detector signal living in ~0x8000..0xb000 into a
            # washed-out gray band.
            vmin, vmax = _percentile_clip_uint16(img, _FIGURE_CLIP_LO_PCT, _FIGURE_CLIP_HI_PCT)
            im = ax.imshow(img, cmap="gray", interpolation="nearest",
                           aspect="equal", vmin=vmin, vmax=vmax)
            if view == "texture":
                ax.set_axis_off()
                fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
            else:
                ax.set_title(f"Raster scan: {res}x{res}")
                ax.set_xlabel("X (pixels)")
                ax.set_ylabel("Y (pixels)")
                fig.colorbar(im, ax=ax, label="ADC sample (14-bit code << 2)")
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
            scan_path = VectorScanPath(last.get("scan_path", VectorScanPath.vertical_raster.value))
            points = last.get("points")
            if pattern == "custom" and points:
                iter_list = [
                    (x, y, dwell)
                    for x, y, dwell, _blank, _pass_index in (
                        _normalize_vector_point(point) for point in points
                    )
                ]
            else:
                iter_list = list(_roi_vector_iter(edge, last.get("roi"), scan_path=scan_path))
                if len(iter_list) < samples.size and edge != DEFAULT_EDGE:
                    iter_list = list(_roi_vector_iter(DEFAULT_EDGE, last.get("roi"), scan_path=scan_path))

            if len(iter_list) < samples.size:
                samples = samples[:len(iter_list)]
            elif len(iter_list) > samples.size:
                iter_list = iter_list[:samples.size]

            line_shift = (
                self._vector_defaults.get("lineShiftPerXRow", 0)
                if scan_path is VectorScanPath.vertical_raster else 0
            )
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
            if rotate90:
                xs, ys = ys.copy(), xs.copy()
            if xflip:
                xs = 16383 - xs
            if yflip:
                ys = 16383 - ys
            cs = samples
            fig, ax = plt.subplots(figsize=(6, 6))
            vmin, vmax = _percentile_clip_uint16(samples, _FIGURE_CLIP_LO_PCT, _FIGURE_CLIP_HI_PCT)
            marker_size = 8 if view == "texture" else 2
            im = ax.scatter(xs, ys, c=cs, cmap="gray", s=marker_size,
                            vmin=vmin, vmax=vmax, marker="s")
            bounds = orient_bounds(_roi_bounds(last.get("roi")))
            if view == "texture" and bounds is not None:
                x0, x1, y0, y1 = bounds
                ax.set_xlim(x0, x1)
                ax.set_ylim(y1, y0)
            else:
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
                fig.colorbar(im, ax=ax, label="ADC sample (14-bit code << 2)")

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
            metadata=metadata,
        )
        plt.close(fig)
        return out.getvalue()

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
        return ScanValidation(passed=all(c.passed for c in checks), checks=checks)

    # -------- state lock --------------------------------------------------

    def _acquire(self, kind: str, *, transport: str = "service"):
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
                svc._abort_requested = False
                svc._status.state = DeviceState.BUSY
                svc._status.last_error = None
                svc._status.chunks_in_flight = 0
                self.started = time.monotonic()
                logger.info("scan start kind=%s production=%s transport=%s", kind,
                            getattr(svc._config, "IsProduction", None), transport)
                return svc
            async def __aexit__(self, exc_type, exc, tb):
                # A streaming client closing its WebSocket causes the async
                # generator to be closed with GeneratorExit. Treat that (and
                # task cancellation) as a normal, incomplete capture rather
                # than a device fault; the generator's finally block still
                # owns hardware cleanup.
                cancelled = exc_type is not None and issubclass(
                    exc_type, (GeneratorExit, asyncio.CancelledError))
                if exc is None:
                    svc._status.scans_completed += 1
                elif cancelled:
                    svc._status.last_error = None
                else:
                    svc._status.last_error = f"{type(exc).__name__}: {exc}"
                # If we still have a connection, we're IDLE; otherwise reflect that.
                if svc._conn is None:
                    svc._status.state = (
                        DeviceState.ERROR if exc and not cancelled else DeviceState.IDLE)
                else:
                    svc._status.state = DeviceState.IDLE
                chunks = svc._status.chunks_in_flight
                svc._status.chunks_in_flight = 0
                svc._release_device_if_idle()
                svc._lock.release()
                logger.info("scan end kind=%s ok=%s cancelled=%s elapsed=%.3fs "
                            "transport=%s chunks=%d error=%s",
                            kind, exc is None, cancelled, time.monotonic() - self.started,
                            transport, chunks, None if exc is None or cancelled
                            else f"{type(exc).__name__}: {exc}")
                return False
        return _Ctx()
