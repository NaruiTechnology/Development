"""Shared widgets and helpers (the web UI's small building blocks).

* ``icon()``            - the web UI's SVG / PNG icon set, recoloured per theme
* ``Card``              - card with header strip (``.card`` / ``.card__header``)
* ``HelpButton``        - "?" button opening the localized help popover
* ``Switch``            - toggle (``.vacuum-switch``)
* ``NumberStepper``     - text input with ▲▼ (``NumberStepperInput``)
* ``PresetNumberField`` - preset select + "Custom" stepper (``PresetNumberField``)
* ``run_bg``            - run a blocking call on a worker thread, deliver on UI thread
* ``Prefs``             - persisted preferences (the browser's localStorage keys)
"""
from __future__ import annotations

import json
import math
import traceback
from functools import lru_cache
from typing import Any, Callable, Iterable, Optional

from PyQt6.QtCore import QByteArray, QObject, QRunnable, QSettings, QSize, Qt, QThreadPool, QTimer, pyqtSignal
from PyQt6.QtGui import QIcon, QPainter, QPixmap
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QFrame, QHBoxLayout, QLabel, QLineEdit, QPushButton, QSizePolicy,
    QTextBrowser, QToolButton, QVBoxLayout, QWidget,
)

from .. import i18n
from ..i18n import t
from ..paths import resource
from . import theme

# --------------------------------------------------------------------------- icons

_PNG_ICONS = {
    "scan": "images/Scan.png", "calibrate": "images/Calibrate.png", "ruler": "images/ruler.png",
    "magCal": "images/MagCal.png", "adcTest": "images/Cog.png", "dashboard": "images/UHVacuumPump_1.png",
    "target": "images/ROI.png", "grid": "images/raster.png", "route": "images/vector.png",
    "fileText": "icons/fileText.png", "sheet": "icons/sheet.png",
}


def icon(name: str, color: Optional[str] = None, size: int = 18) -> QIcon:
    return QIcon(icon_pixmap(name, color or theme.current().text, size))


@lru_cache(maxsize=512)
def icon_pixmap(name: str, color: str, size: int = 18) -> QPixmap:
    png = _PNG_ICONS.get(name)
    if png is not None:
        pm = QPixmap(str(resource(png)))
        if not pm.isNull():
            return pm.scaled(size, size, Qt.AspectRatioMode.KeepAspectRatio,
                             Qt.TransformationMode.SmoothTransformation)
    path = resource("icons", f"{name}.svg")
    pm = QPixmap(size * 2, size * 2)
    pm.fill(Qt.GlobalColor.transparent)
    if path.is_file():
        svg = path.read_text(encoding="utf-8").replace("#COLOR#", color)
        renderer = QSvgRenderer(QByteArray(svg.encode("utf-8")))
        painter = QPainter(pm)
        renderer.render(painter)
        painter.end()
    pm.setDevicePixelRatio(2.0)
    return pm


# --------------------------------------------------------------------------- threads

class _Signals(QObject):
    done = pyqtSignal(object, object)


class _Job(QRunnable):
    def __init__(self, fn, args, kwargs):
        super().__init__()
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.signals = _Signals()

    def run(self):
        try:
            result, error = self.fn(*self.args, **self.kwargs), None
        except BaseException as exc:  # delivered to the error callback
            exc.__traceback_text__ = traceback.format_exc()
            result, error = None, exc
        try:
            self.signals.done.emit(result, error)
        except RuntimeError:
            pass  # application shutting down: the receiver is already gone


_pool = QThreadPool()
_pool.setMaxThreadCount(6)
_live_jobs: set = set()


def shutdown_bg(timeout_ms: int = 3000) -> None:
    """Let in-flight background requests finish before Qt objects go away."""
    _pool.clear()
    _pool.waitForDone(timeout_ms)


def run_bg(fn: Callable, *args, on_ok: Optional[Callable[[Any], None]] = None,
           on_err: Optional[Callable[[BaseException], None]] = None, **kwargs) -> None:
    """Run ``fn(*args, **kwargs)`` on a worker; callbacks run on the UI thread."""
    job = _Job(fn, args, kwargs)
    _live_jobs.add(job)

    def finished(result, error):
        _live_jobs.discard(job)
        if error is not None:
            if on_err is not None:
                on_err(error)
        elif on_ok is not None:
            on_ok(result)

    job.signals.done.connect(finished, Qt.ConnectionType.QueuedConnection)
    job.setAutoDelete(False)
    _pool.start(job)


