"""Magnification calibration (MagCalibration.tsx + store/magCalibrationSlice.ts)."""
from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QFont, QPainter, QPen, QPolygonF
from PyQt6.QtWidgets import (
    QComboBox, QFileDialog, QGridLayout, QHBoxLayout, QHeaderView, QLineEdit, QSizePolicy, QTableWidget,
    QTableWidgetItem, QToolButton, QVBoxLayout,
)

from ..core.jsmath import js_number, js_string, to_exponential, to_precision, trunc
from ..i18n import t
from . import theme
from .common import HelpButton, NumberStepper, button, icon, label, label_with_help, run_bg
from .panel import Panel


def normalize_beam(value: str) -> str:
    text = (value or "").strip().lower()
    if text in ("electron", "e-beam"):
        return "ebeam"
    if text in ("ibeam", "i-beam"):
        return "ion"
    return text or "ion"


def sort_points(points: dict) -> dict:
    out = []
    for mag, fov in points.items():
        m = js_number(mag)
        f = js_number(fov)
        if not math.isfinite(m):
            continue
        key = js_string(trunc(m))
        if trunc(m) >= 1 and math.isfinite(f) and f > 0:
            out.append((key, f))
    out.sort(key=lambda kv: float(kv[0]))
    return dict(out)


def format_scientific(value: float) -> str:
    if not math.isfinite(value) or value <= 0:
        return "0"
    return to_precision(value, 6) if 0.001 <= value < 1000 else to_exponential(value, 6)


