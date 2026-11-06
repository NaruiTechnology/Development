"""Pattern data models (no Qt).

One class per ``model`` name used in ``processingPatterns.json``. A model owns
its parameter values and the ROI the operator drew, both in world coordinates
(the ROI canvas' units), so it survives canvas zoom / image changes.

ROI shapes (``ROI_KIND``):
  rect     {"x_start", "x_end", "y_start", "y_end"}                 (ordered)
  circle   {"cx", "cy", "radius"}                              solid disk
  ring     {"cx", "cy", "r_inner", "r_outer"}   two concentric circles, one centre
  polygon  {"points": [[x, y], ...]}                                 (>= 3 points)
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

MODEL_REGISTRY: dict = {}
Listener = Callable[["PatternModel"], None]


def register_model(cls):
    MODEL_REGISTRY[cls.__name__] = cls
    return cls


@dataclass
class ParameterSpec:
    name: str
    label: str
    type: str = "float"                      # int | float | bool | choice
    default: Any = 0
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    step: float = 1
    unit: str = ""
    choices: list = field(default_factory=list)

    def coerce(self, value):
        """Convert + clamp ``value``; raises ValueError when it is not usable."""
        if self.type == "bool":
            if isinstance(value, str):
                return value.strip().lower() in ("1", "true", "yes", "on")
            return bool(value)
        if self.type == "choice":
            if value not in self.choices:
                raise ValueError(f"{self.name}: {value!r} is not one of {self.choices}")
            return value
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{self.name}: {value!r} is not a number") from None
        if not math.isfinite(num):
            raise ValueError(f"{self.name}: {value!r} is not finite")
        if self.minimum is not None:
            num = max(self.minimum, num)
        if self.maximum is not None:
            num = min(self.maximum, num)
        return int(round(num)) if self.type == "int" else num


class PatternModel:
    """Base data model. Subclasses set ``ROI_KIND`` and may add derived values."""

    ROI_KIND = "rect"

    def __init__(self, key: str, specs: list, caption: str = "", icon: str = ""):
        self.key = key
        self.caption = caption or key
        self.icon = icon
        self.param_specs: dict = {s.name: s for s in specs}
        self.parameters: dict = {s.name: s.default for s in specs}
        self.roi: Optional[dict] = None
        self._listeners: list = []

    # ---- observers (the card binds here)
    def subscribe(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def unsubscribe(self, fn: Listener) -> None:
        if fn in self._listeners:
            self._listeners.remove(fn)

    def _notify(self) -> None:
        for fn in list(self._listeners):
            fn(self)

    # ---- parameters
    def set_parameter(self, name: str, value) -> Any:
        spec = self.param_specs.get(name)
        if spec is None:
            raise KeyError(f"{self.key}: unknown parameter {name!r}")
        coerced = spec.coerce(value)
        if self.parameters.get(name) != coerced:
            self.parameters[name] = coerced
            self._notify()
        return coerced

    # ---- ROI
    def set_roi(self, roi: Optional[dict]) -> None:
        if roi is not None:
            roi = self.validate_roi(roi)
        self.roi = roi
        self._notify()

    def clear_roi(self) -> None:
        if self.roi is not None:
            self.roi = None
            self._notify()

    @property
    def has_roi(self) -> bool:
        return self.roi is not None

    def validate_roi(self, roi: dict) -> dict:
        """Return a normalised copy or raise ValueError."""
        return _validate_rect(roi)

    def area(self) -> float:
        """ROI area in world units squared (0 without a ROI)."""
        if not self.roi:
            return 0.0
        r = self.roi
        return abs(r["x_end"] - r["x_start"]) * abs(r["y_end"] - r["y_start"])

    def contains(self, x: float, y: float) -> bool:
        r = self.roi
        return bool(r) and r["x_start"] <= x <= r["x_end"] and r["y_start"] <= y <= r["y_end"]

    def to_dict(self) -> dict:
        return {"pattern": self.key, "model": type(self).__name__, "parameters": dict(self.parameters),
                "roi": None if self.roi is None else dict(self.roi)}


def _finite(roi: dict, *names) -> list:
    out = []
    for n in names:
        try:
            v = float(roi[n])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"ROI field {n!r} is missing or not a number") from None
        if not math.isfinite(v):
            raise ValueError(f"ROI field {n!r} is not finite")
        out.append(v)
    return out


def _validate_rect(roi: dict) -> dict:
    x0, x1, y0, y1 = _finite(roi, "x_start", "x_end", "y_start", "y_end")
    x0, x1, y0, y1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        raise ValueError("ROI rectangle has no area")
    return {"x_start": x0, "x_end": x1, "y_start": y0, "y_end": y1}


@register_model
class SolidBoxModel(PatternModel):
    ROI_KIND = "rect"


@register_model
class OpenBoxModel(PatternModel):
    ROI_KIND = "rect"


@register_model
class StairCutModel(PatternModel):
    ROI_KIND = "rect"

    def step_rects(self) -> list:
        """The ROI split into ``steps`` equal strips along ``direction`` (empty without a ROI)."""
        r = self.roi
        if not r:
            return []
        n = int(self.parameters.get("steps", 5))
        d = self.parameters.get("direction", "down")
        out = []
        for i in range(n):
            if d in ("down", "up"):
                h = (r["y_end"] - r["y_start"]) / n
                y0 = r["y_start"] + i * h
                out.append({**r, "y_start": y0, "y_end": y0 + h})
            else:
                w = (r["x_end"] - r["x_start"]) / n
                x0 = r["x_start"] + i * w
                out.append({**r, "x_start": x0, "x_end": x0 + w})
        if d in ("up", "left"):
            out.reverse()
        return out


@register_model
class CleaningLineModel(PatternModel):
    ROI_KIND = "rect"

    def lines(self) -> list:
        """Parallel line segments ((x0, y0), (x1, y1)) across the ROI at ``spacing``."""
        r = self.roi
        spacing = float(self.parameters.get("spacing", 0) or 0)
        if not r or spacing <= 0:
            return []
        out = []
        if self.parameters.get("orientation", "horizontal") == "horizontal":
            y = r["y_start"] + spacing / 2
            while y < r["y_end"]:
                out.append(((r["x_start"], y), (r["x_end"], y)))
                y += spacing
        else:
            x = r["x_start"] + spacing / 2
            while x < r["x_end"]:
                out.append(((x, r["y_start"]), (x, r["y_end"])))
                x += spacing
        return out


@register_model
class CircleModel(PatternModel):
    """A solid circular area, including its centre."""

    ROI_KIND = "circle"

    def validate_roi(self, roi: dict) -> dict:
        cx, cy, radius = _finite(roi, "cx", "cy", "radius")
        if radius <= 0:
            raise ValueError("Circle needs a positive radius")
        return {"cx": cx, "cy": cy, "radius": radius}

    def area(self) -> float:
        return 0.0 if not self.roi else math.pi * self.roi["radius"] ** 2

    def contains(self, x: float, y: float) -> bool:
        r = self.roi
        return bool(r and math.hypot(x - r["cx"], y - r["cy"]) <= r["radius"])


@register_model
class RingModel(PatternModel):
    """Two circles with the same centre; the pattern is the area between them."""

    ROI_KIND = "ring"

    def validate_roi(self, roi: dict) -> dict:
        cx, cy, ri, ro = _finite(roi, "cx", "cy", "r_inner", "r_outer")
        ri, ro = min(ri, ro), max(ri, ro)
        if ro <= 0 or ro - ri <= 0:
            raise ValueError("Ring needs two different positive radii")
        return {"cx": cx, "cy": cy, "r_inner": max(0.0, ri), "r_outer": ro}

    def area(self) -> float:
        r = self.roi
        return 0.0 if not r else math.pi * (r["r_outer"] ** 2 - r["r_inner"] ** 2)

    def contains(self, x: float, y: float) -> bool:
        r = self.roi
        if not r:
            return False
        d = math.hypot(x - r["cx"], y - r["cy"])
        return r["r_inner"] <= d <= r["r_outer"]


@register_model
class FreeHandModel(PatternModel):
    ROI_KIND = "polygon"

    def validate_roi(self, roi: dict) -> dict:
        pts = roi.get("points") if isinstance(roi, dict) else None
        if not isinstance(pts, (list, tuple)):
            raise ValueError("ROI polygon needs a list of points")
        clean = []
        for p in pts:
            try:
                x, y = float(p[0]), float(p[1])
            except (TypeError, ValueError, IndexError):
                raise ValueError("ROI polygon point is not an (x, y) pair") from None
            if not (math.isfinite(x) and math.isfinite(y)):
                raise ValueError("ROI polygon point is not finite")
            if not clean or (x, y) != tuple(clean[-1]):
                clean.append([x, y])
        if len(clean) > 1 and clean[0] == clean[-1]:
            clean.pop()
        if len(clean) < 3 or _shoelace(clean) == 0:
            raise ValueError("ROI polygon has no area")
        return {"points": clean}

    def area(self) -> float:
        return 0.0 if not self.roi else abs(_shoelace(self.roi["points"]))

    def contains(self, x: float, y: float) -> bool:
        r = self.roi
        if not r:
            return False
        inside = False
        pts = r["points"]
        j = len(pts) - 1
        for i in range(len(pts)):
            xi, yi = pts[i]
            xj, yj = pts[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return inside


def _shoelace(pts) -> float:
    s = 0.0
    for i, (x0, y0) in enumerate(pts):
        x1, y1 = pts[(i + 1) % len(pts)]
        s += x0 * y1 - x1 * y0
    return s / 2.0