class UiPoster(QObject):
    """Marshal callables from any thread onto the UI thread."""
    _call = pyqtSignal(object)

    def __init__(self):
        super().__init__()
        self._call.connect(lambda fn: fn(), Qt.ConnectionType.QueuedConnection)

    def post(self, fn: Callable[[], None]) -> None:
        self._call.emit(fn)


# --------------------------------------------------------------------------- prefs

class Prefs:
    """localStorage equivalent (same key names as the browser app)."""

    def __init__(self):
        self._s = QSettings("IonBeamTech", "ionbeam-native")

    def get(self, key: str, default=None):
        value = self._s.value(key)
        return default if value is None else value

    def get_json(self, key: str, default=None):
        raw = self._s.value(key)
        if raw is None or raw == "":
            return default
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return default

    def set(self, key: str, value) -> None:
        self._s.setValue(key, value)

    def set_json(self, key: str, value) -> None:
        self._s.setValue(key, json.dumps(value))

    def remove(self, key: str) -> None:
        self._s.remove(key)


PREFS: Optional[Prefs] = None


def prefs() -> Prefs:
    global PREFS
    if PREFS is None:
        PREFS = Prefs()
    return PREFS


# --------------------------------------------------------------------------- widgets

def set_prop(widget: QWidget, name: str, value) -> None:
    """Set a dynamic property and re-polish so the stylesheet picks it up."""
    widget.setProperty(name, value)
    widget.style().unpolish(widget)
    widget.style().polish(widget)


def label(text: str = "", role: Optional[str] = None, wrap: bool = False) -> QLabel:
    w = QLabel(text)
    if role:
        w.setProperty("role", role)
    w.setWordWrap(wrap)
    return w


def button(text: str = "", kind: Optional[str] = None, icon_name: Optional[str] = None,
           tooltip: Optional[str] = None) -> QPushButton:
    b = QPushButton(text)
    if kind:
        b.setProperty("kind", kind)
    if icon_name:
        b.setIcon(icon(icon_name, "#ffffff" if kind == "primary" else None))
        b.setIconSize(QSize(16, 16))
    if tooltip:
        b.setToolTip(tooltip)
    b.setCursor(Qt.CursorShape.PointingHandCursor)
    return b


def hbox(*widgets, spacing: int = 6, margins=(0, 0, 0, 0), stretch_last: bool = False) -> QHBoxLayout:
    lay = QHBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for w in widgets:
        if w is None:
            lay.addStretch(1)
        elif isinstance(w, QWidget):
            lay.addWidget(w)
        else:
            lay.addLayout(w)
    if stretch_last:
        lay.addStretch(1)
    return lay


def vbox(*widgets, spacing: int = 6, margins=(0, 0, 0, 0)) -> QVBoxLayout:
    lay = QVBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for w in widgets:
        if w is None:
            lay.addStretch(1)
        elif isinstance(w, QWidget):
            lay.addWidget(w)
        else:
            lay.addLayout(w)
    return lay


class Card(QFrame):
    """``.card`` with an optional header row; ``body`` is a QVBoxLayout."""

    def __init__(self, title: str = "", parent=None, *, collapsible: bool = False, collapsed: bool = False):
        super().__init__(parent)
        self.setObjectName("Card")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.header = QFrame()
        self.header.setObjectName("CardHeader")
        self.header_layout = QHBoxLayout(self.header)
        self.header_layout.setContentsMargins(12, 8, 8, 8)
        self.header_layout.setSpacing(8)
        self.title = label(title, "title")
        self.header_layout.addWidget(self.title)
        self.header_tools = QHBoxLayout()
        self.header_tools.setSpacing(6)
        self.header_layout.addLayout(self.header_tools)
        self.header_layout.addStretch(1)
        self.collapse_btn: Optional[QToolButton] = None
        if collapsible:
            self.collapse_btn = QToolButton()
            self.collapse_btn.setIcon(icon("chevronDown"))
            self.collapse_btn.setAutoRaise(True)
            self.collapse_btn.clicked.connect(lambda: self.set_collapsed(not self._collapsed))
            self.header_layout.addWidget(self.collapse_btn)
        outer.addWidget(self.header)
        if not title and not collapsible:
            self.header.hide()
        self.body_widget = QWidget()
        self.body = QVBoxLayout(self.body_widget)
        self.body.setContentsMargins(12, 10, 12, 12)
        self.body.setSpacing(8)
        outer.addWidget(self.body_widget)
        self._collapsed = False
        if collapsible:
            self.set_collapsed(collapsed)

    def set_title(self, text: str) -> None:
        self.title.setText(text)

    def set_active(self, active: bool, color: Optional[str] = None) -> None:
        set_prop(self, "active", "true" if active else "false")
        if active and color:
            self.setStyleSheet(f"QFrame#Card {{ border: 2px solid {color}; }}")
        else:
            self.setStyleSheet("")

    def set_collapsed(self, collapsed: bool) -> None:
        self._collapsed = collapsed
        self.body_widget.setVisible(not collapsed)
        if self.collapse_btn is not None:
            tip = t("dacRamp.expand") if collapsed else t("dacRamp.collapse")
            self.collapse_btn.setToolTip(tip)