def parse_mag_csv(text: str) -> dict:
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        if not line or low.startswith("beam,") or low.startswith("date,"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if parts[0].lower().startswith("magnification"):
            continue
        mag = js_number(parts[0])
        fov = js_number(parts[1]) if len(parts) > 1 else math.nan
        if math.isfinite(mag):
            mag = trunc(mag)
            if mag > 0 and math.isfinite(fov) and fov > 0:
                out[js_string(mag)] = fov
    return out


class MagState:
    def __init__(self):
        self.loading = False
        self.saving = False
        self.error: Optional[str] = None
        self.selected_beam = "ion"
        self.beams = {"ion": {"path": "", "m_per_fov": {}}, "ebeam": {"path": "", "m_per_fov": {}}}
        self.mag = 1000
        self.measured_length_m = 1e-6
        self.measured_pixels = 100.0
        self.resolution = 1024

    def beam(self) -> dict:
        if self.selected_beam not in self.beams:
            self.beams[self.selected_beam] = {"path": "", "m_per_fov": {}}
        return self.beams[self.selected_beam]

    def computed_fov(self) -> float:
        if self.measured_pixels <= 0 or self.resolution <= 0:
            return 0.0
        return self.measured_length_m * (self.resolution / self.measured_pixels)

    def apply_response(self, resp: dict) -> None:
        self.selected_beam = normalize_beam(resp.get("selected_beam") or self.selected_beam)
        self.beams = {**self.beams, **(resp.get("beams") or {})}
        self.beam()
        self.error = None if resp.get("ok") else (resp.get("error") or "mag calibration failed")


def _clamp_int(v, lo, hi, fb):
    n = js_number(v)
    if not math.isfinite(n):
        return fb
    return int(min(hi, max(lo, trunc(n))))


def _clamp_num(v, lo, hi, fb):
    n = js_number(v)
    return min(hi, max(lo, n)) if math.isfinite(n) else fb


class MagCalibrationControls(Panel):
    TOPICS = frozenset({"panel", "mag"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        if not hasattr(ctl, "mag"):
            ctl.mag = MagState()
        self.m: MagState = ctl.mag
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        g = QGridLayout()
        g.setHorizontalSpacing(12)
        self.beam_lbl = label()
        self.beam = QComboBox()
        self.beam.activated.connect(self._beam_changed)
        self.mag_lbl = label_with_help("", HelpButton("magCalibration"))
        self.mag_in = NumberStepper(self.m.mag, step=1, minimum=1)
        self.mag_in.valueChanged.connect(lambda s: self._set("mag", _clamp_int(s, 1, 10_000_000, self.m.mag)))
        self.len_lbl = label()
        self.len_in = NumberStepper(js_string(self.m.measured_length_m), step=1, minimum=5e-324)
        self.len_in.valueChanged.connect(
            lambda s: self._set("measured_length_m", _clamp_num(s, 5e-324, 2 ** 53 - 1, self.m.measured_length_m)))
        self.px_lbl = label()
        self.px_in = NumberStepper(js_string(self.m.measured_pixels), step=1, minimum=5e-324)
        self.px_in.valueChanged.connect(
            lambda s: self._set("measured_pixels", _clamp_num(s, 5e-324, 2 ** 53 - 1, self.m.measured_pixels)))
        self.res_lbl = label()
        self.res_in = NumberStepper(self.m.resolution, step=1, minimum=1)
        self.res_in.valueChanged.connect(lambda s: self._set("resolution", _clamp_int(s, 1, 1_000_000, self.m.resolution)))
        self.fov_lbl = label_with_help("", HelpButton("magCalibration"))
        self.fov_out = QLineEdit()
        self.fov_out.setReadOnly(True)
        for i, (lw, w) in enumerate(((self.beam_lbl, self.beam), (self.mag_lbl, self.mag_in),
                                     (self.len_lbl, self.len_in), (self.px_lbl, self.px_in),
                                     (self.res_lbl, self.res_in), (self.fov_lbl, self.fov_out))):
            col = QVBoxLayout()
            col.addWidget(lw)
            col.addWidget(w)
            g.addLayout(col, i // 2, i % 2)
        lay.addLayout(g)
        r1 = QHBoxLayout()
        self.update_btn = button("", "primary", "plus")
        self.update_btn.clicked.connect(self._add_point)
        self.save_btn = button("", "ghost", "save")
        self.save_btn.clicked.connect(self._save)
        r1.addWidget(self.update_btn)
        r1.addWidget(self.save_btn)
        r1.addStretch(1)
        lay.addLayout(r1)
        r2 = QHBoxLayout()
        self.export_btn = button("", "ghost", "download")
        self.export_btn.clicked.connect(self._export)
        self.import_btn = button("", "ghost", "upload")
        self.import_btn.clicked.connect(self._import)
        r2.addWidget(self.export_btn)
        r2.addWidget(self.import_btn)
        r2.addStretch(1)
        lay.addLayout(r2)
        self.path_lbl = label("", "muted", wrap=True)
        lay.addWidget(self.path_lbl)
        self.error_lbl = label("", "warn", wrap=True)
        lay.addWidget(self.error_lbl)
        self.table = QTableWidget(0, 3)
        self.table.verticalHeader().hide()
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.table.setMinimumHeight(160)
        lay.addWidget(self.table)
        self.retranslate()
        self.refresh()
        self._fetch()

    def _fetch(self) -> None:
        self.m.loading = True
        self.m.error = None

        def call():
            r = self.ctl.backend.request("GET", "/api/admin/mag-calibration")
            if r.status_code >= 400:
                raise RuntimeError(f"mag calibration: HTTP {r.status_code} {r.text}")
            return self.ctl.backend.read_json(r, "mag calibration")

        def ok(resp):
            self.m.loading = False
            self.m.apply_response(resp)
            self.ctl.notify("mag")

        def err(exc):
            self.m.loading = False
            self.m.error = str(exc) or "failed to load mag calibration"
            self.ctl.notify("mag")
        run_bg(call, on_ok=ok, on_err=err)

    def _save(self) -> None:
        b = self.m.beam()
        body = {"beam": self.m.selected_beam, "m_per_fov": b["m_per_fov"], "path": b.get("path") or ""}
        self.m.saving = True
        self.m.error = None
        self.ctl.notify("mag")

        def call():
            r = self.ctl.backend.request("POST", "/api/admin/mag-calibration", json_body=body)
            if r.status_code >= 400:
                raise RuntimeError(f"save mag calibration: HTTP {r.status_code} {r.text}")
            return self.ctl.backend.read_json(r, "save mag calibration")

        def ok(resp):
            self.m.saving = False
            self.m.apply_response(resp)
            self.ctl.notify("mag")

        def err(exc):
            self.m.saving = False
            self.m.error = str(exc) or "failed to save mag calibration"
            self.ctl.notify("mag")
        run_bg(call, on_ok=ok, on_err=err)

    def _set(self, attr: str, value) -> None:
        if self._updating:
            return
        setattr(self.m, attr, value)
        self.ctl.notify("mag")

    def _beam_changed(self, i: int) -> None:
        self.m.selected_beam = normalize_beam(self.beam.itemData(i))
        self.m.beam()
        self.ctl.notify("mag")

    def _add_point(self) -> None:
        fov = self.m.computed_fov()
        if not math.isfinite(fov) or fov <= 0:
            return
        b = self.m.beam()
        b["m_per_fov"] = sort_points({**b["m_per_fov"], js_string(self.m.mag): fov})
        self.ctl.notify("mag")

    def _export(self) -> None:
        b = self.m.beam()
        rows = [f"Beam,{self.m.selected_beam}",
                f"Date,{datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}",
                "Magnification,FOV (m)"] + [f"{mag},{js_string(fov)}" for mag, fov in b["m_per_fov"].items()]
        default = str(Path.home() / f"mag-calibration-{self.m.selected_beam}.csv")
        path, _ = QFileDialog.getSaveFileName(self, t("mag.exportCsv"), default, "CSV (*.csv)")
        if path:
            Path(path).write_text("\n".join(rows) + "\n", encoding="utf-8")

    def _import(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, t("mag.importCsv"), "", "CSV (*.csv)")
        if not path:
            return
        text = Path(path).read_text(encoding="utf-8", errors="replace")
        b = self.m.beam()
        b["m_per_fov"] = sort_points(parse_mag_csv(text))
        b["path"] = Path(path).name
        self.ctl.notify("mag")

    def _delete(self, mag: str) -> None:
        b = self.m.beam()
        pts = dict(b["m_per_fov"])
        pts.pop(mag, None)
        b["m_per_fov"] = sort_points(pts)
        self.ctl.notify("mag")

    def retranslate(self):
        self.beam_lbl.setText(t("mag.beam"))
        self.beam.clear()
        self.beam.addItem(t("mag.beam.ion"), "ion")
        self.beam.addItem(t("mag.beam.ebeam"), "ebeam")
        self.mag_lbl.label.setText(t("mag.magnification"))
        self.len_lbl.setText(t("mag.measuredLengthM"))
        self.px_lbl.setText(t("mag.measuredPixels"))
        self.res_lbl.setText(t("mag.imageResolution"))
        self.fov_lbl.label.setText(t("mag.hfovLengthM"))
        self.update_btn.setText(t("mag.updateCurve"))
        self.save_btn.setText(t("mag.save"))
        self.export_btn.setText(t("mag.exportCsv"))
        self.import_btn.setText(t("mag.importCsv"))
        self.table.setHorizontalHeaderLabels([t("mag.table.magnification"), t("mag.table.fov"), ""])

    def refresh(self):
        m = self.m
        disabled = self.disabled
        idx = self.beam.findData(m.selected_beam)
        if idx >= 0:
            self.beam.setCurrentIndex(idx)
        self.beam.setEnabled(not disabled and not m.loading and not m.saving)
        for w, v in ((self.mag_in, m.mag), (self.len_in, js_string(m.measured_length_m)),
                     (self.px_in, js_string(m.measured_pixels)), (self.res_in, m.resolution)):
            w.set_value(v)
            w.setEnabled(not disabled)
        fov = m.computed_fov()
        self.fov_out.setText(format_scientific(fov))
        self.update_btn.setEnabled(not disabled and fov > 0)
        self.save_btn.setEnabled(not disabled and not m.saving)
        self.export_btn.setEnabled(not disabled)
        self.import_btn.setEnabled(not disabled)
        b = m.beam()
        self.path_lbl.setText(b.get("path") or "")
        self.path_lbl.setVisible(bool(b.get("path")))
        self.error_lbl.setText(m.error or "")
        self.error_lbl.setVisible(bool(m.error))
        rows = list(b["m_per_fov"].items())
        self.table.setRowCount(max(1, len(rows)))
        if not rows:
            self.table.setSpan(0, 0, 1, 3)
            item = QTableWidgetItem(t("mag.table.empty"))
            item.setForeground(QColor(theme.current().text_muted))
            self.table.setItem(0, 0, item)
            self.table.setCellWidget(0, 2, None)
            return
        self.table.clearSpans()
        for r, (mag, fov) in enumerate(rows):
            self.table.setItem(r, 0, QTableWidgetItem(str(mag)))
            self.table.setItem(r, 1, QTableWidgetItem(format_scientific(float(fov))))
            btn = QToolButton()
            btn.setIcon(icon("trash", theme.current().danger))
            btn.setEnabled(not disabled)
            btn.clicked.connect(lambda _c, k=mag: self._delete(k))
            self.table.setCellWidget(r, 2, btn)


def _log_bounds(lo, hi):
    return (lo / 10, hi * 10) if lo == hi else (lo, hi)


def _unique(ticks):
    seen, out = set(), []
    for v in ticks:
        n = float(to_precision(v, 6))
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _minor(lo, hi):
    ticks = []
    for exp in range(math.floor(math.log10(lo)), math.ceil(math.log10(hi)) + 1):
        base = 10 ** exp
        for mult in range(2, 10):
            tick = base * mult
            if lo < tick < hi:
                ticks.append(tick)
    return _unique(ticks)


def _scale_log(v, lo, hi, out_lo, out_hi):
    a, b = math.log10(lo), math.log10(hi)
    return out_lo + ((math.log10(v) - a) / (b - a)) * (out_hi - out_lo)


def _format_tick(v):
    return to_precision(v, 3) if 0.01 <= v < 10000 else to_exponential(v, 1)


class MagCalibrationChart(Panel):
    TOPICS = frozenset({"mag"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        if not hasattr(ctl, "mag"):
            ctl.mag = MagState()
        self.setMinimumSize(420, 300)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def refresh(self):
        self.update()

    def paintEvent(self, e):  # noqa: N802
        tk = theme.current()
        m = self.ctl.mag
        pts = sorted(((float(k), float(v)) for k, v in m.beam()["m_per_fov"].items() if float(k) > 0 and float(v) > 0))
        mags = [p[0] for p in pts]
        fovs = [p[1] for p in pts]
        min_mag, max_mag = _log_bounds(min(mags) if mags else 1, max(mags) if mags else 100)
        min_fov, max_fov = _log_bounds(min(fovs) if fovs else 1e-6, max(fovs) if fovs else 1e-3)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        # 640 x 420 viewBox, preserveAspectRatio meet
        s = min(self.width() / 640, self.height() / 420)
        p.translate((self.width() - 640 * s) / 2, (self.height() - 420 * s) / 2)
        p.scale(s, s)
        p.fillRect(QRectF(0, 0, 640, 420), QColor(tk.bg_deep))

        def X(v):
            return _scale_log(v, min_mag, max_mag, 72, 608)

        def Y(v):
            return _scale_log(v, min_fov, max_fov, 350, 32)
        minor_pen = QPen(QColor(tk.border_soft), 0.5)
        grid_pen = QPen(QColor(tk.border), 1)
        for tick in _minor(min_mag, max_mag):
            p.setPen(minor_pen)
            p.drawLine(QPointF(X(tick), 32), QPointF(X(tick), 350))
        for tick in _minor(min_fov, max_fov):
            p.setPen(minor_pen)
            p.drawLine(QPointF(72, Y(tick)), QPointF(608, Y(tick)))
        xt = _unique([min_mag, math.sqrt(min_mag * max_mag), max_mag])
        yt = _unique([min_fov, math.sqrt(min_fov * max_fov), max_fov])
        for tick in xt:
            p.setPen(grid_pen)
            p.drawLine(QPointF(X(tick), 32), QPointF(X(tick), 350))
        for tick in yt:
            p.setPen(grid_pen)
            p.drawLine(QPointF(72, Y(tick)), QPointF(608, Y(tick)))
        p.setPen(QPen(QColor(tk.text_dim), 1.2))
        p.drawLine(QPointF(72, 32), QPointF(72, 350))
        p.drawLine(QPointF(72, 350), QPointF(608, 350))
        f = QFont()
        f.setPixelSize(12)
        p.setFont(f)
        for tick in xt:
            p.drawLine(QPointF(X(tick), 346), QPointF(X(tick), 354))
            p.drawText(QRectF(X(tick) - 40, 360, 80, 16), Qt.AlignmentFlag.AlignCenter, _format_tick(tick))
        for tick in yt:
            p.drawLine(QPointF(68, Y(tick)), QPointF(76, Y(tick)))
            p.drawText(QRectF(0, Y(tick) - 8, 64, 16), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                       _format_tick(tick))
        if len(pts) >= 2:
            p.setPen(QPen(QColor(tk.accent), 2))
            p.drawPolyline(QPolygonF([QPointF(X(a), Y(b)) for a, b in pts]))
        p.setPen(QPen(QColor(tk.accent_hot), 1))
        p.setBrush(QColor(tk.accent))
        for a, b in pts:
            p.drawEllipse(QPointF(X(a), Y(b)), 5, 5)
        p.setPen(QColor(tk.text))
        for a, b in pts:
            p.drawText(QPointF(X(a) + 8, Y(b) - 8), f"{js_string(a)}x")
        p.drawText(QPointF(76, 24), t("mag.chart.fov"))
        p.drawText(QPointF(492, 390), t("mag.chart.magnification"))
        if not pts:
            p.setPen(QColor(tk.text_muted))
            p.drawText(QRectF(0, 395, 640, 20), Qt.AlignmentFlag.AlignCenter, t("mag.chart.empty"))
        p.end()
