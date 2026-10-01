"""Gray-level tools from App.tsx: GrayScaleSpectrum, VectorGrayLevelSelector and
GrayScaleConfirmDialog."""
from __future__ import annotations

from typing import Callable, Optional

from PyQt6.QtCore import QPointF, QRectF, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QPainter, QPen
from PyQt6.QtWidgets import (
    QButtonGroup, QDialog, QHBoxLayout, QLabel, QPushButton, QRadioButton, QSizePolicy, QVBoxLayout, QWidget,
)

from ..core.helpers import format_gray_scale_selection
from ..core.jsmath import js_round
from ..i18n import t
from . import theme
from .common import HelpButton, NumberStepper, button, label


def clamp_step_delta(value) -> int:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 10
    if n != n:
        return 10
    return max(1, min(255, js_round(n)))


def build_gray_scale_boxes(levels: list, step_delta: int, selected) -> list:
    """``buildGrayScaleBoxes``."""
    if not levels:
        return []
    delta = clamp_step_delta(step_delta)
    count = max(1, min(len(levels), delta))
    if count == 1:
        return [levels[(len(levels) - 1) // 2]]
    if count == len(levels):
        return list(levels)
    boxes: list = []
    last = len(levels) - 1
    for i in range(count):
        value = levels[js_round(i * last / (count - 1))]
        if not boxes or boxes[-1] != value:
            boxes.append(value)
    if boxes[0] != levels[0]:
        boxes.insert(0, levels[0])
    if boxes[-1] != levels[last]:
        boxes.append(levels[last])
    if selected is not None:
        start = max(0, min(255, min(selected[0], selected[1])))
        end = max(0, min(255, max(selected[0], selected[1])))
        boxes += [start, end]
    return sorted(set(boxes))


class GrayScaleSpectrum(QWidget):
    select = pyqtSignal(int)
    step_delta_changed = pyqtSignal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        top = QHBoxLayout()
        self.chain = QHBoxLayout()
        self.chain.setSpacing(2)
        top.addLayout(self.chain, 1)
        self.source = QLabel()
        self.source.setObjectName("Pill")
        top.addWidget(self.source)
        lay.addLayout(top)
        self.note = label("", "muted", wrap=True)
        lay.addWidget(self.note)
        ctl = QHBoxLayout()
        self.stepper = NumberStepper(10, step=1, minimum=1, maximum=255, width=60)
        self.stepper.valueChanged.connect(lambda s: self.step_delta_changed.emit(clamp_step_delta(s)))
        self.stepper.setToolTip("Gray level box count")
        ctl.addWidget(self.stepper)
        ctl.addWidget(HelpButton("grayScale"))
        ctl.addStretch(1)
        lay.addLayout(ctl)
        self._buttons: list = []

    def set_state(self, *, selected, anchor, levels, step_delta, source_label, scope_note):
        for b in self._buttons:
            b.deleteLater()
        self._buttons = []
        boxes = build_gray_scale_boxes(levels, step_delta, selected)
        lo = min(selected) if selected else None
        hi = max(selected) if selected else None
        for g in boxes:
            b = QPushButton(str(g))
            b.setFixedSize(34, 28)
            sel = lo is not None and lo <= g <= hi
            endpoint = None
            if lo is not None:
                endpoint = "both" if g == lo == hi else "start" if g == lo else "end" if g == hi else None
            fg = "#f8fafc" if g < 140 else "#101820"
            border = theme.current().accent if sel else theme.current().border
            width = 3 if endpoint else (2 if sel else 1)
            if anchor is not None and g == anchor:
                border, width = "#facc15", 3
            b.setStyleSheet(f"QPushButton {{ background: rgb({g},{g},{g}); color: {fg}; border: {width}px solid "
                            f"{border}; border-radius: 4px; padding: 0; font-size: 10px; }}")
            b.setToolTip({"start": f"Start gray level {g}", "end": f"End gray level {g}",
                          "both": f"Gray level {g} (start and end)"}.get(endpoint, f"Gray level {g}"))
            b.clicked.connect(lambda _c, v=g: self.select.emit(v))
            self.chain.addWidget(b)
            self._buttons.append(b)
        self.source.setText(source_label or "")
        self.source.setVisible(bool(source_label))
        self.note.setText(scope_note or "")
        self.note.setVisible(bool(scope_note))
        if not self.stepper.edit.hasFocus():
            self.stepper.force_value(step_delta)


class _RangeSlider(QWidget):
    changed = pyqtSignal(int, int)
    committed = pyqtSignal()

    def __init__(self):
        super().__init__()
        self.lo, self.hi = 0, 255
        self.setMinimumSize(300, 52)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._drag: Optional[str] = None
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._focus = "lo"

    def _x(self, v):
        return 10 + (self.width() - 20) * v / 255

    def _v(self, x):
        return max(0, min(255, js_round((x - 10) / max(1, self.width() - 20) * 255)))

    def paintEvent(self, e):  # noqa: N802
        tk = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        y = 22
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(tk.border))
        p.drawRoundedRect(QRectF(10, y - 2, self.width() - 20, 4), 2, 2)
        p.setBrush(QColor(tk.accent))
        p.drawRect(QRectF(self._x(self.lo), y - 2, self._x(self.hi) - self._x(self.lo), 4))
        f = QFont()
        f.setPixelSize(9)
        p.setFont(f)
        for v in range(5, 256, 5):
            if v % 20 and v != 255:
                p.setPen(QPen(QColor(tk.text_muted), 1))
                p.drawLine(QPointF(self._x(v), y + 5), QPointF(self._x(v), y + 8))
        for v in list(range(0, 241, 20)) + [255]:
            p.setPen(QPen(QColor(tk.text_dim), 1))
            p.drawLine(QPointF(self._x(v), y + 5), QPointF(self._x(v), y + 11))
            p.drawText(QRectF(self._x(v) - 12, y + 12, 24, 12), Qt.AlignmentFlag.AlignCenter, str(v))
        for v, name in ((self.lo, "lo"), (self.hi, "hi")):
            p.setBrush(QColor(tk.accent_hot if self._focus == name and self.hasFocus() else tk.accent))
            p.setPen(QPen(QColor("#fff"), 1))
            p.drawEllipse(QPointF(self._x(v), y), 7, 7)
            p.setPen(QColor(tk.text))
            p.drawText(QRectF(self._x(v) - 14, 0, 28, 12), Qt.AlignmentFlag.AlignCenter, str(v))
        if not self.isEnabled():
            p.fillRect(self.rect(), QColor(0, 0, 0, 80))
        p.end()

    def mousePressEvent(self, e):  # noqa: N802
        v = self._v(e.position().x())
        self._drag = "lo" if abs(v - self.lo) <= abs(v - self.hi) and not (v > self.hi) else "hi"
        self._focus = self._drag
        self._move(v)

    def mouseMoveEvent(self, e):  # noqa: N802
        if self._drag:
            self._move(self._v(e.position().x()))

    def mouseReleaseEvent(self, e):  # noqa: N802
        if self._drag:
            self._drag = None
            self.committed.emit()

    def keyPressEvent(self, e):  # noqa: N802
        d = {Qt.Key.Key_Left: -1, Qt.Key.Key_Down: -1, Qt.Key.Key_Right: 1, Qt.Key.Key_Up: 1}.get(e.key())
        if e.key() == Qt.Key.Key_Tab:
            self._focus = "hi" if self._focus == "lo" else "lo"
            self.update()
            return
        if d is None:
            return super().keyPressEvent(e)
        self._drag = self._focus
        self._move((self.lo if self._focus == "lo" else self.hi) + d)
        self._drag = None

    def keyReleaseEvent(self, e):  # noqa: N802
        if e.key() in (Qt.Key.Key_Left, Qt.Key.Key_Right, Qt.Key.Key_Up, Qt.Key.Key_Down):
            self.committed.emit()

    def _move(self, v):
        v = max(0, min(255, v))
        if self._drag == "lo":
            self.changed.emit(min(v, self.hi), self.hi)
        else:
            self.changed.emit(self.lo, max(v, self.lo))


class VectorGrayLevelSelector(QWidget):
    range_changed = pyqtSignal(int, int)
    commit = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.slider = _RangeSlider()
        self.slider.changed.connect(self.range_changed.emit)
        self.slider.committed.connect(self.commit.emit)
        lay.addWidget(self.slider, 1)
        self.select_btn = button("", "primary")
        self.select_btn.clicked.connect(self.commit.emit)
        lay.addWidget(self.select_btn)

    def set_state(self, rng, disabled: bool):
        self.slider.lo, self.slider.hi = min(rng), max(rng)
        self.slider.setEnabled(not disabled)
        self.slider.setToolTip(t("vector.grayLevels.range"))
        self.slider.update()
        self.select_btn.setText(t("vector.grayLevels.select"))
        self.select_btn.setEnabled(not disabled)


class GrayScaleConfirmDialog(QDialog):
    def __init__(self, selection, skipped: Optional[bool], on_skip_change: Callable, parent=None):
        super().__init__(parent)
        self.setObjectName("Modal")
        self.setModal(True)
        self.setWindowTitle(t("roi.grayScale.confirm.title"))
        lay = QVBoxLayout(self)
        lay.addWidget(label(t("roi.grayScale.confirm.title"), "title"))
        lay.addWidget(label(t("roi.grayScale.confirm.body", selection=format_gray_scale_selection(selection)),
                            wrap=True))
        group = QButtonGroup(self)
        for value, key in ((False, "spot"), (True, "skip")):
            rb = QRadioButton(t(f"roi.grayScale.confirm.mode.{key}"))
            rb.setChecked(skipped is value)
            rb.toggled.connect(lambda c, v=value: c and on_skip_change(v))
            group.addButton(rb)
            lay.addWidget(rb)
            lay.addWidget(label(t(f"roi.grayScale.confirm.mode.{key}.help"), "muted", wrap=True))
        row = QHBoxLayout()
        row.addStretch(1)
        cancel = button(t("settings.confirm.cancel"), "ghost")
        cancel.clicked.connect(self.reject)
        ok = button(t("roi.grayScale.confirm.select"), "primary")
        ok.clicked.connect(self.accept)
        row.addWidget(cancel)
        row.addWidget(ok)
        lay.addLayout(row)
        self.setMinimumWidth(480)
