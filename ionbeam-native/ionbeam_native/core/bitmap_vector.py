"""Port of ionbeam-web/frontend/src/lib/bitmapVector.ts (scan request builders).

Builds the Raster/Vector request dicts from the ROI state exactly as the web
UI does: ROI -> DAC mapping, bitmap crop -> simulation bitmap, gray-level
selection -> custom points with per-point blank / pass index, and the
adaptive gray feedback request. The browser decoded the ROI image through a
<canvas>; here Pillow decodes and resamples it (bilinear), so borderline
pixels on heavily down-sampled images can differ by one gray level.
"""
from __future__ import annotations

import copy
import hashlib
import io
import math
from typing import Optional, Tuple

import numpy as np

from .geometry import ROI_CANVAS_EDGE, image_world_bounds, viewport_bounds, world_selection_to_dac_roi
from .helpers import bitmap_scan_coordinate_arrays, normalize_gray_scale_selection
from .jsmath import js_round

MAX_POINTS = 250_000

_cached_extraction: Optional[Tuple[str, dict]] = None


def clear_bitmap_selection_cache() -> None:
    global _cached_extraction
    _cached_extraction = None


def _without_bitmap_roi(req: dict) -> dict:
    out = dict(req)
    out["roi"] = None
    out["simulation_bitmap"] = None
    if "feedback_mode" in req:
        out.update({"feedback_mode": "standard", "gray_level_range": None, "gray_level_skipped": None})
    return out


def is_partial_selection(roi) -> bool:
    sel = roi.selection
    if not sel:
        return False
    x0, x1 = min(roi.x_origin, roi.x_end), max(roi.x_origin, roi.x_end)
    y0, y1 = min(roi.y_origin, roi.y_end), max(roi.y_origin, roi.y_end)
    sx0, sx1 = min(sel["x_start"], sel["x_end"]), max(sel["x_start"], sel["x_end"])
    sy0, sy1 = min(sel["y_start"], sel["y_end"]), max(sel["y_start"], sel["y_end"])
    return sx0 > x0 or sx1 < x1 or sy0 > y0 or sy1 < y1


def _extraction_key(roi) -> str:
    image = roi.imageDataUrl or b""
    digest = hashlib.blake2b(image, digest_size=16).hexdigest()
    return repr((roi.imageName, roi.imageKind, digest, roi.x_origin, roi.x_end, roi.y_origin, roi.y_end,
                 roi.imageBounds, roi.viewport_x_start, roi.viewport_x_end, roi.viewport_y_start,
                 roi.viewport_y_end, roi.selection))


def decode_image_rgba(data: bytes) -> np.ndarray:
    """Decode encoded image bytes to an (H, W, 4) uint8 RGBA array."""
    from PIL import Image
    with Image.open(io.BytesIO(data)) as img:
        return np.asarray(img.convert("RGBA"))


def _selection_crop(roi, source_w: int, source_h: int) -> Tuple[int, int, int, int]:
    sel = roi.selection
    ib = image_world_bounds(roi)
    x0, x1 = min(ib["x_origin"], ib["x_end"]), max(ib["x_origin"], ib["x_end"])
    y0, y1 = min(ib["y_origin"], ib["y_end"]), max(ib["y_origin"], ib["y_end"])
    sx0, sx1 = min(sel["x_start"], sel["x_end"]), max(sel["x_start"], sel["x_end"])
    sy0, sy1 = min(sel["y_start"], sel["y_end"]), max(sel["y_start"], sel["y_end"])
    b = viewport_bounds(roi)

    def clamp01(n):
        return max(0.0, min(1.0, n if math.isfinite(n) else 0.0))

    left = clamp01((sx0 - x0) / max(1, x1 - x0))
    right = clamp01((sx1 - x0) / max(1, x1 - x0))
    top = clamp01((sy0 - y0) / max(1, y1 - y0))
    bottom = clamp01((sy1 - y0) / max(1, y1 - y0))
    px0 = max(0, min(source_w - 1, math.floor(((b.left + left * b.width) / ROI_CANVAS_EDGE) * source_w)))
    px1 = max(px0 + 1, min(source_w, math.ceil(((b.left + right * b.width) / ROI_CANVAS_EDGE) * source_w)))
    py0 = max(0, min(source_h - 1, math.floor(((b.top + top * b.height) / ROI_CANVAS_EDGE) * source_h)))
    py1 = max(py0 + 1, min(source_h, math.ceil(((b.top + bottom * b.height) / ROI_CANVAS_EDGE) * source_h)))
    return px0, py0, px1 - px0, py1 - py0


