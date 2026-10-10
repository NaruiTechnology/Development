"""OBI-style level wedge (port of components/LevelWedge.tsx).

axis ticks | histogram | gradient bar | handles. Top handle (filled) = white
level, bottom handle (hollow) = black level. Drag a handle, drag the band
between them, double-click (or Auto) for automatic levels; handles take
arrow keys (Shift = x16) and Home / End when focused.
"""
from __future__ import annotations

from typing import Optional

from PyQt6.QtCore import QPointF, QRectF, Qt, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QLinearGradient, QPainter, QPainterPath, QPen, QPolygonF
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QSizePolicy, QVBoxLayout, QWidget

from ..core.display_levels import (
    MIN_LEVEL_GAP, OBI_FULL_SCALE, LevelHistogram, ResolvedLevels, code_to_sample, drag_levels,
    fraction_to_value, nice_code_ticks, normalize_levels, sample_to_code, value_to_fraction, wedge_domain,
)
from ..i18n import t
from . import theme
from .common import HelpButton


class _WedgePlot(QWidget):
    AXIS_W = 40
    HIST_W = 34
    BAR_W = 16
    HANDLE_W = 10

    def __init__(self, owner: "LevelWedge"):
        super().__init__()
        self.owner = owner
        self.setMinimumWidth(self.AXIS_W + self.HIST_W + self.BAR_W + self.HANDLE_W + 4)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._drag = None
        self.focused_handle = "high"

    # geometry -------------------------------------------------------------
    def _plot_rect(self) -> QRectF:
        return QRectF(0, 8, self.width(), max(10, self.height() - 16))

    def _y_for(self, frac: float) -> float:
        r = self._plot_rect()
        return r.bottom() - frac * r.height()

    def _value_at(self, y: float) -> float:
        r = self._plot_rect()
        frac = 1 - (y - r.top()) / r.height() if r.height() > 0 else 0
        return fraction_to_value(frac, self.owner.domain)

    def _bar_x(self) -> float:
        return self.AXIS_W + self.HIST_W

    # painting -------------------------------------------------------------
    def paintEvent(self, event):  # noqa: N802
        o = self.owner
        tk = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = self._plot_rect()
        dom = o.domain
        # axis ticks
        p.setPen(QColor(tk.text_dim))
        f = p.font()
        f.setPointSizeF(7.5)
        p.setFont(f)
        for tick in nice_code_ticks(dom, 7, o.code_divisor):
            y = self._y_for(value_to_fraction(code_to_sample(tick, o.code_divisor), dom))
            p.drawText(QRectF(0, y - 7, self.AXIS_W - 4, 14),
                       Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, str(tick))
            p.drawLine(QPointF(self.AXIS_W - 3, y), QPointF(self.AXIS_W, y))
        # histogram
        hist = o.histogram
        hx0 = self.AXIS_W
        if hist is not None and hist.total > 0:
            bins = hist.bins
            peak = float(bins.max()) if len(bins) else 0.0
            if peak > 0:
                bw = (hist.max - hist.min) / (len(bins) - 1) if hist.max > hist.min else 0
                path = QPainterPath()
                for i, count in enumerate(bins):
                    if count == 0:
                        continue
                    y0 = 1 - value_to_fraction(hist.min + i * bw, dom)
                    y1 = 1 - value_to_fraction(hist.min + (i + 1) * bw, dom)
                    top = min(y0, y1)
                    height = max(abs(y1 - y0), 0.002)
                    x = 1 - count / peak
                    path.addRect(QRectF(hx0 + x * self.HIST_W, r.top() + top * r.height(),
                                        (1 - x) * self.HIST_W, height * r.height()))
                p.fillPath(path, QColor(tk.accent))
        # gradient bar
        bx = self._bar_x()
        low_f = value_to_fraction(o.levels.low, dom)
        high_f = value_to_fraction(o.levels.high, dom)
        grad = QLinearGradient(0, r.bottom(), 0, r.top())
        grad.setColorAt(0.0, QColor("#000"))
        grad.setColorAt(max(0.0, min(1.0, low_f)), QColor("#000"))
        grad.setColorAt(max(0.0, min(1.0, high_f)), QColor("#fff"))
        grad.setColorAt(1.0, QColor("#fff"))
        p.fillRect(QRectF(bx, r.top(), self.BAR_W, r.height()), QBrush(grad))
        p.setPen(QPen(QColor(tk.border), 1))
        p.drawRect(QRectF(bx, r.top(), self.BAR_W, r.height()))
        # region band + lines
        yl, yh = self._y_for(low_f), self._y_for(high_f)
        p.fillRect(QRectF(hx0, yh, self.HIST_W + self.BAR_W, max(0.0, yl - yh)), QColor(95, 184, 255, 28))
        accent = QColor(tk.accent)
        p.setPen(QPen(accent, 1))
        p.drawLine(QPointF(hx0, yh), QPointF(bx + self.BAR_W, yh))
        p.drawLine(QPointF(hx0, yl), QPointF(bx + self.BAR_W, yl))
        # handles (filled = white level, hollow = black level)
        hx = bx + self.BAR_W + 1
        for y, filled, name in ((yh, True, "high"), (yl, False, "low")):
            tri = QPolygonF([QPointF(hx, y), QPointF(hx + self.HANDLE_W, y - 6), QPointF(hx + self.HANDLE_W, y + 6)])
            p.setPen(QPen(accent.lighter(130) if (self.hasFocus() and self.focused_handle == name) else accent, 1.4))
            p.setBrush(accent if filled else Qt.BrushStyle.NoBrush)
            p.drawPolygon(tri)
        if o.disabled:
            p.fillRect(self.rect(), QColor(0, 0, 0, 90))
        p.end()

    # interaction ------------------------------------------------------------
    def _hit(self, pos) -> Optional[str]:
        o = self.owner
        low_y = self._y_for(value_to_fraction(o.levels.low, o.domain))
        high_y = self._y_for(value_to_fraction(o.levels.high, o.domain))
        x = pos.x()
        if x >= self._bar_x() - 4:
            if abs(pos.y() - high_y) <= 7:
                return "high"
            if abs(pos.y() - low_y) <= 7:
                return "low"
        if x >= self.AXIS_W and high_y <= pos.y() <= low_y:
            return "region"
        return None

    def mousePressEvent(self, event):  # noqa: N802
        o = self.owner
        if o.disabled or event.button() != Qt.MouseButton.LeftButton:
            return
        kind = self._hit(event.position())
        if kind is None:
            return
        if kind in ("low", "high"):
            self.focused_handle = kind
        value = self._value_at(event.position().y())
        anchor = o.levels.low if kind in ("low", "region") else o.levels.high
        self._drag = (kind, o.levels, value - anchor)

    def mouseMoveEvent(self, event):  # noqa: N802
        o = self.owner
        if self._drag is None:
            kind = self._hit(event.position())
            self.setCursor(Qt.CursorShape.SizeVerCursor if kind else Qt.CursorShape.ArrowCursor)
            self.setToolTip({"high": f"{t('canvas.wedge.white')}: {sample_to_code(o.levels.high, o.code_divisor)}",
                             "low": f"{t('canvas.wedge.black')}: {sample_to_code(o.levels.low, o.code_divisor)}",
                             "region": t("canvas.wedge.region")}.get(kind, t("canvas.wedge.hint")))
            return
        kind, start, offset = self._drag
        o.emit_change(drag_levels(kind, start, self._value_at(event.position().y()), offset, o.full_scale))

    def mouseReleaseEvent(self, event):  # noqa: N802
        self._drag = None

    def mouseDoubleClickEvent(self, event):  # noqa: N802
        if not self.owner.disabled:
            self.owner.auto_requested.emit()

    def keyPressEvent(self, event):  # noqa: N802
        o = self.owner
        if o.disabled:
            return
        big = 16 if event.modifiers() & Qt.KeyboardModifier.ShiftModifier else 1
        key = event.key()
        if key in (Qt.Key.Key_Up, Qt.Key.Key_Right):
            delta = 1
        elif key in (Qt.Key.Key_Down, Qt.Key.Key_Left):
            delta = -1
        elif key == Qt.Key.Key_Home:
            delta = -1e6
        elif key == Qt.Key.Key_End:
            delta = 1e6
        elif key == Qt.Key.Key_Tab:
            self.focused_handle = "low" if self.focused_handle == "high" else "high"
            self.update()
            return
        else:
            return super().keyPressEvent(event)
        step = code_to_sample(delta * big, o.code_divisor)
        lv = o.levels
        if self.focused_handle == "low":
            nxt = normalize_levels(min(lv.low + step, lv.high - MIN_LEVEL_GAP), lv.high, o.full_scale)
        else:
            nxt = normalize_levels(lv.low, max(lv.high + step, lv.low + MIN_LEVEL_GAP), o.full_scale)
        o.emit_change(nxt)


