"""Frame buffers shared between the acquisition thread and the UI thread.

The acquisition thread appends samples as chunks arrive (a memcpy plus a
``bincount``); the UI thread paints from the same arrays at display rate.
Nothing per-sample happens in Python and nothing on the acquisition path
waits for painting. Ports the buffer semantics of store/imageSlice.ts.

Concurrency: appends and resets take ``lock``; readers call ``view()``
under the lock to get consistent (arrays, cursor, revision) references and
then read the arrays without holding it. A reader may see the chunk that is
being written half-copied; the next paint (or the final one after the scan
completes) shows it complete.
"""
from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..core.helpers import decode_eight_bit, vector_scan_index_map
from ..core.jsmath import js_round

VEC_EDGE = 2048
_INDEX_MAP_CACHE: dict = {}


def cached_index_map(edge: int, path: str) -> np.ndarray:
    key = (int(edge), path)
    found = _INDEX_MAP_CACHE.get(key)
    if found is None:
        if len(_INDEX_MAP_CACHE) > 6:
            _INDEX_MAP_CACHE.clear()
        found = _INDEX_MAP_CACHE[key] = vector_scan_index_map(edge, path)
    return found


def as_samples(chunk, output_mode: str = "SixteenBit") -> np.ndarray:
    """Chunk from the service (array('H'/'B'), ndarray) -> uint16 on the 0..0xfffc scale."""
    if isinstance(chunk, (bytes, bytearray, memoryview)):
        raw = np.frombuffer(chunk, dtype=np.uint8 if output_mode == "EightBit" else np.uint16)
    else:
        raw = np.asarray(chunk)
    if raw.dtype == np.uint8 or getattr(chunk, "typecode", None) == "B":
        return decode_eight_bit(raw)
    return raw.astype(np.uint16, copy=False)


@dataclass
class FrameView:
    kind: str
    frame: np.ndarray
    cursor: int
    revision: int
    edge: int
    value_counts: Optional[np.ndarray]
    total: int
    chunks: int
    nbytes: int


class RasterFrame:
    """Row-major raster buffer (``imageSlice`` raster fields)."""

    def __init__(self, resolution: int = 512):
        self.lock = threading.Lock()
        self.resolution = resolution
        self.frame = np.zeros(resolution * resolution, dtype=np.uint16)
        self.value_counts = np.zeros(65536, dtype=np.int64)
        self.cursor = 0
        self.revision = 0
        self.chunks = 0
        self.nbytes = 0

    def reset(self, resolution: int, preserve_frame: bool = False) -> None:
        with self.lock:
            keep = preserve_frame and self.resolution == resolution and self.frame.size == resolution * resolution
            self.resolution = resolution
            if not keep:
                self.frame = np.zeros(resolution * resolution, dtype=np.uint16)
            self.value_counts = np.zeros(65536, dtype=np.int64)
            self.cursor = 0
            self.chunks = 0
            self.nbytes = 0
            self.revision += 1

    def append(self, samples: np.ndarray, nbytes: int) -> None:
        with self.lock:
            n = min(samples.size, self.frame.size - self.cursor)
            if n > 0:
                part = samples[:n]
                self.frame[self.cursor:self.cursor + n] = part
                self.value_counts += np.bincount(part, minlength=65536)
                self.cursor += n
            self.chunks += 1
            self.nbytes += nbytes
            self.revision += 1

    def load(self, samples: np.ndarray, resolution: int) -> None:
        """Replace the buffer with a complete frame (validated runs)."""
        self.reset(resolution)
        self.append(samples, samples.size * 2)

    def view(self) -> FrameView:
        with self.lock:
            return FrameView("raster", self.frame, self.cursor, self.revision, self.resolution,
                             self.value_counts, self.frame.size, self.chunks, self.nbytes)


