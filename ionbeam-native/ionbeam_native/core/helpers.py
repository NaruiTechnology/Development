"""Ports of the small pure helpers in ionbeam-web/frontend/src/lib:

grayScaleSelection.ts, vectorScanPath.ts, scanSamples.ts, scanRepeat.ts,
grayScaleUI.ts, roiWorkflow.ts, scanError.ts, vacuumPolicy.ts, sites.ts.
"""
from __future__ import annotations

import re
from typing import Iterator, Optional, Tuple

import numpy as np

from .jsmath import is_finite, js_round, trunc

# ---- grayScaleSelection.ts ----------------------------------------------------

GrayScaleSelection = Optional[Tuple[int, int]]


def clamp_gray_scale(value) -> int:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0
    if not is_finite(n):
        return 0
    return max(0, min(255, js_round(n)))


def normalize_gray_scale_selection(selection) -> GrayScaleSelection:
    if not selection:
        return None
    lo = clamp_gray_scale(min(selection[0], selection[1]))
    hi = clamp_gray_scale(max(selection[0], selection[1]))
    return (lo, hi)


def gray_scale_selection_contains(selection: GrayScaleSelection, value) -> bool:
    if not selection:
        return False
    n = clamp_gray_scale(value)
    return selection[0] <= n <= selection[1]


def format_gray_scale_selection(selection: GrayScaleSelection) -> str:
    if not selection:
        return ""
    return str(selection[0]) if selection[0] == selection[1] else f"{selection[0]}-{selection[1]}"


# ---- vectorScanPath.ts --------------------------------------------------------

VECTOR_SCAN_PATHS = ("horizontal_sawtooth", "horizontal_triangle", "vertical_raster", "vertical_serpentine")


def vector_scan_sample_count(edge: float, path: str = "") -> int:
    size = max(1, trunc(edge))
    return size * size


def vector_scan_sample_pixel(sample_index: int, edge: float, path: str) -> Optional[Tuple[int, int]]:
    size = max(1, trunc(edge))
    index = max(0, trunc(sample_index))
    if index >= size * size:
        return None
    if path in ("horizontal_sawtooth", "horizontal_triangle"):
        y, offset = divmod(index, size)
        x = size - 1 - offset if path == "horizontal_triangle" and y % 2 == 1 else offset
        return (x, y)
    x, offset = divmod(index, size)
    y = size - 1 - offset if path == "vertical_serpentine" and x % 2 == 1 else offset
    return (x, y)


def vector_scan_index_map(edge: int, path: str) -> np.ndarray:
    """Flat row-major pixel index (y * edge + x) for every sample index, as int64.

    Vectorised form of ``vectorScanSamplePixel`` used to place streamed
    samples without a per-sample Python loop.
    """
    size = max(1, int(edge))
    i = np.arange(size * size, dtype=np.int64)
    outer, offset = np.divmod(i, size)
    if path in ("horizontal_sawtooth", "horizontal_triangle"):
        y = outer
        x = np.where((path == "horizontal_triangle") & (y % 2 == 1), size - 1 - offset, offset)
    else:
        x = outer
        y = np.where((path == "vertical_serpentine") & (x % 2 == 1), size - 1 - offset, offset)
    return y * size + x


def bitmap_scan_coordinates(width: int, height: int, scan_path: str) -> Iterator[Tuple[int, int]]:
    if scan_path in ("vertical_raster", "vertical_serpentine"):
        for x in range(width):
            for offset in range(height):
                y = height - 1 - offset if scan_path == "vertical_serpentine" and x % 2 == 1 else offset
                yield x, y
        return
    for y in range(height):
        for offset in range(width):
            x = width - 1 - offset if scan_path == "horizontal_triangle" and y % 2 == 1 else offset
            yield x, y


def bitmap_scan_coordinate_arrays(width: int, height: int, scan_path: str) -> Tuple[np.ndarray, np.ndarray]:
    """Vectorised ``bitmapScanCoordinates``: (xs, ys) in scan order."""
    if scan_path in ("vertical_raster", "vertical_serpentine"):
        x = np.repeat(np.arange(width), height)
        offset = np.tile(np.arange(height), width)
        y = np.where((scan_path == "vertical_serpentine") & (x % 2 == 1), height - 1 - offset, offset)
        return x, y
    y = np.repeat(np.arange(height), width)
    offset = np.tile(np.arange(width), height)
    x = np.where((scan_path == "horizontal_triangle") & (y % 2 == 1), width - 1 - offset, offset)
    return x, y


# ---- scanSamples.ts -----------------------------------------------------------

OBI_SCAN_FULL_SCALE = 0xFFFC


def scale_scan_sample(value: float, low: float = 0, high: float = OBI_SCAN_FULL_SCALE) -> int:
    if not is_finite(low) or not is_finite(high) or high <= low:
        low, high = 0, OBI_SCAN_FULL_SCALE
    clamped = max(low, min(high, value))
    return js_round(((clamped - low) * 255) / (high - low))


def scale_scan_samples(values: np.ndarray) -> np.ndarray:
    """Vectorised ``scaleScanSample`` with the default absolute 0..0xfffc range."""
    v = np.clip(np.asarray(values, dtype=np.float64), 0, OBI_SCAN_FULL_SCALE)
    x = (v * 255) / OBI_SCAN_FULL_SCALE
    f = np.floor(x)
    return (f + ((x - f) >= 0.5)).astype(np.int64)


