"""Canvas drawing tool for the Processing tab.

Attached to ``ROIEditorCanvas.pattern_tool``. While ``enabled`` (Processing tab
visible) it takes over the canvas mouse: the operator draws the ROI of the
selected pattern model, and every drawn pattern ROI is painted on the image.

  rect     drag a rectangle
  ring     drag from the centre to the outer circle, then click to place the
           inner circle; both circles share the centre, the pattern is the area
           between them
  polygon  press-drag-release a free-hand outline

All shapes are stored in world coordinates (``core.geometry``), radii are world
lengths, so a ring stays a true circle whatever the image aspect.
"""
from __future__ import annotations

import math
from typing import Optional

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QPainterPath, QPen, QPolygonF

from ..core.geometry import image_world_bounds, viewport_bounds, world_to_canvas_x, world_to_canvas_y
from ..processing.models import CleaningLineModel, OpenBoxModel, StairCutModel

DRAG_THRESHOLD = 8          # canvas px (same as the ROI rectangle tool)
ACTIVE_COLOR = "#ffd400"
OTHER_COLOR = "#4cc9f0"


class PatternTool:
    def __init__(self, panel):
        self.panel = panel          # needs .active_model() and .models
        self.enabled = False
        self.reset()

    # ------------------------------------------------------------------ state
    def reset(self) -> None:
        self.rect_start: Optional[tuple] = None
        self.rect_draft: Optional[dict] = None
        self.ring_drag = False
        self.ring_stage = 0                     # 0 idle/dragging, 1 waiting for the inner-circle click
        self.ring_center: Optional[tuple] = None        # world
        self.ring_center_canvas: Optional[tuple] = None
        self.ring_outer = 0.0                   # world length
        self.ring_inner = 0.0
        self.poly: Optional[list] = None        # canvas points

    def cancel(self) -> None:
        self.reset()

    def set_enabled(self, on: bool) -> None:
        if on != self.enabled:
            self.enabled = on
            self.reset()

    @property
    def drawing(self) -> bool:
        return bool(self.rect_start or self.ring_drag or self.ring_stage or self.poly)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _scales(canvas) -> tuple:
        """Canvas px per world unit along x and y."""
        roi = canvas.roi
        ib, b = image_world_bounds(roi), viewport_bounds(roi)
        return (abs(world_to_canvas_x(1.0, ib, b) - world_to_canvas_x(0.0, ib, b)),
                abs(world_to_canvas_y(1.0, ib, b) - world_to_canvas_y(0.0, ib, b)))

    @staticmethod
    def _to_canvas(canvas, wx: float, wy: float) -> QPointF:
        roi = canvas.roi
        ib, b = image_world_bounds(roi), viewport_bounds(roi)
        return QPointF(world_to_canvas_x(wx, ib, b), world_to_canvas_y(wy, ib, b))

    def _rect_canvas(self, canvas, r: dict) -> QRectF:
        a = self._to_canvas(canvas, r["x_start"], r["y_start"])
        b = self._to_canvas(canvas, r["x_end"], r["y_end"])
        return QRectF(a, b).normalized()

    @staticmethod
    def _commit(model, roi: dict) -> None:
        try:
            model.set_roi(roi)
        except ValueError:
            pass                                  # degenerate shape: keep the previous ROI

    # ------------------------------------------------------------------ mouse (return value unused: tool owns the canvas)
    def mouse_press(self, canvas, e) -> None:
        if e.button() == Qt.MouseButton.RightButton:
            self.cancel()
            canvas.view.update()
            return
        if e.button() != Qt.MouseButton.LeftButton or canvas.disabled:
            return
        model = self.panel.active_model()
        if model is None:
            return
        canvas.view.setFocus()
        pt = canvas._canvas_point(e.position())
        kind = model.ROI_KIND
        if kind == "rect":
            self.rect_start, self.rect_draft = pt, None
        elif kind == "ring":
            if self.ring_stage == 1:
                w = canvas._to_dut(pt)
                inner = min(math.hypot(w[0] - self.ring_center[0], w[1] - self.ring_center[1]),
                            self.ring_outer * 0.999)
                self._commit(model, {"cx": self.ring_center[0], "cy": self.ring_center[1],
                                     "r_inner": inner, "r_outer": self.ring_outer})
                self.reset()
            else:
                self.reset()
                self.ring_drag = True
                self.ring_center = canvas._to_dut(pt)
                self.ring_center_canvas = pt
        else:
            self.poly = [pt]
        canvas.view.update()

    def mouse_move(self, canvas, e) -> None:
        model = self.panel.active_model()
        if model is None or canvas.disabled:
            return
        pt = canvas._canvas_point(e.position())
        kind = model.ROI_KIND
        if kind == "rect" and self.rect_start is not None:
            if max(abs(pt[0] - self.rect_start[0]), abs(pt[1] - self.rect_start[1])) >= DRAG_THRESHOLD:
                self.rect_draft = canvas._rect_from_points(self.rect_start, pt)
        elif kind == "ring" and (self.ring_drag or self.ring_stage == 1):
            w = canvas._to_dut(pt)
            d = math.hypot(w[0] - self.ring_center[0], w[1] - self.ring_center[1])
            if self.ring_drag:
                self.ring_outer = d
            else:
                self.ring_inner = min(d, self.ring_outer * 0.999)
        elif kind == "polygon" and self.poly is not None:
            spacing = float(model.parameters.get("smoothing", 2.0) or 0)
            if math.hypot(pt[0] - self.poly[-1][0], pt[1] - self.poly[-1][1]) >= max(spacing, 0.5):
                self.poly.append(pt)
        else:
            return
        canvas.view.update()

    def mouse_release(self, canvas, e) -> None:
        model = self.panel.active_model()
        if model is None or e.button() != Qt.MouseButton.LeftButton:
            return
        kind = model.ROI_KIND
        if kind == "rect" and self.rect_start is not None:
            if self.rect_draft is not None:
                self._commit(model, self.rect_draft)
            self.rect_start, self.rect_draft = None, None
        elif kind == "ring" and self.ring_drag:
            self.ring_drag = False
            pt = canvas._canvas_point(e.position())
            moved = math.hypot(pt[0] - self.ring_center_canvas[0], pt[1] - self.ring_center_canvas[1])
            if moved >= DRAG_THRESHOLD and self.ring_outer > 0:
                self.ring_stage = 1
                self.ring_inner = self.ring_outer * 0.5
            else:
                self.reset()
        elif kind == "polygon" and self.poly is not None:
            if len(self.poly) >= 3:
                self._commit(model, {"points": [list(canvas._to_dut(p)) for p in self.poly]})
            self.poly = None
        canvas.view.update()

    def mouse_leave(self, canvas) -> None:
        # a pending inner-circle placement survives the cursor leaving; drags do not
        self.rect_start, self.rect_draft, self.poly, self.ring_drag = None, None, None, False
        if self.ring_stage == 0:
            self.ring_center = None
        canvas.view.update()

    def key_press(self, canvas, e) -> None:
        if e.key() == Qt.Key.Key_Escape and self.drawing:
            self.cancel()
            canvas.view.update()

    # ------------------------------------------------------------------ painting (640 x 640 canvas space)
    def paint(self, p, canvas) -> None:
        if not self.enabled:
            return
        active = self.panel.active_model()
        for model in self.panel.models.values():
            if model.roi:
                self._paint_roi(p, canvas, model, model.roi, model is active, draft=False)
        if active is None:
            return
        kind = active.ROI_KIND
        if kind == "rect" and self.rect_draft:
            self._paint_roi(p, canvas, active, self.rect_draft, True, draft=True)
        elif kind == "ring" and (self.ring_drag or self.ring_stage == 1) and self.ring_outer > 0:
            self._paint_roi(p, canvas, active, {"cx": self.ring_center[0], "cy": self.ring_center[1],
                                                "r_inner": self.ring_inner if self.ring_stage == 1 else 0.0,
                                                "r_outer": self.ring_outer}, True, draft=True)
        elif kind == "polygon" and self.poly and len(self.poly) > 1:
            pen = QPen(QColor(ACTIVE_COLOR), 1.2)
            pen.setStyle(Qt.PenStyle.DashLine)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawPolyline(QPolygonF([QPointF(*q) for q in self.poly]))

    def _paint_roi(self, p, canvas, model, roi: dict, active: bool, *, draft: bool) -> None:
        col = QColor(ACTIVE_COLOR if active else OTHER_COLOR)
        pen = QPen(col, 1.3 if active else 0.9)
        if draft:
            pen.setStyle(Qt.PenStyle.DashLine)
        fill = QColor(col)
        fill.setAlpha(55 if active else 35)
        p.setPen(pen)
        p.setBrush(fill)
        kind = model.ROI_KIND
        if kind == "rect":
            self._paint_rect_model(p, canvas, model, roi, col, pen, fill)
        elif kind == "ring":
            c = self._to_canvas(canvas, roi["cx"], roi["cy"])
            sx, sy = self._scales(canvas)
            path = QPainterPath()
            path.setFillRule(Qt.FillRule.OddEvenFill)
            path.addEllipse(c, roi["r_outer"] * sx, roi["r_outer"] * sy)
            path.addEllipse(c, roi["r_inner"] * sx, roi["r_inner"] * sy)
            p.drawPath(path)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawEllipse(c, roi["r_outer"] * sx, roi["r_outer"] * sy)
            p.drawEllipse(c, roi["r_inner"] * sx, roi["r_inner"] * sy)
        else:
            poly = QPolygonF([self._to_canvas(canvas, x, y) for x, y in roi["points"]])
            p.drawPolygon(poly)

    def _paint_rect_model(self, p, canvas, model, roi, col, pen, fill) -> None:
        rect = self._rect_canvas(canvas, roi)
        if isinstance(model, OpenBoxModel):
            sx, sy = self._scales(canvas)
            w = float(model.parameters.get("lineWidth", 0) or 0)
            inner = rect.adjusted(w * sx, w * sy, -w * sx, -w * sy)
            path = QPainterPath()
            path.setFillRule(Qt.FillRule.OddEvenFill)
            path.addRect(rect)
            if inner.width() > 0 and inner.height() > 0:
                path.addRect(inner)
            p.drawPath(path)
        elif isinstance(model, StairCutModel):
            steps = StairCutModel.step_rects(_RectView(model, roi))
            n = max(1, len(steps))
            for i, r in enumerate(steps):
                f = QColor(col)
                f.setAlpha(25 + int(85 * (i + 1) / n))
                p.setBrush(f)
                p.drawRect(self._rect_canvas(canvas, r))
        elif isinstance(model, CleaningLineModel):
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRect(rect)
            line_pen = QPen(col, 0.7)
            p.setPen(line_pen)
            for a, b in CleaningLineModel.lines(_RectView(model, roi)):
                p.drawLine(self._to_canvas(canvas, *a), self._to_canvas(canvas, *b))
            p.setPen(pen)
        else:
            p.drawRect(rect)


class _RectView:
    """A model's parameters with a different ROI (used to preview a draft without touching the model)."""

    def __init__(self, model, roi: dict):
        self.parameters = model.parameters
        self.roi = roi
