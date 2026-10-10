"""Canvas painters from ImageCanvas.tsx, vectorised.

Each painter returns ``(rgba, stats)`` where ``rgba`` is an (H, W, 4) uint8
array (unpainted cells transparent) and ``stats`` carries min / max /
populated plus the histogram and applied levels for the wedge - the same
``PaintStats`` the web canvas computes, pixel for pixel.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..core.display_levels import (
    AUTO_LEVELS, LevelHistogram, LevelSetting, build_histogram, histogram_from_value_counts, level_lut,
    resolve_levels,
)
from ..core.helpers import scale_scan_samples

DAC_RANGE = 2048
ROI_ACTION_BLANK_COLOR = (97, 0, 0)
ROI_ACTION_HIGHLIGHT_COLOR = (253, 224, 71)


@dataclass
class PaintStats:
    min: int = 0
    max: int = 0
    populated: int = 0
    histogram: Optional[LevelHistogram] = None
    low: float = 0.0
    high: float = float(0xFFFC)


def _levels(hist: LevelHistogram, setting: LevelSetting):
    lv = resolve_levels(hist, setting)
    return lv.low, lv.high


def _gray_rgba(values: np.ndarray, lut: np.ndarray) -> np.ndarray:
    g = lut[values]
    out = np.empty(values.shape + (4,), dtype=np.uint8)
    out[..., 0] = g
    out[..., 1] = g
    out[..., 2] = g
    out[..., 3] = 255
    return out


def _spot_mask(samples: np.ndarray, selection, skipped) -> Optional[np.ndarray]:
    """``sampleInGraySelectionToFilter`` vectorised."""
    if not selection:
        return None
    scaled = scale_scan_samples(samples)
    selected = (scaled >= selection[0]) & (scaled <= selection[1])
    return ~selected if skipped is False else selected


def paint_grayscale(buf: np.ndarray, edge: int, populated: int, setting: LevelSetting = AUTO_LEVELS,
                    value_counts: Optional[np.ndarray] = None):
    limit = int(min(populated, buf.size))
    rgba = np.zeros((edge * edge, 4), dtype=np.uint8)
    if limit <= 0:
        hist = build_histogram(0, 0, 0, np.zeros(0))
        low, high = _levels(hist, setting)
        return rgba.reshape(edge, edge, 4), PaintStats(0, 0, 0, hist, low, high)
    part = buf[:limit]
    if value_counts is not None:
        hist = histogram_from_value_counts(value_counts)
        lo, hi = int(hist.min), int(hist.max)
    else:
        lo, hi = int(part.min()), int(part.max())
        hist = build_histogram(lo, hi, limit, part)
    low, high = _levels(hist, setting)
    lut = level_lut(low, high)
    reg = min(limit, edge * edge)
    rgba[:reg] = _gray_rgba(part[:reg], lut)
    return rgba.reshape(edge, edge, 4), PaintStats(lo, hi, limit, hist, low, high)


def _vector_default_values(buf: np.ndarray, index_map: np.ndarray, limit: int) -> np.ndarray:
    return buf[index_map[:limit]]


def vector_default_range(buf: np.ndarray, index_map: np.ndarray, limit: int, setting: LevelSetting = AUTO_LEVELS,
                         value_counts: Optional[np.ndarray] = None) -> PaintStats:
    limit = int(min(limit, index_map.size))
    if limit <= 0:
        hist = build_histogram(0, 0, 0, np.zeros(0))
        low, high = _levels(hist, setting)
        return PaintStats(0, 0, 0, hist, low, high)
    if value_counts is not None:
        hist = histogram_from_value_counts(value_counts)
        lo, hi = int(hist.min), int(hist.max)
    else:
        vals = _vector_default_values(buf, index_map, limit)
        lo, hi = int(vals.min()), int(vals.max())
        hist = build_histogram(lo, hi, limit, vals)
    low, high = _levels(hist, setting)
    return PaintStats(lo, hi, limit, hist, low, high)


def paint_vector_default(buf: np.ndarray, edge: int, populated: int, index_map: np.ndarray,
                         gray_selection=None, gray_skipped=None, spot_color=ROI_ACTION_BLANK_COLOR,
                         setting: LevelSetting = AUTO_LEVELS, value_counts: Optional[np.ndarray] = None):
    limit = int(min(populated, buf.size, index_map.size))
    stats = vector_default_range(buf, index_map, limit, setting, value_counts)
    rgba = np.zeros((edge * edge, 4), dtype=np.uint8)
    if limit > 0:
        idx = index_map[:limit]
        samples = buf[idx]
        px = _gray_rgba(samples, level_lut(stats.low, stats.high))
        spot = _spot_mask(samples, gray_selection, gray_skipped)
        if spot is not None and spot.any():
            px[spot, 0], px[spot, 1], px[spot, 2] = spot_color
        rgba[idx] = px
    return rgba.reshape(edge, edge, 4), stats


def native_block_index(edge: int, native: int = DAC_RANGE) -> np.ndarray:
    """For each native pixel, the decimated cell whose block covers it (paintVectorDefaultBlockFill)."""
    bases = (np.arange(edge, dtype=np.int64) * native) // edge
    return np.searchsorted(bases, np.arange(native), side="right") - 1


def block_fill(rgba: np.ndarray, native: int = DAC_RANGE) -> np.ndarray:
    """Expand a decimated (edge, edge, 4) image to (native, native, 4) with the web's block rule."""
    edge = rgba.shape[0]
    if edge >= native:
        return rgba
    idx = native_block_index(edge, native)
    return rgba[idx][:, idx]


def paint_vector_custom(buf: np.ndarray, edge: int, render_index: np.ndarray, populated: int,
                        blank_mask: Optional[np.ndarray], spot_mask: Optional[np.ndarray],
                        spot_color=ROI_ACTION_BLANK_COLOR, setting: LevelSetting = AUTO_LEVELS):
    n = int(min(populated, render_index.size))
    idx = render_index[:n]
    ok = idx >= 0
    blank = blank_mask[:n] if blank_mask is not None else np.zeros(n, dtype=bool)
    visible = ok & ~blank
    vis_vals = buf[idx[visible]]
    if vis_vals.size:
        lo, hi = int(vis_vals.min()), int(vis_vals.max())
    else:
        lo = hi = 0
    hist = build_histogram(lo, hi, int(vis_vals.size), vis_vals)
    low, high = _levels(hist, setting)
    lut = level_lut(low, high)
    rgba = np.zeros((edge * edge, 4), dtype=np.uint8)
    # draw order: later points overwrite earlier ones (as the JS loop does)
    order_idx = idx[ok]
    px = _gray_rgba(buf[order_idx], lut)
    b = blank[ok]
    s = spot_mask[:n][ok] if spot_mask is not None else np.zeros(order_idx.size, dtype=bool)
    px[b, 0], px[b, 1], px[b, 2] = ROI_ACTION_BLANK_COLOR
    sm = s & ~b
    px[sm, 0], px[sm, 1], px[sm, 2] = spot_color
    rgba[order_idx] = px          # numpy assignment keeps the last write per index
    if spot_mask is not None:
        # spot selections win even when several points collapse onto one pixel
        spot_idx = idx[(spot_mask[:n]) & ~blank & ok]
        if spot_idx.size:
            rgba[spot_idx, 0], rgba[spot_idx, 1], rgba[spot_idx, 2] = spot_color
            rgba[spot_idx, 3] = 255
    return rgba.reshape(edge, edge, 4), PaintStats(lo, hi, n, hist, low, high)