def decode_eight_bit(samples: np.ndarray) -> np.ndarray:
    """EightBit wire bytes -> the same 0..0xfffc display scale the browser uses."""
    x = (np.asarray(samples, dtype=np.float64) * OBI_SCAN_FULL_SCALE) / 0xFF
    f = np.floor(x)
    return (f + ((x - f) >= 0.5)).astype(np.uint16)


# ---- scanType.ts / scanRepeat.ts ---------------------------------------------

class ScanType:
    RASTER = "RASTER"
    VECTOR = "VECTOR"
    VECTOR_ADAPTIVE_GRAN_FEED_BLANK = "VECTOR_ADAPTIVE_GRAN_FEED_BLANK"
    CUSTOM_RASTER = "CUSTOM_RASTER"
    CUSTOM_GRAY_FEEDBACK_BLANK = "CUSTOM_GRAY_FEEDBACK_BLANK"


SCAN_TYPE_COLORS = {
    ScanType.RASTER: "lawngreen",
    ScanType.VECTOR: "yellow",
    ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK: "pink",
    ScanType.CUSTOM_RASTER: "green",
    ScanType.CUSTOM_GRAY_FEEDBACK_BLANK: "red",
}


def repeat_countdown_display(configured_repeat: float, cycles_remaining: float, loop_active: bool) -> int:
    configured = max(1, trunc(configured_repeat))
    if not loop_active:
        return configured
    return max(1, trunc(cycles_remaining))


def should_clear_roi_feedback_before_repeat(scan_type: str, cycles_remaining: int) -> bool:
    return scan_type == ScanType.CUSTOM_GRAY_FEEDBACK_BLANK and cycles_remaining > 0


def should_retain_roi_feedback_on_complete(scan_type: str, cycles_remaining: int) -> bool:
    return scan_type != ScanType.CUSTOM_GRAY_FEEDBACK_BLANK or cycles_remaining <= 1


# ---- grayScaleUI.ts -----------------------------------------------------------

def resolve_roi_action_kind(kind: str, last_scan_kind: str) -> Optional[str]:
    if kind in ("raster", "vector"):
        return kind
    if kind == "roi":
        return "vector"
    return None


def should_show_roi_action_controls(kind: str, has_partial_roi: bool) -> bool:
    if kind != "roi":
        return kind != "mag"
    return has_partial_roi


def should_show_roi_gray_scale_clear(kind: str, has_confirmed_gray_range: bool) -> bool:
    return kind == "roi" and has_confirmed_gray_range


def resolve_gray_scale_source_kind(show_gray_spectrum: bool, roi_image_data_url, roi_scan_image_url,
                                   last_scan_kind: str) -> Optional[str]:
    if not show_gray_spectrum:
        return None
    if roi_image_data_url:
        return "loaded"
    if roi_scan_image_url:
        return last_scan_kind
    return None


def gray_scale_source_label_for_kind(source_kind: Optional[str], t) -> Optional[str]:
    if source_kind == "raster":
        return t("roi.grayScale.source.raster")
    if source_kind == "vector":
        return t("roi.grayScale.source.vector")
    return None


def gray_scale_scope_note_for_kind(source_kind: Optional[str], is_production: bool, t) -> Optional[str]:
    if source_kind == "raster":
        return t("roi.grayScale.context.raster.production" if is_production else "roi.grayScale.context.raster.preview")
    if source_kind == "vector":
        return t("roi.grayScale.context.vector")
    return None


# ---- scanError.ts / vacuumPolicy.ts -----------------------------------------

def display_scan_error(message: Optional[str], device_not_found_message: str) -> Optional[str]:
    if not message:
        return None
    return device_not_found_message if re.search(r"device\s+not\s+found", message, re.I) else message


def should_disable_scan_panel(scan_active: bool, signed_in: bool, vacuum_enabled: bool, vacuum_ready: bool) -> bool:
    return scan_active or not signed_in or (vacuum_enabled and not vacuum_ready)


def should_show_vacuum_controller(vacuum_enabled: bool) -> bool:
    return bool(vacuum_enabled)


# ---- sites.ts -----------------------------------------------------------------

SITE_OPTIONS = (
    ("Beijing(北京)", "site.beijing"),
    ("Shanghai(上海)", "site.shanghai"),
    ("Shenzheng(深圳)", "site.shenzheng"),
    ("Wuxi(无锡)", "site.wexi"),
    ("Xian(西安)", "site.xian"),
    ("Chengdu(成都)", "site.chengdu"),
    ("Hangzhou(杭州)", "site.hangzhou"),
    ("Tianjing(天津)", "site.tianjing"),
    ("Taixin(泰兴)", "site.taixin"),
)
_LEGACY_SITE_ALIASES = {"Wexi(无锡)": "Wuxi(无锡)"}
DEFAULT_SITE = SITE_OPTIONS[0][0]


def normalize_site_value(value) -> str:
    site = str(value if value is not None else "").strip()
    canonical = _LEGACY_SITE_ALIASES.get(site, site)
    return canonical if any(v == canonical for v, _ in SITE_OPTIONS) else DEFAULT_SITE


def site_label_key(value) -> Optional[str]:
    site = str(value if value is not None else "").strip()
    for v, key in SITE_OPTIONS:
        if v == site:
            return key
    return None
