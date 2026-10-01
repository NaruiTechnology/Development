"""Port of ionbeam-web/frontend/src/lib/displayLevels.ts (the image "wedge").

Same maths, vectorised: a histogram can be built either from raw samples or
from a 65 536-bin value count (``np.bincount``) that the acquisition engine
maintains incrementally, and the black/white levels become a 65 536-entry
uint8 lookup table so a whole frame converts to display gray with one
indexing operation instead of a per-pixel loop.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from .jsmath import js_round

OBI_SCAN_FULL_SCALE = 0xFFFC
OBI_FULL_SCALE = OBI_SCAN_FULL_SCALE
LEVEL_HISTOGRAM_BINS = 512
AUTO_LOW_PERCENT = 0.5
AUTO_HIGH_PERCENT = 99.5
MIN_LEVEL_GAP = 4
ROI_GRAY_SAMPLE_SCALE = 256
ROI_GRAY_FULL_SCALE = 255 * ROI_GRAY_SAMPLE_SCALE


@dataclass(frozen=True)
class LevelSetting:
    mode: str = "auto"          # "auto" | "manual"
    low: float = 0.0
    high: float = float(OBI_SCAN_FULL_SCALE)

    @property
    def auto(self) -> bool:
        return self.mode == "auto"


AUTO_LEVELS = LevelSetting("auto")


@dataclass(frozen=True)
class ResolvedLevels:
    low: float
    high: float


@dataclass
class LevelHistogram:
    min: float
    max: float
    total: int
    bins: np.ndarray  # uint32/int64 counts


def sample_to_code(value: float, divisor: float = 4) -> int:
    return js_round(value / divisor)


def code_to_sample(code: float, divisor: float = 4) -> float:
    return code * divisor


def empty_histogram(bin_count: int = LEVEL_HISTOGRAM_BINS) -> LevelHistogram:
    return LevelHistogram(0, 0, 0, np.zeros(bin_count, dtype=np.int64))


def _bin_index(values: np.ndarray, lo: float, hi: float, count: int) -> np.ndarray:
    span = hi - lo
    scale = (count - 1) / span if span > 0 else 0.0
    idx = np.floor((values.astype(np.float64) - lo) * scale)
    return np.clip(idx, 0, count - 1).astype(np.int64)


def build_histogram(lo: float, hi: float, total: int, values: np.ndarray,
                    bin_count: int = LEVEL_HISTOGRAM_BINS) -> LevelHistogram:
    """``buildHistogram`` over explicit sample values (each counted once)."""
    count = max(1, int(math.floor(bin_count)))
    if total <= 0 or not (hi >= lo):
        return LevelHistogram(0, 0, 0, np.zeros(count, dtype=np.int64))
    values = np.asarray(values)
    bins = np.bincount(_bin_index(values, lo, hi, count), minlength=count)[:count]
    return LevelHistogram(lo, hi, int(total), bins.astype(np.int64))


def histogram_from_value_counts(value_counts: np.ndarray,
                                bin_count: int = LEVEL_HISTOGRAM_BINS) -> LevelHistogram:
    """Histogram of every counted sample given ``counts[v]`` = occurrences of value v.

    Equivalent to painting-time ``buildHistogram(min, max, total, visit)`` in
    the web canvas, but O(65536) instead of O(pixels).
    """
    counts = np.asarray(value_counts)
    nz = np.flatnonzero(counts)
    count = max(1, int(bin_count))
    if nz.size == 0:
        return LevelHistogram(0, 0, 0, np.zeros(count, dtype=np.int64))
    lo, hi = int(nz[0]), int(nz[-1])
    idx = _bin_index(nz, lo, hi, count)
    bins = np.bincount(idx, weights=counts[nz], minlength=count)[:count].astype(np.int64)
    return LevelHistogram(lo, hi, int(counts[nz].sum()), bins)


def histogram_percentile(hist: LevelHistogram, percent: float) -> float:
    if hist.total <= 0:
        return 0.0
    span = hist.max - hist.min
    if span <= 0:
        return float(hist.min)
    target = (min(100.0, max(0.0, percent)) / 100.0) * hist.total
    bins = hist.bins
    bin_count = len(bins)
    bin_width = span / max(1, bin_count - 1)
    cumulative = np.cumsum(bins)
    # first i with cumulative_before + count >= target and count > 0
    before = cumulative - bins
    ok = (cumulative >= target) & (bins > 0)
    hits = np.flatnonzero(ok)
    if hits.size == 0:
        return float(hist.max)
    i = int(hits[0])
    within = (target - float(before[i])) / float(bins[i])
    return float(min(hist.max, max(hist.min, hist.min + (i + within) * bin_width)))


def _clamp_sample(value: float, full_scale: float) -> float:
    return min(full_scale, max(0.0, value))


def normalize_levels(low: float, high: float, full_scale: float = OBI_SCAN_FULL_SCALE) -> ResolvedLevels:
    lo = _clamp_sample(low if math.isfinite(low) else 0.0, full_scale)
    hi = _clamp_sample(high if math.isfinite(high) else full_scale, full_scale)
    if lo > hi:
        lo, hi = hi, lo
    if hi - lo < MIN_LEVEL_GAP:
        if lo + MIN_LEVEL_GAP <= full_scale:
            hi = lo + MIN_LEVEL_GAP
        else:
            lo = hi - MIN_LEVEL_GAP
    return ResolvedLevels(lo, hi)


def resolve_levels(hist: LevelHistogram, setting: LevelSetting,
                   full_scale: float = OBI_SCAN_FULL_SCALE) -> ResolvedLevels:
    if setting.mode == "manual":
        return normalize_levels(setting.low, setting.high, full_scale)
    if hist.total <= 0:
        return ResolvedLevels(0.0, float(full_scale))
    lo = histogram_percentile(hist, AUTO_LOW_PERCENT)
    hi = histogram_percentile(hist, AUTO_HIGH_PERCENT)
    if hi - lo < MIN_LEVEL_GAP:
        lo, hi = float(hist.min), float(hist.max)
    return normalize_levels(lo, hi, full_scale)


def level_gray(value: float, low: float, high: float) -> int:
    if value <= low:
        return 0
    if value >= high:
        return 255
    return js_round(((value - low) * 255) / (high - low))


def js_round_array(x: np.ndarray) -> np.ndarray:
    f = np.floor(x)
    return f + ((x - f) >= 0.5)


def level_lut(low: float, high: float, size: int = 65536) -> np.ndarray:
    """uint8 LUT with ``lut[v] == level_gray(v, low, high)`` for v in 0..size-1."""
    v = np.arange(size, dtype=np.float64)
    denom = (high - low) if high != low else 1.0
    g = js_round_array(((v - low) * 255) / denom)
    g = np.where(v <= low, 0, np.where(v >= high, 255, g))
    return np.clip(g, 0, 255).astype(np.uint8)


def wedge_domain(hist: LevelHistogram, levels: ResolvedLevels,
                 full_scale: float = OBI_SCAN_FULL_SCALE) -> tuple[float, float]:
    data_min = hist.min if hist.total > 0 else levels.low
    data_max = hist.max if hist.total > 0 else levels.high
    span = max(data_max - data_min, 64 * MIN_LEVEL_GAP)
    pad = span * 0.25
    mid = (data_min + data_max) / 2
    lo = max(0.0, mid - span / 2 - pad)
    hi = min(float(full_scale), mid + span / 2 + pad)
    if hi - lo < MIN_LEVEL_GAP:
        hi = lo + MIN_LEVEL_GAP
    return lo, hi


def value_to_fraction(value: float, domain: tuple[float, float]) -> float:
    span = domain[1] - domain[0]
    if span <= 0:
        return 0.0
    return min(1.0, max(0.0, (value - domain[0]) / span))


def fraction_to_value(fraction: float, domain: tuple[float, float]) -> float:
    f = min(1.0, max(0.0, fraction))
    return domain[0] + f * (domain[1] - domain[0])


def nice_code_ticks(domain: tuple[float, float], target: int = 7, divisor: float = 4) -> List[int]:
    lo = sample_to_code(domain[0], divisor)
    hi = sample_to_code(domain[1], divisor)
    span = max(1, hi - lo)
    rough = span / max(2, target)
    magnitude = 10 ** math.floor(math.log10(rough))
    residual = rough / magnitude
    step = (5 if residual >= 5 else 2 if residual >= 2 else 1) * magnitude
    ticks = []
    t = math.ceil(lo / step) * step
    while t <= hi:
        ticks.append(int(t) if float(t).is_integer() else t)
        t += step
    return ticks


def drag_levels(kind: str, start: ResolvedLevels, pointer_value: float, grab_offset: float,
                full_scale: float = OBI_SCAN_FULL_SCALE) -> ResolvedLevels:
    if kind == "low":
        return normalize_levels(min(pointer_value - grab_offset, start.high - MIN_LEVEL_GAP), start.high, full_scale)
    if kind == "high":
        return normalize_levels(start.low, max(pointer_value - grab_offset, start.low + MIN_LEVEL_GAP), full_scale)
    width = start.high - start.low
    low = pointer_value - grab_offset
    low = min(full_scale - width, max(0.0, low))
    return normalize_levels(low, low + width, full_scale)


# ---- 8-bit gray images (ROI canvas) -----------------------------------------

def _opaque_gray_mask(rgba: np.ndarray) -> np.ndarray:
    r, g, b, a = rgba[..., 0], rgba[..., 1], rgba[..., 2], rgba[..., 3]
    return (a != 0) & (r == g) & (r == b)


def gray_histogram(rgba: np.ndarray) -> LevelHistogram:
    """Histogram of the plain gray pixels of an RGBA (H, W, 4) uint8 buffer."""
    rgba = np.asarray(rgba)
    mask = _opaque_gray_mask(rgba)
    grays = rgba[..., 0][mask]
    if grays.size == 0:
        return empty_histogram()
    lo, hi = int(grays.min()), int(grays.max())
    return build_histogram(lo * ROI_GRAY_SAMPLE_SCALE, hi * ROI_GRAY_SAMPLE_SCALE, int(grays.size),
                           grays.astype(np.int64) * ROI_GRAY_SAMPLE_SCALE, hi - lo + 1)


def gray_level_lut(levels: ResolvedLevels) -> np.ndarray:
    g = np.arange(256, dtype=np.float64) * ROI_GRAY_SAMPLE_SCALE
    out = np.array([level_gray(v, levels.low, levels.high) for v in g], dtype=np.uint8)
    return out


def is_identity_lut(lut: np.ndarray) -> bool:
    return bool(np.array_equal(np.asarray(lut), np.arange(256, dtype=np.uint8)))


def apply_gray_lut(rgba: np.ndarray, lut: np.ndarray) -> None:
    """Remap the gray pixels of an RGBA buffer in place; coloured pixels are left alone."""
    mask = _opaque_gray_mask(rgba)
    mapped = np.asarray(lut)[rgba[..., 0][mask]]
    for c in range(3):
        channel = rgba[..., c]
        channel[mask] = mapped


def resolve_roi_levels(histogram: Optional[LevelHistogram], setting: LevelSetting) -> ResolvedLevels:
    if histogram is None:
        return resolve_levels(LevelHistogram(0, 0, 0, np.zeros(1, dtype=np.int64)), setting, ROI_GRAY_FULL_SCALE)
    return resolve_levels(histogram, setting, ROI_GRAY_FULL_SCALE)