def _empty_conversion() -> dict:
    return {"roi": {"x_start": 0, "x_end": 1, "y_start": 0, "y_end": 1},
            "bitmap": {"width": 0, "height": 0, "values": np.zeros(0, dtype=np.uint8)}}


def bitmap_selection_to_vector(roi) -> dict:
    """Crop + down-sample the ROI image under the selection to <= 250 000 gray pixels."""
    global _cached_extraction
    if not roi.imageDataUrl or not roi.selection:
        return _empty_conversion()
    key = _extraction_key(roi)
    if _cached_extraction and _cached_extraction[0] == key:
        return _cached_extraction[1]
    try:
        rgba = decode_image_rgba(roi.imageDataUrl)
    except Exception as exc:  # corrupt image: the web rejected with "failed to load ROI bitmap"
        raise RuntimeError("failed to load ROI bitmap") from exc
    source_h, source_w = rgba.shape[:2]
    if source_w <= 0 or source_h <= 0:
        return _empty_conversion()
    cx, cy, cw, ch = _selection_crop(roi, source_w, source_h)
    if cw <= 0 or ch <= 0:
        return _empty_conversion()
    scale = max(1.0, math.sqrt((cw * ch) / MAX_POINTS))
    sample_w = max(1, math.floor(cw / scale))
    sample_h = max(1, math.floor(ch / scale))
    from PIL import Image
    crop = Image.fromarray(rgba).crop((cx, cy, cx + cw, cy + ch))
    if (sample_w, sample_h) != (cw, ch):
        crop = crop.resize((sample_w, sample_h), Image.BILINEAR)
    data = np.asarray(crop, dtype=np.float64)
    luma = 0.2126 * data[..., 0] + 0.7152 * data[..., 1] + 0.0722 * data[..., 2]
    f = np.floor(luma)
    gray = np.where(data[..., 3] == 0, 255, f + ((luma - f) >= 0.5)).astype(np.uint8).reshape(-1)
    value = {"roi": world_selection_to_dac_roi(roi.selection, roi),
             "bitmap": {"width": sample_w, "height": sample_h, "values": gray}}
    _cached_extraction = (key, value)
    return value


def _highlight_mask(values: np.ndarray, selection) -> np.ndarray:
    if selection is None:
        return np.zeros(values.shape, dtype=bool)
    v = values.astype(np.int64)
    return (v >= selection[0]) & (v <= selection[1])


def simulation_bitmap_payload(bitmap: dict, selection, skipped) -> dict:
    """``decorateSimulationBitmap`` -> the JSON-shaped SimulationBitmap the service accepts."""
    sel = normalize_gray_scale_selection(selection)
    norm_skipped = None if skipped is None else bool(skipped)
    values = bitmap["values"]
    if sel is None:
        pixels = [{"value": int(v), "isHighlighted": False, "isSkipped": None, "blank": None} for v in values]
    else:
        hl = _highlight_mask(values, sel)
        pixels = []
        for v, h in zip(values.tolist(), hl.tolist()):
            blank = h if norm_skipped is True else (not h) if norm_skipped is False else None
            pixels.append({"value": v, "isHighlighted": h, "isSkipped": norm_skipped if h else None, "blank": blank})
    return {"width": bitmap["width"], "height": bitmap["height"], "pixels": pixels}


def _roi_bounds(roi_req: dict):
    x0, x1 = min(roi_req["x_start"], roi_req["x_end"]), max(roi_req["x_start"], roi_req["x_end"])
    y0, y1 = min(roi_req["y_start"], roi_req["y_end"]), max(roi_req["y_start"], roi_req["y_end"])
    return x0, x1, y0, y1


