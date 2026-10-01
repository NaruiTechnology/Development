"""Scan state model: port of the rules in store/scanSlice.ts.

Plain Python (no Qt) so the reducer semantics can be unit-tested. The UI
wraps an instance in a Qt object that emits change signals.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field, fields, replace
from typing import Any, Dict, Optional

from .jsmath import is_finite, js_number

VALID_SCAN_PATHS = ("vertical_raster", "vertical_serpentine", "horizontal_sawtooth", "horizontal_triangle")

DEFAULT_RASTER: Dict[str, Any] = {
    "resolution": 512,
    "dwell": 16,
    "latency_bytes": 16384,
    "frame_blank": False,
    "cookie": 123,
    "output_mode": "SixteenBit",
    "adc_valid": True,
    "do_validate": True,
    "roi": None,
}

DEFAULT_VECTOR: Dict[str, Any] = {
    "pattern": "default",
    "scan_path": "horizontal_sawtooth",
    "points": None,
    "vector_resolution": 2048,
    "dwell": 16,
    "latency_bytes": 8196,
    "output_mode": "SixteenBit",
    "adc_valid": True,
    "cookie": 123,
    "pre_process": True,
    "do_validate": True,
    "roi": None,
}


def boolean_default(value, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("true", "1", "yes", "on"):
            return True
        if normalized in ("false", "0", "no", "off", ""):
            return False
    return fallback


def number_default(value, fallback: int) -> int:
    n = js_number(value)
    import math
    return int(math.floor(n)) if is_finite(n) else fallback


def float_default(value, fallback: float) -> float:
    n = js_number(value)
    return n if is_finite(n) else fallback


def dwell_default(value, fallback: int) -> int:
    return max(0, number_default(value, fallback))


def vector_scan_path_default(value, fallback: str) -> str:
    return value if value in VALID_SCAN_PATHS else fallback


@dataclass
class ROIState:
    x_origin: float = 0
    x_end: float = 100
    y_origin: float = 0
    y_end: float = 100
    viewport_x_start: float = 0
    viewport_x_end: float = 640
    viewport_y_start: float = 0
    viewport_y_end: float = 640
    calibration_enabled: bool = False
    calibration_x_origin: float = 0
    calibration_x_end: float = 100
    calibration_y_origin: float = 0
    calibration_y_end: float = 100
    calibration_viewport_x_start: float = 0
    calibration_viewport_x_end: float = 640
    calibration_viewport_y_start: float = 0
    calibration_viewport_y_end: float = 640
    calibration_confirmed: bool = False
    x_scale_length: float = 100
    y_scale_length: float = 100
    scale_unit: str = "um"
    show_grid: bool = True
    raster_show_grid: bool = True
    vector_show_grid: bool = True
    vector_show_scan_path: bool = False
    selection: Optional[dict] = None
    imageName: str = "No image selected"
    # Images are held as encoded bytes (PNG/JPEG/...) plus a stable identity
    # string; the web used data URLs for the same purpose.
    imageDataUrl: Optional[bytes] = None
    imageKind: str = "none"            # none | file | lastScan
    imageBounds: Optional[dict] = None
    scanImageDataUrl: Optional[bytes] = None
    scanGeometry: Optional[dict] = None


_CALIBRATION_MAPPING_KEYS = {
    "x_origin", "x_end", "y_origin", "y_end",
    "viewport_x_start", "viewport_x_end", "viewport_y_start", "viewport_y_end",
    "calibration_x_origin", "calibration_x_end", "calibration_y_origin", "calibration_y_end",
    "calibration_viewport_x_start", "calibration_viewport_x_end",
    "calibration_viewport_y_start", "calibration_viewport_y_end",
}
_BOOL_ROI_KEYS = {"show_grid", "raster_show_grid", "vector_show_grid", "vector_show_scan_path"}


@dataclass
class DimensionCalibrationValues:
    x_origin: float = 0
    x_end: float = 100
    y_origin: float = 0
    y_end: float = 100
    viewport_x_start: float = 0
    viewport_x_end: float = 640
    viewport_y_start: float = 0
    viewport_y_end: float = 640
    scale_unit: str = "um"
    source: Optional[dict] = None

    def to_json(self) -> dict:
        out = {f.name: getattr(self, f.name) for f in fields(self) if f.name != "source"}
        if self.source:
            out["source"] = self.source
        return out


def parse_dimension_calibration(value) -> Optional[DimensionCalibrationValues]:
    """``parseDimensionCalibration`` on an already-decoded object."""
    if not isinstance(value, dict):
        return None
    numeric = ["x_origin", "x_end", "y_origin", "y_end",
               "viewport_x_start", "viewport_x_end", "viewport_y_start", "viewport_y_end"]
    parsed: Dict[str, Any] = {}
    for key in numeric:
        v = value.get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not is_finite(v):
            return None
        parsed[key] = v
    scale_unit = value.get("scale_unit").strip() if isinstance(value.get("scale_unit"), str) else ""
    if (not scale_unit or parsed["x_end"] <= parsed["x_origin"] or parsed["y_end"] <= parsed["y_origin"]
            or parsed["viewport_x_end"] <= parsed["viewport_x_start"]
            or parsed["viewport_y_end"] <= parsed["viewport_y_start"]):
        return None
    source = value.get("source")
    parsed_source = None
    if isinstance(source, dict):
        if source.get("kind") == "manual" and isinstance(source.get("set_at"), str):
            parsed_source = {"kind": "manual", "set_at": source["set_at"]}
        elif (source.get("kind") == "scanGeometry" and isinstance(source.get("equipment_id"), (int, float))
              and source.get("equipment_type") in ("FIB", "SEM")
              and (source.get("profile_revision") is None or isinstance(source.get("profile_revision"), (int, float)))
              and isinstance(source.get("applied_at"), str)):
            parsed_source = {k: source[k] for k in ("kind", "equipment_id", "equipment_type",
                                                     "profile_revision", "applied_at")}
    return DimensionCalibrationValues(**parsed, scale_unit=scale_unit, source=parsed_source)


@dataclass
class ScanState:
    kind: str = "roi"                  # raster | vector | roi | mag
    phase: str = "idle"                # idle | running | stopping | completed | error
    bytesReceived: int = 0
    chunksReceived: int = 0
    lastResult: Optional[dict] = None
    lastOutput: Optional[dict] = None
    errorMessage: Optional[str] = None
    raster: Dict[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULT_RASTER))
    vector: Dict[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULT_VECTOR))
    preview: bool = True
    roi: ROIState = field(default_factory=ROIState)
    beamEnergyEv: float = 1000.0
    roiGrayScaleSelection: Optional[tuple] = None
    roiGrayScaleSkipped: Optional[bool] = None
    roiGrayScaleStepDelta: int = 10
    vectorRenderMode: str = "decimated"  # native | decimated

    # ---- reducers ----------------------------------------------------------

    def update_raster(self, patch: dict) -> None:
        patch = dict(patch)
        for key in ("frame_blank", "do_validate", "adc_valid"):
            if key in patch:
                patch[key] = boolean_default(patch[key], self.raster[key])
        self.raster.update(patch)

    def update_vector(self, patch: dict) -> None:
        patch = dict(patch)
        for key in ("pre_process", "do_validate", "adc_valid"):
            if key in patch:
                patch[key] = boolean_default(patch[key], self.vector[key])
        self.vector.update(patch)

    def update_roi(self, patch: dict) -> None:
        patch = dict(patch)
        for key in _BOOL_ROI_KEYS & patch.keys():
            patch[key] = boolean_default(patch[key], getattr(self.roi, key))
        self.roi = replace(self.roi, **patch)
        if _CALIBRATION_MAPPING_KEYS & patch.keys():
            self.roi.calibration_confirmed = False
        if "selection" in patch:
            self.raster["roi"] = patch["selection"]
            self.vector["roi"] = patch["selection"]
            if patch["selection"]:
                self.roi.vector_show_scan_path = True

    def set_scan_geometry(self, applied: Optional[dict]) -> None:
        self.roi.scanGeometry = applied if applied and applied.get("enabled") else None
        self._clear_selection_only()

    def _clear_selection_only(self) -> None:
        self.roi.selection = None
        self.raster["roi"] = None
        self.vector["roi"] = None

    def begin_dimension_calibration(self, v: DimensionCalibrationValues) -> None:
        r = self.roi
        r.calibration_enabled = True
        r.calibration_confirmed = False
        r.calibration_x_origin, r.calibration_x_end = v.x_origin, v.x_end
        r.calibration_y_origin, r.calibration_y_end = v.y_origin, v.y_end
        r.calibration_viewport_x_start, r.calibration_viewport_x_end = v.viewport_x_start, v.viewport_x_end
        r.calibration_viewport_y_start, r.calibration_viewport_y_end = v.viewport_y_start, v.viewport_y_end
        r.scale_unit = v.scale_unit

    def apply_persisted_dimension_calibration(self, v: DimensionCalibrationValues, *, enabled: bool = True) -> None:
        r = self.roi
        r.calibration_enabled = enabled
        r.calibration_x_origin, r.calibration_x_end = v.x_origin, v.x_end
        r.calibration_y_origin, r.calibration_y_end = v.y_origin, v.y_end
        r.calibration_viewport_x_start, r.calibration_viewport_x_end = v.viewport_x_start, v.viewport_x_end
        r.calibration_viewport_y_start, r.calibration_viewport_y_end = v.viewport_y_start, v.viewport_y_end
        r.x_origin, r.x_end, r.y_origin, r.y_end = v.x_origin, v.x_end, v.y_origin, v.y_end
        r.viewport_x_start, r.viewport_x_end, r.viewport_y_start, r.viewport_y_end = 0, 640, 0, 640
        r.scale_unit = v.scale_unit
        r.calibration_confirmed = True
        self._clear_selection_only()

    def restore_persisted_dimension_calibration(self, v: DimensionCalibrationValues) -> None:
        self.apply_persisted_dimension_calibration(v, enabled=False)

    def confirm_roi_calibration(self) -> None:
        r = self.roi
        r.x_origin, r.x_end = r.calibration_x_origin, r.calibration_x_end
        r.y_origin, r.y_end = r.calibration_y_origin, r.calibration_y_end
        r.viewport_x_start, r.viewport_x_end, r.viewport_y_start, r.viewport_y_end = 0, 640, 0, 640
        r.calibration_confirmed = True
        self._clear_selection_only()

    def set_roi_gray_scale_selection(self, selection, is_skipped="__unset__", step_delta=None) -> None:
        from .helpers import normalize_gray_scale_selection
        self.roiGrayScaleSelection = normalize_gray_scale_selection(selection)
        if selection is None:
            self.roiGrayScaleSkipped = None
        elif is_skipped != "__unset__":
            self.roiGrayScaleSkipped = None if is_skipped is None else bool(is_skipped)
        if step_delta is not None:
            self.roiGrayScaleStepDelta = clamp_gray_scale_step_delta(step_delta)

    def clear_roi_image(self) -> None:
        self.roi.imageName = "No image selected"
        self.roi.imageDataUrl = None
        self.roi.imageKind = "none"
        self.roi.imageBounds = None

    def clear_roi_scan_image(self) -> None:
        self.roi.scanImageDataUrl = None

    def clear_roi_selection(self) -> None:
        self._clear_selection_only()
        self.roiGrayScaleSelection = None
        self.roiGrayScaleSkipped = None
        self.roi.scanImageDataUrl = None

    def stream_started(self) -> None:
        self.phase = "running"
        self.bytesReceived = 0
        self.chunksReceived = 0
        self.lastResult = None
        self.lastOutput = None
        self.errorMessage = None

    def stream_progress(self, nbytes: int, chunks: int) -> None:
        self.bytesReceived += nbytes
        self.chunksReceived += chunks

    def stream_stopping(self) -> None:
        self.phase = "stopping"

    def stream_completed(self, chunks=None, kind=None, csv_filename=None, image_filename=None) -> None:
        self.phase = "completed"
        if chunks is not None:
            self.chunksReceived = chunks
        if kind:
            self.lastOutput = {"kind": kind, "csv_filename": csv_filename, "image_filename": image_filename}

    def stream_errored(self, message: str) -> None:
        self.phase = "error"
        self.errorMessage = message

    def stream_reset(self) -> None:
        self.phase = "idle"
        self.bytesReceived = 0
        self.chunksReceived = 0
        self.errorMessage = None
        self.lastOutput = None

    def validated_pending(self) -> None:
        self.stream_started()

    def validated_fulfilled(self, kind: str, result: dict) -> None:
        self.phase = "completed"
        self.lastResult = result
        self.lastOutput = {"kind": kind, "csv_filename": result.get("csv_filename"),
                           "image_filename": result.get("image_filename")}

    def validated_rejected(self, message: str, aborted: bool = False) -> None:
        if aborted:
            self.phase = "idle"
            self.errorMessage = None
            return
        self.phase = "error"
        self.errorMessage = message

    def apply_server_defaults(self, defaults: dict) -> None:
        """``applyServerDefaults`` + beam energy (fetchDefaults.fulfilled)."""
        rp = defaults.get("raster_params") or {}
        vp = defaults.get("vector_params") or {}
        r = defaults.get("raster") or {}
        v = defaults.get("vector") or {}

        def first(*values):
            for value in values:
                if value is not None:
                    return value
            return None

        raster_latency = first(rp.get("latency_bytes"), r.get("latency_bytes"), r.get("latency"),
                               number_default(r.get("pixels"), 8192) * 2 if r.get("pixels") is not None else None)
        self.raster.update({
            "resolution": number_default(first(rp.get("resolution"), r.get("resolution")), self.raster["resolution"]),
            "dwell": dwell_default(first(rp.get("dwell"), r.get("dwell")), self.raster["dwell"]),
            "latency_bytes": number_default(raster_latency, self.raster["latency_bytes"]),
            "frame_blank": boolean_default(first(rp.get("frame_blank"), r.get("frame_blank"), r.get("frameBlank")),
                                           self.raster["frame_blank"]),
            "do_validate": boolean_default(first(rp.get("do_validate"), r.get("do_validate"), r.get("doValidate")),
                                           self.raster["do_validate"]),
            "adc_valid": boolean_default(first(rp.get("adc_valid"), r.get("adc_valid"), r.get("adcValid")),
                                         self.raster["adc_valid"]),
            "output_mode": "SixteenBit",
        })
        self.vector.update({
            "scan_path": vector_scan_path_default(vp.get("scan_path"), self.vector["scan_path"]),
            "vector_resolution": number_default(first(vp.get("vector_resolution"), v.get("vector_resolution"),
                                                      v.get("vectorResolution")), self.vector["vector_resolution"]),
            "dwell": dwell_default(first(vp.get("dwell"), v.get("dwell")), self.vector["dwell"]),
            "latency_bytes": number_default(first(vp.get("latency_bytes"), v.get("latency_bytes"), v.get("latency")),
                                            self.vector["latency_bytes"]),
            "output_mode": "SixteenBit",
            "adc_valid": boolean_default(first(vp.get("adc_valid"), v.get("adc_valid"), v.get("adcValid")),
                                         self.vector["adc_valid"]),
            "pre_process": boolean_default(first(vp.get("pre_process"), v.get("pre_process"), v.get("preProcess")),
                                           self.vector["pre_process"]),
            "do_validate": boolean_default(first(vp.get("do_validate"), v.get("do_validate"), v.get("doValidate")),
                                           self.vector["do_validate"]),
        })
        self.beamEnergyEv = float_default(defaults.get("ev"), self.beamEnergyEv)


def clamp_gray_scale_step_delta(value) -> int:
    from .jsmath import js_round
    n = js_number(value)
    if not is_finite(n):
        return 10
    return max(1, min(255, js_round(n)))


def is_partial_roi_selection(roi: ROIState) -> bool:
    sel = roi.selection
    if not sel:
        return False
    x0, x1 = min(roi.x_origin, roi.x_end), max(roi.x_origin, roi.x_end)
    y0, y1 = min(roi.y_origin, roi.y_end), max(roi.y_origin, roi.y_end)
    sx0, sx1 = min(sel["x_start"], sel["x_end"]), max(sel["x_start"], sel["x_end"])
    sy0, sy1 = min(sel["y_start"], sel["y_end"]), max(sel["y_start"], sel["y_end"])
    return sx0 > x0 or sx1 < x1 or sy0 > y0 or sy1 < y1


def completed_roi_image_patch(roi: ROIState, image: bytes, image_name: str) -> dict:
    """``completedROIImagePatch``: promote a completed partial scan, keeping its world position."""
    return {"imageName": image_name, "imageDataUrl": image, "imageKind": "lastScan",
            "imageBounds": roi.selection or roi.imageBounds, "scanImageDataUrl": None, "selection": None}