class VectorFrame:
    """Vector render target (``imageSlice`` vector fields)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pattern = "default"
        self.scan_path = "vertical_raster"
        self.source = "vector"
        self.edge = VEC_EDGE
        self.image = np.zeros(VEC_EDGE * VEC_EDGE, dtype=np.uint16)
        self.value_counts = np.zeros(65536, dtype=np.int64)
        self.index_map: Optional[np.ndarray] = None
        self.custom_points: Optional[np.ndarray] = None        # (N, 2) float32, DAC coords
        self.custom_render: Optional[np.ndarray] = None        # (N, 2) float32, render coords
        self.custom_render_index: Optional[np.ndarray] = None  # (N,) int64, -1 = off-canvas
        self.custom_blank: Optional[np.ndarray] = None         # (N,) bool
        self.custom_spot: Optional[np.ndarray] = None          # (N,) bool
        self.custom_count = 0
        self.cursor = 0
        self.revision = 0
        self.chunks = 0
        self.nbytes = 0
        self.retain_feedback_on_complete = True

    # ---- setupVector -----------------------------------------------------

    def setup(self, *, pattern: str, scan_path: str, points=None, edge: int = VEC_EDGE,
              roi: Optional[dict] = None, simulation_bitmap: Optional[dict] = None) -> None:
        with self.lock:
            self.pattern = pattern
            self.scan_path = scan_path or "vertical_raster"
            self.source = "roi" if pattern == "custom" and roi else "vector"
            self.edge = int(edge)
            self.image = np.zeros(self.edge * self.edge, dtype=np.uint16)
            self.value_counts = np.zeros(65536, dtype=np.int64)
            self.cursor = 0
            self.chunks = 0
            self.nbytes = 0
            self.index_map = None
            self.custom_points = self.custom_render = self.custom_render_index = None
            self.custom_blank = self.custom_spot = None
            self.custom_count = 0
            if pattern == "custom" and points:
                self._setup_custom_points(points, roi)
            elif pattern == "custom" and simulation_bitmap:
                self._setup_custom_bitmap(simulation_bitmap, roi)
            elif pattern != "custom":
                self.index_map = cached_index_map(self.edge, self.scan_path)
            self.revision += 1

    def _setup_custom_points(self, points, roi) -> None:
        xs = np.fromiter((_point_x(p) for p in points), dtype=np.float64, count=len(points))
        ys = np.fromiter((_point_y(p) for p in points), dtype=np.float64, count=len(points))
        blank = np.fromiter((_point_blank(p) for p in points), dtype=bool, count=len(points))
        spot = np.fromiter((_point_spot(p) for p in points), dtype=bool, count=len(points))
        x0, x1, y0, y1 = _custom_bounds(xs, ys, roi)
        rx = _map_coord_to_pixel(xs, x0, x1, self.edge)
        ry = _map_coord_to_pixel(ys, y0, y1, self.edge)
        self._finish_custom(xs, ys, rx, ry, blank, spot)

    def _setup_custom_bitmap(self, bitmap: dict, roi) -> None:
        width = max(1, int(bitmap["width"]))
        height = max(1, int(bitmap["height"]))
        if roi:
            x0, x1 = min(roi["x_start"], roi["x_end"]), max(roi["x_start"], roi["x_end"])
            y0, y1 = min(roi["y_start"], roi["y_end"]), max(roi["y_start"], roi["y_end"])
        else:
            x0, x1, y0, y1 = 0, 16383, 0, 16383
        # i = x * height + y  (column-major, as imageSlice builds it)
        gx = np.repeat(np.arange(width), height).astype(np.float64)
        gy = np.tile(np.arange(height), width).astype(np.float64)
        xs = x0 + (x1 - x0) * (gx / (width - 1) if width > 1 else 0 * gx)
        ys = y0 + (y1 - y0) * (gy / (height - 1) if height > 1 else 0 * gy)
        rx = _map_coord_to_pixel(gx, 0, max(1, width - 1), self.edge)
        ry = _map_coord_to_pixel(gy, 0, max(1, height - 1), self.edge)
        self._finish_custom(xs, ys, rx, ry, None, None)

    def _finish_custom(self, xs, ys, rx, ry, blank, spot) -> None:
        self.custom_points = np.stack([xs, ys], axis=1).astype(np.float32)
        self.custom_render = np.stack([rx, ry], axis=1).astype(np.float32)
        ix, iy = rx.astype(np.int64), ry.astype(np.int64)
        ok = (ix >= 0) & (ix < self.edge) & (iy >= 0) & (iy < self.edge)
        self.custom_render_index = np.where(ok, iy * self.edge + ix, -1)
        self.custom_blank = blank
        self.custom_spot = spot
        self.custom_count = int(xs.size)

    # ---- appendVectorSamples ---------------------------------------------

    def append(self, samples: np.ndarray, nbytes: int) -> None:
        with self.lock:
            cur = self.cursor
            n = samples.size
            if self.pattern == "default" and self.index_map is not None:
                total = self.index_map.size
                m = max(0, min(n, total - cur))
                if m:
                    part = samples[:m]
                    self.image[self.index_map[cur:cur + m]] = part
                    self.value_counts += np.bincount(part, minlength=65536)
            elif self.custom_render_index is not None:
                m = max(0, min(n, self.custom_count - cur))
                if m:
                    idx = self.custom_render_index[cur:cur + m]
                    ok = idx >= 0
                    self.image[idx[ok]] = samples[:m][ok]
            self.cursor += n
            self.chunks += 1
            self.nbytes += nbytes
            self.revision += 1

    def correct_line_shift(self, line_shift_per_x_row: float) -> None:
        """``correctVectorLineShift`` (vertical_raster default pattern only)."""
        try:
            shift_per_row = float(line_shift_per_x_row)
        except (TypeError, ValueError):
            return
        with self.lock:
            edge = self.edge
            if (self.pattern != "default" or self.scan_path != "vertical_raster" or not math.isfinite(shift_per_row)
                    or shift_per_row == 0 or edge <= 1 or self.cursor <= 0):
                return
            img = self.image.reshape(edge, edge)
            corrected = np.empty_like(img)
            for col in range(edge):
                shift = js_round(col * shift_per_row) % edge
                corrected[:, col] = np.roll(img[:, col], shift)
            self.image = corrected.reshape(-1)
            self.revision += 1

    def reset(self) -> None:
        """``resetVector``: clear the image, keep pattern / points."""
        with self.lock:
            self.image = np.zeros(self.edge * self.edge, dtype=np.uint16)
            self.value_counts = np.zeros(65536, dtype=np.int64)
            self.cursor = 0
            self.revision += 1

    def view(self) -> FrameView:
        with self.lock:
            total = self.index_map.size if (self.pattern == "default" and self.index_map is not None) \
                else self.custom_count
            return FrameView("vector", self.image, self.cursor, self.revision, self.edge,
                             self.value_counts if self.pattern == "default" else None,
                             total, self.chunks, self.nbytes)


class DacRampFrame:
    """16384-point single-axis sweep (useDacRampStream)."""

    POINTS = 16384

    def __init__(self):
        self.lock = threading.Lock()
        self.samples = np.full(self.POINTS, np.nan)
        self.cursor = 0
        self.revision = 0

    def reset(self) -> None:
        with self.lock:
            self.samples = np.full(self.POINTS, np.nan)
            self.cursor = 0
            self.revision += 1

    def append(self, samples: np.ndarray, nbytes: int) -> None:
        with self.lock:
            n = max(0, min(samples.size, self.POINTS - self.cursor))
            self.samples[self.cursor:self.cursor + n] = samples[:n] >> 2
            self.cursor += n
            self.revision += 1


class AdcTimeline:
    """2048 time bins of raw 14-bit ADC samples (useAdcTestStream)."""

    BINS = 2048

    def __init__(self):
        self.lock = threading.Lock()
        self.reset(5)

    def reset(self, duration_minutes: int) -> None:
        self.duration_minutes = duration_minutes
        self.bin_min = np.full(self.BINS, -1, dtype=np.int64)
        self.bin_max = np.full(self.BINS, -1, dtype=np.int64)
        self.bin_sum = np.zeros(self.BINS, dtype=np.float64)
        self.bin_count = np.zeros(self.BINS, dtype=np.int64)
        self.bin_latest = np.full(self.BINS, -1, dtype=np.int64)
        self.count = 0
        self.minimum: Optional[int] = None
        self.maximum: Optional[int] = None
        self.revision = getattr(self, "revision", 0) + 1

    def append_bytes(self, data: bytes, elapsed_s: float) -> None:
        values = (np.frombuffer(data[: len(data) & ~1], dtype=">u2") & 0x3FFF).astype(np.int64)
        if not values.size:
            return
        with self.lock:
            bin_index = min(self.BINS - 1, int((elapsed_s / (self.duration_minutes * 60)) * self.BINS))
            lo, hi = int(values.min()), int(values.max())
            self.bin_min[bin_index] = lo if self.bin_min[bin_index] < 0 else min(lo, self.bin_min[bin_index])
            self.bin_max[bin_index] = max(hi, self.bin_max[bin_index])
            self.bin_sum[bin_index] += float(values.sum())
            self.bin_count[bin_index] += values.size
            self.bin_latest[bin_index] = int(values[-1])
            self.count += int(values.size)
            self.minimum = lo if self.minimum is None else min(self.minimum, lo)
            self.maximum = hi if self.maximum is None else max(self.maximum, hi)
            self.revision += 1


# ---- custom point helpers (imageSlice.ts) ------------------------------------

def _point_x(p) -> float:
    return float(p[0]) if isinstance(p, (list, tuple)) else float(p["x"] if isinstance(p, dict) else p.x)


def _point_y(p) -> float:
    return float(p[1]) if isinstance(p, (list, tuple)) else float(p["y"] if isinstance(p, dict) else p.y)


def _point_field(p, index: int, name: str):
    if isinstance(p, (list, tuple)):
        return p[index] if len(p) > index else None
    return p.get(name) if isinstance(p, dict) else getattr(p, name, None)


def _point_blank(p) -> bool:
    return _point_field(p, 3, "blank") is True


def _point_spot(p) -> bool:
    return _point_field(p, 4, "passIndex") == 1 and _point_field(p, 3, "blank") is False


def _custom_bounds(xs: np.ndarray, ys: np.ndarray, roi):
    if roi:
        return (min(roi["x_start"], roi["x_end"]), max(roi["x_start"], roi["x_end"]),
                min(roi["y_start"], roi["y_end"]), max(roi["y_start"], roi["y_end"]))
    x0, x1 = (float(xs.min()), float(xs.max())) if xs.size else (math.inf, -math.inf)
    y0, y1 = (float(ys.min()), float(ys.max())) if ys.size else (math.inf, -math.inf)
    if not math.isfinite(x0) or x0 == x1:
        x0, x1 = 0, 16383
    if not math.isfinite(y0) or y0 == y1:
        y0, y1 = 0, 16383
    return x0, x1, y0, y1


def _map_coord_to_pixel(values: np.ndarray, start: float, end: float, edge: int) -> np.ndarray:
    denom = end - start
    if edge <= 1 or denom == 0:
        return np.zeros(values.shape, dtype=np.float64)
    t = (values - start) / denom * (edge - 1)
    f = np.floor(t)
    return np.clip(f + ((t - f) >= 0.5), 0, edge - 1)