def _sample_coords(bitmap: dict, roi_req: dict, scan_path: str):
    width, height = bitmap["width"], bitmap["height"]
    x0, x1, y0, y1 = _roi_bounds(roi_req)
    x_span, y_span = max(1, x1 - x0), max(1, y1 - y0)
    x_div, y_div = max(1, width - 1), max(1, height - 1)
    xs, ys = bitmap_scan_coordinate_arrays(width, height, scan_path)
    tx = (xs / x_div) * x_span
    ty = (ys / y_div) * y_span
    fx, fy = np.floor(tx), np.floor(ty)
    sample_x = x0 + (fx + ((tx - fx) >= 0.5)).astype(np.int64)
    sample_y = y0 + (fy + ((ty - fy) >= 0.5)).astype(np.int64)
    return xs, ys, sample_x, sample_y


def bitmap_to_custom_points(bitmap: dict, roi_req: dict, dwell: int, selection, skipped, scan_path: str) -> list:
    """``bitmapToCustomPoints``: highlighted interval first pass, complement second pass."""
    if bitmap["width"] <= 0 or bitmap["height"] <= 0 or len(bitmap["values"]) == 0:
        return []
    norm_skipped = None if skipped is None else bool(skipped)
    xs, ys, sx, sy = _sample_coords(bitmap, roi_req, scan_path)
    values = bitmap["values"]
    hl = _highlight_mask(values, normalize_gray_scale_selection(selection))[ys * bitmap["width"] + xs]
    if norm_skipped is True:
        blank, primary = hl, hl
    elif norm_skipped is False:
        blank, primary = ~hl, ~hl
    else:
        blank, primary = np.zeros(hl.shape, dtype=bool), np.ones(hl.shape, dtype=bool)
    pass_index = None if norm_skipped is None else np.where(hl, 1, 2)
    order = np.concatenate([np.flatnonzero(primary), np.flatnonzero(~primary)])
    sx_l, sy_l, blank_l = sx[order].tolist(), sy[order].tolist(), blank[order].tolist()
    if pass_index is None:
        return [[x, y, dwell, b, None] for x, y, b in zip(sx_l, sy_l, blank_l)]
    pi_l = pass_index[order].tolist()
    return [[x, y, dwell, b, p] for x, y, b, p in zip(sx_l, sy_l, blank_l, pi_l)]


def bitmap_to_roi_action_points(bitmap: dict, roi_req: dict, dwell: int, selection, skipped: bool,
                                scan_path: str) -> list:
    """``bitmapToROIActionPoints``: blank decided per pixel from the decorated bitmap."""
    if bitmap["width"] <= 0 or bitmap["height"] <= 0 or len(bitmap["values"]) == 0:
        return []
    xs, ys, sx, sy = _sample_coords(bitmap, roi_req, scan_path)
    idx = ys * bitmap["width"] + xs
    hl = _highlight_mask(bitmap["values"], selection)[idx]
    # decorateSimulationBitmap(selection, skipped) sets pixel.blank to exactly this value.
    blank = hl if skipped else ~hl
    pass_index = np.where(hl, 1, 2)
    return [[x, y, dwell, b, p] for x, y, b, p in
            zip(sx.tolist(), sy.tolist(), blank.tolist(), pass_index.tolist())]


def roi_with_full_selection(roi):
    if roi.selection:
        return roi
    ib = image_world_bounds(roi)
    clone = copy.copy(roi)
    clone.selection = {"x_start": min(ib["x_origin"], ib["x_end"]), "x_end": max(ib["x_origin"], ib["x_end"]),
                       "y_start": min(ib["y_origin"], ib["y_end"]), "y_end": max(ib["y_origin"], ib["y_end"])}
    return clone


def raster_request_with_bitmap_selection(req: dict, roi, *, is_production: bool = False,
                                         allow_bitmap_simulation: bool = False,
                                         gray_scale_selection=None, gray_scale_skipped=None) -> dict:
    if not roi.selection or not is_partial_selection(roi):
        return _without_bitmap_roi(req)
    if not roi.imageDataUrl or not allow_bitmap_simulation:
        return {**req, "roi": world_selection_to_dac_roi(roi.selection, roi), "simulation_bitmap": None}
    converted = bitmap_selection_to_vector(roi)
    if not len(converted["bitmap"]["values"]):
        return _without_bitmap_roi(req)
    return {**req, "roi": converted["roi"],
            "simulation_bitmap": None if is_production else
            simulation_bitmap_payload(converted["bitmap"], gray_scale_selection, gray_scale_skipped)}


