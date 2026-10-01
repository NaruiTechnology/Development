"""ROI editor (controls + canvas), ROI calibration card and ROI preview.

Ports ROIEditor.tsx, ROICalibrationCard.tsx and ROIScanPreview.tsx. All
geometry runs in the web's 640 x 640 ROI canvas space (core.geometry) and is
scaled to the widget, so selections, calibration handles and world
coordinates are identical to the browser.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Callable, Optional

import numpy as np
from PyQt6.QtCore import QPointF, QRectF, Qt, QTimer
from PyQt6.QtGui import QColor, QFont, QFontMetricsF, QImage, QPainter, QPainterPath, QPen, QPolygonF
from PyQt6.QtWidgets import (
    QComboBox, QDialog, QFileDialog, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QProgressBar,
    QScrollArea, QSizePolicy, QToolButton, QToolTip, QVBoxLayout, QWidget,
)

from ..core.bitmap_vector import clear_bitmap_selection_cache
from ..core.display_levels import (
    AUTO_LEVELS, ROI_GRAY_FULL_SCALE, ROI_GRAY_SAMPLE_SCALE, LevelSetting, ResolvedLevels, apply_gray_lut,
    gray_histogram, gray_level_lut, is_identity_lut, resolve_roi_levels,
)
from ..core.geometry import (
    ROI_CANVAS_EDGE, ROI_VIEWPORT_MIN_SPAN, canvas_point_to_world, clamp_canvas_point_to_viewport,
    clamp_viewport_coordinate, image_world_bounds, viewport_bounds, world_to_canvas_x, world_to_canvas_y,
)
from ..core.helpers import vector_scan_sample_count, vector_scan_sample_pixel
from ..core.jsmath import js_number, js_round, to_fixed
from ..core.state import DimensionCalibrationValues
from ..i18n import fmt, t
from . import theme
from .common import NumberStepper, button, hbox, icon, label, set_prop
from .imaging import png_to_qimage, qimage_to_png, qimage_to_rgba, rgba_to_qimage
from .level_wedge import LevelWedge
from .panel import Panel

EDGE = ROI_CANVAS_EDGE
UNITS = (("um", "μm"), ("mm", "mm"), ("cm", "cm"), ("nm", "nm"))
ROI_DRAG_THRESHOLD = 8
ROI_CORNER_DRAG_THRESHOLD = 18
LEVEL_KEY = "roi"


def unit_label(value: str) -> str:
    return dict(UNITS).get(value, value)


def f1(v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "0.0"
    return to_fixed(v, 1) if math.isfinite(v) else "0.0"


def fmt_point(p) -> str:
    return f"({f1(p[0])}, {f1(p[1])})"


def has_at_most_one_decimal(text: str) -> bool:
    return re.fullmatch(r"-?\d+(?:\.\d)?", text.strip()) is not None


def fmt_dim(value: float, unit: str) -> str:
    return f"{f1(value)} {unit_label(unit)}"


# ---------------------------------------------------------------------------- image cache

_RAW_CACHE: dict = {}


def roi_raw_image(png: Optional[bytes]):
    """(rgba 640x640x4, histogram) of the image drawn at ROI canvas size (measureGrayImage)."""
    if not png:
        return None, None
    key = hash(png)
    hit = _RAW_CACHE.get(key)
    if hit is not None:
        return hit
    img = png_to_qimage(png)
    if img is None:
        return None, None
    scaled = img.convertToFormat(QImage.Format.Format_RGBA8888).scaled(
        EDGE, EDGE, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)
    rgba = qimage_to_rgba(scaled)
    hist = gray_histogram(rgba)
    if len(_RAW_CACHE) > 8:
        _RAW_CACHE.clear()
    _RAW_CACHE[key] = (rgba, hist)
    return rgba, hist


def leveled(rgba: np.ndarray, levels: ResolvedLevels) -> np.ndarray:
    lut = gray_level_lut(levels)
    if is_identity_lut(lut):
        return rgba
    out = rgba.copy()
    apply_gray_lut(out, lut)
    return out


def roi_image_source(roi, background: Optional[bytes]) -> Optional[bytes]:
    if roi.scanImageDataUrl is not None:
        return roi.scanImageDataUrl
    if roi.imageKind == "lastScan":
        return background or roi.imageDataUrl
    return roi.imageDataUrl or background


def composite_on(png: bytes, fill: str) -> Optional[bytes]:
    """``imageToDataUrl``: draw the image over an opaque fill, keep its natural size."""
    img = png_to_qimage(png)
    if img is None or img.width() <= 0:
        return None
    out = QImage(img.size(), QImage.Format.Format_ARGB32)
    out.fill(QColor(fill))
    p = QPainter(out)
    p.drawImage(0, 0, img)
    p.end()
    return qimage_to_png(out)


def tint(rgb: np.ndarray, hl, opacity: float) -> np.ndarray:
    x = rgb.astype(np.float64) * (1 - opacity) + np.array(hl, dtype=np.float64) * opacity
    f = np.floor(x)
    return np.clip(f + ((x - f) >= 0.5), 0, 255).astype(np.uint8)


def point_array_bounds(points: np.ndarray):
    if points is None or points.size == 0:
        return 0.0, 1.0, 0.0, 1.0
    return float(points[:, 0].min()), float(points[:, 0].max()), float(points[:, 1].min()), float(points[:, 1].max())


# ---------------------------------------------------------------------------- canvas view

class ROICanvasView(QWidget):
    def __init__(self, editor: "ROIEditorCanvas"):
        super().__init__(editor)
        self.ed = editor
        self.setMinimumSize(360, 360)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    def hasHeightForWidth(self):  # noqa: N802
        return True

    def heightForWidth(self, w):  # noqa: N802
        return w

    def rect640(self) -> QRectF:
        side = min(self.width(), self.height())
        return QRectF((self.width() - side) / 2, 0, side, side)

    def to_canvas(self, pos) -> tuple:
        r = self.rect640()
        k = EDGE / r.width() if r.width() else 1
        return ((pos.x() - r.left()) * k, (pos.y() - r.top()) * k)

    def paintEvent(self, event):  # noqa: N802
        self.ed.paint(self)

    def mousePressEvent(self, e):  # noqa: N802
        self.ed.mouse_press(e)

    def mouseMoveEvent(self, e):  # noqa: N802
        self.ed.mouse_move(e)

    def mouseReleaseEvent(self, e):  # noqa: N802
        self.ed.mouse_release(e)

    def leaveEvent(self, e):  # noqa: N802
        self.ed.mouse_leave()

    def keyReleaseEvent(self, e):  # noqa: N802
        if e.key() == Qt.Key.Key_Control:
            self.ed.ctrl_released()
        super().keyReleaseEvent(e)


class ROIEditorCanvas(Panel):
    """``<ROIEditor variant="canvas">``."""

    TOPICS = frozenset({"scan", "roi", "panel", "frame:vector", "progress", "frame-complete", "gray", "theme"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.background: Optional[bytes] = None
        self.gray_selection = None
        self.gray_skipped = None
        self.live_vector_preview = False
        self.hide_selection_overlay = False
        self._suppressed_background: Optional[bytes] = None
        self._promoted_background: Optional[bytes] = None
        self._image_reset = False
        self.draft: Optional[dict] = None
        self.drag_start: Optional[tuple] = None
        self.resize_corner: Optional[str] = None
        self.resize_selection: Optional[dict] = None
        self.resize_trace: Optional[tuple] = None
        self.ctrl_cursor: Optional[tuple] = None
        self.calibration_line: Optional[list] = None
        self.active_handle: Optional[str] = None
        self._captured_key = None
        self._blink = True
        self._live_overlay: Optional[np.ndarray] = None
        self._raw: Optional[np.ndarray] = None
        self._hist = None
        self._display: Optional[QImage] = None
        self._mask: Optional[QImage] = None

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        col = QVBoxLayout()
        self.view = ROICanvasView(self)
        col.addWidget(self.view, 1)
        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setRange(0, 1000)
        self.progress.setFixedHeight(8)
        self.meta = QLabel()
        self.meta.setTextFormat(Qt.TextFormat.RichText)
        self.meta.setProperty("role", "dim")
        self.meta.setWordWrap(True)
        col.addWidget(self.progress)
        col.addWidget(self.meta)
        lay.addLayout(col, 1)
        self.wedge = LevelWedge(full_scale=ROI_GRAY_FULL_SCALE, code_divisor=ROI_GRAY_SAMPLE_SCALE)
        self.wedge.changed.connect(lambda lv: self._set_levels(LevelSetting("manual", lv.low, lv.high)))
        self.wedge.auto_requested.connect(lambda: self._set_levels(AUTO_LEVELS))
        lay.addWidget(self.wedge)
        self._blink_timer = QTimer(self)
        self._blink_timer.timeout.connect(self._tick_blink)
        self._blink_timer.start(550)
        self.refresh()

    # ------------------------------------------------------------------ inputs from the window
    def configure(self, *, background: Optional[bytes], gray_selection, gray_skipped, live_vector_preview: bool,
                  hide_selection_overlay: bool) -> None:
        self.background = background
        self.gray_selection = gray_selection
        self.gray_skipped = gray_skipped
        self.live_vector_preview = live_vector_preview
        self.hide_selection_overlay = hide_selection_overlay
        self.refresh()

    def reset_gray_selection(self) -> None:
        """``graySelectionResetToken``: drop the cached image and live overlay."""
        self._captured_key = None
        self._live_overlay = None
        self._image_reset = True
        self.refresh()
        self._image_reset = False

    def clear_suppression(self) -> None:
        self._suppressed_background = None

    def suppress_background(self, png) -> None:
        self._suppressed_background = png

    # ------------------------------------------------------------------ derived
    @property
    def roi(self):
        return self.ctl.scan.roi

    def _background_source(self) -> Optional[bytes]:
        bg = self.background
        return bg if bg and bg is not self._suppressed_background and bg != self._suppressed_background else None

    def _image_source(self) -> Optional[bytes]:
        return None if self._image_reset else roi_image_source(self.roi, self._background_source())

    def _levels(self):
        setting = self.ctl.level_memory.get(LEVEL_KEY, AUTO_LEVELS)
        return setting, resolve_roi_levels(self._hist, setting)

    def _set_levels(self, setting: LevelSetting) -> None:
        self.ctl.level_memory[LEVEL_KEY] = setting
        self.ctl.notify("roi-levels")
        self.refresh()

    def _tick_blink(self) -> None:
        if self.roi.calibration_enabled:
            self._blink = not self._blink
            self.view.update()

    # ------------------------------------------------------------------ refresh (draw* effects)
    def refresh(self) -> None:
        roi = self.roi
        src = self._image_source()
        rgba, hist = roi_raw_image(src)
        self._raw, self._hist = rgba, hist
        # promote a last-scan background into ROI state (so gray tools work on it)
        bg = self._background_source()
        if (rgba is not None and bg is not None and src is bg and roi.scanImageDataUrl is None
                and self._promoted_background is not bg and self.ctl.scan.phase != "running"):
            promoted = composite_on(bg, theme.current().bg_elev)
            if promoted:
                self._promoted_background = bg
                self.ctl.scan.update_roi({"imageName": t("roi.imageName.lastScan"), "imageDataUrl": promoted,
                                          "imageKind": "lastScan"})
                QTimer.singleShot(0, lambda: self.ctl.notify("roi"))
        setting, levels = self._levels()
        if rgba is not None:
            self._display = rgba_to_qimage(leveled(rgba, levels))
        else:
            self._display = None
        self._mask = self._build_mask(levels)
        self._update_live_overlay()
        self._maybe_capture_completed()
        self.wedge.set_state(hist, levels, setting.mode == "auto",
                             not hist or hist.total <= 0 or roi.calibration_enabled)
        self._update_meta()
        self.view.update()

    def _active_selection(self):
        return self.draft or self.roi.selection

    def _sel_canvas_rect(self, sel) -> tuple:
        roi = self.roi
        b = viewport_bounds(roi)
        ib = image_world_bounds(roi)
        return (world_to_canvas_x(sel["x_start"], ib, b), world_to_canvas_x(sel["x_end"], ib, b),
                world_to_canvas_y(sel["y_start"], ib, b), world_to_canvas_y(sel["y_end"], ib, b))

    def _build_mask(self, levels) -> Optional[QImage]:
        """``drawHighlightMask``: tint the selected gray interval inside the ROI selection."""
        roi = self.roi
        sel = self._active_selection()
        if self._raw is None or self.gray_selection is None or not sel or roi.calibration_enabled:
            return None
        x0, x1, y0, y1 = self._sel_canvas_rect(sel)
        left, top = max(0, min(x0, x1)), max(0, min(y0, y1))
        width, height = max(0, abs(x1 - x0)), max(0, abs(y1 - y0))
        if width <= 0 or height <= 0:
            return None
        # getImageData(left, top, w, h) truncates fractional coordinates
        l, tp = int(left), int(top)
        r_, b_ = min(EDGE, l + max(1, int(round(width)))), min(EDGE, tp + max(1, int(round(height))))
        region = self._raw[tp:b_, l:r_].copy()
        out = np.zeros((EDGE, EDGE, 4), dtype=np.uint8)
        a = region[..., 3]
        v = region[..., 0]
        lo, hi = self.gray_selection
        selected = (a != 0) & (v >= lo) & (v <= hi)
        is_gray = (region[..., 0] == region[..., 1]) & (region[..., 0] == region[..., 2])
        lut = gray_level_lut(levels)
        shown = lut[v]
        rgb = region[..., :3].copy()
        rgb[is_gray] = np.stack([shown, shown, shown], axis=-1)[is_gray]
        spot = self.gray_skipped is False
        hl, op = ((255, 236, 96), 0.96) if spot else ((255, 255, 72), 0.78)
        tinted = tint(rgb, hl, op)
        region_out = np.zeros_like(region)
        region_out[..., :3] = tinted
        region_out[..., 3] = js_round(255 * op)
        region_out[~selected] = 0
        out[tp:b_, l:r_] = region_out
        return rgba_to_qimage(out)

    def _live_points(self):
        """Beam-on canvas points of the running gray-filter custom vector (drawLiveVectorOverlay)."""
        roi = self.roi
        v = self.ctl.engine.vector
        if (not self.live_vector_preview or v.pattern != "custom" or v.custom_points is None or not roi.selection
                or self.gray_skipped is None or self.gray_selection is None):
            return None
        limit = min(v.cursor, v.custom_points.shape[0], v.custom_count)
        if limit <= 0:
            return np.zeros((0, 2), dtype=np.int64)
        pts = v.custom_points
        x0b, x1b, y0b, y1b = point_array_bounds(pts)
        sel = roi.selection
        wxs = max(1e-6, sel["x_end"] - sel["x_start"])
        wys = max(1e-6, sel["y_end"] - sel["y_start"])
        pxs = max(1e-6, x1b - x0b)
        pys = max(1e-6, y1b - y0b)
        xs = pts[:limit, 0].astype(np.int64).astype(np.float64)
        ys = pts[:limit, 1].astype(np.int64).astype(np.float64)
        wx = sel["x_start"] + ((xs - x0b) / pxs) * wxs
        wy = sel["y_start"] + ((ys - y0b) / pys) * wys
        ib = image_world_bounds(roi)
        b = viewport_bounds(roi)

        def norm(val, s, e):
            if s == e:
                return np.zeros_like(val)
            return np.clip((val - s) / (e - s), 0, 1)
        cx = b.left + norm(wx, ib["x_origin"], ib["x_end"]) * b.width
        cy = b.top + norm(wy, ib["y_origin"], ib["y_end"]) * b.height
        cx = np.floor(cx + 0.5).astype(np.int64)
        cy = np.floor(cy + 0.5).astype(np.int64)
        ok = (cx >= 0) & (cx < EDGE) & (cy >= 0) & (cy < EDGE)
        cx, cy = cx[ok], cy[ok]
        src = self._raw if self._raw is not None else None
        values = src[cy, cx, 0].astype(np.int64) if src is not None else np.zeros(cx.size, dtype=np.int64)
        lo, hi = self.gray_selection
        selected = (values >= lo) & (values <= hi)
        beam_on = selected if self.gray_skipped is False else ~selected
        return np.stack([cx[beam_on], cy[beam_on]], axis=1)

    def _update_live_overlay(self) -> None:
        keep = self.roi.scanImageDataUrl is not None and self.ctl.scan.phase == "completed"
        pts = self._live_points()
        if pts is None or pts.size == 0:
            if not keep:
                self._live_overlay = None
            return
        img = QImage(EDGE, EDGE, QImage.Format.Format_ARGB32_Premultiplied)
        img.fill(Qt.GlobalColor.transparent)
        p = QPainter(img)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = max(1.4, min(2.4, EDGE / 1024))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(100, 0, 0, int(0.5732 * 255)))
        for x, y in pts:
            p.drawEllipse(QPointF(x + 0.5, y + 0.5), r, r)
        lx, ly = pts[-1]
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.setPen(QPen(QColor(246, 8, 8, int(0.44 * 255)), 0.75))
        p.drawEllipse(QPointF(lx + 0.5, ly + 0.5), r + 0.8, r + 0.8)
        p.end()
        self._live_overlay = img

    def _maybe_capture_completed(self) -> None:
        v = self.ctl.engine.vector
        phase = self.ctl.scan.phase
        if (not self.live_vector_preview or phase != "completed" or v.pattern != "custom" or v.custom_count <= 0
                or not v.retain_feedback_on_complete or self.gray_selection is None or self.gray_skipped is None):
            if phase != "completed":
                self._captured_key = None
            return
        key = (v.custom_count, self.gray_selection[0], self.gray_selection[1], str(self.gray_skipped))
        if self._captured_key == key:
            return
        self._captured_key = key
        base = rgba_to_qimage(self._raw) if self._raw is not None else self._display
        composed = QImage(EDGE, EDGE, QImage.Format.Format_ARGB32)
        composed.fill(Qt.GlobalColor.transparent)
        p = QPainter(composed)
        if base is not None:
            p.drawImage(0, 0, base)
        else:
            p.fillRect(0, 0, EDGE, EDGE, QColor(theme.current().bg_elev))
        if self._mask is not None:
            p.drawImage(0, 0, self._mask)
        if self._live_overlay is not None:
            p.drawImage(0, 0, self._live_overlay)
        p.end()
        png = qimage_to_png(composed)
        QTimer.singleShot(0, lambda: (self.ctl.scan.update_roi({"scanImageDataUrl": png}), self.ctl.notify("roi")))

    def _update_meta(self) -> None:
        show = self.live_vector_preview
        self.progress.setVisible(show)
        self.meta.setVisible(show)
        if not show:
            return
        v = self.ctl.engine.vector
        s = self.ctl.scan
        samples = min(v.cursor, v.custom_count) if (v.pattern == "custom" and v.custom_count > 0) else v.cursor
        total = v.custom_count if v.pattern == "custom" else vector_scan_sample_count(v.edge, v.scan_path)
        pct = min(100.0, samples / max(1, total) * 100)
        self.progress.setValue(int(pct * 10))
        parts = [f"{t('canvas.meta.phase')} <b>{t('phase.' + s.phase)}</b>",
                 f"{t('canvas.meta.chunks')} <b>{fmt(round(s.chunksReceived))}</b>",
                 f"{t('canvas.meta.bytes')} <b>{fmt(round(s.bytesReceived))}</b>",
                 f"{t('canvas.meta.samples')} <b>{fmt(samples)}"
                 + (f" / {fmt(v.custom_count)}" if v.pattern == "custom" and v.custom_count > 0 else "") + "</b>",
                 f"{t('canvas.meta.progress')} <b>{js_round(pct)}%</b>"]
        self.meta.setText(" &nbsp;·&nbsp; ".join(parts))

    # ------------------------------------------------------------------ painting
    def paint(self, w: ROICanvasView) -> None:
        roi = self.roi
        tk = theme.current()
        p = QPainter(w)
        R = w.rect640()
        k = R.width() / EDGE
        p.fillRect(R, QColor(tk.bg_elev))
        p.save()
        p.translate(R.left(), R.top())
        p.scale(k, k)
        if self._display is not None:
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
            p.drawImage(QRectF(0, 0, EDGE, EDGE), self._display)
        if self._mask is not None:
            p.drawImage(0, 0, self._mask)
        if self._live_overlay is not None:
            p.drawImage(0, 0, self._live_overlay)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self._paint_scan_path(p)
        if roi.calibration_enabled:
            self._paint_calibration_viewport(p)
        else:
            self._paint_scale(p)
        sel = None if (roi.calibration_enabled or self.hide_selection_overlay) else roi.selection
        if sel:
            if self.resize_trace and self.resize_selection:
                self._paint_trace(p, self.resize_selection)
            elif self.draft:
                self._paint_selection(p, self.draft)
            else:
                self._paint_selection(p, sel)
        p.restore()
        self._paint_overlays(p, R, k)
        p.end()

    def _paint_selection(self, p: QPainter, sel) -> None:
        x0, x1, y0, y1 = self._sel_canvas_rect(sel)
        p.setPen(QPen(QColor("#ff2d2d"), 0.75))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(QRectF(x0, y0, x1 - x0, y1 - y0))

    def _paint_trace(self, p: QPainter, sel) -> None:
        roi = self.roi
        b = viewport_bounds(roi)
        ib = image_world_bounds(roi)
        corner, point = self.resize_trace
        table = {
            "top-left": ((sel["x_start"], sel["y_start"]), ((sel["x_end"], sel["y_start"]), (sel["x_start"], sel["y_end"]))),
            "top-right": ((sel["x_end"], sel["y_start"]), ((sel["x_start"], sel["y_start"]), (sel["x_end"], sel["y_end"]))),
            "bottom-left": ((sel["x_start"], sel["y_end"]), ((sel["x_start"], sel["y_start"]), (sel["x_end"], sel["y_end"]))),
            "bottom-right": ((sel["x_end"], sel["y_end"]), ((sel["x_end"], sel["y_start"]), (sel["x_start"], sel["y_end"]))),
        }[corner]

        def c(pt):
            return QPointF(world_to_canvas_x(pt[0], ib, b), world_to_canvas_y(pt[1], ib, b))
        pen = QPen(QColor(124, 255, 107, 242), 1.25)
        pen.setDashPattern([4 / 1.25, 3 / 1.25])
        p.setPen(pen)
        tp = QPointF(*point)
        p.drawLine(c(table[0]), tp)
        p.drawLine(tp, c(table[1][0]))
        p.drawLine(tp, c(table[1][1]))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(124, 255, 107, 242))
        p.drawEllipse(tp, 3, 3)

    def _paint_scale(self, p: QPainter) -> None:
        roi = self.roi
        b = viewport_bounds(roi)
        major, minor_per = 4, 5
        ticks = major * minor_per
        p.setPen(QPen(QColor(95, 184, 255, 230), 1))
        p.drawLine(QPointF(b.left, b.top), QPointF(b.right, b.top))
        p.drawLine(QPointF(b.left, b.top), QPointF(b.left, b.bottom))
        for i in range(ticks + 1):
            is_major = i % minor_per == 0
            u = i / ticks
            x = b.left + b.width * u
            y = b.top + b.height * u
            ln = 10 if is_major else 5
            p.setPen(QPen(QColor(95, 184, 255, 230), 1))
            p.drawLine(QPointF(x, b.top), QPointF(x, b.top + ln))
            p.drawLine(QPointF(b.left, y), QPointF(b.left + ln, y))
            if roi.show_grid and is_major:
                p.fillRect(QRectF(x - 0.5, b.top, 1, b.height), QColor(95, 184, 255, 36))
                p.fillRect(QRectF(b.left, y - 0.5, b.width, 1), QColor(95, 184, 255, 36))

    def _paint_calibration_viewport(self, p: QPainter) -> None:
        b = viewport_bounds(self.roi, "draft")
        shade = QColor(3, 7, 18, 153)
        p.fillRect(QRectF(0, 0, EDGE, b.top), shade)
        p.fillRect(QRectF(0, b.bottom, EDGE, EDGE - b.bottom), shade)
        p.fillRect(QRectF(0, b.top, b.left, b.height), shade)
        p.fillRect(QRectF(b.right, b.top, EDGE - b.right, b.height), shade)
        p.setPen(QPen(QColor("lawngreen"), 0.2))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(QRectF(b.left, b.top, b.width, b.height))
        if self.calibration_line:
            (sx, sy), (ex, ey) = self.calibration_line
            p.setPen(QPen(QColor("#ff0000"), 0.8))
            p.drawLine(QPointF(sx, sy), QPointF(ex, ey))

    def _paint_scan_path(self, p: QPainter) -> None:
        roi = self.roi
        v = self.ctl.engine.vector
        samples = min(v.cursor, v.custom_count) if (v.pattern == "custom" and v.custom_count > 0) else v.cursor
        if not self.live_vector_preview or not roi.vector_show_scan_path or not roi.selection or samples <= 0:
            return
        sel = roi.selection
        b = viewport_bounds(roi)
        ib = image_world_bounds(roi)
        cb = point_array_bounds(v.custom_points) if v.custom_points is not None else None
        cxs = max(1e-6, cb[1] - cb[0]) if cb else 1
        cys = max(1e-6, cb[3] - cb[2]) if cb else 1
        wxs = max(1e-6, sel["x_end"] - sel["x_start"])
        wys = max(1e-6, sel["y_end"] - sel["y_start"])

        def point_at(i):
            if v.pattern == "custom":
                if v.custom_points is None or cb is None or i >= v.custom_count:
                    return None
                x, y = float(v.custom_points[i, 0]), float(v.custom_points[i, 1])
                wx = sel["x_start"] + ((x - cb[0]) / cxs) * wxs
                wy = sel["y_start"] + ((y - cb[2]) / cys) * wys
            else:
                pt = vector_scan_sample_pixel(i, v.edge, v.scan_path)
                if pt is None:
                    return None
                wx = sel["x_start"] + (pt[0] / max(1, v.edge - 1)) * wxs
                wy = sel["y_start"] + (pt[1] / max(1, v.edge - 1)) * wys
            return QPointF(world_to_canvas_x(wx, ib, b), world_to_canvas_y(wy, ib, b))
        limit = min(samples, v.custom_count) if v.pattern == "custom" else \
            min(samples, vector_scan_sample_count(v.edge, v.scan_path))
        first = max(0, limit - min(160, max(24, v.edge >> 2)))
        path = QPainterPath()
        started = False
        for i in range(first, limit):
            q = point_at(i)
            if q is None:
                continue
            if not started:
                path.moveTo(q)
                started = True
            else:
                path.lineTo(q)
        p.setPen(QPen(QColor(111, 190, 211, 46), 0.55))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(path)
        cur = point_at(limit - 1)
        if cur is not None:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(151, 210, 224, 122))
            p.drawEllipse(cur, 1.15, 1.15)
            p.setPen(QPen(QColor(151, 210, 224, 107), 0.6))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawEllipse(cur, 1.3, 1.3)
            p.drawLine(cur - QPointF(2.3, 0), cur + QPointF(2.3, 0))
            p.drawLine(cur - QPointF(0, 2.3), cur + QPointF(0, 2.3))

    def _pill(self, p: QPainter, text: str, x: float, y: float, *, anchor_right=False, fg=None, bg=None, border=None,
              center=False) -> QRectF:
        tk = theme.current()
        f = QFont()
        f.setPixelSize(11)
        p.setFont(f)
        fm = QFontMetricsF(f)
        wdt = fm.horizontalAdvance(text) + 14
        h = 20
        left = x - wdt if anchor_right else (x - wdt / 2 if center else x)
        rect = QRectF(left, y, wdt, h)
        p.setPen(QPen(QColor(border or tk.border_soft), 1))
        p.setBrush(QColor(bg) if bg else Qt.BrushStyle.NoBrush)
        p.drawRoundedRect(rect, 10, 10)
        p.setPen(QColor(fg or tk.text_dim))
        p.drawText(rect, Qt.AlignmentFlag.AlignCenter, text)
        return rect

    def _paint_overlays(self, p: QPainter, R: QRectF, k: float) -> None:
        roi = self.roi
        tk = theme.current()

        def cpt(x, y):
            return QPointF(R.left() + x * k, R.top() + y * k)
        # confirmed viewport box
        if not roi.calibration_enabled:
            b = viewport_bounds(roi)
            if b.width > 0 and b.height > 0:
                pen = QPen(QColor(255, 255, 255, 102), 1, Qt.PenStyle.DashLine)
                p.setPen(pen)
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawRect(QRectF(cpt(b.left, b.top), cpt(b.right, b.bottom)))
        # axis labels (ROIAxisOverlay / ROICalibrationAxisOverlay)
        f = QFont("monospace")
        f.setStyleHint(QFont.StyleHint.Monospace)
        f.setPixelSize(12)
        p.setFont(f)
        cal = roi.calibration_enabled
        x0 = roi.calibration_x_origin if cal else roi.x_origin
        x1 = roi.calibration_x_end if cal else roi.x_end
        y0 = roi.calibration_y_origin if cal else roi.y_origin
        y1 = roi.calibration_y_end if cal else roi.y_end
        unit = unit_label(roi.scale_unit)
        if cal:
            if roi.show_grid:
                for i in range(0, 21, 5):
                    u = i / 20
                    p.fillRect(QRectF(R.left() + u * R.width(), R.top(), 1, R.height()), QColor(95, 184, 255, 36))
                    p.fillRect(QRectF(R.left(), R.top() + u * R.height(), R.width(), 1), QColor(95, 184, 255, 36))
            p.setPen(QPen(QColor(95, 184, 255, 230), 1))
            p.drawLine(R.topLeft(), R.topRight())
            p.drawLine(R.topLeft(), R.bottomLeft())
            for i in range(0, 21, 5):
                u = i / 20
                p.drawLine(QPointF(R.left() + u * R.width(), R.top()), QPointF(R.left() + u * R.width(), R.top() + 10))
                p.drawLine(QPointF(R.left(), R.top() + u * R.height()), QPointF(R.left() + 10, R.top() + u * R.height()))
        for i in range(0, 21, 5):
            u = i / 20
            xl = f1(x0 + (x1 - x0) * u) + (f" {unit}" if cal else "")
            yl = f1(y0 + (y1 - y0) * u) + (f" {unit}" if cal else "")
            self._shadow_text(p, QPointF(R.left() + u * R.width() + 3, R.top() + 16 + 10), xl)
            self._shadow_text(p, QPointF(R.left() + 14, R.top() + u * R.height() + 4), yl)
        fm = QFontMetricsF(f)
        for text, top in ((t("roi.canvas.start", point=f"({f1(x0)}, {f1(y0)})", unit=unit), 12),
                          (t("roi.canvas.end", point=f"({f1(x1)}, {f1(y1)})", unit=unit), 34)):
            box = QRectF(R.left() + 12, R.top() + top, fm.horizontalAdvance(text) + 8, 18)
            p.fillRect(box, QColor(0, 0, 0, 51))
            p.setPen(QColor(105, 105, 105))
            p.drawText(box, Qt.AlignmentFlag.AlignCenter, text)
        # mode / source pills
        if not cal:
            mode = (t("roi.canvasMode.scanPreview") if roi.scanImageDataUrl is not None or roi.imageKind == "lastScan"
                    else t("roi.canvasMode.loadedPreview") if roi.imageKind == "file"
                    else t("roi.canvasMode.selection"))
            self._pill(p, mode, R.left() + 10, R.bottom() - 30)
        src = (t("roi.imageSource.lastScan") if roi.scanImageDataUrl is not None or roi.imageKind == "lastScan"
               else t("roi.imageSource.loaded") if roi.imageKind == "file" else None)
        if src:
            self._pill(p, src, R.right() - 10, R.top() + 10, anchor_right=True)
        # selection hint + corner handles
        sel = self._active_selection()
        if sel and not cal:
            sx0, sx1, sy0, sy1 = self._sel_canvas_rect(sel)
            hint = (f"Press ctrl to drag a corner   {fmt_point((sel['x_start'], sel['y_start']))} - "
                    f"{fmt_point((sel['x_end'], sel['y_end']))}")
            top_c = max(0, min(sy0, sy1) - 16)
            hx = R.left() + (min(sx0, sx1) + max(sx0, sx1)) / 2 * k
            self._pill(p, hint, hx, R.top() + top_c * k - 20, center=True, fg="silver", border="dimgray")
            for corner in ("top-left", "top-right", "bottom-left", "bottom-right"):
                pos = self._corner_point(corner)
                if pos and self.resize_corner != corner:
                    p.setPen(QPen(QColor(255, 45, 45, 160), 1))
                    p.setBrush(Qt.BrushStyle.NoBrush)
                    p.drawEllipse(cpt(*pos), 4, 4)
        if self.ctrl_cursor and not cal:
            x, y, captured = self.ctrl_cursor
            if captured:
                p.setPen(QPen(QColor(0, 0, 0, 115), 1))
                p.setBrush(QColor("lawngreen"))
            else:
                p.setPen(QPen(QColor(255, 255, 255, 235), 1))
                p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawEllipse(cpt(x, y), 5, 5)
        if cal:
            self._paint_calibration_handles(p, R, k)
        if not cal and self.gray_selection is not None and self.gray_skipped is False:
            rect = QRectF(R.left() + 10, R.top() + 56, 150, 22)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(0, 0, 0, 140))
            p.drawRoundedRect(rect, 6, 6)
            p.setBrush(QColor("#ec4899"))
            p.drawRect(QRectF(rect.left() + 8, rect.top() + 6, 10, 10))
            p.setPen(QColor(tk.text))
            p.drawText(rect.adjusted(24, 0, 0, 0), Qt.AlignmentFlag.AlignVCenter, "Spot beam-on pixels")

    def _shadow_text(self, p: QPainter, pt: QPointF, text: str) -> None:
        p.setPen(QColor(0, 0, 0, 184))
        p.drawText(pt + QPointF(0, 1), text)
        p.setPen(QColor(230, 238, 249, 242))
        p.drawText(pt, text)

    def _paint_calibration_handles(self, p: QPainter, R: QRectF, k: float) -> None:
        roi = self.roi
        tk = theme.current()
        b = viewport_bounds(roi, "draft")
        cyan = QColor(0, 255, 255, 255 if self._blink else 51)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(cyan)
        for x in (b.left, b.right):
            X = R.left() + x * k
            p.drawPolygon(QPolygonF([QPointF(X - 9, R.top() + 2), QPointF(X + 9, R.top() + 2),
                                     QPointF(X, R.top() + 14.6)]))
        for y in (b.top, b.bottom):
            Y = R.top() + y * k
            p.drawPolygon(QPolygonF([QPointF(R.left() + 2, Y - 9), QPointF(R.left() + 2, Y + 9),
                                     QPointF(R.left() + 14.6, Y)]))
        bgc = QColor(tk.bg_elev).darker(140).name()

        def xval(cx):
            return roi.calibration_x_origin + (roi.calibration_x_end - roi.calibration_x_origin) * min(1, max(0, cx / EDGE))

        def yval(cy):
            return roi.calibration_y_origin + (roi.calibration_y_end - roi.calibration_y_origin) * min(1, max(0, cy / EDGE))
        self._pill(p, fmt_dim(xval(b.left), roi.scale_unit), R.left() + b.left * k + 8, R.top() + 16, fg=tk.text,
                   bg=bgc, border=tk.accent)
        self._pill(p, fmt_dim(xval(b.right), roi.scale_unit), R.left() + b.right * k, R.top() + 16, anchor_right=True,
                   fg=tk.text, bg=bgc, border=tk.accent)
        self._pill(p, fmt_dim(yval(b.top), roi.scale_unit), R.left() + 16, R.top() + b.top * k - 10, fg=tk.text,
                   bg=bgc, border=tk.accent)
        self._pill(p, fmt_dim(yval(b.bottom), roi.scale_unit), R.left() + 16, R.top() + b.bottom * k - 20,
                   fg=tk.text, bg=bgc, border=tk.accent)
        wspan = abs(xval(b.right) - xval(b.left))
        hspan = abs(yval(b.bottom) - yval(b.top))
        self._pill(p, f"W : {fmt_dim(wspan, roi.scale_unit)}", R.left() + (b.left + b.width / 2) * k,
                   R.top() + (b.top + 8) * k, center=True, fg=tk.text, bg=bgc, border=tk.accent)
        p.save()
        cx, cy = R.left() + max(0, b.left - 2) * k - 10, R.top() + (b.top + b.height / 2) * k
        p.translate(cx, cy)
        p.rotate(-90)
        self._pill(p, f"H : {fmt_dim(hspan, roi.scale_unit)}", 0, -10, center=True, fg=tk.text, bg=bgc,
                   border=tk.accent)
        p.restore()
        if self.calibration_line:
            (sx, sy), (ex, ey) = self.calibration_line
            sw = self._calibration_world((sx, sy))
            ew = self._calibration_world((ex, ey))
            xl, yl = abs(ew[0] - sw[0]), abs(ew[1] - sw[1])
            text1 = f"X1: {fmt_dim(sw[0], roi.scale_unit)} | Y1: {fmt_dim(sw[1], roi.scale_unit)}"
            text2 = f"X2: {fmt_dim(sw[0] + xl, roi.scale_unit)} | Y2: {fmt_dim(sw[1] + yl, roi.scale_unit)}"
            mx, my = R.left() + (sx + ex) / 2 * k, R.top() + (sy + ey) / 2 * k
            f = QFont()
            f.setPixelSize(11)
            fm = QFontMetricsF(f)
            wd = max(fm.horizontalAdvance(text1), fm.horizontalAdvance(text2)) + 18
            rect = QRectF(mx - wd / 2, my - 52, wd, 40)
            p.setOpacity(0.7)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(0, 0, 0, 200))
            p.drawRoundedRect(rect, 6, 6)
            p.setPen(QColor("#fff"))
            p.setFont(f)
            p.drawText(rect.adjusted(9, 4, 0, -20), Qt.AlignmentFlag.AlignVCenter, text1)
            p.drawText(rect.adjusted(9, 20, 0, -4), Qt.AlignmentFlag.AlignVCenter, text2)
            p.setOpacity(1)

    # ------------------------------------------------------------------ geometry helpers
    def _to_dut(self, pt):
        return canvas_point_to_world(pt, image_world_bounds(self.roi), viewport_bounds(self.roi))

    def _calibration_world(self, pt):
        return canvas_point_to_world(pt, image_world_bounds(self.roi), viewport_bounds(self.roi, "draft"))

    def _canvas_point(self, pos, clamp_selection=True):
        x, y = self.view.to_canvas(pos)
        raw = (clamp_viewport_coordinate(x, 0, EDGE), clamp_viewport_coordinate(y, 0, EDGE))
        return clamp_canvas_point_to_viewport(raw, viewport_bounds(self.roi)) if clamp_selection else raw

    def _rect_from_points(self, a, b) -> dict:
        p0, p1 = self._to_dut(a), self._to_dut(b)
        return {"x_start": min(p0[0], p1[0]), "x_end": max(p0[0], p1[0]),
                "y_start": min(p0[1], p1[1]), "y_end": max(p0[1], p1[1])}

    def _corner_at(self, pt) -> Optional[str]:
        sel = self.roi.selection
        if not sel:
            return None
        x0, x1, y0, y1 = self._sel_canvas_rect(sel)
        best, dist = None, math.inf
        for corner, cx, cy in (("top-left", x0, y0), ("top-right", x1, y0), ("bottom-left", x0, y1),
                               ("bottom-right", x1, y1)):
            d = math.hypot(pt[0] - cx, pt[1] - cy)
            if d < dist:
                best, dist = corner, d
        return best if dist <= ROI_CORNER_DRAG_THRESHOLD else None

    def _corner_point(self, corner: str):
        sel = self.resize_selection or self.roi.selection
        if not sel:
            return None
        if self.resize_trace and self.resize_trace[0] == corner:
            return self.resize_trace[1]
        x0, x1, y0, y1 = self._sel_canvas_rect(sel)
        return {"top-left": (x0, y0), "top-right": (x1, y0), "bottom-left": (x0, y1),
                "bottom-right": (x1, y1)}[corner]

    def _rect_from_corner_drag(self, corner, pt):
        sel = self.resize_selection or self.roi.selection
        if not sel:
            return None
        mx, my = self._to_dut(pt)
        fx, fy = {"top-left": (sel["x_end"], sel["y_end"]), "top-right": (sel["x_start"], sel["y_end"]),
                  "bottom-left": (sel["x_end"], sel["y_start"]),
                  "bottom-right": (sel["x_start"], sel["y_start"])}[corner]
        return {"x_start": min(fx, mx), "x_end": max(fx, mx), "y_start": min(fy, my), "y_end": max(fy, my)}

    def _tip(self, global_pos, pt) -> None:
        QToolTip.showText(global_pos, fmt_point(self._to_dut(pt)), self.view)

    # ------------------------------------------------------------------ mouse
    def _handle_at(self, pos) -> Optional[str]:
        R = self.view.rect640()
        k = R.width() / EDGE
        b = viewport_bounds(self.roi, "draft")
        x, y = pos.x(), pos.y()
        if y <= R.top() + 18:
            for name, cx in (("x-start", b.left), ("x-end", b.right)):
                if abs(x - (R.left() + cx * k)) <= 10:
                    return name
        if x <= R.left() + 18:
            for name, cy in (("y-start", b.top), ("y-end", b.bottom)):
                if abs(y - (R.top() + cy * k)) <= 10:
                    return name
        return None

    def mouse_press(self, e) -> None:
        if e.button() != Qt.MouseButton.LeftButton or self.disabled:
            return
        roi = self.roi
        pos = e.position()
        if roi.calibration_enabled:
            handle = self._handle_at(pos)
            if handle:
                self.active_handle = handle
                return
            pt = self._canvas_point(pos, False)
            self.calibration_line = [pt, pt]
            self.view.update()
            return
        ctrl = bool(e.modifiers() & Qt.KeyboardModifier.ControlModifier)
        pt = self._canvas_point(pos)
        self.draft = None
        # corner handles (always active, like the handle buttons)
        corner = self._corner_at(self._canvas_point(pos, False))
        if corner and roi.selection:
            self.resize_corner = corner
            self.resize_selection = roi.selection
            self.drag_start = None
            self.resize_trace = (corner, pt)
            self.ctrl_cursor = (pt[0], pt[1], True)
            self._tip(e.globalPosition().toPoint(), pt)
            self.view.update()
            return
        if ctrl:
            self.resize_corner = None
            self.resize_selection = None
            self.drag_start = None
            self.ctrl_cursor = (pt[0], pt[1], False)
            self._tip(e.globalPosition().toPoint(), pt)
            self.view.update()
            return
        self.resize_corner = None
        self.resize_selection = None
        self.drag_start = pt
        self.ctrl_cursor = None
        self._tip(e.globalPosition().toPoint(), pt)

    def mouse_move(self, e) -> None:
        roi = self.roi
        pos = e.position()
        if self.active_handle:
            self._drag_handle(self.active_handle, pos)
            return
        if self.resize_corner:
            pt = self._canvas_point(pos, False)
            self.resize_trace = (self.resize_corner, pt)
            self.ctrl_cursor = (pt[0], pt[1], True)
            self._tip(e.globalPosition().toPoint(), pt)
            self.view.update()
            return
        if self.disabled:
            return
        if roi.calibration_enabled:
            self.view.setCursor(Qt.CursorShape.PointingHandCursor if self._handle_at(pos) else
                                Qt.CursorShape.CrossCursor)
            if self.calibration_line:
                self.calibration_line[1] = self._canvas_point(pos, False)
                self.view.update()
            return
        pt = self._canvas_point(pos)
        ctrl = bool(e.modifiers() & Qt.KeyboardModifier.ControlModifier)
        if ctrl:
            hover = self._corner_at(pt)
            snapped = self._corner_point(hover) if hover else pt
            self.ctrl_cursor = (snapped[0], snapped[1], bool(hover))
        else:
            self.ctrl_cursor = None
        if self.drag_start is not None:
            dx, dy = abs(pt[0] - self.drag_start[0]), abs(pt[1] - self.drag_start[1])
            if max(dx, dy) >= ROI_DRAG_THRESHOLD:
                self.draft = self._rect_from_points(self.drag_start, pt)
                self.refresh()
            self._tip(e.globalPosition().toPoint(), pt)
        self.view.update()

    def mouse_release(self, e) -> None:
        roi = self.roi
        pos = e.position()
        if self.active_handle:
            self.active_handle = None
            return
        if self.resize_corner:
            pt = self._canvas_point(pos, False)
            nxt = self._rect_from_corner_drag(self.resize_corner, pt)
            self.resize_corner = None
            self.resize_selection = None
            self.drag_start = None
            self.resize_trace = None
            self.draft = None
            self.ctrl_cursor = None
            QToolTip.hideText()
            if nxt:
                clear_bitmap_selection_cache()
                self.ctl.scan.update_roi({"selection": nxt})
                self.ctl.notify("roi", "scan")
            self.view.update()
            return
        if self.disabled:
            return
        if roi.calibration_enabled:
            line = self.calibration_line
            if not line:
                return
            end = self._canvas_point(pos, False)
            sw = self._calibration_world(line[0])
            ew = self._calibration_world(end)
            dx, dy = abs(ew[0] - sw[0]), abs(ew[1] - sw[1])
            self.calibration_line = None
            self.view.update()
            CalibrationCorrectionDialog(self.ctl, (sw[0], sw[0] + dx, sw[1], sw[1] + dy), self).exec()
            return
        pt = self._canvas_point(pos)
        start = self.drag_start
        if start is None:
            ctrl = bool(e.modifiers() & Qt.KeyboardModifier.ControlModifier)
            self.ctrl_cursor = (pt[0], pt[1], False) if ctrl else None
            QToolTip.hideText()
            self.view.update()
            return
        did_drag = max(abs(pt[0] - start[0]), abs(pt[1] - start[1])) >= ROI_DRAG_THRESHOLD
        self.drag_start = None
        self.draft = None
        QToolTip.hideText()
        if not did_drag:
            self.refresh()
            return
        clear_bitmap_selection_cache()
        self.ctl.scan.update_roi({"selection": self._rect_from_points(start, pt)})
        self.ctl.notify("roi", "scan")

    def mouse_leave(self) -> None:
        if self.resize_corner or self.active_handle:
            return
        self.drag_start = None
        self.resize_selection = None
        self.resize_trace = None
        self.draft = None
        self.ctrl_cursor = None
        QToolTip.hideText()
        self.view.update()

    def ctrl_released(self) -> None:
        self.resize_trace = None if not self.resize_corner else self.resize_trace
        self.ctrl_cursor = None
        if not self.resize_corner:
            self.resize_selection = None
        self.view.update()

    def _drag_handle(self, handle: str, pos) -> None:
        roi = self.roi
        x, y = self.view.to_canvas(pos)
        patch = {}
        if handle == "x-start":
            patch["calibration_viewport_x_start"] = clamp_viewport_coordinate(
                x, 0, roi.calibration_viewport_x_end - ROI_VIEWPORT_MIN_SPAN)
        elif handle == "x-end":
            patch["calibration_viewport_x_end"] = clamp_viewport_coordinate(
                x, roi.calibration_viewport_x_start + ROI_VIEWPORT_MIN_SPAN, EDGE)
        elif handle == "y-start":
            patch["calibration_viewport_y_start"] = clamp_viewport_coordinate(
                y, 0, roi.calibration_viewport_y_end - ROI_VIEWPORT_MIN_SPAN)
        else:
            patch["calibration_viewport_y_end"] = clamp_viewport_coordinate(
                y, roi.calibration_viewport_y_start + ROI_VIEWPORT_MIN_SPAN, EDGE)
        self.ctl.scan.update_roi(patch)
        self.ctl.notify("roi", "scan")


class CalibrationCorrectionDialog(QDialog):
    def __init__(self, ctl, measured: tuple, parent=None):
        super().__init__(parent)
        self.ctl = ctl
        roi = ctl.scan.roi
        self.original = (roi.calibration_x_origin, roi.calibration_x_end, roi.calibration_y_origin,
                         roi.calibration_y_end)
        self.measured = measured
        self.setObjectName("Modal")
        self.setWindowTitle("Correct calibration values")
        self.setModal(True)
        lay = QVBoxLayout(self)
        lay.addWidget(label("Correct calibration values", "title"))
        lay.addWidget(label("Review the delta-derived coordinates before applying them.", "muted", wrap=True))
        grid = QGridLayout()
        unit = unit_label(roi.scale_unit)
        self.inputs = {}
        for i, (name, value) in enumerate(zip(("X1", "X2", "Y1", "Y2"), measured)):
            grid.addWidget(label(f"{name} ({unit})"), (i // 2) * 2, i % 2)
            edit = QLineEdit(f1(value))
            self.inputs[name] = edit
            grid.addWidget(edit, (i // 2) * 2 + 1, i % 2)
        lay.addLayout(grid)
        self.err = label("", "warn", wrap=True)
        self.err.hide()
        lay.addWidget(self.err)
        cancel = button("Cancel", "ghost", "x")
        cancel.setIcon(icon("x", theme.current().danger))
        cancel.clicked.connect(self.reject)
        apply_ = button("Apply", "primary", "check")
        apply_.clicked.connect(self._apply)
        lay.addLayout(hbox(None, cancel, apply_))

    def _apply(self):
        vals = [js_number(self.inputs[n].text()) for n in ("X1", "X2", "Y1", "Y2")]
        if not all(math.isfinite(v) for v in vals):
            self.err.setText("Enter valid numeric X1, X2, Y1, and Y2 values.")
            self.err.show()
            return
        x1, x2, y1, y2 = vals
        if x2 <= x1 or y2 <= y1:
            self.err.setText("X2 must be greater than X1 and Y2 must be greater than Y1.")
            self.err.show()
            return
        o, m = self.original, self.measured
        self.ctl.scan.update_roi({
            "calibration_x_origin": o[0] + (x1 - m[0]), "calibration_x_end": o[1] + (x2 - m[1]),
            "calibration_y_origin": o[2] + (y1 - m[2]), "calibration_y_end": o[3] + (y2 - m[3])})
        self.ctl.notify("roi", "scan")
        self.accept()


# ---------------------------------------------------------------------------- controls

class ROIEditorControls(Panel):
    """``<ROIEditor variant="controls">``."""

    TOPICS = frozenset({"scan", "roi", "panel", "last-scan"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.allow_clear_region_while_disabled = False
        self.last_scan_available = False
        self.on_load_last_scan: Optional[Callable[[], None]] = None
        self.on_clear_image: Optional[Callable[[], None]] = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        row = QHBoxLayout()
        row.setSpacing(6)
        self.select_btn = button("", None, "upload")
        self.select_btn.setIcon(icon("upload", theme.current().accent))
        self.select_btn.clicked.connect(self._pick_file)
        self.last_btn = button("", "ghost", "download")
        self.last_btn.setIcon(icon("download", theme.current().accent))
        self.last_btn.clicked.connect(lambda: self.on_load_last_scan and self.on_load_last_scan())
        self.clear_img_btn = button("", "ghost", "trash")
        self.clear_img_btn.setIcon(icon("trash", theme.current().danger))
        self.clear_img_btn.clicked.connect(self._clear_image)
        self.clear_region_btn = button("", "ghost", "crop")
        self.clear_region_btn.setIcon(icon("crop", theme.current().warn))
        self.clear_region_btn.clicked.connect(self._clear_region)
        self.image_name = label("", "muted")
        for w in (self.select_btn, self.last_btn, self.clear_img_btn, self.clear_region_btn):
            row.addWidget(w)
        row.addWidget(self.image_name, 1)
        lay.addLayout(row)
        self.unit_lbl = label()
        lay.addWidget(self.unit_lbl)
        self.unit = QComboBox()
        for v, lbl in UNITS:
            self.unit.addItem(lbl, v)
        self.unit.activated.connect(lambda i: self._update({"scale_unit": self.unit.itemData(i)}))
        lay.addWidget(self.unit)
        self.fields_box = QWidget()
        g = QGridLayout(self.fields_box)
        g.setContentsMargins(0, 0, 0, 0)
        self.num = {}
        for i, key in enumerate(("xOrigin", "xEnd", "yOrigin", "yEnd")):
            lbl = label()
            box = NumberStepper("", step=0.1)
            box.set_read_only(True)
            self.num[key] = (lbl, box)
            g.addWidget(lbl, (i // 2) * 2, i % 2)
            g.addWidget(box, (i // 2) * 2 + 1, i % 2)
        self.start_lbl, self.end_lbl = label(), label()
        self.start_edit, self.end_edit = QLineEdit(), QLineEdit()
        self.start_edit.setEnabled(False)
        self.end_edit.setEnabled(False)
        g.addWidget(self.start_lbl, 4, 0)
        g.addWidget(self.end_lbl, 4, 1)
        g.addWidget(self.start_edit, 5, 0)
        g.addWidget(self.end_edit, 5, 1)
        self.extent = label("", "muted", wrap=True)
        self.extent.setTextFormat(Qt.TextFormat.RichText)
        g.addWidget(self.extent, 6, 0, 1, 2)
        lay.addWidget(self.fields_box)
        self.cal_note = label("", "muted", wrap=True)
        lay.addWidget(self.cal_note)
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.select_btn.setText(t("roi.select"))
        self.last_btn.setText(t("roi.loadLastScan"))
        self.clear_img_btn.setText(t("roi.clearImage"))
        self.clear_region_btn.setText(t("roi.clearRegion"))
        self.unit_lbl.setText(t("roi.scaleUnit"))
        for key, (lbl, _) in self.num.items():
            lbl.setText(t(f"roi.{key}"))
        self.start_lbl.setText(t("roi.start"))
        self.end_lbl.setText(t("roi.end"))
        self.cal_note.setText(t("roi.calibration.pending"))

    def refresh(self):
        roi = self.ctl.scan.roi
        disabled = self.disabled
        self.select_btn.setEnabled(not disabled)
        self.last_btn.setVisible(self.last_scan_available)
        self.last_btn.setEnabled(not disabled and roi.imageKind != "lastScan")
        self.clear_img_btn.setEnabled(not disabled and bool(roi.imageDataUrl))
        self.clear_region_btn.setEnabled(not ((disabled and not self.allow_clear_region_while_disabled)
                                              or roi.calibration_enabled or not roi.selection))
        self.image_name.setText(roi.imageName)
        idx = self.unit.findData(roi.scale_unit)
        if idx >= 0:
            self.unit.setCurrentIndex(idx)
        cal = roi.calibration_enabled
        self.fields_box.setVisible(not cal)
        self.cal_note.setVisible(cal)
        for key, value in (("xOrigin", roi.x_origin), ("xEnd", roi.x_end), ("yOrigin", roi.y_origin),
                           ("yEnd", roi.y_end)):
            self.num[key][1].force_value(f1(value))
            self.num[key][1].setEnabled(False)
        sel = roi.selection
        start = (sel["x_start"], sel["y_start"]) if sel else (roi.x_origin, roi.y_origin)
        end = (sel["x_end"], sel["y_end"]) if sel else (roi.x_end, roi.y_end)
        self.start_edit.setText(fmt_point(start))
        self.end_edit.setText(fmt_point(end))
        if sel:
            sx, ex = min(sel["x_start"], sel["x_end"]), max(sel["x_start"], sel["x_end"])
            w = abs(sel["x_end"] - sel["x_start"])
            u = unit_label(roi.scale_unit)
            self.extent.setText(f"{t('roi.selectionExtent')}&nbsp; S({f1(sx)} {u}) → E({f1(ex)} {u}) "
                                f"&nbsp;<span style='opacity:0.7'>w : {f1(w)} {u}</span>")
            self.extent.show()
        else:
            self.extent.hide()

    def _update(self, patch):
        if not self._updating:
            self.ctl.scan.update_roi(patch)
            self.ctl.notify("roi", "scan")

    def _pick_file(self):
        path, _ = QFileDialog.getOpenFileName(self, t("roi.select"), "",
                                              "Images (*.png *.bmp *.jpg *.jpeg *.svg *.webp *.gif *.tif *.tiff)")
        if not path:
            return
        try:
            data = open(path, "rb").read()
        except OSError:
            return
        if path.lower().endswith(".svg"):
            img = png_to_qimage(data)
            if img is None:
                from PyQt6.QtSvg import QSvgRenderer
                from PyQt6.QtCore import QByteArray
                r = QSvgRenderer(QByteArray(data))
                img = QImage(r.defaultSize(), QImage.Format.Format_ARGB32)
                img.fill(Qt.GlobalColor.transparent)
                p = QPainter(img)
                r.render(p)
                p.end()
            data = qimage_to_png(img)
        elif png_to_qimage(data) is None:
            return
        import os
        clear_bitmap_selection_cache()
        s = self.ctl.scan
        s.clear_roi_selection()
        s.update_roi({"imageName": os.path.basename(path), "imageDataUrl": data, "imageKind": "file",
                      "imageBounds": None})
        self.ctl.notify("roi", "scan", "roi-file")

    def _stop_all(self):
        if self.ctl.stream_active:
            self.ctl.stop_stream()
        elif self.ctl.scan_active:
            self.ctl.abort_validated()

    def _clear_image(self):
        clear_bitmap_selection_cache()
        self._stop_all()
        if self.on_clear_image:
            self.on_clear_image()
        s = self.ctl.scan
        s.clear_roi_image()
        s.clear_roi_scan_image()
        s.clear_roi_selection()
        s.stream_reset()
        self.ctl.notify("roi", "scan", "panel")

    def _clear_region(self):
        clear_bitmap_selection_cache()
        self._stop_all()
        s = self.ctl.scan
        s.clear_roi_image()
        s.clear_roi_scan_image()
        s.clear_roi_selection()
        s.stream_reset()
        self.ctl.notify("roi", "scan", "panel")


# ---------------------------------------------------------------------------- calibration card

class ROICalibrationCard(Panel):
    TOPICS = frozenset({"scan", "roi", "panel", "dimcal", "last-scan"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.last_scan_available = False
        self.on_load_last_scan: Optional[Callable[[], None]] = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        self.hint = label("", "muted", wrap=True)
        lay.addWidget(self.hint)
        self.source = label("", "dim", wrap=True)
        lay.addWidget(self.source)
        self.last_btn = button("", "ghost", "download")
        self.last_btn.setIcon(icon("download", theme.current().accent))
        self.last_btn.clicked.connect(lambda: self.on_load_last_scan and self.on_load_last_scan())
        lay.addWidget(self.last_btn, 0, Qt.AlignmentFlag.AlignLeft)
        g = QGridLayout()
        self.fields = {}
        for i, (key, attr) in enumerate((("xOrigin", "calibration_x_origin"), ("xEnd", "calibration_x_end"),
                                         ("yOrigin", "calibration_y_origin"), ("yEnd", "calibration_y_end"))):
            lbl = label()
            box = NumberStepper("", step=0.1)
            warn = label("", "warn", wrap=True)
            warn.hide()
            box.valueChanged.connect(lambda text, k=key, a=attr: self._commit(k, a, text))
            self.fields[key] = (lbl, box, warn, attr)
            col = QVBoxLayout()
            col.addWidget(lbl)
            col.addWidget(box)
            col.addWidget(warn)
            g.addLayout(col, i // 2, i % 2)
        lay.addLayout(g)
        self.meta = label("", "dim", wrap=True)
        lay.addWidget(self.meta)
        self.validation = label("", "warn", wrap=True)
        lay.addWidget(self.validation)
        self.confirm = button("")
        self.confirm.clicked.connect(self._confirm)
        lay.addWidget(self.confirm, 0, Qt.AlignmentFlag.AlignLeft)
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.hint.setText(t("roi.calibration.instructions"))
        self.last_btn.setText(t("roi.loadLastScan"))
        for key, (lbl, *_rest) in self.fields.items():
            lbl.setText(t(f"roi.{key}"))
        self.confirm.setText(t("roi.confirmCalibration"))

    def _validate(self, key: str, v: float) -> Optional[str]:
        roi = self.ctl.scan.roi
        if key == "xOrigin":
            return None if v < roi.calibration_x_end else t("roi.error.xOriginBeforeEnd", end=f1(roi.calibration_x_end))
        if key == "xEnd":
            return None if v > roi.calibration_x_origin else t("roi.error.xEndAfterOrigin", origin=f1(roi.calibration_x_origin))
        if key == "yOrigin":
            return None if v < roi.calibration_y_end else t("roi.error.yOriginBeforeEnd", end=f1(roi.calibration_y_end))
        return None if v > roi.calibration_y_origin else t("roi.error.yEndAfterOrigin", origin=f1(roi.calibration_y_origin))

    def _commit(self, key, attr, text):
        lbl, box, warn, _ = self.fields[key]
        n = js_number(text)
        if text == "" or not math.isfinite(n):
            warn.setText(t("roi.error.pointValueRequired", label=t(f"roi.{key}")))
            warn.show()
            box.set_invalid(True)
            return
        problem = self._validate(key, n)
        if problem:
            warn.setText(problem)
            warn.show()
            box.set_invalid(True)
            return
        warn.hide()
        box.set_invalid(False)
        self.ctl.scan.update_roi({attr: n})
        self.ctl.notify("roi", "scan")

    def _source_text(self) -> str:
        src = self.ctl.dim_cal.source
        if not src:
            return ""
        def short(iso):
            return iso.replace("T", " ")[:19]
        if src.get("kind") == "manual":
            return t("roi.calibration.source.manual", when=short(src["set_at"]))
        return t("roi.calibration.source.scanGeometry", type=src.get("equipment_type"),
                 revision=src.get("profile_revision") or 0, when=short(src.get("applied_at", "")))

    def refresh(self):
        roi = self.ctl.scan.roi
        disabled = self.disabled
        src = self._source_text()
        self.source.setText(src)
        self.source.setVisible(bool(src))
        self.last_btn.setVisible(self.last_scan_available and self.on_load_last_scan is not None)
        self.last_btn.setEnabled(not disabled and roi.imageKind != "lastScan")
        for key, (lbl, box, warn, attr) in self.fields.items():
            if not box.edit.hasFocus():
                box.force_value(f1(getattr(roi, attr)))
                warn.hide()
                box.set_invalid(False)
            box.setEnabled(not disabled)
        b = viewport_bounds(roi, "draft")
        unit = unit_label(roi.scale_unit)
        xs = abs(roi.calibration_x_end - roi.calibration_x_origin)
        ys = abs(roi.calibration_y_end - roi.calibration_y_origin)
        self.meta.setText("   ".join([f"{t('roi.scaleUnit')}: {unit}",
                                      t("roi.calibration.hfov", value=f1(xs), unit=unit, pixels=fmt(b.width)),
                                      t("roi.calibration.vfov", value=f1(ys), unit=unit, pixels=fmt(b.height))]))
        validation = None
        if roi.calibration_x_end <= roi.calibration_x_origin:
            validation = t("roi.error.xEndAfterOrigin", origin=f1(roi.calibration_x_origin))
        elif roi.calibration_y_end <= roi.calibration_y_origin:
            validation = t("roi.error.yEndAfterOrigin", origin=f1(roi.calibration_y_origin))
        self.validation.setText(validation or "")
        self.validation.setVisible(bool(validation))
        dirty = (roi.calibration_x_origin != roi.x_origin or roi.calibration_x_end != roi.x_end
                 or roi.calibration_y_origin != roi.y_origin or roi.calibration_y_end != roi.y_end)
        can_confirm = dirty and not validation
        set_prop(self.confirm, "kind", "gold" if can_confirm else "primary")
        self.confirm.setEnabled(not disabled and can_confirm)

    def _confirm(self):
        roi = self.ctl.scan.roi
        if self.disabled:
            return
        src = self.ctl.dim_cal.source
        if src and src.get("kind") == "scanGeometry":
            answer = QMessageBox.question(self, t("roi.confirmCalibration"), t(
                "roi.calibration.overwriteScanGeometry", type=src.get("equipment_type"),
                revision=src.get("profile_revision") or 0))
            if answer != QMessageBox.StandardButton.Yes:
                return
        clear_bitmap_selection_cache()
        values = DimensionCalibrationValues(
            x_origin=roi.calibration_x_origin, x_end=roi.calibration_x_end, y_origin=roi.calibration_y_origin,
            y_end=roi.calibration_y_end, viewport_x_start=roi.calibration_viewport_x_start,
            viewport_x_end=roi.calibration_viewport_x_end, viewport_y_start=roi.calibration_viewport_y_start,
            viewport_y_end=roi.calibration_viewport_y_end, scale_unit=roi.scale_unit,
            source={"kind": "manual",
                    "set_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})
        self.ctl.save_dimension_calibration(values)
        self.ctl.scan.confirm_roi_calibration()
        self.ctl.notify("roi", "scan")


# ---------------------------------------------------------------------------- ROI preview

ZOOM_LEVELS = (0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20)


class _PreviewCanvas(QWidget):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner
        self.image: Optional[QImage] = None

    def paintEvent(self, e):  # noqa: N802
        p = QPainter(self)
        if self.image is not None:
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
            p.drawImage(QRectF(0, 0, self.width(), self.height()), self.image)
        p.end()


class ROIScanPreview(Panel):
    TOPICS = frozenset({"roi", "scan", "roi-levels", "theme"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.background: Optional[bytes] = None
        self.zoom_index = 2
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(False)
        self.scroll.setFixedSize(216, 216)
        self.canvas = _PreviewCanvas(self)
        self.scroll.setWidget(self.canvas)
        lay.addWidget(self.scroll)
        row = QHBoxLayout()
        self.out_btn = QToolButton()
        self.out_btn.setIcon(icon("zoomOut"))
        self.out_btn.clicked.connect(lambda: self._zoom(-1))
        self.value = label("", "dim")
        self.value.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.in_btn = QToolButton()
        self.in_btn.setIcon(icon("zoomIn"))
        self.in_btn.clicked.connect(lambda: self._zoom(1))
        row.addWidget(self.out_btn)
        row.addWidget(self.value, 1)
        row.addWidget(self.in_btn)
        lay.addLayout(row)
        lay.addStretch(1)
        self.retranslate()
        self.refresh()

    def set_background(self, png: Optional[bytes]) -> None:
        self.background = png
        self.refresh()

    def retranslate(self):
        self.out_btn.setToolTip(t("roi.preview.zoomOut"))
        self.in_btn.setToolTip(t("roi.preview.zoomIn"))

    def _zoom(self, d: int):
        self.zoom_index = max(0, min(len(ZOOM_LEVELS) - 1, self.zoom_index + d))
        self.refresh()
        if ZOOM_LEVELS[self.zoom_index] > 1:
            QTimer.singleShot(0, self._center)

    def _center(self):
        for bar in (self.scroll.horizontalScrollBar(), self.scroll.verticalScrollBar()):
            bar.setValue((bar.maximum() + bar.minimum()) // 2)

    def refresh(self):
        roi = self.ctl.scan.roi
        zoom = ZOOM_LEVELS[self.zoom_index]
        side = int(214 * zoom)
        self.canvas.setFixedSize(side, side)
        self.value.setText(f"{js_round(zoom * 100)}%")
        self.out_btn.setEnabled(self.zoom_index > 0)
        self.in_btn.setEnabled(self.zoom_index < len(ZOOM_LEVELS) - 1)
        img = QImage(EDGE, EDGE, QImage.Format.Format_ARGB32)
        img.fill(QColor(theme.current().bg_elev))
        p = QPainter(img)
        src = roi_image_source(roi, self.background)
        rgba, hist = roi_raw_image(src)
        if rgba is not None:
            setting = self.ctl.level_memory.get(LEVEL_KEY, AUTO_LEVELS)
            p.drawImage(0, 0, rgba_to_qimage(leveled(rgba, resolve_roi_levels(hist, setting))))
        sel = roi.selection
        if sel:
            b = viewport_bounds(roi)
            ib = image_world_bounds(roi)
            x0, x1 = world_to_canvas_x(sel["x_start"], ib, b), world_to_canvas_x(sel["x_end"], ib, b)
            y0, y1 = world_to_canvas_y(sel["y_start"], ib, b), world_to_canvas_y(sel["y_end"], ib, b)
            left, top = min(x0, x1), min(y0, y1)
            w, h = max(1, abs(x1 - x0)), max(1, abs(y1 - y0))
            shade = QColor(0, 0, 0, 82)
            p.fillRect(QRectF(0, 0, EDGE, top), shade)
            p.fillRect(QRectF(0, top + h, EDGE, EDGE - top - h), shade)
            p.fillRect(QRectF(0, top, left, h), shade)
            p.fillRect(QRectF(left + w, top, EDGE - left - w, h), shade)
            p.setPen(QPen(QColor("#ff2d2d"), 0.75))
            p.drawRect(QRectF(left + 1.5, top + 1.5, max(1, w - 3), max(1, h - 3)))
            pen = QPen(QColor(255, 255, 255, 209), 0.5)
            pen.setDashPattern([16, 12])
            p.setPen(pen)
            p.drawRect(QRectF(left + 8, top + 8, max(1, w - 16), max(1, h - 16)))
        p.end()
        self.canvas.image = img
        self.canvas.update()
