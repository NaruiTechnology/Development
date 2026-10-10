"""Live raster / vector image (port of components/ImageCanvas.tsx).

Paints straight from the engine's frame buffers (no per-chunk messages),
at most ~30 times per second while a scan streams and once more when it
completes. Includes the OBI-style level wedge, calibrated axis overlay,
vector scan-path trail, decimated/native view toggle, server-figure
fallback for validated runs, and the annotation editor (highlight /
comment / rectangle / circle, undo / remove / clear, merge + FTP upload).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PyQt6.QtCore import QPointF, QRectF, QSize, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QFontMetricsF, QImage, QPainter, QPainterPath, QPen
from PyQt6.QtWidgets import (
    QColorDialog, QComboBox, QDialog, QHBoxLayout, QLabel, QLineEdit, QMenu, QProgressBar, QPushButton,
    QSizePolicy, QToolButton, QVBoxLayout, QWidget,
)

from ..core.display_levels import AUTO_LEVELS, LevelSetting, ResolvedLevels
from ..core.helpers import vector_scan_sample_count, vector_scan_sample_pixel
from ..i18n import fmt, t
from . import theme
from .common import HelpButton, Spinner, button, hbox, icon, label, run_bg
from .imaging import png_data_url, png_to_qimage, qimage_to_png, rgba_to_qimage
from .level_wedge import LevelWedge
from .painters import (
    DAC_RANGE, ROI_ACTION_BLANK_COLOR, ROI_ACTION_HIGHLIGHT_COLOR, PaintStats, block_fill, paint_grayscale,
    paint_vector_custom, paint_vector_default,
)
from .panel import Panel

LINE_WIDTHS = (0.5, 1, 2, 3, 4, 6, 8)
PAINT_INTERVAL_S = 0.033


@dataclass
class Annotation:
    id: str
    kind: str                 # highlight | comment | rectangle | circle
    x: float
    y: float
    x2: Optional[float] = None
    y2: Optional[float] = None
    color: str = "#7cfc00"
    line_style: str = "solid"
    line_width: float = 0.5
    text: str = ""


def unit_label(unit: str) -> str:
    return "μm" if unit == "um" else unit


def format_one_decimal(v: float) -> str:
    from ..core.jsmath import to_fixed
    try:
        return to_fixed(float(v), 1)
    except (TypeError, ValueError):
        return "0.0"


def format_coord(v: float) -> str:
    from ..core.jsmath import to_fixed
    if float(v).is_integer():
        return fmt(v)
    return to_fixed(float(v), 2)


def format_point(x: float, y: float, unit: str) -> str:
    return f"({format_coord(x)}, {format_coord(y)}) {unit}"


def _pen(color: str, width: float, style: str) -> QPen:
    pen = QPen(QColor(color), max(0.5, width))
    if style == "dashed":
        pen.setDashPattern([4, 2])
    elif style == "dotted":
        pen.setDashPattern([1, 1.8])
    return pen


def draw_annotations(p: QPainter, anns: list, w: float, h: float, *, ox: float = 0, oy: float = 0,
                     selected: Optional[str] = None, scale_markers: bool = True) -> None:
    """``drawCanvasAnnotations`` (also used on screen, where ox/oy offset the image rect)."""
    marker_r = max(12, round(min(w, h) * 0.02)) if scale_markers else 12
    font_size = max(14, round(marker_r * 0.9)) if scale_markers else 12
    for index, a in enumerate(anns):
        x, y = ox + a.x * w, oy + a.y * h
        p.save()
        p.setPen(_pen(a.color, a.line_width, a.line_style))
        if a.kind in ("rectangle", "circle"):
            x2, y2 = ox + (a.x2 if a.x2 is not None else a.x) * w, oy + (a.y2 if a.y2 is not None else a.y) * h
            rect = QRectF(x, y, max(0, x2 - x), max(0, y2 - y))
            p.setBrush(Qt.BrushStyle.NoBrush)
            if a.kind == "rectangle":
                p.drawRect(rect)
            else:
                p.drawEllipse(rect)
            if selected == a.id:
                p.setPen(QPen(QColor(theme.current().accent), 1, Qt.PenStyle.DotLine))
                p.drawRect(rect.adjusted(-3, -3, 3, 3))
            p.restore()
            continue
        c = QColor(a.color)
        fill = QColor(c)
        fill.setAlphaF(0.92 if (a.kind == "comment" and not scale_markers) else 0.24)
        p.setBrush(fill)
        pen = QPen(c, max(1.0, a.line_width))
        if selected == a.id:
            pen = QPen(QColor(theme.current().accent), 2)
        p.setPen(pen)
        p.drawEllipse(QPointF(x, y), marker_r, marker_r)
        f = QFont()
        f.setPixelSize(font_size)
        f.setWeight(QFont.Weight.DemiBold)
        p.setFont(f)
        p.setPen(QColor("#101820"))
        p.drawText(QRectF(x - marker_r, y - marker_r, 2 * marker_r, 2 * marker_r), Qt.AlignmentFlag.AlignCenter,
                   str(index + 1))
        if a.kind == "comment" and a.text:
            f2 = QFont()
            f2.setPixelSize(max(12, round(font_size * 0.9)))
            p.setFont(f2)
            fm = QFontMetricsF(f2)
            bw = fm.horizontalAdvance(a.text) + 20
            bh = font_size + 12
            bx = min(ox + w - bw - 6, x + marker_r + 8)
            by = max(oy + 6, y - bh - 8)
            path = QPainterPath()
            path.addRoundedRect(QRectF(bx, by, bw, bh), 8, 8)
            tail = QPainterPath()
            tail.moveTo(x + marker_r * 0.55, y - marker_r * 0.2)
            tail.lineTo(bx + 8, by + bh)
            tail.lineTo(bx + 18, by + bh)
            tail.closeSubpath()
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(16, 24, 32, 224))
            p.drawPath(path.united(tail))
            p.setPen(QColor("#f8fafc"))
            p.drawText(QRectF(bx + 10, by, bw - 10, bh), Qt.AlignmentFlag.AlignVCenter, a.text)
        p.restore()


class CanvasView(QWidget):
    """Square image stage with axis overlay, scan-path trail and annotation layer."""

    clicked = pyqtSignal(float, float)            # relative point (highlight / comment tools)
    shape_drawn = pyqtSignal(str, float, float, float, float)
    context_requested = pyqtSignal(object, object)  # global pos, annotation id
    annotation_clicked = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(320, 320)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.image: Optional[QImage] = None
        self.figure: Optional[QImage] = None          # server / merged figure (drawn instead of the canvas)
        self.axis: Optional[dict] = None              # {x0,x1,y0,y1,unit,grid}
        self.trail: Optional[tuple] = None            # (edge, cursor, path)
        self.annotations: list = []
        self.selected: Optional[str] = None
        self.editor_enabled = False
        self.tool = "highlight"
        self.draft: Optional[tuple] = None            # (kind, x, y, x2, y2, color, style, width)
        self._press: Optional[QPointF] = None
        self.setMouseTracking(False)

    def sizeHint(self):  # noqa: N802
        return QSize(640, 640)

    def hasHeightForWidth(self):  # noqa: N802
        return True

    def heightForWidth(self, w):  # noqa: N802
        return w

    def image_rect(self) -> QRectF:
        side = min(self.width(), self.height())
        return QRectF((self.width() - side) / 2, 0, side, side)

    def rel(self, pos) -> Optional[tuple]:
        r = self.image_rect()
        if r.width() <= 0:
            return None
        return (min(1.0, max(0.0, (pos.x() - r.left()) / r.width())),
                min(1.0, max(0.0, (pos.y() - r.top()) / r.height())))

    def paintEvent(self, event):  # noqa: N802
        tk = theme.current()
        p = QPainter(self)
        r = self.image_rect()
        p.fillRect(r, QColor(tk.bg_elev))
        if self.figure is not None:
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
            p.drawImage(r, self.figure)
        elif self.image is not None:
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)   # image-rendering: pixelated
            p.drawImage(r, self.image)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if self.trail is not None:
            self._paint_trail(p, r)
        if self.axis is not None:
            self._paint_axis(p, r)
        if self.editor_enabled or self.annotations:
            draw_annotations(p, self.annotations, r.width(), r.height(), ox=r.left(), oy=r.top(),
                             selected=self.selected, scale_markers=False)
        if self.draft is not None:
            kind, x, y, x2, y2, color, style, width = self.draft
            rect = QRectF(r.left() + min(x, x2) * r.width(), r.top() + min(y, y2) * r.height(),
                          abs(x2 - x) * r.width(), abs(y2 - y) * r.height())
            p.setPen(_pen(color, width, style))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRect(rect) if kind == "rectangle" else p.drawEllipse(rect)
        p.end()

    def _paint_axis(self, p: QPainter, r: QRectF) -> None:
        a = self.axis
        axis_color = QColor(95, 184, 255, 230)
        grid_color = QColor(95, 184, 255, 36)
        f = QFont("monospace")
        f.setStyleHint(QFont.StyleHint.Monospace)
        f.setPixelSize(12)
        p.setFont(f)
        minor, major_every = 20, 5
        if a["grid"]:
            p.setPen(QPen(grid_color, 1))
            for i in range(0, minor + 1, major_every):
                x = r.left() + r.width() * i / minor
                y = r.top() + r.height() * i / minor
                p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
                p.drawLine(QPointF(r.left(), y), QPointF(r.right(), y))
        p.setPen(QPen(axis_color, 1))
        p.drawLine(QPointF(r.left(), r.top()), QPointF(r.right(), r.top()))
        p.drawLine(QPointF(r.left(), r.top()), QPointF(r.left(), r.bottom()))
        for i in range(minor + 1):
            major = i % major_every == 0
            x = r.left() + r.width() * i / minor
            y = r.top() + r.height() * i / minor
            p.setPen(QPen(axis_color, 1))
            p.drawLine(QPointF(x, r.top()), QPointF(x, r.top() + (10 if major else 5)))
            p.drawLine(QPointF(r.left(), y), QPointF(r.left() + (10 if major else 5), y))
            if major:
                ratio = i / minor
                xl = format_one_decimal(a["x0"] + (a["x1"] - a["x0"]) * ratio)
                yl = format_one_decimal(a["y0"] + (a["y1"] - a["y0"]) * ratio)
                fm_axis = QFontMetricsF(f)
                tx = min(x + 3, r.right() - fm_axis.horizontalAdvance(xl) - 3)
                ty = max(r.top() + 14, min(y + 4, r.bottom() - 4))
                self._shadow_text(p, QPointF(tx, r.top() + 16 + 10), xl)
                self._shadow_text(p, QPointF(r.left() + 14, ty), yl)
        unit = unit_label(a["unit"])
        start = t("roi.canvas.start", point=f"({format_one_decimal(a['x0'])}, {format_one_decimal(a['y0'])})",
                  unit=unit)
        end = t("roi.canvas.end", point=f"({format_one_decimal(a['x1'])}, {format_one_decimal(a['y1'])})", unit=unit)
        fm = QFontMetricsF(f)
        for text, top in ((start, 12), (end, 34)):
            box = QRectF(r.left() + 12, r.top() + top, fm.horizontalAdvance(text) + 8, 18)
            p.fillRect(box, QColor(0, 0, 0, 51))
            p.setPen(QColor(105, 105, 105))
            p.drawText(box, Qt.AlignmentFlag.AlignCenter, text)

    @staticmethod
    def _shadow_text(p: QPainter, pt: QPointF, text: str) -> None:
        p.setPen(QColor(0, 0, 0, 184))
        p.drawText(pt + QPointF(0, 1), text)
        p.setPen(QColor(230, 238, 249, 242))
        p.drawText(pt, text)

    def _paint_trail(self, p: QPainter, r: QRectF) -> None:
        """``paintVectorScanOrderOverlay`` (drawn at <= 256 px resolution, scaled)."""
        edge, cursor, path = self.trail
        if edge <= 0 or cursor <= 0:
            return
        total = vector_scan_sample_count(edge, path)
        limit = min(cursor, total)
        trail = min(limit, max(24, min(160, edge >> 2)))
        first = limit - trail
        size = min(256, max(1, edge))
        k = r.width() / size

        def to_xy(pt):
            return QPointF(r.left() + (pt[0] / max(1, edge - 1)) * (size - 1) * k,
                           r.top() + (pt[1] / max(1, edge - 1)) * (size - 1) * k)
        path_obj = QPainterPath()
        started = False
        for index in range(first, limit):
            pt = vector_scan_sample_pixel(index, edge, path)
            if pt is None:
                continue
            q = to_xy(pt)
            if not started:
                path_obj.moveTo(q)
                started = True
            else:
                path_obj.lineTo(q)
        p.setPen(QPen(QColor(111, 190, 211, 46), 0.55 * k))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(path_obj)
        cur = vector_scan_sample_pixel(limit - 1, edge, path)
        if cur is None:
            return
        c = to_xy(cur)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(151, 210, 224, 122))
        p.drawEllipse(c, 1.15 * k, 1.15 * k)
        p.setPen(QPen(QColor(151, 210, 224, 107), 0.6 * k))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(c, 1.3 * k, 1.3 * k)
        p.drawLine(c - QPointF(2.3 * k, 0), c + QPointF(2.3 * k, 0))
        p.drawLine(c - QPointF(0, 2.3 * k), c + QPointF(0, 2.3 * k))

    # ---- editor input ---------------------------------------------------------
    def _hit_annotation(self, pos) -> Optional[str]:
        r = self.image_rect()
        for a in reversed(self.annotations):
            if a.kind in ("rectangle", "circle"):
                x2 = a.x2 if a.x2 is not None else a.x
                y2 = a.y2 if a.y2 is not None else a.y
                rect = QRectF(r.left() + a.x * r.width(), r.top() + a.y * r.height(),
                              (x2 - a.x) * r.width(), (y2 - a.y) * r.height())
                if rect.adjusted(-4, -4, 4, 4).contains(pos) and not rect.adjusted(6, 6, -6, -6).contains(pos):
                    return a.id
            else:
                c = QPointF(r.left() + a.x * r.width(), r.top() + a.y * r.height())
                if (c - pos).manhattanLength() <= 18:
                    return a.id
        return None

    def mousePressEvent(self, event):  # noqa: N802
        if not self.editor_enabled:
            return
        pos = event.position()
        if event.button() == Qt.MouseButton.RightButton:
            self.context_requested.emit(event.globalPosition().toPoint(), self._hit_annotation(pos))
            return
        if event.button() != Qt.MouseButton.LeftButton:
            return
        hit = self._hit_annotation(pos)
        if hit is not None:
            self.annotation_clicked.emit(hit)
            return
        rel = self.rel(pos)
        if rel is None:
            return
        if self.tool in ("rectangle", "circle"):
            self._press = pos
            owner = self.parent()
            self.draft = (self.tool, rel[0], rel[1], rel[0], rel[1], owner.stroke_color, owner.line_style,
                          owner.line_width)
            self.update()
        else:
            self.clicked.emit(rel[0], rel[1])

    def mouseMoveEvent(self, event):  # noqa: N802
        if self.draft is None:
            return
        rel = self.rel(event.position())
        if rel is None:
            return
        d = self.draft
        self.draft = (d[0], d[1], d[2], rel[0], rel[1], d[5], d[6], d[7])
        self.update()

    def mouseReleaseEvent(self, event):  # noqa: N802
        if self.draft is None:
            return
        kind, x, y, x2, y2 = self.draft[:5]
        self.draft = None
        self.update()
        self.shape_drawn.emit(kind, x, y, x2, y2)


class MergeConfirmDialog(QDialog):
    def __init__(self, count: int, on_confirm, parent=None):
        super().__init__(parent)
        self.setObjectName("Modal")
        self.setWindowTitle(t("canvas.editor.merge.confirm.title"))
        self.setModal(True)
        lay = QVBoxLayout(self)
        lay.addWidget(label(t("canvas.editor.merge.confirm.title"), "title"))
        lay.addWidget(label(t("canvas.editor.merge.confirm", count=count), wrap=True))
        self.error = label("", "danger", wrap=True)
        self.error.hide()
        lay.addWidget(self.error)
        self.spinner = Spinner(t("canvas.editor.merge.uploading"))
        self.spinner.hide()
        cancel = button(t("settings.confirm.cancel"), "ghost")
        cancel.clicked.connect(self.reject)
        self.ok = button(t("canvas.editor.merge.confirm.yes"), "primary", "save")
        self.ok.clicked.connect(lambda: on_confirm(self))
        self.cancel = cancel
        lay.addLayout(hbox(self.spinner, None, cancel, self.ok))

    def set_busy(self, busy: bool) -> None:
        self.spinner.setVisible(busy)
        self.ok.setEnabled(not busy)
        self.cancel.setEnabled(not busy)
        self.ok.setText(t("canvas.editor.merge.uploading") if busy else t("canvas.editor.merge.confirm.yes"))

    def show_error(self, text: str) -> None:
        self.error.setText(text)
        self.error.show()


class ImageCanvasPanel(Panel):
    TOPICS = frozenset({"scan", "frame:raster", "frame:vector", "frame-complete", "roi", "server-figure",
                        "progress", "vector-gray"})
    rendered_image = pyqtSignal(str, object)      # kind, png bytes | None   (onRenderedImageChange)
    merged_figure = pyqtSignal(str, object)       # kind, png bytes | None   (onMergedFigureChange)

    def __init__(self, ctl, kind: str, parent=None):
        super().__init__(ctl, parent)
        self.kind = kind
        self.stroke_color = "#7cfc00"            # lawngreen
        self.line_style = "solid"
        self.line_width = 0.5
        self.tool = "highlight"
        self.annotations: list = []
        self._seq = 0
        self.merged_png: Optional[bytes] = None
        self.stats = PaintStats()
        self.native_rgba: Optional[np.ndarray] = None
        self._last_paint = 0.0
        self._painted_revision = None
        self._last_emit: Optional[tuple] = None
        self._prev_phase = ctl.scan.phase
        self.vector_gray_selection = None
        self.vector_gray_skipped = None
        self._editor_error: Optional[str] = None

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        # render-mode row (vector default only)
        self.mode_row = QWidget()
        mr = QHBoxLayout(self.mode_row)
        mr.setContentsMargins(0, 0, 0, 0)
        mr.setSpacing(6)
        self.view_label = label("", "title")
        mr.addWidget(self.view_label)
        mr.addWidget(HelpButton("canvasView"))
        self.mode_btns = {}
        for m in ("decimated", "native"):
            b = QPushButton()
            b.setCheckable(True)
            b.setProperty("kind", "seg")
            b.setIcon(icon("scan" if m == "decimated" else "gridSvg", theme.current().accent))
            b.clicked.connect(lambda _c, mode=m: self._set_render_mode(mode))
            self.mode_btns[m] = b
            mr.addWidget(b)
        self.identical_note = label("", "muted")
        mr.addWidget(self.identical_note)
        mr.addStretch(1)
        lay.addWidget(self.mode_row)
        # editor toolbar
        self.toolbar = self._build_toolbar()
        lay.addWidget(self.toolbar)
        # stage
        stage = QHBoxLayout()
        stage.setSpacing(10)
        self.view = CanvasView(self)
        self.view.clicked.connect(self._surface_click)
        self.view.shape_drawn.connect(self._shape_drawn)
        self.view.context_requested.connect(self._context_menu)
        self.view.annotation_clicked.connect(self._select_annotation)
        stage.addWidget(self.view, 1)
        self.wedge = LevelWedge()
        self.wedge.changed.connect(self._wedge_changed)
        self.wedge.auto_requested.connect(lambda: self._set_levels(AUTO_LEVELS))
        stage.addWidget(self.wedge)
        lay.addLayout(stage, 1)
        self.figure_note = label("", "muted", wrap=True)
        lay.addWidget(self.figure_note)
        self.editor_error = label("", "danger", wrap=True)
        lay.addWidget(self.editor_error)
        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setRange(0, 1000)
        self.progress.setFixedHeight(8)
        lay.addWidget(self.progress)
        self.meta = QLabel()
        self.meta.setWordWrap(True)
        self.meta.setTextFormat(Qt.TextFormat.RichText)
        self.meta.setProperty("role", "dim")
        lay.addWidget(self.meta)
        self.retranslate()
        self.refresh()

    # ------------------------------------------------------------------ toolbar
    def _build_toolbar(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self.tool_btns = {}
        for tool, ic in (("highlight", "highlightTool"), ("comment", "commentTool"),
                         ("rectangle", "rectangleTool"), ("circle", "circleTool")):
            b = QToolButton()
            b.setCheckable(True)
            b.setIcon(icon(ic, theme.current().accent))
            b.clicked.connect(lambda _c, tl=tool: self._set_tool(tl))
            self.tool_btns[tool] = b
            lay.addWidget(b)
        self.color_btn = QToolButton()
        self.color_btn.clicked.connect(self._pick_color)
        lay.addWidget(self.color_btn)
        self.style_combo = QComboBox()
        self.style_combo.activated.connect(lambda i: setattr(self, "line_style", self.style_combo.itemData(i)))
        lay.addWidget(self.style_combo)
        self.width_combo = QComboBox()
        for wd in LINE_WIDTHS:
            self.width_combo.addItem(f"{wd}px", wd)
        self.width_combo.activated.connect(lambda i: setattr(self, "line_width", self.width_combo.itemData(i)))
        lay.addWidget(self.width_combo)
        self.merge_btn = QToolButton()
        self.merge_btn.setIcon(icon("save", theme.current().success))
        self.merge_btn.clicked.connect(self._open_merge)
        lay.addWidget(self.merge_btn)
        self.hint = label("", "muted")
        lay.addWidget(self.hint, 1)
        self._update_color_btn()
        return w

    def _update_color_btn(self):
        self.color_btn.setStyleSheet(f"QToolButton {{ background: {self.stroke_color}; min-width: 22px; "
                                     f"border-radius: 4px; }}")

    def _pick_color(self):
        c = QColorDialog.getColor(QColor(self.stroke_color), self, t("canvas.editor.pen.color"))
        if c.isValid():
            self.stroke_color = c.name()
            self._update_color_btn()

    def _set_tool(self, tool: str):
        self.tool = tool
        self.view.tool = tool
        self.view.selected = None
        self.view.draft = None
        self._refresh_toolbar()
        self.view.update()

    # ------------------------------------------------------------------ i18n
    def retranslate(self):
        self.view_label.setText(t("canvas.view"))
        for tool, b in self.tool_btns.items():
            b.setToolTip(t(f"canvas.editor.tool.{tool}"))
        self.color_btn.setToolTip(t("canvas.editor.pen.color"))
        self.style_combo.clear()
        for st in ("solid", "dashed", "dotted"):
            self.style_combo.addItem(t(f"canvas.editor.pen.lineStyle.{st}"), st)
        self.style_combo.setCurrentIndex(("solid", "dashed", "dotted").index(self.line_style))
        self.style_combo.setToolTip(t("canvas.editor.pen.lineStyle"))
        self.width_combo.setToolTip(t("canvas.editor.pen.width"))
        self.width_combo.setCurrentIndex(LINE_WIDTHS.index(self.line_width) if self.line_width in LINE_WIDTHS else 0)
        self.merge_btn.setToolTip(t("canvas.editor.merge"))
        self.wedge.retranslate()

    # ------------------------------------------------------------------ helpers
    def _frame(self):
        return self.ctl.engine.raster if self.kind == "raster" else self.ctl.engine.vector

    def _level_setting(self) -> LevelSetting:
        return self.ctl.level_memory.get(self.kind, AUTO_LEVELS)

    def _set_levels(self, setting: LevelSetting):
        self.ctl.level_memory[self.kind] = setting
        self._paint(force=True)

    def _wedge_changed(self, levels: ResolvedLevels):
        self._set_levels(LevelSetting("manual", levels.low, levels.high))

    def _set_render_mode(self, mode: str):
        self.ctl.scan.vectorRenderMode = mode
        self.ctl.notify("scan", "render-mode")
        self._paint(force=True)

    def set_vector_gray(self, selection, skipped):
        self.vector_gray_selection = selection
        self.vector_gray_skipped = skipped
        self._paint(force=True)

    def _completed_kind(self):
        s = self.ctl.scan
        return (s.lastOutput or {}).get("kind") or (s.lastResult or {}).get("kind")

    def _has_live_data(self) -> bool:
        if self.kind == "raster":
            return self.ctl.engine.raster.cursor > 0
        v = self.ctl.engine.vector
        return v.source == "vector" and v.cursor > 0

    def _show_server_figure(self) -> bool:
        s = self.ctl.scan
        return (s.phase == "completed" and self._completed_kind() == self.kind
                and (self.kind != "vector" or self.ctl.engine.vector.source == "vector"))

    def _server_png(self) -> Optional[bytes]:
        value = self.ctl.server_figure.get(self.kind)
        return value if isinstance(value, (bytes, bytearray)) else None

    def _displayed_figure(self) -> Optional[bytes]:
        if self.merged_png:
            return self.merged_png
        server = self._server_png()
        if server and self._show_server_figure() and not self._has_live_data():
            return server
        return None

    @property
    def editor_enabled(self) -> bool:
        return self.ctl.scan.phase == "completed" and (self.stats.populated > 0 or bool(self._displayed_figure()))

    # ------------------------------------------------------------------ painting
    def _paint(self, force: bool = False) -> None:
        now = time.perf_counter()
        frame = self._frame()
        rev = (frame.revision, self.ctl.scan.vectorRenderMode, self._level_setting(), self.vector_gray_selection,
               self.vector_gray_skipped, theme.current_name())
        if not force and rev == self._painted_revision:
            return
        if not force and self.ctl.scan_active and now - self._last_paint < PAINT_INTERVAL_S:
            return
        self._last_paint = now
        self._painted_revision = rev
        setting = self._level_setting()
        if self.kind == "raster":
            view = frame.view()
            rgba, stats = paint_grayscale(view.frame, view.edge, view.cursor, setting, view.value_counts)
        else:
            v = frame
            with v.lock:
                image, edge, cursor, pattern = v.image, v.edge, v.cursor, v.pattern
                index_map, render_index = v.index_map, v.custom_render_index
                blank, spot, source, counts = v.custom_blank, v.custom_spot, v.source, v.value_counts
            if source != "vector":
                rgba, stats = np.zeros((edge, edge, 4), dtype=np.uint8), PaintStats()
            elif pattern == "default" and index_map is not None:
                sel = self.vector_gray_selection
                skipped = self.vector_gray_skipped if sel is not None else None
                color = ROI_ACTION_BLANK_COLOR if sel is not None else (
                    ROI_ACTION_HIGHLIGHT_COLOR if skipped is False else ROI_ACTION_BLANK_COLOR)
                rgba, stats = paint_vector_default(image, edge, cursor, index_map, sel, skipped, color, setting,
                                                   counts)
            elif render_index is not None:
                color = ROI_ACTION_BLANK_COLOR if self.vector_gray_selection is not None else (
                    ROI_ACTION_HIGHLIGHT_COLOR if self.vector_gray_skipped is False else ROI_ACTION_BLANK_COLOR)
                rgba, stats = paint_vector_custom(image, edge, render_index, cursor, blank, spot, color, setting)
            else:
                rgba, stats = paint_grayscale(image, edge, cursor, setting)
        self.stats = stats
        self.native_rgba = rgba
        self.view.image = rgba_to_qimage(rgba)
        self._update_overlays()
        self.wedge.set_state(stats.histogram, ResolvedLevels(stats.low, stats.high), setting.mode == "auto",
                             not stats.histogram or stats.histogram.total <= 0 or bool(self._displayed_figure()))
        self.view.update()
        self._update_meta()

    def native_image_rgba(self) -> Optional[np.ndarray]:
        """Canvas pixels at the web canvas' size (native block fill when selected)."""
        if self.native_rgba is None:
            return None
        v = self.ctl.engine.vector
        if (self.kind == "vector" and v.pattern == "default" and self.ctl.scan.vectorRenderMode == "native"
                and v.edge < DAC_RANGE):
            return block_fill(self.native_rgba)
        return self.native_rgba

    def _update_overlays(self) -> None:
        roi = self.ctl.scan.roi
        grid = roi.raster_show_grid if self.kind == "raster" else roi.vector_show_grid
        self.view.axis = {"x0": roi.x_origin, "x1": roi.x_end, "y0": roi.y_origin, "y1": roi.y_end,
                          "unit": roi.scale_unit, "grid": grid}
        v = self.ctl.engine.vector
        show_path = self.kind == "vector" and v.pattern == "default" and roi.vector_show_scan_path
        cursor = v.cursor if v.source == "vector" else 0
        self.view.trail = (v.edge, cursor, v.scan_path) if show_path else None
        fig = self._displayed_figure()
        self.view.figure = png_to_qimage(fig) if fig else None

    # ------------------------------------------------------------------ refresh
    def refresh(self):
        s = self.ctl.scan
        phase = s.phase
        if phase != self._prev_phase:
            if phase in ("idle", "running", "error"):
                self._clear_editor()
            self._prev_phase = phase
        v = self.ctl.engine.vector
        self.mode_row.setVisible(self.kind == "vector" and v.pattern == "default")
        edge = s.vector["vector_resolution"] if (self.kind == "vector" and v.pattern == "default") else v.edge
        stride = max(1, DAC_RANGE // edge) if edge else 1
        exact = edge > 0 and DAC_RANGE % edge == 0
        for m, b in self.mode_btns.items():
            b.setChecked(s.vectorRenderMode == m)
            b.setText(t("canvas.view.decimated", edge=edge) if m == "decimated" else
                      t("canvas.view.native", edge=DAC_RANGE))
            b.setToolTip(t("canvas.view.decimated.title", edge=edge) if m == "decimated" else
                         t("canvas.view.native.title", edge=DAC_RANGE, stride=stride) if exact else
                         t("canvas.view.native.title.custom", edge=DAC_RANGE, sourceEdge=edge))
        self.identical_note.setText(t("canvas.view.identical") if edge == DAC_RANGE else "")
        self._paint()
        self._update_overlays()
        self.view.update()
        self._refresh_toolbar()
        self._update_meta()
        # server figure note
        if self._show_server_figure() and not self._server_png() and not self.merged_png:
            state = self.ctl.server_figure.get(self.kind)
            if state == "busy":
                self.figure_note.setText(t("canvas.serverFigure.rendering"))
            elif isinstance(state, tuple):
                self.figure_note.setText(t("canvas.serverFigure.unavailable", detail=state[1]))
            else:
                self.figure_note.setText(t("canvas.serverFigure.livePreview"))
            self.figure_note.show()
        else:
            self.figure_note.hide()
        self.editor_error.setText(self._editor_error or "")
        self.editor_error.setVisible(bool(self._editor_error))
        self._emit_rendered()

    def _refresh_toolbar(self) -> None:
        visible = self.ctl.scan.phase == "completed" and (self.stats.populated > 0 or bool(self._displayed_figure()))
        self.toolbar.setVisible(visible)
        self.view.editor_enabled = visible
        self.view.annotations = self.annotations
        for tool, b in self.tool_btns.items():
            b.setChecked(tool == self.tool)
        self.merge_btn.setEnabled(bool(self.annotations))
        if self.annotations:
            hint = t("canvas.editor.pending", count=len(self.annotations))
        elif self.merged_png:
            hint = t("canvas.editor.mergedReady")
        else:
            hint = t(f"canvas.editor.instructions.{self.tool}")
        self.hint.setText(hint)

    def _emit_rendered(self) -> None:
        if self.kind not in ("raster", "vector"):
            return
        if not self._has_live_data():
            self._emit(None)
            return
        if self.ctl.scan.phase != "completed":
            return
        self._paint(force=True)
        rgba = self.native_image_rgba()
        if rgba is None:
            return
        key = (self._frame().revision, self.ctl.scan.vectorRenderMode, self._level_setting())
        if self._last_emit and self._last_emit[0] == key:
            return
        png = qimage_to_png(rgba_to_qimage(rgba))
        self._last_emit = (key, png)
        self.rendered_image.emit(self.kind, png)

    def _emit(self, png):
        if self._last_emit and self._last_emit[1] is png:
            return
        self._last_emit = (None, png)
        self.rendered_image.emit(self.kind, png)

    def _update_meta(self) -> None:
        s = self.ctl.scan
        v = self.ctl.engine.vector
        r = self.ctl.engine.raster
        roi = s.roi
        phase_label = t(f"phase.{s.phase}")
        if self.kind == "raster":
            native = r.resolution
            total = r.resolution * r.resolution
            cursor = r.cursor
        else:
            visible_cursor = v.cursor if v.source == "vector" else 0
            if v.pattern == "default" and s.vectorRenderMode == "native" and v.edge and DAC_RANGE // max(1, s.vector[
                    "vector_resolution"]) > 1:
                native = DAC_RANGE
            else:
                native = v.edge
            total = 0 if v.source != "vector" else (vector_scan_sample_count(v.edge, v.scan_path)
                                                    if v.pattern == "default" else v.custom_count)
            cursor = visible_cursor
        pct = min(100.0, cursor / total * 100) if total > 0 else (100.0 if s.phase == "completed" else 0.0)
        self.progress.setValue(int(pct * 10))
        region = roi.selection or {"x_start": roi.x_origin, "x_end": roi.x_end, "y_start": roi.y_origin,
                                   "y_end": roi.y_end}
        parts = [f"{t('canvas.meta.phase')} <b>{phase_label}</b>",
                 f"{t('canvas.meta.chunks')} <b>{fmt(s.chunksReceived)}</b>",
                 f"{t('canvas.meta.bytes')} <b>{fmt(s.bytesReceived)}</b>",
                 f"{t('canvas.meta.resolution')} <b>{fmt(native)}×{fmt(native)}</b>"]
        if self.kind == "raster":
            parts.append(f"{t('canvas.meta.pixels')} <b>{fmt(cursor)} / {fmt(total)}</b>")
        else:
            parts.append(f"{t('canvas.meta.samples')} <b>{fmt(cursor)}{' / ' + fmt(total) if total > 0 else ''}</b>")
            pat = t("vector.pattern.default") if v.pattern == "default" else t("vector.pattern.custom")
            if v.pattern == "default":
                pat += f" {v.edge}×{v.edge}"
            parts.append(f"<span style='font-size:11px'>{pat}</span>")
        parts.append(f"{t('canvas.meta.roi')} <b>{format_point(region['x_start'], region['y_start'], roi.scale_unit)}"
                     f" → {format_point(region['x_end'], region['y_end'], roi.scale_unit)}</b>")
        cur = self._current_beam(region)
        if cur:
            parts.append(f"{t('canvas.meta.beam')} <b>{format_point(cur[0], cur[1], roi.scale_unit)}</b>")
            parts.append(f"{t('canvas.meta.adcNow')} <b>{cur[2]}</b>")
        if self.stats.populated > 0:
            parts.append(f"{t('canvas.meta.adcRange')} <b>{self.stats.min}..{self.stats.max}</b>")
        self.meta.setText(" &nbsp;·&nbsp; ".join(parts))

    def _current_beam(self, region) -> Optional[tuple]:
        def lerp(a, b, u):
            return a + (b - a) * u
        if self.kind == "raster":
            r = self.ctl.engine.raster
            if r.cursor <= 0 or r.resolution <= 0:
                return None
            idx = min(r.cursor, r.frame.size) - 1
            col, row = idx % r.resolution, idx // r.resolution
            d = max(1, r.resolution - 1)
            return (lerp(region["x_start"], region["x_end"], col / d), lerp(region["y_start"], region["y_end"], row / d),
                    int(r.frame[idx]))
        v = self.ctl.engine.vector
        cursor = v.cursor if v.source == "vector" else 0
        if cursor <= 0 or v.edge <= 0:
            return None
        idx = cursor - 1
        if v.pattern == "custom" and v.custom_points is not None:
            if idx >= v.custom_count:
                return None
            x, y = int(v.custom_points[idx, 0]), int(v.custom_points[idx, 1])
            rc = int(v.custom_render[idx, 0]) if v.custom_render is not None else x
            rr = int(v.custom_render[idx, 1]) if v.custom_render is not None else y
            rc, rr = max(0, min(v.edge - 1, rc)), max(0, min(v.edge - 1, rr))
            return (x, y, int(v.image[rr * v.edge + rc]))
        pt = vector_scan_sample_pixel(idx, v.edge, v.scan_path)
        if pt is None:
            return None
        d = max(1, v.edge - 1)
        return (lerp(region["x_start"], region["x_end"], pt[0] / d), lerp(region["y_start"], region["y_end"], pt[1] / d),
                int(v.image[pt[1] * v.edge + pt[0]]))

    # ------------------------------------------------------------------ editor
    def _next_id(self) -> str:
        self._seq += 1
        return f"annotation-{self._seq}"

    def _clear_editor(self) -> None:
        self._seq = 0
        self.annotations = []
        self.view.selected = None
        self.view.draft = None
        self._editor_error = None
        self.merged_png = None
        self.merged_figure.emit(self.kind, None)

    def _invalidate_merged(self) -> None:
        self.merged_png = None
        self.merged_figure.emit(self.kind, None)

    def _surface_click(self, x: float, y: float) -> None:
        if not self.editor_enabled:
            return
        self.view.selected = None
        self._editor_error = None
        if self.tool == "comment":
            text = self._ask_comment()
            if text:
                ann = Annotation(self._next_id(), "comment", x, y, color=self.stroke_color,
                                 line_style=self.line_style, line_width=self.line_width, text=text)
                self.annotations.append(ann)
                self.view.selected = ann.id
        elif self.tool == "highlight":
            ann = Annotation(self._next_id(), "highlight", x, y, color=self.stroke_color,
                             line_style=self.line_style, line_width=self.line_width)
            self.annotations.append(ann)
            self.view.selected = ann.id
        self._refresh_toolbar()
        self.view.update()

    def _ask_comment(self) -> str:
        dlg = QDialog(self)
        dlg.setObjectName("Modal")
        dlg.setWindowTitle(t("canvas.editor.tool.comment"))
        lay = QVBoxLayout(dlg)
        edit = QLineEdit()
        edit.setPlaceholderText(t("canvas.editor.comment.placeholder"))
        lay.addWidget(edit)
        save = button(t("canvas.editor.comment.save"), "ghost")
        cancel = button(t("canvas.editor.comment.cancel"), "ghost")
        save.clicked.connect(dlg.accept)
        cancel.clicked.connect(dlg.reject)
        edit.returnPressed.connect(dlg.accept)
        lay.addLayout(hbox(None, save, cancel))
        return edit.text().strip() if dlg.exec() == QDialog.DialogCode.Accepted else ""

    def _shape_drawn(self, kind: str, x: float, y: float, x2: float, y2: float) -> None:
        x0, x1, y0, y1 = min(x, x2), max(x, x2), min(y, y2), max(y, y2)
        if abs(x1 - x0) < 0.008 or abs(y1 - y0) < 0.008:
            return
        ann = Annotation(self._next_id(), kind, x0, y0, x1, y1, self.stroke_color, self.line_style, self.line_width)
        self.annotations.append(ann)
        self.view.selected = ann.id
        self._refresh_toolbar()
        self.view.update()

    def _select_annotation(self, ann_id: str) -> None:
        self.view.selected = ann_id
        self.view.update()

    def _context_menu(self, global_pos, ann_id) -> None:
        self.view.selected = ann_id
        target = ann_id or self.view.selected
        menu = QMenu(self)
        undo = menu.addAction(t("canvas.editor.context.undo"))
        undo.setEnabled(bool(self.annotations))
        remove = menu.addAction(t("canvas.editor.context.remove"))
        remove.setEnabled(bool(target))
        clear = menu.addAction(t("canvas.editor.context.clear"))
        clear.setEnabled(bool(self.annotations))
        chosen = menu.exec(global_pos)
        if chosen is undo:
            self.undo()
        elif chosen is remove:
            self.annotations = [a for a in self.annotations if a.id != target]
            self.view.selected = None
            self._invalidate_merged()
        elif chosen is clear:
            self.annotations = []
            self.view.selected = None
            self._invalidate_merged()
        self._refresh_toolbar()
        self.view.update()

    def undo(self) -> None:
        if not self.editor_enabled:
            return
        self.annotations = self.annotations[:-1]
        self.view.selected = self.annotations[-1].id if self.annotations else None
        self._invalidate_merged()
        self._refresh_toolbar()
        self.view.update()

    def keyPressEvent(self, event):  # noqa: N802
        if (event.modifiers() & Qt.KeyboardModifier.ControlModifier) and event.key() == Qt.Key.Key_Z:
            self.undo()
            return
        super().keyPressEvent(event)

    def _open_merge(self) -> None:
        if not self.annotations:
            return
        dlg = MergeConfirmDialog(len(self.annotations), self._merge, self)
        dlg.exec()

    def _merge(self, dlg: MergeConfirmDialog) -> None:
        dlg.set_busy(True)
        try:
            fig = self._displayed_figure()
            if fig:
                base = png_to_qimage(fig)
            else:
                rgba = self.native_image_rgba()
                base = rgba_to_qimage(rgba) if rgba is not None else None
            if base is None:
                raise RuntimeError(t("canvas.editor.merge.error"))
            img = base.convertToFormat(QImage.Format.Format_ARGB32)
            p = QPainter(img)
            p.setRenderHint(QPainter.RenderHint.Antialiasing)
            draw_annotations(p, self.annotations, img.width(), img.height())
            p.end()
            png = qimage_to_png(img)
        except Exception as exc:  # noqa: BLE001
            self._editor_error = str(exc) or t("canvas.editor.merge.error")
            dlg.set_busy(False)
            dlg.show_error(self._editor_error)
            return
        self.merged_png = png
        self.annotations = []
        self._editor_error = None
        self.merged_figure.emit(self.kind, png)
        filename = ((self.ctl.scan.lastOutput or {}).get("image_filename") if
                    (self.ctl.scan.lastOutput or {}).get("kind") == self.kind else None) or \
                   ((self.ctl.scan.lastResult or {}).get("image_filename") if
                    (self.ctl.scan.lastResult or {}).get("kind") == self.kind else None)
        body = {"kind": self.kind, "data_url": png_data_url(png), "filename": (filename or "").strip() or None}

        def upload():
            r = self.ctl.backend.request("POST", "/api/admin/ftp/merged-figure", json_body=body, timeout=60)
            if r.status_code >= 400:
                raise RuntimeError(r.text or f"HTTP {r.status_code}")

        def ok(_):
            dlg.set_busy(False)
            dlg.accept()
            self.refresh()

        def err(exc):
            dlg.set_busy(False)
            self._editor_error = str(exc) or t("canvas.editor.merge.error")
            dlg.show_error(self._editor_error)
            self.refresh()
        run_bg(upload, on_ok=ok, on_err=err)
        self._paint(force=True)
