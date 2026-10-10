"""Ports of roiGeometry.ts, roiDac.ts and the apply-side of scanGeometry.ts.

Only the read/apply path of the scan geometry lives here; editing and
fitting it is CONFIGURATION (Admin > Calibration), which the desktop app
does not include.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

from .jsmath import is_finite, js_round, to_precision

ROI_CANVAS_EDGE = 640
ROI_VIEWPORT_MIN_SPAN = 24
DAC_CODES = 16384
DAC_MAX = DAC_CODES - 1
DAC_CENTER = DAC_MAX / 2
VENDOR_SPOT_DAC_CODES = 65536

Mat2 = Tuple[float, float, float, float]
Vec2 = Tuple[float, float]


def _clamp(value: float, lo: float, hi: float) -> float:
    if not is_finite(value):
        return lo
    return min(hi, max(lo, value))


# ---- roiGeometry.ts -----------------------------------------------------------

@dataclass(frozen=True)
class ViewportBounds:
    left: float
    right: float
    top: float
    bottom: float
    width: float
    height: float


def image_world_bounds(roi) -> dict:
    """World coordinate space occupied by the displayed bitmap (or the hardware FOV)."""
    bounds = roi.imageBounds if roi.imageDataUrl else None
    if bounds:
        return {"x_origin": bounds["x_start"], "x_end": bounds["x_end"],
                "y_origin": bounds["y_start"], "y_end": bounds["y_end"]}
    return {"x_origin": roi.x_origin, "x_end": roi.x_end, "y_origin": roi.y_origin, "y_end": roi.y_end}


def viewport_bounds(roi, mode: str = "confirmed") -> ViewportBounds:
    if mode == "draft":
        x0, x1 = roi.calibration_viewport_x_start, roi.calibration_viewport_x_end
        y0, y1 = roi.calibration_viewport_y_start, roi.calibration_viewport_y_end
    else:
        x0, x1 = roi.viewport_x_start, roi.viewport_x_end
        y0, y1 = roi.viewport_y_start, roi.viewport_y_end
    left = _clamp(min(x0, x1), 0, ROI_CANVAS_EDGE)
    right = _clamp(max(x0, x1), 0, ROI_CANVAS_EDGE)
    top = _clamp(min(y0, y1), 0, ROI_CANVAS_EDGE)
    bottom = _clamp(max(y0, y1), 0, ROI_CANVAS_EDGE)
    return ViewportBounds(left, right, top, bottom, max(1, right - left), max(1, bottom - top))


def clamp_canvas_point_to_viewport(point: Vec2, b: ViewportBounds) -> Vec2:
    return (_clamp(point[0], b.left, b.right), _clamp(point[1], b.top, b.bottom))


def _normalize(value: float, start: float, end: float) -> float:
    if start == end:
        return 0.0
    return _clamp((value - start) / (end - start), 0, 1)


def canvas_point_to_world(point: Vec2, world: dict, b: ViewportBounds) -> Vec2:
    tx = _normalize(point[0], b.left, b.right)
    ty = _normalize(point[1], b.top, b.bottom)
    return (world["x_origin"] + (world["x_end"] - world["x_origin"]) * tx,
            world["y_origin"] + (world["y_end"] - world["y_origin"]) * ty)


def world_to_canvas_x(value: float, world: dict, b: ViewportBounds) -> float:
    return b.left + _normalize(value, world["x_origin"], world["x_end"]) * b.width


def world_to_canvas_y(value: float, world: dict, b: ViewportBounds) -> float:
    return b.top + _normalize(value, world["y_origin"], world["y_end"]) * b.height


def clamp_viewport_coordinate(value: float, lo: float, hi: float) -> float:
    return _clamp(js_round(value), lo, hi)


# ---- scanGeometry.ts (apply path) --------------------------------------------

IDENTITY: Mat2 = (1.0, 0.0, 0.0, 1.0)


def mul(p: Mat2, q: Mat2) -> Mat2:
    return (p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3],
            p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3])


def det(m: Mat2) -> float:
    return m[0] * m[3] - m[1] * m[2]


def inv(m: Mat2) -> Mat2:
    d = det(m)
    if not math.isfinite(d) or abs(d) < 1e-300:
        raise ValueError("singular geometry matrix")
    return (m[3] / d, -m[1] / d, -m[2] / d, m[0] / d)


def apply(m: Mat2, v: Vec2) -> Vec2:
    return (m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1])


def _rot(deg: float) -> Mat2:
    r = deg * math.pi / 180
    return (math.cos(r), -math.sin(r), math.sin(r), math.cos(r))


def hardware_transform(t: dict) -> Mat2:
    swap: Mat2 = (0.0, 1.0, 1.0, 0.0) if t.get("rotate90") else IDENTITY
    flip: Mat2 = (-1.0 if t.get("xflip") else 1.0, 0.0, 0.0, -1.0 if t.get("yflip") else 1.0)
    return mul(flip, swap)


def tilt_factor(t: dict) -> float:
    if not t.get("enabled"):
        return 1.0
    angle = abs(t["beamTiltDeg"] - t["stageTiltDeg"])
    if not angle < 89:
        raise ValueError("tilt correction angle must be below 89°")
    return 1 / math.cos(angle * math.pi / 180)


def nominal_matrix(i: dict) -> Mat2:
    kx = i["hfovUm"] / DAC_CODES
    ky = kx * i["yxAspect"] * tilt_factor(i["tiltCorrection"])
    return mul(mul(_rot(i["rotationOffsetDeg"] + i["scanRotationDeg"]), (kx, 0.0, 0.0, ky)),
               hardware_transform(i["transforms"]))


@dataclass
class Affine2:
    a: Mat2
    b: Vec2


def transform(f: Affine2, p: Vec2) -> Vec2:
    v = apply(f.a, p)
    return (v[0] + f.b[0], v[1] + f.b[1])


@dataclass
class ScanGeometry:
    inputs: dict
    correction: dict
    forward: Affine2
    inverse: Affine2


def build_scan_geometry(inputs: dict, correction: Optional[dict] = None) -> ScanGeometry:
    correction = correction or {"matrix": IDENTITY, "dacOffset": (0.0, 0.0)}
    if not (inputs["hfovUm"] > 0) or not math.isfinite(inputs["hfovUm"]):
        raise ValueError("HFOV must be a positive number")
    a = mul(tuple(correction["matrix"]), nominal_matrix(inputs))
    shifted = apply(a, (DAC_CENTER + correction["dacOffset"][0], DAC_CENTER + correction["dacOffset"][1]))
    b = (inputs["stageOriginUm"][0] - shifted[0], inputs["stageOriginUm"][1] - shifted[1])
    ai = inv(a)
    bi = apply(ai, b)
    return ScanGeometry(inputs, correction, Affine2(a, b), Affine2(ai, (-bi[0], -bi[1])))


def dac_to_world(g: ScanGeometry, d: Vec2) -> Vec2:
    return transform(g.forward, d)


def _decompose(a: Mat2) -> dict:
    sx = math.hypot(a[0], a[2])
    theta = math.atan2(a[2], a[0])
    c, s = math.cos(theta), math.sin(theta)
    r12 = c * a[1] + s * a[3]
    sy = -s * a[1] + c * a[3]
    return {"scaleX": sx, "scaleY": abs(sy), "rotationDeg": theta * 180 / math.pi,
            "shear": r12 / sx if sx > 0 else 0.0, "mirrored": sy < 0}


def scan_geometry_results(g: ScanGeometry) -> dict:
    i = g.inputs
    parts = _decompose(g.forward.a)
    dpp = (DAC_CODES / i["pixelsX"], DAC_CODES / i["pixelsY"])
    corners = [dac_to_world(g, p) for p in ((0, 0), (DAC_MAX, 0), (DAC_MAX, DAC_MAX), (0, DAC_MAX))]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    return {
        "pixels": (i["pixelsX"], i["pixelsY"]),
        "pixelSizeNm": (parts["scaleX"] * dpp[0] * 1e3, parts["scaleY"] * dpp[1] * 1e3),
        "worldBounds": {"x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys)},
    }


def world_rect_to_dac_roi(inverse: Affine2, sel: dict) -> dict:
    pts = [transform(inverse, (x, y)) for x in (sel["x_start"], sel["x_end"]) for y in (sel["y_start"], sel["y_end"])]

    def clamp(v: float) -> int:
        return max(0, min(DAC_MAX, js_round(v)))

    x0 = clamp(min(p[0] for p in pts))
    x1 = clamp(max(p[0] for p in pts))
    y0 = clamp(min(p[1] for p in pts))
    y1 = clamp(max(p[1] for p in pts))
    return {"x_start": x0, "x_end": min(DAC_MAX, max(x0 + 1, x1)),
            "y_start": y0, "y_end": min(DAC_MAX, max(y0 + 1, y1))}


def _is_vec2(v) -> bool:
    return isinstance(v, (list, tuple)) and len(v) == 2 and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v)


def _is_mat2(v) -> bool:
    return isinstance(v, (list, tuple)) and len(v) == 4 and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v)


def parse_scan_geometry_config(raw) -> Optional[dict]:
    """``parseScanGeometryConfig``: validated config or None (linear ROI mapping then applies)."""
    if not isinstance(raw, dict):
        return None
    i = raw.get("inputs")
    c = raw.get("correction")
    if not isinstance(i, dict) or not isinstance(c, dict) or not _is_mat2(c.get("matrix")) \
            or not _is_vec2(c.get("dacOffset")) or abs(det(tuple(c["matrix"]))) < 1e-12:
        return None

    def n(k):
        v = i.get(k)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else math.nan

    required = ["magnification", "hfovUm", "pixelsX", "pixelsY", "rotationOffsetDeg", "scanRotationDeg",
                "yxAspect", "dwell", "adcHalfPeriod"]
    if any(math.isnan(n(k)) for k in required):
        return None
    if not (n("hfovUm") > 0) or not (n("pixelsX") >= 1) or not (n("pixelsY") >= 1) or not (n("yxAspect") > 0):
        return None
    tc = i.get("tiltCorrection") or {}
    tr = i.get("transforms") or {}
    inputs = {
        "equipmentType": "SEM" if i.get("equipmentType") == "SEM" else "FIB",
        "magnification": n("magnification"),
        "hfovUm": n("hfovUm"),
        "pixelsX": js_round(n("pixelsX")),
        "pixelsY": js_round(n("pixelsY")),
        "dwell": n("dwell"),
        "adcHalfPeriod": n("adcHalfPeriod"),
        "vendorDwell": i.get("vendorDwell") if isinstance(i.get("vendorDwell"), (int, float)) else None,
        "rotationOffsetDeg": n("rotationOffsetDeg"),
        "scanRotationDeg": n("scanRotationDeg"),
        "yxAspect": n("yxAspect"),
        "tiltCorrection": {
            "enabled": tc.get("enabled") is True,
            "beamTiltDeg": tc.get("beamTiltDeg") if isinstance(tc.get("beamTiltDeg"), (int, float)) else 52,
            "stageTiltDeg": tc.get("stageTiltDeg") if isinstance(tc.get("stageTiltDeg"), (int, float)) else 52,
        },
        "transforms": {"xflip": tr.get("xflip") is True, "yflip": tr.get("yflip") is True,
                       "rotate90": tr.get("rotate90") is True},
        "stageOriginUm": tuple(i["stageOriginUm"]) if _is_vec2(i.get("stageOriginUm")) else (0.0, 0.0),
        "spotPark": tuple(i["spotPark"]) if _is_vec2(i.get("spotPark")) else None,
    }
    correction = {"matrix": tuple(c["matrix"]), "dacOffset": tuple(c["dacOffset"])}
    try:
        build_scan_geometry(inputs, correction)
    except (ValueError, ZeroDivisionError):
        return None
    return {
        "version": raw.get("version") if isinstance(raw.get("version"), (int, float)) else 1,
        "enabled": raw.get("enabled") is True,
        "beam": "ebeam" if raw.get("beam") == "ebeam" else "ion",
        "equipment_id": raw.get("equipment_id") if isinstance(raw.get("equipment_id"), (int, float)) else None,
        "equipment_type": "SEM" if raw.get("equipment_type") == "SEM" else "FIB",
        "profile_revision": raw.get("profile_revision") if isinstance(raw.get("profile_revision"), (int, float)) else None,
        "inputs": inputs,
        "correction": correction,
        "fit": raw.get("fit"),
        "applied_at": raw.get("applied_at") if isinstance(raw.get("applied_at"), str) else "",
        "applied_by": raw.get("applied_by") if isinstance(raw.get("applied_by"), str) else "",
    }


def geometry_from_config(config: dict) -> ScanGeometry:
    return build_scan_geometry(config["inputs"], config["correction"])


def to_applied_geometry(g: ScanGeometry, profile_revision) -> dict:
    r = scan_geometry_results(g)
    return {"enabled": True, "unit": "um", "forward": g.forward, "inverse": g.inverse,
            "magnification": g.inputs["magnification"], "pixels": r["pixels"],
            "pixelSizeNm": r["pixelSizeNm"], "profileRevision": profile_revision}


def dimension_bounds_from_geometry(g: ScanGeometry) -> dict:
    b = scan_geometry_results(g)["worldBounds"]

    def rnd(v: float) -> float:
        return float(to_precision(v, 9))

    return {"x_origin": rnd(b["x0"]), "x_end": rnd(b["x1"]), "y_origin": rnd(b["y0"]),
            "y_end": rnd(b["y1"]), "scale_unit": "um"}


# ---- roiDac.ts -----------------------------------------------------------------

def world_selection_to_dac_roi(selection: dict, fov) -> dict:
    """World-unit selection -> absolute DAC ROI (optionally through the applied scan geometry)."""
    geometry = getattr(fov, "scanGeometry", None) if not isinstance(fov, dict) else fov.get("scanGeometry")
    if geometry and geometry.get("enabled"):
        return world_rect_to_dac_roi(geometry["inverse"], selection)

    def attr(name):
        return fov[name] if isinstance(fov, dict) else getattr(fov, name)

    fx0, fx1 = min(attr("x_origin"), attr("x_end")), max(attr("x_origin"), attr("x_end"))
    fy0, fy1 = min(attr("y_origin"), attr("y_end")), max(attr("y_origin"), attr("y_end"))

    def clamp_to(v, lo, hi):
        return lo if not is_finite(v) else max(lo, min(hi, v))

    sx0 = clamp_to(min(selection["x_start"], selection["x_end"]), fx0, fx1)
    sx1 = clamp_to(max(selection["x_start"], selection["x_end"]), fx0, fx1)
    sy0 = clamp_to(min(selection["y_start"], selection["y_end"]), fy0, fy1)
    sy1 = clamp_to(max(selection["y_start"], selection["y_end"]), fy0, fy1)
    eps = 2.220446049250313e-16
    span_x = max(eps, fx1 - fx0)
    span_y = max(eps, fy1 - fy0)

    def to_dac(value, origin, span):
        return max(0, min(DAC_MAX, js_round(((value - origin) / span) * DAC_MAX)))

    dx0, dx1 = to_dac(sx0, fx0, span_x), to_dac(sx1, fx0, span_x)
    dy0, dy1 = to_dac(sy0, fy0, span_y), to_dac(sy1, fy0, span_y)
    return {"x_start": dx0, "x_end": min(DAC_MAX, max(dx0 + 1, dx1)),
            "y_start": dy0, "y_end": min(DAC_MAX, max(dy0 + 1, dy1))}
