"""Hardware diagnostics: ADC test (AdcTest.tsx + useAdcTestStream.ts) and DAC ramp
check (DacRampTest.tsx + useDacRampStream.ts). Both run on the engine thread;
neither touches the raster/vector scan state, exactly like the web hooks."""
from __future__ import annotations

import math
import re
import time
from typing import Optional

import numpy as np
from PyQt6.QtCore import QPointF, QRectF, Qt, QTimer
from PyQt6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PyQt6.QtWidgets import QComboBox, QGridLayout, QHBoxLayout, QLabel, QSizePolicy, QSpinBox, QVBoxLayout, QWidget

from ..core.jsmath import js_number, js_round
from ..engine.engine import ScanJob
from ..i18n import fmt, t
from . import theme
from .common import NumberStepper, Switch, button, label, set_prop
from .panel import Panel

ADC_PHASE_LABELS = {"idle": "adc.phase.idle", "connecting": "adc.phase.connecting", "running": "adc.phase.sampling",
                    "done": "adc.phase.complete", "error": "adc.phase.error"}


def format_time(seconds: float) -> str:
    whole = max(0, math.floor(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def normalize_adc_error(detail: str, code: Optional[str] = None) -> str:
    if re.search(r"timeout\(\)|timed? ?out|timeout", detail or "", re.IGNORECASE):
        return "adc.error.timeout"
    if code == "upstream_unreachable":
        return "adc.error.hardwareUnavailable"
    return detail or "adc.error.generic"


class AdcTestState:
    def __init__(self):
        self.phase = "idle"
        self.duration = 5
        self.error: Optional[str] = None
        self.started_at = 0.0
        self.elapsed = 0.0


class AdcTestControls(Panel):
    TOPICS = frozenset({"defaults", "adc"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        if not hasattr(ctl, "adc_state"):
            ctl.adc_state = AdcTestState()
        self.st: AdcTestState = ctl.adc_state
        self._simulation_touched = False
        prod = ctl.is_production
        self.simulation = not prod
        self.seed = 42
        self.duration = 5
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        self.dur_lbl = label()
        self.dur = QComboBox()
        self.dur.activated.connect(lambda i: setattr(self, "duration", self.dur.itemData(i)))
        lay.addWidget(self.dur_lbl)
        lay.addWidget(self.dur)
        self.sim = Switch()
        self.sim.setChecked(self.simulation)
        self.sim.toggled.connect(self._sim_toggled)
        lay.addWidget(self.sim)
        self.seed_box = QWidget()
        sb = QVBoxLayout(self.seed_box)
        sb.setContentsMargins(0, 0, 0, 0)
        head = QHBoxLayout()
        self.seed_lbl = label()
        head.addWidget(self.seed_lbl)
        head.addStretch(1)
        head.addWidget(label("1–16383", "muted"))
        sb.addLayout(head)
        row = QHBoxLayout()
        row.addWidget(label("#", "dim"))
        self.seed_in = QSpinBox()
        self.seed_in.setRange(1, 16383)
        self.seed_in.setValue(self.seed)
        self.seed_in.valueChanged.connect(lambda v: setattr(self, "seed", max(1, min(16383, v))))
        row.addWidget(self.seed_in, 1)
        row.addWidget(label("U14", "dim"))
        sb.addLayout(row)
        lay.addWidget(self.seed_box)
        self.settings = QLabel()
        self.settings.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(self.settings)
        self.note = label("", "warn", wrap=True)
        lay.addWidget(self.note)
        self.run_btn = button("", "primary")
        self.run_btn.clicked.connect(self._run_or_stop)
        lay.addWidget(self.run_btn, 0, Qt.AlignmentFlag.AlignLeft)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.RichText)
        self.status.setWordWrap(True)
        lay.addWidget(self.status)
        lay.addStretch(1)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self.retranslate()
        self.refresh()

    @property
    def active(self) -> bool:
        return self.st.phase in ("connecting", "running")

    def _sim_toggled(self, c: bool) -> None:
        self._simulation_touched = True
        self.simulation = c
        self.refresh()

    def _run_or_stop(self) -> None:
        if self.active:
            self.stop()
        else:
            self.start()

    def start(self) -> None:
        st = self.st
        if self.ctl.engine.busy:
            st.phase, st.error = "error", "busy"
            self.ctl.notify("adc")
            return
        st.phase, st.error, st.duration = "connecting", None, self.duration
        st.started_at = time.monotonic()
        st.elapsed = 0.0
        self.ctl.adc_active = True
        self.ctl.notify("adc", "panel", "status")

        def started():
            st.phase = "running"
            st.started_at = time.monotonic()
            self.ctl.notify("adc")

        def finished(outcome: dict):
            self.ctl.adc_active = False
            if outcome.get("event") == "error":
                st.phase = "error"
                st.error = normalize_adc_error(str(outcome.get("detail") or ""), outcome.get("code"))
                if st.error == "adc.error.generic" and self.simulation:
                    st.error = "adc.error.simulation"
            elif st.phase != "error":
                st.phase = "done"
            self._timer.stop()
            self.ctl.notify("adc", "panel", "status")
        try:
            self.ctl.engine.start_adc(duration_minutes=self.duration, simulation=self.simulation, seed=self.seed,
                                      on_started=started, on_finished=finished)
        except RuntimeError as exc:
            self.ctl.adc_active = False
            st.phase, st.error = "error", str(exc)
            self.ctl.notify("adc", "panel")
            return
        self._timer.start(500)

    def stop(self) -> None:
        self.ctl.engine.stop()
        if self.st.phase != "error":
            self.st.phase = "done"
        self.ctl.notify("adc")

    def _tick(self) -> None:
        if self.st.phase == "running":
            self.st.elapsed = max(0.0, time.monotonic() - self.st.started_at)
        self.ctl.notify("adc")

    def retranslate(self):
        self.dur_lbl.setText(t("adc.duration"))
        self.dur.clear()
        for m in (5, 10, 15, 20):
            self.dur.addItem(f"{m} {t('adc.minutes')}", m)
        self.dur.setCurrentIndex((5, 10, 15, 20).index(self.duration))
        self.sim.setText(t("adc.simulation"))
        self.seed_lbl.setText(t("adc.seed"))
        self.note.setText(t("adc.productionRequired"))

    def refresh(self):
        d = self.ctl.defaults or {}
        if not self._simulation_touched and d.get("is_production") is not None:
            want = d.get("is_production") is not True
            if want != self.simulation:
                self.simulation = want
                self.sim.blockSignals(True)
                self.sim.setChecked(want)
                self.sim.blockSignals(False)
        adc = d.get("adc") or {}
        rows = [(t("adc.halfPeriod"), f"{adc.get('adcHalfPeriod', 3)} {t('adc.cycles')}"),
                (t("adc.settle"), f"{adc.get('adcSettleCycles', 1)} {t('adc.cycles')}"),
                (t("settings.general.adcLatchCycles"), f"{adc.get('adcLatchCycles', 1)} {t('adc.cycles')}"),
                (t("adc.dataDirection"), t("adc.inputOnly")), (t("adc.xyActivity"), t("adc.disabled"))]
        self.settings.setText("<table cellspacing='4'>" + "".join(
            f"<tr><td style='color:{theme.current().text_dim}'>{a}</td><td><b>{b}</b></td></tr>" for a, b in rows)
                              + "</table>")
        active = self.active
        for w in (self.dur, self.sim, self.seed_in):
            w.setEnabled(not active)
        self.seed_box.setVisible(self.simulation)
        self.note.setVisible(bool(d.get("is_production") is True) and not self.simulation)
        self.run_btn.setText(t("adc.stop") if active else t("adc.run"))
        set_prop(self.run_btn, "kind", "danger" if active else "primary")
        st = self.st
        remaining = max(0, self.duration * 60 - st.elapsed)
        count = self.ctl.engine.adc.count
        err = st.error
        if err and err.startswith("adc."):
            err = t(err)
        parts = [f"<b>{t(ADC_PHASE_LABELS[st.phase])}</b>", f"{format_time(st.elapsed)} {t('adc.elapsed')}",
                 f"{format_time(remaining)} {t('adc.remaining')}", f"{fmt(count)} {t('adc.samples')}"]
        if err:
            parts.append(f"<span style='color:{theme.current().warn}'>{err}</span>")
        self.status.setText(" &nbsp;·&nbsp; ".join(parts))


class AdcTimelineCanvas(Panel):
    TOPICS = frozenset({"adc"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.plot = _AdcPlot(ctl)
        lay.addWidget(self.plot, 1)
        self.summary = label("", "dim")
        lay.addWidget(self.summary)
        self.refresh()

    def refresh(self):
        a = self.ctl.engine.adc
        self.summary.setText(f"{t('adc.minimum')} {a.minimum if a.minimum is not None else '—'} · "
                             f"{t('adc.maximum')} {a.maximum if a.maximum is not None else '—'} · {t('adc.grayMapping')}")
        self.plot.update()


class _AdcPlot(QWidget):
    def __init__(self, ctl):
        super().__init__()
        self.ctl = ctl
        self.setMinimumSize(320, 320)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def paintEvent(self, e):  # noqa: N802
        a = self.ctl.engine.adc
        w, h = max(320, self.width()), max(320, self.height())
        p = QPainter(self)
        p.fillRect(0, 0, w, h, QColor("#050a14"))
        left, bottom = 44, 28
        pw, ph = w - left - 10, h - bottom - 10
        f = QFont()
        f.setPixelSize(11)
        p.setFont(f)
        for gray in range(0, 256, 51):
            y = 10 + ph - (gray / 255) * ph
            p.setPen(QPen(QColor(148, 163, 184, 77), 1))
            p.drawLine(QPointF(left, y), QPointF(w - 10, y))
            p.setPen(QColor("#94a3b8"))
            p.drawText(QPointF(8, y + 4), str(gray))
        with a.lock:
            latest = a.bin_latest.copy()
            duration = a.duration_minutes
        bins = latest.size
        bw = max(1.0, pw / bins)
        idx = np.flatnonzero(latest >= 0)
        for i in idx:
            gray = js_round(min(0x3FFF, int(latest[i])) * 255 / 0x3FFF)
            bh = gray / 255 * ph
            p.fillRect(QRectF(left + i / bins * pw, 10 + ph - bh, bw, bh), QColor(gray, gray, gray))
        p.setPen(QColor("#94a3b8"))
        p.drawText(QPointF(left, h - 7), "0")
        p.drawText(QPointF(w - 46, h - 7), f"{duration} min")
        p.end()


DAC_PHASE_LABELS = {"idle": "dacRamp.phase.idle", "connecting": "dacRamp.phase.connecting",
                    "running": "dacRamp.phase.running", "done": "dacRamp.phase.done", "error": "dacRamp.phase.error"}


class DacRampPanel(Panel):
    TOPICS = frozenset({"panel", "dac", "frame:dac"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.phase = "idle"
        self.axis = "x"
        self.run_axis = "x"
        self.fixed_code = 8192
        self.dwell = 500
        self.error: Optional[str] = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        self.switch = Switch()
        self.switch.toggled.connect(self._toggle)
        lay.addWidget(self.switch)
        self.hint = label("", "muted", wrap=True)
        lay.addWidget(self.hint)
        g = QGridLayout()
        self.axis_lbl = label()
        self.axis_in = QComboBox()
        self.axis_in.activated.connect(lambda i: setattr(self, "axis", self.axis_in.itemData(i)))
        self.fixed_lbl = label()
        self.fixed_in = NumberStepper(8192, step=1, minimum=0, maximum=16383)
        self.fixed_in.valueChanged.connect(self._fixed)
        self.dwell_lbl = label()
        self.dwell_in = NumberStepper(500, step=1, minimum=0, maximum=65535)
        self.dwell_in.valueChanged.connect(self._dwell)
        for i, (lw, w) in enumerate(((self.axis_lbl, self.axis_in), (self.fixed_lbl, self.fixed_in),
                                     (self.dwell_lbl, self.dwell_in))):
            g.addWidget(lw, 0, i)
            g.addWidget(w, 1, i)
        lay.addLayout(g)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(self.status)
        self.wave = _DacWave(ctl)
        lay.addWidget(self.wave)
        self.wave_summary = label("", "dim", wrap=True)
        lay.addWidget(self.wave_summary)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._poll)
        self.retranslate()
        self.refresh()

    @property
    def active(self) -> bool:
        return self.phase in ("connecting", "running")

    def _fixed(self, s):
        n = js_number(s)
        if math.isfinite(n):
            self.fixed_code = max(0, min(16383, js_round(n)))

    def _dwell(self, s):
        n = js_number(s)
        if math.isfinite(n):
            self.dwell = max(0, min(65535, js_round(n)))

    def _toggle(self, on: bool):
        if self._updating:
            return
        if on:
            self.start()
        else:
            self.stop()

    def start(self):
        if self.ctl.engine.busy:
            self.phase, self.error = "error", "busy"
            self.refresh()
            return
        self.phase, self.error = "connecting", None
        self.run_axis = self.axis
        self.ctl.engine.dac_ramp.reset()
        req = {"axis": self.axis, "fixed_code": self.fixed_code, "dwell": self.dwell, "latency_bytes": 16384,
               "cookie": 123, "beam_type": "Ion", "external_control": True,
               "adc_valid": bool(self.ctl.scan.vector["adc_valid"])}

        def started():
            self.phase = "running"
            self.refresh()

        def finished(outcome):
            self._timer.stop()
            if outcome.get("event") == "error":
                self.phase = "error"
                self.error = str(outcome.get("message") or "dacRamp.error.generic")
            elif self.phase != "error":
                self.phase = "done"
            self.refresh()
        try:
            self.ctl.engine.start_stream(ScanJob("dac_ramp", req), on_started=started, on_frame=lambda i, r: None,
                                         on_finished=finished)
        except RuntimeError as exc:
            self.phase, self.error = "error", str(exc)
        self._timer.start(50)
        self.refresh()

    def stop(self):
        self.ctl.engine.stop()
        if self.phase != "error":
            self.phase = "done"
        self.refresh()

    def _poll(self):
        self.wave.update()
        self.refresh()

    def retranslate(self):
        self.switch.setText(t("dacRamp.toggle"))
        self.hint.setText(t("dacRamp.hint"))
        self.axis_lbl.setText(t("dacRamp.axis"))
        self.axis_in.clear()
        self.axis_in.addItem(t("dacRamp.axis.x"), "x")
        self.axis_in.addItem(t("dacRamp.axis.y"), "y")
        self.axis_in.setCurrentIndex(0 if self.axis == "x" else 1)
        self.fixed_lbl.setText(t("dacRamp.fixedCode"))
        self.dwell_lbl.setText(t("dacRamp.dwell"))

    def refresh(self):
        active = self.active
        self.switch.blockSignals(True)
        self.switch.setChecked(active)
        self.switch.blockSignals(False)
        self.switch.setEnabled(not self.disabled and self.phase != "connecting")
        for w in (self.axis_in, self.fixed_in, self.dwell_in):
            w.setEnabled(not active and not self.disabled)
        show = active or self.phase in ("done", "error")
        for w in (self.status, self.wave, self.wave_summary):
            w.setVisible(show)
        err = self.error
        if err and err.startswith("dacRamp."):
            err = t(err)
        count = self.ctl.engine.dac_ramp.cursor
        parts = [f"<b>{t(DAC_PHASE_LABELS[self.phase])}</b>", f"{fmt(count)} / 16384 {t('dacRamp.samples')}"]
        if err:
            parts.append(f"<span style='color:{theme.current().warn}'>{err}</span>")
        self.status.setText(" &nbsp;·&nbsp; ".join(parts))
        self.wave_summary.setText(f"{t('dacRamp.axis')} {self.run_axis.upper()} · {t('dacRamp.waveformHint')}")
        self.wave.update()


class _DacWave(QWidget):
    def __init__(self, ctl):
        super().__init__()
        self.ctl = ctl
        self.setMinimumHeight(220)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def paintEvent(self, e):  # noqa: N802
        w, h = max(320, self.width()), max(220, self.height())
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(0, 0, w, h, QColor("#050a14"))
        left, bottom = 44, 10
        pw, ph = w - left - 10, h - bottom - 10
        f = QFont()
        f.setPixelSize(11)
        p.setFont(f)
        for code in range(0, 16385, 4096):
            y = 10 + ph - (min(code, 16383) / 16383) * ph
            p.setPen(QPen(QColor(148, 163, 184, 77), 1))
            p.drawLine(QPointF(left, y), QPointF(w - 10, y))
            p.setPen(QColor("#94a3b8"))
            p.drawText(QPointF(4, y + 4), str(code))
        samples = self.ctl.engine.dac_ramp.samples
        n = samples.size
        idx = np.flatnonzero(~np.isnan(samples))
        if idx.size:
            # decimate to the pixel width for drawing (visually identical polyline)
            step = max(1, idx.size // max(1, int(pw * 2)))
            sel = idx[::step]
            if sel[-1] != idx[-1]:
                sel = np.append(sel, idx[-1])
            path = QPainterPath()
            xs = left + sel / (n - 1) * pw
            ys = 10 + ph - samples[sel] / 16383 * ph
            path.moveTo(xs[0], ys[0])
            for x, y in zip(xs[1:], ys[1:]):
                path.lineTo(x, y)
            p.setPen(QPen(QColor("#22d3ee"), 1.5))
            p.drawPath(path)
        p.end()