class HelpDialog(QDialog):
    def __init__(self, title: str, html: str, parent=None, *, wide: bool = False):
        super().__init__(parent)
        self.setObjectName("Modal")
        self.setWindowTitle(title)
        self.setModal(True)
        lay = QVBoxLayout(self)
        head = label(title, "title")
        lay.addWidget(head)
        body = QTextBrowser()
        body.setOpenExternalLinks(True)
        tk = theme.current()
        body.document().setDefaultStyleSheet(
            f"body {{ color: {tk.text}; }} a {{ color: {tk.accent}; }} code {{ color: {tk.accent_hot}; }}"
            " li { margin-bottom: 4px; } p { margin: 0 0 8px 0; }")
        body.setHtml(html)
        lay.addWidget(body, 1)
        close = button(t("help.close"), "ghost")
        close.clicked.connect(self.accept)
        lay.addLayout(hbox(None, close))
        self.resize(760 if wide else 560, 480)


class HelpButton(QPushButton):
    """The web ``*Help`` shells: title/aria from ``help.<topic>.*``, body from help.json."""

    locked = False            # set while a scan runs (help is disabled then, as in the web UI)
    _instances: list = []

    def __init__(self, topic: str, parent=None, *, title_key: Optional[str] = None,
                 html: Optional[Callable[[], str]] = None, wide: bool = False):
        super().__init__("?", parent)
        self.topic = topic
        self.title_key = title_key or f"help.{topic}.title"
        self.aria_key = f"help.{topic}.aria"
        self._html = html
        self._wide = wide
        self.setProperty("kind", "help")
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.clicked.connect(self._open)
        self.retranslate()
        HelpButton._instances.append(self)
        self.destroyed.connect(lambda *_: HelpButton._instances.remove(self) if self in HelpButton._instances else None)

    def retranslate(self) -> None:
        self.setToolTip(t(self.aria_key) if i18n.has_key(self.aria_key) else t(self.title_key))

    def _open(self) -> None:
        if HelpButton.locked:
            return
        html = self._html() if self._html else i18n.help_html(self.topic)
        HelpDialog(t(self.title_key), html, self.window(), wide=self._wide).exec()

    @classmethod
    def set_locked(cls, locked: bool) -> None:
        cls.locked = locked
        for b in list(cls._instances):
            try:
                b.setEnabled(not locked)
            except RuntimeError:
                pass


class Switch(QCheckBox):
    """``.vacuum-switch`` toggle."""

    def __init__(self, text: str = "", parent=None):
        super().__init__(text, parent)
        self.setCursor(Qt.CursorShape.PointingHandCursor)


def _decimals_for_step(step: float) -> int:
    text = repr(float(step)) if not float(step).is_integer() else str(int(step))
    return 0 if "." not in text else len(text.split(".")[1])