class LevelWedge(QWidget):
    changed = pyqtSignal(object)        # ResolvedLevels
    auto_requested = pyqtSignal()

    def __init__(self, *, full_scale: float = OBI_FULL_SCALE, code_divisor: float = 4, parent=None):
        super().__init__(parent)
        self.full_scale = full_scale
        self.code_divisor = code_divisor
        self.histogram: Optional[LevelHistogram] = None
        self.levels = ResolvedLevels(0, full_scale)
        self.auto = True
        self.disabled = True
        self.domain = (0.0, float(full_scale))
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 0, 0, 0)
        lay.setSpacing(4)
        self.plot = _WedgePlot(self)
        lay.addWidget(self.plot, 1)
        self.readout_high = QLabel()
        self.readout_low = QLabel()
        for w in (self.readout_high, self.readout_low):
            w.setProperty("role", "muted")
            w.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lay.addWidget(w)
        row = QHBoxLayout()
        row.setSpacing(4)
        self.auto_btn = QPushButton(t("canvas.wedge.auto"))
        self.auto_btn.setCheckable(True)
        self.auto_btn.setProperty("kind", "ghost")
        self.auto_btn.clicked.connect(lambda: self.auto_requested.emit())
        row.addWidget(self.auto_btn)
        self.help = HelpButton("wedge", title_key="canvas.wedge.help.title",
                               html=lambda: f"<p>{t('canvas.wedge.help.body')}</p>")
        self.help.aria_key = "canvas.wedge.help.aria"
        self.help.retranslate()
        row.addWidget(self.help)
        lay.addLayout(row)
        self.setFixedWidth(118)
        self.retranslate()

    def retranslate(self) -> None:
        self.auto_btn.setText(t("canvas.wedge.auto"))
        self.auto_btn.setToolTip(t("canvas.wedge.autoTitle"))
        self.setToolTip(t("canvas.wedge.label"))
        self._update_readout()

    def emit_change(self, levels: ResolvedLevels) -> None:
        self.changed.emit(levels)

    def set_state(self, histogram: Optional[LevelHistogram], levels: ResolvedLevels, auto: bool, disabled: bool):
        self.histogram = histogram
        self.levels = levels
        self.auto = auto
        self.disabled = disabled
        empty = LevelHistogram(0, 0, 0, __import__("numpy").zeros(1, dtype="int64"))
        self.domain = wedge_domain(histogram or empty, levels, self.full_scale)
        self.auto_btn.setChecked(auto)
        self.auto_btn.setEnabled(not disabled)
        self._update_readout()
        self.plot.update()

    def _update_readout(self) -> None:
        self.readout_high.setText(f"▲ {sample_to_code(self.levels.high, self.code_divisor)}")
        self.readout_low.setText(f"▽ {sample_to_code(self.levels.low, self.code_divisor)}")
        self.readout_high.setToolTip(t("canvas.wedge.white"))
        self.readout_low.setToolTip(t("canvas.wedge.black"))
