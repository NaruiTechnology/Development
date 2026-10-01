"""Raster / Vector parameter forms (RasterParameters.tsx, VectorParameters.tsx,
VectorScanPathField.tsx, BeamEnergyField.tsx)."""
from __future__ import annotations

import html
import math
import re
from typing import Optional

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QPainter, QPen, QPolygonF
from PyQt6.QtWidgets import (
    QComboBox, QGridLayout, QHBoxLayout, QPlainTextEdit, QVBoxLayout, QWidget,
)

from ..core.helpers import VECTOR_SCAN_PATHS
from ..core.jsmath import js_number, trunc
from ..core.scan_timing import (
    estimate_revc3_scan_timing, format_duration, format_nanoseconds, revc3_dwell_preset_options,
)
from ..i18n import fmt, t
from . import theme
from .common import HelpButton, NumberStepper, PresetNumberField, Switch, hline, label, label_with_help
from .panel import Panel

RES_PRESETS = (128, 256, 512, 1024, 2048)
LATENCY_PRESETS = (4096, 8192, 16384, 32768)
VECTOR_RES_OPTIONS = (2048, 1024, 512, 256, 128)
MAX_POINTS = 1_000_000


def bracketed_bold(text: str) -> str:
    """``renderBracketedBold``: "<Run validated>" -> <b>Run validated</b> (rich text)."""
    out, last = [], 0
    for m in re.finditer(r"<([^<>]+)>", text):
        out.append(html.escape(text[last:m.start()]))
        out.append(f"<b>{html.escape(m.group(1))}</b>")
        last = m.end()
    out.append(html.escape(text[last:]))
    return "".join(out)


def clamp_text(s: str, lo: int, hi: int, fallback: int) -> int:
    n = js_number(s)
    if not math.isfinite(n):
        return fallback
    return int(min(hi, max(lo, math.floor(n))))