class NumberStepper(QWidget):
    """``NumberStepperInput``: free text + ▲▼; emits the raw text like the web control."""

    valueChanged = pyqtSignal(str)

    def __init__(self, value="", *, step: float = 1, minimum: Optional[float] = None,
                 maximum: Optional[float] = None, parent=None, width: Optional[int] = None):
        super().__init__(parent)
        self.step = step if (isinstance(step, (int, float)) and step > 0 and math.isfinite(step)) else 1
        self.minimum, self.maximum = minimum, maximum
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self.edit = QLineEdit(str(value))
        if width:
            self.edit.setFixedWidth(width)
        self.edit.textEdited.connect(self.valueChanged.emit)
        lay.addWidget(self.edit, 1)
        col = QVBoxLayout()
        col.setSpacing(0)
        self.up = QToolButton()
        self.up.setText("▲")
        self.down = QToolButton()
        self.down.setText("▼")
        for b in (self.up, self.down):
            b.setFixedSize(18, 13)
            b.setStyleSheet("QToolButton { font-size: 8px; padding: 0; border: none; }")
            col.addWidget(b)
        self.up.clicked.connect(lambda: self._nudge(1))
        self.down.clicked.connect(lambda: self._nudge(-1))
        lay.addLayout(col)
        self.warning = QLabel()
        self.warning.setProperty("role", "danger")
        self.warning.hide()
        self._read_only = False

    def text(self) -> str:
        return self.edit.text()

    def set_value(self, value) -> None:
        text = str(value)
        if self.edit.text() != text and not self.edit.hasFocus():
            self.edit.setText(text)
        elif not self.edit.hasFocus():
            self.edit.setText(text)

    def force_value(self, value) -> None:
        self.edit.setText(str(value))

    def set_read_only(self, ro: bool) -> None:
        self._read_only = ro
        self.edit.setReadOnly(ro)
        self.up.setEnabled(not ro)
        self.down.setEnabled(not ro)

    def set_invalid(self, invalid: bool) -> None:
        set_prop(self.edit, "invalid", "true" if invalid else "false")

    def _nudge(self, direction: int) -> None:
        if not self.isEnabled() or self._read_only:
            return
        try:
            base = float(self.edit.text())
            if not math.isfinite(base):
                raise ValueError
        except ValueError:
            base = self.minimum if self.minimum is not None else (self.maximum if self.maximum is not None else 0)
        nxt = base + direction * self.step
        if self.minimum is not None:
            nxt = max(self.minimum, nxt)
        if self.maximum is not None:
            nxt = min(self.maximum, nxt)
        dec = _decimals_for_step(self.step)
        from ..core.jsmath import to_fixed, trunc
        text = to_fixed(nxt, dec) if dec > 0 else str(int(trunc(nxt)))
        self.edit.setText(text)
        self.valueChanged.emit(text)


def _clamp_int(value: float, lo: int, hi: int, fallback: int) -> int:
    if not math.isfinite(value):
        return fallback
    return int(min(hi, max(lo, math.floor(value))))