def vector_request_with_bitmap_selection(req: dict, roi, *, is_production: bool = False,
                                         allow_bitmap_simulation: bool = False,
                                         gray_scale_selection=None, gray_scale_skipped=None) -> dict:
    if not roi.selection or not is_partial_selection(roi):
        return _without_bitmap_roi(req)
    if not roi.imageDataUrl:
        return {**req, "pattern": "default", "points": None,
                "roi": world_selection_to_dac_roi(roi.selection, roi), "simulation_bitmap": None}
    converted = bitmap_selection_to_vector(roi)
    if not len(converted["bitmap"]["values"]):
        return _without_bitmap_roi(req)
    if is_production and gray_scale_selection is not None and gray_scale_skipped is not None:
        return {**req, "pattern": "custom",
                "points": bitmap_to_custom_points(converted["bitmap"], converted["roi"], req["dwell"],
                                                  gray_scale_selection, gray_scale_skipped, req["scan_path"]),
                "roi": converted["roi"], "simulation_bitmap": None}
    if not allow_bitmap_simulation:
        return {**req, "pattern": "default", "points": None,
                "roi": world_selection_to_dac_roi(roi.selection, roi), "simulation_bitmap": None}
    return {**req, "pattern": "default", "points": None, "roi": converted["roi"],
            "simulation_bitmap": None if is_production else
            simulation_bitmap_payload(converted["bitmap"], gray_scale_selection, gray_scale_skipped)}


def vector_request_with_roi_gray_scale_action(req: dict, roi, *, gray_scale_selection, gray_scale_skipped) -> dict:
    selection = normalize_gray_scale_selection(gray_scale_selection)
    if selection is None or gray_scale_skipped is None:
        return vector_request_with_bitmap_selection(req, roi, is_production=True, gray_scale_selection=selection,
                                                    gray_scale_skipped=gray_scale_skipped)
    converted = bitmap_selection_to_vector(roi_with_full_selection(roi))
    if not len(converted["bitmap"]["values"]):
        return _without_bitmap_roi(req)
    dwell = max(2, req["dwell"])
    return {**req, "pattern": "custom",
            "points": bitmap_to_roi_action_points(converted["bitmap"], converted["roi"], dwell, selection,
                                                  bool(gray_scale_skipped), req["scan_path"]),
            "roi": converted["roi"], "simulation_bitmap": None, "dwell": dwell,
            "gray_level_range": [selection[0], selection[1]], "gray_level_skipped": gray_scale_skipped,
            "pre_process": False}


def vector_request_with_adaptive_gray_feedback(req: dict, roi, *, gray_scale_selection, gray_scale_skipped) -> dict:
    selection = normalize_gray_scale_selection(gray_scale_selection)
    if selection is None or gray_scale_skipped is None:
        return _without_bitmap_roi(req)
    active = roi_with_full_selection(roi)
    if not active.selection:
        return _without_bitmap_roi(req)
    roi_request = bitmap_selection_to_vector(active)["roi"] if active.imageDataUrl else \
        world_selection_to_dac_roi(active.selection, active)
    return {**req, "pattern": "default", "points": None, "roi": roi_request, "simulation_bitmap": None,
            "pre_process": True, "dwell": req["dwell"], "output_mode": "SixteenBit",
            "feedback_mode": "adaptive_gray_feedback", "gray_level_range": [selection[0], selection[1]],
            "gray_level_skipped": gray_scale_skipped}


def gray_scale_spectrum_levels_for_selection(roi) -> list:
    converted = bitmap_selection_to_vector(roi)
    values = converted["bitmap"]["values"]
    if not len(values):
        return []
    return sorted(int(v) for v in np.unique(values))


def without_partial_roi_selection(roi):
    clone = copy.copy(roi)
    clone.selection = None
    return clone


def js_round_int(x: float) -> int:  # re-export for UI modules
    return js_round(x)