class BeamEnergyField(Panel):
    TOPICS = frozenset({"scan", "panel", "defaults"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self.lbl = label()
        lay.addWidget(self.lbl)
        self.input = NumberStepper(ctl.scan.beamEnergyEv, step=1, minimum=0)
        self.input.valueChanged.connect(self._changed)
        lay.addWidget(self.input)
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.lbl.setText(t("settings.general.ev"))

    def refresh(self):
        value = self.ctl.scan.beamEnergyEv
        self.input.set_value(int(value) if float(value).is_integer() else value)
        self.input.setEnabled(not self.disabled)

    def _changed(self, text: str):
        n = js_number(text)
        if math.isfinite(n):
            self.ctl.scan.beamEnergyEv = n
            self.ctl.notify("beam-energy")


class ScanPathPreview(QWidget):
    POINTS = {
        "vertical_raster": "10,10 10,90 30,10 30,90 50,10 50,90 70,10 70,90 90,10 90,90",
        "vertical_serpentine": "10,10 10,90 30,90 30,10 50,10 50,90 70,90 70,10 90,10 90,90",
        "horizontal_sawtooth": "10,10 90,10 10,30 90,30 10,50 90,50 10,70 90,70 10,90 90,90",
        "horizontal_triangle": "10,10 90,10 90,30 10,30 10,50 90,50 90,70 10,70 10,90 90,90",
    }

    def __init__(self, parent=None):
        super().__init__(parent)
        self.path = "horizontal_sawtooth"
        self.setFixedSize(40, 40)

    def set_path(self, path: str) -> None:
        self.path = path
        self.update()

    def paintEvent(self, event):  # noqa: N802
        tk = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        s = self.width() / 100.0
        p.setPen(QPen(QColor(tk.border), 1))
        p.drawRoundedRect(QRectF(5 * s, 5 * s, 90 * s, 90 * s), 5 * s, 5 * s)
        pts = [tuple(map(float, xy.split(","))) for xy in self.POINTS.get(self.path, "").split()]
        p.setPen(QPen(QColor(tk.accent), 1.4))
        p.drawPolyline(QPolygonF([QPointF(x * s, y * s) for x, y in pts]))
        p.setBrush(QColor(tk.success))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(QPointF(10 * s, 10 * s), 3 * s, 3 * s)
        p.end()


class VectorScanPathField(Panel):
    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self.lbl = label()
        lay.addWidget(self.lbl)
        row = QHBoxLayout()
        self.combo = QComboBox()
        self.combo.activated.connect(self._picked)
        row.addWidget(self.combo, 1)
        self.preview = ScanPathPreview()
        row.addWidget(self.preview)
        lay.addLayout(row)
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.lbl.setText(t("vector.scanPath"))
        self.combo.blockSignals(True)
        self.combo.clear()
        for path in VECTOR_SCAN_PATHS:
            self.combo.addItem(t(f"vector.scanPath.{path}"), path)
        self.combo.blockSignals(False)

    def refresh(self):
        path = self.ctl.scan.vector["scan_path"]
        idx = self.combo.findData(path)
        if idx >= 0:
            self.combo.setCurrentIndex(idx)
        self.preview.set_path(path)
        self.preview.setToolTip(t("vector.scanPath.preview", path=t(f"vector.scanPath.{path}")))
        self.combo.setEnabled(not self.disabled)

    def _picked(self, index: int):
        self.ctl.scan.update_vector({"scan_path": self.combo.itemData(index)})
        self.ctl.notify("scan")


def _dwell_label(dwell: int, resolution: int, half_period) -> str:
    timing = estimate_revc3_scan_timing(resolution, dwell, half_period)
    return t("scan.dwell.dynamic", dwell=dwell, period=format_nanoseconds(timing.sample_period_ns),
             samples=timing.samples_per_pixel, pixel=format_nanoseconds(timing.pixel_dwell_ns),
             resolution=resolution, frame=format_duration(timing.frame_seconds))


def _half_period(ctl):
    try:
        return float(((ctl.defaults or {}).get("adc") or {}).get("adcHalfPeriod", 3))
    except (TypeError, ValueError):
        return 3


class RasterParameters(Panel):
    TOPICS = frozenset({"scan", "panel", "defaults"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        lay.addWidget(BeamEnergyField(ctl))
        self.mode_guide = label_with_help("", HelpButton("scanModes"))
        lay.addWidget(self.mode_guide)
        grid = QGridLayout()
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(10)
        self.res_label = label_with_help("", HelpButton("resolution"))
        self.resolution = PresetNumberField(self.res_label, minimum=1, maximum=2048)
        self.resolution.changed.connect(lambda v: self._update({"resolution": v}))
        self.dwell_label = label_with_help("", HelpButton("dwell"))
        self.dwell_label.label.setWordWrap(True)
        self.dwell = PresetNumberField(self.dwell_label, minimum=0, maximum=65535)
        self.dwell.changed.connect(lambda v: self._update({"dwell": v}))
        self.lat_label = label_with_help("", HelpButton("latency"))
        self.latency = PresetNumberField(self.lat_label, minimum=2, maximum=1 << 20)
        self.latency.changed.connect(lambda v: self._update({"latency_bytes": v}))
        cookie_box = QWidget()
        cl = QVBoxLayout(cookie_box)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(4)
        self.cookie_label = label_with_help("", HelpButton("cookie"))
        cl.addWidget(self.cookie_label)
        self.cookie = NumberStepper(123, step=1, minimum=0, maximum=0xFFFF)
        self.cookie.valueChanged.connect(lambda s: self._update({"cookie": clamp_text(s, 0, 0xFFFF, 123)}))
        cl.addWidget(self.cookie)
        cl.addStretch(1)
        out_box = QWidget()
        ol = QVBoxLayout(out_box)
        ol.setContentsMargins(0, 0, 0, 0)
        ol.setSpacing(4)
        self.out_label = label_with_help("", HelpButton("outputMode"))
        ol.addWidget(self.out_label)
        self.output = QComboBox()
        self.output.addItems(["SixteenBit", "EightBit"])
        self.output.activated.connect(lambda i: self._update({"output_mode": self.output.itemText(i)}))
        ol.addWidget(self.output)
        self.adc_valid = Switch()
        self.adc_valid.toggled.connect(lambda c: self._update({"adc_valid": c}))
        adc_row = QHBoxLayout()
        adc_row.addWidget(self.adc_valid)
        adc_row.addWidget(HelpButton("adcValid"))
        adc_row.addStretch(1)
        grid.addWidget(self.resolution, 0, 0)
        grid.addWidget(self.dwell, 0, 1)
        grid.addWidget(self.latency, 1, 0)
        grid.addWidget(cookie_box, 1, 1)
        grid.addWidget(out_box, 2, 0)
        grid.addLayout(adc_row, 2, 1, Qt.AlignmentFlag.AlignBottom)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        lay.addLayout(grid)
        fb_row = QHBoxLayout()
        self.frame_blank = Switch()
        self.frame_blank.toggled.connect(lambda c: self._update({"frame_blank": c}))
        fb_row.addWidget(self.frame_blank)
        fb_row.addWidget(HelpButton("frameBlank"))
        fb_row.addStretch(1)
        lay.addLayout(fb_row)
        lay.addWidget(hline())
        self.validated_title = label("", "title")
        lay.addWidget(self.validated_title)
        dv_row = QHBoxLayout()
        self.do_validate = Switch()
        self.do_validate.toggled.connect(lambda c: self._update({"do_validate": c}))
        dv_row.addWidget(self.do_validate)
        dv_row.addWidget(HelpButton("validation"))
        dv_row.addStretch(1)
        lay.addLayout(dv_row)
        self.footnote = label("", "muted", wrap=True)
        self.footnote.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(self.footnote)
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.mode_guide.label.setText(t("scan.modeGuide"))
        self.res_label.label.setText(t("raster.resolution"))
        self.lat_label.label.setText(t("raster.latencyBytes"))
        self.cookie_label.label.setText(t("raster.cookie"))
        self.out_label.label.setText(t("raster.outputMode"))
        self.adc_valid.setText(t("raster.adcValid"))
        self.frame_blank.setText(t("raster.frameBlank"))
        self.validated_title.setText(t("card.validatedRunOptions"))
        self.do_validate.setText(t("raster.doValidate"))
        self.footnote.setText(bracketed_bold(t("raster.footnote")))
        self.resolution.set_options([(v, None) for v in RES_PRESETS])
        self.latency.set_options([(v, None) for v in LATENCY_PRESETS])

    def refresh(self):
        r = self.ctl.scan.raster
        hp = _half_period(self.ctl)
        self.dwell.set_options([(o.value, o.label) for o in revc3_dwell_preset_options(adc_half_period=hp)])
        self.dwell_label.label.setText(_dwell_label(r["dwell"], r["resolution"], hp))
        self.resolution.set_value(r["resolution"])
        self.dwell.set_value(r["dwell"])
        self.latency.set_value(r["latency_bytes"])
        self.cookie.set_value(r["cookie"])
        self.output.setCurrentText(r.get("output_mode") or "SixteenBit")
        for sw, key in ((self.adc_valid, "adc_valid"), (self.frame_blank, "frame_blank"),
                        (self.do_validate, "do_validate")):
            sw.blockSignals(True)
            sw.setChecked(bool(r[key]))
            sw.blockSignals(False)
        enabled = not self.disabled
        for w in (self.resolution, self.dwell, self.latency, self.cookie, self.output, self.adc_valid,
                  self.frame_blank, self.do_validate):
            w.setEnabled(enabled)

    def _update(self, patch: dict):
        if self._updating:
            return
        self.ctl.scan.update_raster(patch)
        self.ctl.notify("scan")


class VectorParameters(Panel):
    TOPICS = frozenset({"scan", "panel", "defaults", "vector-gray"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.gray_filter_active = False
        self._points_text = ""
        v = ctl.scan.vector
        if v.get("points"):
            self._points_text = "\n".join(",".join(str(c) for c in _point_triple(p)) for p in v["points"])
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        lay.addWidget(BeamEnergyField(ctl))
        self.mode_guide = label_with_help("", HelpButton("scanModes"))
        lay.addWidget(self.mode_guide)
        pat = QVBoxLayout()
        pat.setSpacing(4)
        self.pattern_label = label_with_help("", HelpButton("pattern"))
        pat.addWidget(self.pattern_label)
        self.pattern = QComboBox()
        self.pattern.activated.connect(lambda i: self._update({"pattern": self.pattern.itemData(i)}))
        pat.addWidget(self.pattern)
        lay.addLayout(pat)
        self.default_box = QWidget()
        dl = QVBoxLayout(self.default_box)
        dl.setContentsMargins(0, 0, 0, 0)
        dl.setSpacing(10)
        dl.addWidget(VectorScanPathField(ctl))
        row = QHBoxLayout()
        row.setSpacing(12)
        self.res_label = label_with_help("", HelpButton("vectorResolution"))
        self.resolution = PresetNumberField(self.res_label, minimum=1, maximum=2048,
                                            custom_validate=self._validate_res,
                                            normalize=lambda v: max(128, v) if self.gray_filter_active else v)
        self.resolution.changed.connect(lambda v: self._update({"vector_resolution": v}))
        self.dwell_label = label_with_help("", HelpButton("dwell"))
        self.dwell_label.label.setWordWrap(True)
        self.dwell = PresetNumberField(self.dwell_label, minimum=0, maximum=65535,
                                       normalize=lambda v: max(2, v) if self.gray_filter_active else v)
        self.dwell.changed.connect(lambda v: self._update({"dwell": v}))
        row.addWidget(self.resolution, 1)
        row.addWidget(self.dwell, 1)
        dl.addLayout(row)
        lay.addWidget(self.default_box)
        grid = QGridLayout()
        grid.setHorizontalSpacing(12)
        out_box = QVBoxLayout()
        self.out_label = label_with_help("", HelpButton("outputMode"))
        out_box.addWidget(self.out_label)
        self.output = QComboBox()
        self.output.addItems(["SixteenBit", "EightBit"])
        self.output.activated.connect(lambda i: self._update({"output_mode": self.output.itemText(i)}))
        out_box.addWidget(self.output)
        grid.addLayout(out_box, 0, 0)
        adc_row = QHBoxLayout()
        self.adc_valid = Switch()
        self.adc_valid.toggled.connect(lambda c: self._update({"adc_valid": c}))
        adc_row.addWidget(self.adc_valid)
        adc_row.addWidget(HelpButton("adcValid"))
        adc_row.addStretch(1)
        grid.addLayout(adc_row, 0, 1, Qt.AlignmentFlag.AlignBottom)
        lat_box = QVBoxLayout()
        self.lat_label = label_with_help("", HelpButton("latency"))
        lat_box.addWidget(self.lat_label)
        self.latency = NumberStepper(8196, step=1, minimum=2)
        self.latency.valueChanged.connect(
            lambda s: self._update({"latency_bytes": clamp_text(s, self._latency_min(), 1 << 20, 8196)}))
        lat_box.addWidget(self.latency)
        grid.addLayout(lat_box, 1, 0)
        cookie_box = QVBoxLayout()
        self.cookie_label = label_with_help("", HelpButton("cookie"))
        cookie_box.addWidget(self.cookie_label)
        self.cookie = NumberStepper(123, step=1, minimum=0, maximum=0xFFFF)
        self.cookie.valueChanged.connect(lambda s: self._update({"cookie": clamp_text(s, 0, 0xFFFF, 123)}))
        cookie_box.addWidget(self.cookie)
        grid.addLayout(cookie_box, 1, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        lay.addLayout(grid)
        self.custom_box = QWidget()
        cbl = QVBoxLayout(self.custom_box)
        cbl.setContentsMargins(0, 0, 0, 0)
        cbl.setSpacing(4)
        self.points_label = label_with_help("", HelpButton("customPoints"))
        cbl.addWidget(self.points_label)
        self.points = QPlainTextEdit()
        self.points.setPlaceholderText("0,0,2\n100,100,2\n200,100,2")
        self.points.setMinimumHeight(110)
        self.points.setStyleSheet('font-family: "JetBrains Mono", "DejaVu Sans Mono", monospace;')
        self.points.setPlainText(self._points_text)
        self.points.textChanged.connect(lambda: self._commit_points(self.points.toPlainText()))
        cbl.addWidget(self.points)
        self.points_status = label("", "muted", wrap=True)
        cbl.addWidget(self.points_status)
        self._points_err: Optional[str] = None
        lay.addWidget(self.custom_box)
        lay.addWidget(hline())
        self.validated_title = label("", "title")
        lay.addWidget(self.validated_title)
        for attr, topic, key in (("pre_process", "preProcess", "pre_process"),
                                 ("do_validate", "validation", "do_validate")):
            r = QHBoxLayout()
            sw = Switch()
            sw.toggled.connect(lambda c, k=key: self._update({k: c}))
            setattr(self, attr, sw)
            r.addWidget(sw)
            r.addWidget(HelpButton(topic))
            r.addStretch(1)
            lay.addLayout(r)
        self.retranslate()
        self.refresh()

    def set_gray_filter_active(self, active: bool) -> None:
        self.gray_filter_active = active
        self.refresh()

    def _latency_min(self) -> int:
        return 8196 if self.gray_filter_active else 2

    def _validate_res(self, value: int) -> Optional[str]:
        iv = trunc(value)
        if iv < 128:
            return t("vector.resolution.validation.min128")
        if iv & (iv - 1):
            return t("vector.resolution.validation.powerOfTwo")
        return None

    def retranslate(self):
        self.mode_guide.label.setText(t("scan.modeGuide"))
        self.pattern_label.label.setText(t("vector.pattern"))
        self.pattern.clear()
        self.pattern.addItem(t("vector.pattern.default"), "default")
        self.pattern.addItem(t("vector.pattern.custom"), "custom")
        self.res_label.label.setText(t("vector.resolution"))
        self.resolution.set_options([(v, t(f"vector.resolution.option.{v}")) for v in VECTOR_RES_OPTIONS])
        self.out_label.label.setText(t("vector.outputMode"))
        self.adc_valid.setText(t("vector.adcValid"))
        self.lat_label.label.setText(t("vector.latencyBytes"))
        self.cookie_label.label.setText(t("vector.cookie"))
        self.points_label.label.setText(t("vector.customPoints.label"))
        self.validated_title.setText(t("card.validatedRunOptions"))
        self.pre_process.setText(t("vector.preProcess"))
        self.do_validate.setText(t("vector.doValidate"))

    def refresh(self):
        v = self.ctl.scan.vector
        hp = _half_period(self.ctl)
        self.pattern.setCurrentIndex(0 if v["pattern"] == "default" else 1)
        self.default_box.setVisible(v["pattern"] == "default")
        self.custom_box.setVisible(v["pattern"] == "custom")
        self.resolution.minimum = 128 if self.gray_filter_active else 1
        self.dwell.minimum = 2 if self.gray_filter_active else 0
        self.dwell.set_options([(o.value, o.label) for o in revc3_dwell_preset_options(adc_half_period=hp)])
        self.dwell_label.label.setText(_dwell_label(v["dwell"], v["vector_resolution"], hp))
        self.resolution.set_value(v["vector_resolution"])
        self.dwell.set_value(v["dwell"])
        res = v["vector_resolution"]
        title = (t("vector.resolution.title.native") if res == 2048 else
                 t("vector.resolution.title.stride", stride=2048 // res) if res and 2048 % res == 0 else
                 t("vector.resolution.title.custom", resolution=res))
        self.resolution.set_tooltip(title)
        self.latency.minimum = self._latency_min()
        self.latency.set_value(v["latency_bytes"])
        self.cookie.set_value(v["cookie"])
        self.output.setCurrentText(v.get("output_mode") or "SixteenBit")
        for sw, key in ((self.adc_valid, "adc_valid"), (self.pre_process, "pre_process"),
                        (self.do_validate, "do_validate")):
            sw.blockSignals(True)
            sw.setChecked(bool(v[key]))
            sw.blockSignals(False)
        if self._points_err:
            self.points_status.setText(self._points_err)
            self.points_status.setProperty("role", "danger")
        else:
            pts = v.get("points")
            self.points_status.setText(t("vector.customPoints.count", count=fmt(len(pts))) if pts
                                       else t("vector.customPoints.empty"))
            self.points_status.setProperty("role", "muted")
        self.points_status.style().polish(self.points_status)
        enabled = not self.disabled
        for w in (self.resolution, self.dwell, self.latency, self.cookie, self.output, self.adc_valid,
                  self.pre_process, self.do_validate, self.points):
            w.setEnabled(enabled)
        self.pattern.setEnabled(enabled and not self.gray_filter_active)

    def _commit_points(self, text: str):
        if self._updating:
            return
        self._points_text = text
        if not text.strip():
            self._points_err = None
            self._update({"points": None})
            return
        lines = [ln.strip() for ln in re.split(r"\r?\n", text) if ln.strip()]
        if len(lines) > MAX_POINTS:
            self._points_err = t("vector.customPoints.error.tooMany", count=fmt(len(lines)), max=fmt(MAX_POINTS))
            self.refresh()
            return
        out = []
        for i, line in enumerate(lines):
            parts = [js_number(p) for p in re.split(r"[,\s]+", line)]
            if len(parts) < 3 or any(not math.isfinite(n) for n in parts):
                self._points_err = t("vector.customPoints.error.format", line=i + 1)
                self.refresh()
                return
            out.append([_to_int32(parts[0]), _to_int32(parts[1]), _to_int32(parts[2])])
        self._points_err = None
        self._update({"points": out})

    def _update(self, patch: dict):
        if self._updating:
            return
        self.ctl.scan.update_vector(patch)
        self.ctl.notify("scan")


def _to_int32(n: float) -> int:
    """JavaScript ``n | 0``."""
    v = int(math.trunc(n)) & 0xFFFFFFFF
    return v - (1 << 32) if v & 0x80000000 else v


def _point_triple(p):
    if isinstance(p, (list, tuple)):
        return list(p)
    return [p.get("x"), p.get("y"), p.get("dwell")]