class PresetNumberField(QWidget):
    """Preset ``<select>`` + "Custom" stepper, with the web control's validation rules."""

    changed = pyqtSignal(int)
    CUSTOM = "__custom__"

    def __init__(self, label_widget: QWidget, *, minimum: int, maximum: int,
                 custom_validate: Optional[Callable[[int], Optional[str]]] = None,
                 normalize: Optional[Callable[[int], int]] = None, parent=None):
        super().__init__(parent)
        self.minimum, self.maximum = minimum, maximum
        self.custom_validate = custom_validate
        self.normalize = normalize
        self._value = minimum
        self._options: list = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        lay.addWidget(label_widget)
        self.combo = QComboBox()
        self.combo.activated.connect(self._on_select)
        lay.addWidget(self.combo)
        self.custom = NumberStepper("", step=1, minimum=minimum, maximum=maximum)
        self.custom.valueChanged.connect(self._on_custom)
        self.custom.hide()
        lay.addWidget(self.custom)
        self.warning = label("", "danger", wrap=True)
        self.warning.hide()
        lay.addWidget(self.warning)
        self.helper = label("", "muted", wrap=True)
        self.helper.hide()
        lay.addWidget(self.helper)

    def set_options(self, options: Iterable[tuple]) -> None:
        """options: (value, label) pairs."""
        self._options = [(int(v), lbl) for v, lbl in options]
        self._rebuild()

    def _rebuild(self) -> None:
        self.combo.blockSignals(True)
        self.combo.clear()
        for v, lbl in self._options:
            self.combo.addItem(str(lbl if lbl is not None else v), v)
        self.combo.addItem(t("common.custom"), self.CUSTOM)
        self.combo.blockSignals(False)
        self._sync()

    def set_helper(self, text: str) -> None:
        self.helper.setText(text)
        self.helper.setVisible(bool(text))

    def set_tooltip(self, text: str) -> None:
        self.combo.setToolTip(text)
        self.custom.setToolTip(text)

    def value(self) -> int:
        return self._value

    def set_value(self, value: int) -> None:
        self._value = int(value)
        self._sync()

    def _sync(self) -> None:
        values = [v for v, _ in self._options]
        custom_mode = self._value not in values or (self.combo.currentData() == self.CUSTOM and self.custom.isVisible()
                                                    and self._value not in values)
        self.combo.blockSignals(True)
        if self._value in values:
            self.combo.setCurrentIndex(values.index(self._value))
            self.custom.hide()
        else:
            self.combo.setCurrentIndex(len(values))
            self.custom.show()
            if not self.custom.edit.hasFocus():
                self.custom.force_value(self._value)
        self.combo.blockSignals(False)
        if not custom_mode:
            self.warning.hide()

    def _on_select(self, index: int) -> None:
        data = self.combo.itemData(index)
        if data == self.CUSTOM:
            self.custom.show()
            self.custom.force_value(self._value)
            self.warning.hide()
            return
        parsed = _clamp_int(float(data), self.minimum, self.maximum, self._value)
        normalized = _clamp_int(float(self.normalize(parsed) if self.normalize else parsed),
                                self.minimum, self.maximum, self._value)
        self.custom.hide()
        self._value = normalized
        self.changed.emit(normalized)

    def _on_custom(self, text: str) -> None:
        if not text.strip():
            self.warning.hide()
            return
        try:
            parsed = float(text)
            if not math.isfinite(parsed):
                raise ValueError
        except ValueError:
            self.warning.setText(t("common.invalidNumber"))
            self.warning.show()
            return
        normalized = _clamp_int(parsed, self.minimum, self.maximum, self._value)
        effective = _clamp_int(float(self.normalize(normalized) if self.normalize else normalized),
                               self.minimum, self.maximum, self._value)
        err = self.custom_validate(effective) if self.custom_validate else None
        if err:
            self.warning.setText(err)
            self.warning.show()
            return
        self.warning.hide()
        if effective != normalized:
            self.custom.force_value(effective)
        self._value = effective
        self.changed.emit(effective)

    def setEnabled(self, enabled: bool) -> None:  # noqa: N802 - Qt naming
        super().setEnabled(enabled)


def field(label_text: str, widget: QWidget, help_btn: Optional[QWidget] = None, *, helper: str = "") -> QWidget:
    """``.field``: label (+help) above a control."""
    w = QWidget()
    lay = QVBoxLayout(w)
    lay.setContentsMargins(0, 0, 0, 0)
    lay.setSpacing(4)
    head = QHBoxLayout()
    head.setSpacing(6)
    lbl = label(label_text)
    head.addWidget(lbl)
    if help_btn is not None:
        head.addWidget(help_btn)
    head.addStretch(1)
    lay.addLayout(head)
    lay.addWidget(widget)
    if helper:
        lay.addWidget(label(helper, "muted", wrap=True))
    w.label = lbl  # type: ignore[attr-defined]
    return w


def label_with_help(text: str, help_btn: Optional[QWidget] = None) -> QWidget:
    w = QWidget()
    lay = QHBoxLayout(w)
    lay.setContentsMargins(0, 0, 0, 0)
    lay.setSpacing(6)
    w.label = label(text)  # type: ignore[attr-defined]
    lay.addWidget(w.label)
    if help_btn is not None:
        lay.addWidget(help_btn)
    lay.addStretch(1)
    return w


class Spinner(QLabel):
    """``LoadingSpinner`` (animated GIF + label)."""

    def __init__(self, text: str = "", size: int = 20, parent=None):
        super().__init__(parent)
        from PyQt6.QtGui import QMovie
        self.movie = QMovie(str(resource("images", "spinner.gif")))
        self.movie.setScaledSize(QSize(size, size))
        self.setMovie(self.movie)
        self.movie.start()
        if text:
            self.setToolTip(text)


def hline() -> QFrame:
    line = QFrame()
    line.setFrameShape(QFrame.Shape.HLine)
    line.setStyleSheet(f"color: {theme.current().border_soft};")
    return line


def expanding(w: QWidget) -> QWidget:
    w.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
    return w


def single_shot(ms: int, fn: Callable[[], None]) -> None:
    QTimer.singleShot(ms, fn)
