"""Vacuum controller and sample-stage dashboards (VacuumDashboard.tsx,
SampleStageDashboard.tsx). Floating tool windows that poll the backend once a
second while open, like the browser popups."""
from __future__ import annotations

import math
import time
from typing import Optional
from urllib.parse import quote

from PyQt6.QtCore import QPointF, QRectF, Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QPainter, QPen, QPixmap, QTransform
from PyQt6.QtWidgets import (
    QDialog, QFrame, QGridLayout, QHBoxLayout, QLabel, QPushButton, QScrollArea, QSizePolicy, QSlider,
    QVBoxLayout, QWidget,
)

from ..core.jsmath import js_number, to_exponential, to_fixed
from ..i18n import t
from ..paths import resource
from . import theme
from .common import Card, NumberStepper, Switch, button, label, run_bg

PUMP_IMAGES = {"MechanicalVacuumPump": "MechanicalVacuumPump.png", "TurboVacuumPump": "TurboVacuumPump.png",
               "UHVacuumPump_1": "UHVacuumPump_1.png", "UHVacuumPump_2": "UHVacuumPump_2.png"}
BORDER_COLORS = {"off": None, "waiting": "#facc15", "ready": "#4ade80", "error": "#f87171"}


def format_vacuum_value(v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "—"
    if not math.isfinite(v):
        return "—"
    return "0" if v == 0 else to_exponential(v, 2)


def format_runtime(seconds) -> str:
    total = max(0, int(math.floor(float(seconds or 0))))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def group_stages(pumps) -> list:
    """``[(groupName, [pump, ...]), ...]``: consecutive pumps sharing a group."""
    stages: list = []
    for pump in pumps:
        group = pump.get("group") or pump.get("name")
        if stages and stages[-1][0] == group:
            stages[-1][1].append(pump)
        else:
            stages.append((group, [pump]))
    return stages


def group_state(pumps) -> str:
    if any(p.get("border") == "error" for p in pumps):
        return "error"
    if pumps and all(p.get("border") == "ready" for p in pumps):
        return "ready"
    if any(p.get("border") == "waiting" for p in pumps):
        return "waiting"
    return "off"


class _ToolWindow(QDialog):
    minimized_changed = pyqtSignal(bool)
    activity_changed = pyqtSignal(bool)

    def __init__(self, parent=None):
        super().__init__(parent, Qt.WindowType.Tool | Qt.WindowType.WindowTitleHint | Qt.WindowType.WindowCloseButtonHint)
        self.setObjectName("Modal")
        self.setModal(False)

    def keyPressEvent(self, e):  # noqa: N802
        if e.key() == Qt.Key.Key_Escape:
            self.minimize()
            return
        super().keyPressEvent(e)

    def closeEvent(self, e):  # noqa: N802
        self.minimize()
        e.ignore()

    def minimize(self):
        self.hide()
        self.minimized_changed.emit(True)


class VacuumDashboard(_ToolWindow):
    def __init__(self, ctl, parent=None):
        super().__init__(parent)
        self.ctl = ctl
        self.status: Optional[dict] = None
        self.error: Optional[str] = None
        self.pending: Optional[str] = None
        self.resize(980, 560)
        lay = QVBoxLayout(self)
        head = QHBoxLayout()
        col = QVBoxLayout()
        self.title = label("", "title")
        self.device = label("", "dim")
        col.addWidget(self.title)
        col.addWidget(self.device)
        head.addLayout(col, 1)
        self.min_btn = button("−", "ghost")
        self.min_btn.clicked.connect(self.minimize)
        head.addWidget(self.min_btn)
        lay.addLayout(head)
        self.err = label("", "danger", wrap=True)
        lay.addWidget(self.err)
        self.body = QWidget()
        self.body_lay = QHBoxLayout(self.body)
        self.body_lay.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.body)
        lay.addWidget(scroll, 1)
        self.footer = label("", "dim")
        lay.addWidget(self.footer)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh_status)
        self._fetching = False
        self._version = 0
        self.retranslate()

    def retranslate(self):
        self.setWindowTitle(t("vacuum.title"))
        self.title.setText(t("vacuum.title"))
        self.min_btn.setToolTip(t("vacuum.minimize"))
        self.render_status()

    def open_dashboard(self):
        self.status, self.error, self.pending = None, None, None
        self.render_status()
        self.show()
        self.raise_()
        self.minimized_changed.emit(False)
        self.refresh_status()
        self._timer.start(1000)

    def minimize(self):
        super().minimize()

    def stop_polling(self):
        self._timer.stop()

    def _emit_activity(self):
        s = self.status or {}
        initializing = (s.get("running") is True and s.get("isVacuumSystemReady") is not True
                        and s.get("cascade_stopped") is not True and self.error is None)
        self.activity_changed.emit(self.isVisible() and (self.pending is not None or initializing))

    def refresh_status(self):
        if self.pending is not None or self._fetching:
            return
        self._fetching = True
        version = self._version

        def call():
            r = self.ctl.backend.request("GET", "/api/vacuum", timeout=5)
            if r.status_code == 404:
                return "__404__"
            if r.status_code >= 400:
                raise RuntimeError(f"{r.status_code} {r.reason_phrase}")
            return self.ctl.backend.read_json(r, "vacuum status")

        def ok(data):
            self._fetching = False
            if data == "__404__":
                self.minimize()
                self.stop_polling()
                return
            if self.pending is not None or version != self._version:
                return
            self.status, self.error = data, None
            self.render_status()

        def err(exc):
            self._fetching = False
            if self.pending is not None or version != self._version:
                return
            self.error = str(exc)
            self.render_status()
        run_bg(call, on_ok=ok, on_err=err)

    def update_power(self, name: str, power: bool):
        self.pending = name
        self.error = None
        self._version += 1
        self.render_status()

        def call():
            r = self.ctl.backend.request("POST", f"/api/vacuum/pumps/{quote(name, safe='')}/power",
                                         json_body={"power": power})
            if r.status_code >= 400:
                raise RuntimeError(r.text or f"{r.status_code} {r.reason_phrase}")
            return self.ctl.backend.read_json(r, "vacuum power")

        def ok(data):
            self.pending = None
            self.status = data
            self.render_status()

        def err(exc):
            self.pending = None
            self.error = str(exc)
            self.render_status()
        run_bg(call, on_ok=ok, on_err=err)

    def _pump_card(self, pump: dict) -> QWidget:
        s = self.status or {}
        mech = pump.get("name") == "MechanicalVacuumPump"
        card = Card(pump.get("name", ""))
        color = BORDER_COLORS.get(pump.get("border"))
        if color:
            card.setStyleSheet(f"QFrame#Card {{ border: 2px solid {color}; }}")
        sw = Switch()
        sw.setChecked(pump.get("port_b_value") == s.get("voltage"))
        sw.setEnabled(False)
        sw.setToolTip(t("vacuum.mechanicalAlwaysOn") if mech else pump.get("name", ""))
        card.header_tools.addWidget(sw)
        img = PUMP_IMAGES.get(pump.get("name"))
        if img:
            pm = QPixmap(str(resource("images", img)))
            if not pm.isNull():
                il = QLabel()
                il.setPixmap(pm.scaled(150, 110, Qt.AspectRatioMode.KeepAspectRatio,
                                       Qt.TransformationMode.SmoothTransformation))
                il.setAlignment(Qt.AlignmentFlag.AlignCenter)
                card.body.addWidget(il)
        for key, val in (("vacuum.threshold", format_vacuum_value(pump.get("threshold"))),
                         ("vacuum.realtime", "—" if pump.get("value") is None else format_vacuum_value(pump.get("value")))):
            row = QHBoxLayout()
            row.addWidget(label(t(key), "dim"))
            row.addStretch(1)
            row.addWidget(label(val, "title"))
            card.body.addLayout(row)
        row = QHBoxLayout()
        row.addWidget(label(f"{pump.get('write', '')} → {pump.get('read', '')}", "mono"))
        row.addStretch(1)
        pb = QPushButton("⏻")
        pb.setCheckable(True)
        pb.setChecked(bool(pump.get("power")))
        pb.setEnabled(not mech and s.get("running") is True and self.pending is None)
        pb.setToolTip(f"{t('vacuum.power')} {'off' if pump.get('power') else 'on'}")
        pb.setStyleSheet("QPushButton { border-radius: 14px; min-width: 28px; min-height: 28px; font-size: 16px; }"
                         f"QPushButton:checked {{ color: {theme.current().success}; border-color: {theme.current().success}; }}")
        pb.clicked.connect(lambda _c, n=pump.get("name"), p=pump.get("power"): self.update_power(n, not p))
        row.addWidget(pb)
        card.body.addLayout(row)
        card.setMinimumWidth(210)
        return card

    def render_status(self):
        s = self.status
        if s:
            transport = "Raspberry Pi GPIO" if s.get("control_transport") == "raspberry-pi-gpio" else t("vacuum.gpioSimulation")
            self.device.setText(f"{s.get('device_id')} · {to_fixed(float(s.get('voltage') or 0), 1)} V · "
                                f"{t('vacuum.simulation') if s.get('simulation') else t('vacuum.hardware')} · "
                                f"{transport} · {format_runtime(s.get('runtime_seconds'))}")
        else:
            self.device.setText("")
        self.err.setText(self.error or "")
        self.err.setVisible(bool(self.error))
        while self.body_lay.count():
            it = self.body_lay.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
        if not s:
            self.body_lay.addWidget(label(t("vacuum.acquiring") if self.pending == "acquire" else t("vacuum.loading"),
                                          "muted"))
        else:
            pumps = s.get("pumps") or []
            # Cascade stages come from each pump's groupName (``group``).
            stages = group_stages(pumps)
            if len(stages) > 1 and stages[0][1][0].get("name") == "MechanicalVacuumPump":
                for index, (group_name, members) in enumerate(stages):
                    if index:
                        self.body_lay.addWidget(self._arrow(group_state(stages[index - 1][1])))
                    if len(members) == 1:
                        self.body_lay.addWidget(self._pump_card(members[0]))
                        continue
                    group = QFrame()
                    group.setObjectName("Card")
                    gcol = BORDER_COLORS.get(group_state(members))
                    if gcol:
                        group.setStyleSheet(f"QFrame#Card {{ border: 2px dashed {gcol}; }}")
                    gl = QVBoxLayout(group)
                    gl.addWidget(label(t("vacuum.groupedStage", group=group_name), "dim"))
                    gr = QHBoxLayout()
                    for p in members:
                        gr.addWidget(self._pump_card(p))
                    gl.addLayout(gr)
                    self.body_lay.addWidget(group)
            else:
                grid = QWidget()
                gl = QGridLayout(grid)
                for i, p in enumerate(pumps):
                    gl.addWidget(self._pump_card(p), i // 4, i % 4)
                self.body_lay.addWidget(grid)
        self.body_lay.addStretch(1)
        self.footer.setText(t("vacuum.cascadeStopped") if (s or {}).get("cascade_stopped") else t("vacuum.cascadeRunning"))
        self._emit_activity()

    @staticmethod
    def _arrow(state) -> QWidget:
        lbl = QLabel("⟶")
        color = BORDER_COLORS.get(state) or theme.current().text_muted
        lbl.setStyleSheet(f"color: {color}; font-size: 28px;")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        return lbl


# ---------------------------------------------------------------------------- sample stage

DEFAULT_LIMITS = {"x": (-75000, 75000), "y": (-75000, 75000), "z": (0, 10000), "t": (-10, 60), "r": (-180, 180)}


def display_um(v: float) -> str:
    """``Number(v.toFixed(4))`` rendered like JS."""
    from ..core.jsmath import js_string
    return js_string(float(to_fixed(float(v), 4)))


def axis_percent(value, limit, invert=False):
    lo, hi = limit
    pct = max(0.0, min(100.0, (value - lo) / (hi - lo) * 100)) if hi != lo else 0.0
    return 100 - pct if invert else pct


class _StageCanvas(QWidget):
    def __init__(self, dash):
        super().__init__()
        self.dash = dash
        self.image = QPixmap(str(resource("images", "SampleStage-0.3.png")))
        self.setMinimumSize(520, 380)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def paintEvent(self, e):  # noqa: N802
        d = self.dash
        tk = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        W, H = self.width(), self.height()
        p.fillRect(0, 0, W, H, QColor(tk.bg_elev))
        lim = d.limits()
        # background grid / ticks / labels
        p.setPen(QPen(QColor(95, 184, 255, 36), 1))
        for q in (0, 25, 50, 75, 100):
            p.drawLine(QPointF(W * q / 100, 0), QPointF(W * q / 100, H))
            p.drawLine(QPointF(0, H * q / 100), QPointF(W, H * q / 100))
        f = QFont("monospace")
        f.setPixelSize(10)
        p.setFont(f)
        for i in range(21):
            major = i % 5 == 0
            x, y = W * i / 20, H * i / 20
            p.setPen(QPen(QColor(95, 184, 255, 230), 1))
            p.drawLine(QPointF(x, 0), QPointF(x, 10 if major else 5))
            p.drawLine(QPointF(0, y), QPointF(10 if major else 5, y))
            if major:
                p.setPen(QColor(230, 238, 249, 220))
                xv = display_um(lim["x"][0] + i * (lim["x"][1] - lim["x"][0]) / 20)
                yv = display_um(lim["y"][1] - i * (lim["y"][1] - lim["y"][0]) / 20)
                p.drawText(QRectF(x - 40 if 0 < i < 20 else (x + 3 if i == 0 else x - 83), 14, 80, 12),
                           Qt.AlignmentFlag.AlignCenter, xv)
                p.drawText(QRectF(14, y - 6 if 0 < i < 20 else (y + 3 if i == 0 else y - 15), 80, 12),
                           Qt.AlignmentFlag.AlignLeft, yv)
        # stage image transform
        pos = d.stage_position
        if not self.image.isNull():
            iw, ih = self.image.width(), self.image.height()
            scale = min(W / iw, H / ih) * 0.72
            w, h = iw * scale, ih * scale
            xt, yt = (W - w) / 2, (H - h) / 2
            xm, ym = sum(lim["x"]) / 2, sum(lim["y"]) / 2
            x = (W - w) / 2 + ((pos["x"] - xm) / ((lim["x"][1] - lim["x"][0]) / 2)) * xt
            y = (H - h) / 2 - ((pos["y"] - ym) / ((lim["y"][1] - lim["y"][0]) / 2)) * yt
            zp = axis_percent(pos["z"], lim["z"]) / 100
            s = 1 + zp * 0.12
            tilt, rot = math.radians(pos["t"]), math.radians(pos["r"])
            proj = max(0.42, math.cos(tilt))
            shear = math.sin(tilt) * 0.16
            p.save()
            p.translate(x + w / 2, y + h / 2 - zp * 64)
            p.rotate(math.degrees(rot))
            p.scale(s, s)
            p.setTransform(QTransform(1, shear, 0, proj, 0, 0), True)
            p.drawPixmap(QRectF(-w / 2, -h / 2, w, h), self.image, QRectF(0, 0, iw, ih))
            p.restore()
        ox = (0 - lim["x"][0]) / (lim["x"][1] - lim["x"][0]) * W
        oy = (lim["y"][1] - 0) / (lim["y"][1] - lim["y"][0]) * H
        p.setPen(QPen(QColor(255, 0, 0), 0.5))
        p.drawLine(QPointF(ox, 0), QPointF(ox, H))
        p.drawLine(QPointF(0, oy), QPointF(W, oy))
        # position lines
        p.setPen(QPen(QColor(tk.accent), 1, Qt.PenStyle.DashLine))
        px = W * axis_percent(pos["x"], lim["x"]) / 100
        py = H * axis_percent(pos["y"], lim["y"], True) / 100
        p.drawLine(QPointF(px, 0), QPointF(px, H))
        p.drawLine(QPointF(0, py), QPointF(W, py))
        # target values
        tg = d.target
        p.setPen(QColor(tk.accent_hot))
        tx = W * axis_percent(tg["x"], lim["x"]) / 100
        ty = H * axis_percent(tg["y"], lim["y"], True) / 100
        p.drawText(QPointF(min(W - 90, tx + 4), H - 6), f"{display_um(tg['x'])} µm")
        p.drawText(QPointF(W - 96, max(12, ty - 4)), f"{display_um(tg['y'])} µm")
        # kinematic glyph (Z scale, platter tilt / rotation)
        self._kinematic(p, W - 190, H - 170, pos, lim)
        p.end()

    def _kinematic(self, p: QPainter, x0: float, y0: float, pos, lim) -> None:
        tk = theme.current()
        zp = axis_percent(pos["z"], lim["z"]) / 100
        p.save()
        p.translate(x0, y0)
        p.setPen(QPen(QColor(tk.text_dim), 1))
        p.drawLine(QPointF(14, 22), QPointF(14, 111))
        for fr in (0, 0.25, 0.5, 0.75, 1):
            p.drawLine(QPointF(10, 111 - fr * 89), QPointF(20, 111 - fr * 89))
        p.drawText(QPointF(8, 13), "Z")
        p.setPen(QPen(QColor(tk.accent), 1.4))
        p.drawLine(QPointF(8, 88 - zp * 64), QPointF(62, 88 - zp * 64))
        p.drawText(QPointF(21, 83 - zp * 64), f"{display_um(pos['z'])} µm")
        p.setBrush(QColor("#17475e"))
        p.setPen(QPen(QColor("#558aa3"), 1))
        p.drawRect(QRectF(62, 111, 89, 24))
        p.translate(0, -zp * 64)
        p.drawRect(QRectF(94, 87, 25, 31))
        p.translate(107, 88)
        p.rotate(-pos["t"] * 0.65)
        p.translate(-107, -88)
        p.setBrush(QColor("#0a1e2c"))
        p.drawEllipse(QPointF(107, 78), 58, 27)
        p.setBrush(QColor("#17475e"))
        p.drawEllipse(QPointF(107, 72), 58, 27)
        p.translate(107, 72)
        p.rotate(pos["r"])
        p.scale(1, 0.465)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.setPen(QPen(QColor("#66c9e7"), 1.2))
        p.drawEllipse(QPointF(0, 0), 49, 49)
        p.drawLine(QPointF(-45, 0), QPointF(45, 0))
        p.drawLine(QPointF(0, -23), QPointF(0, 23))
        p.restore()
        p.setPen(QColor(tk.text))
        p.drawText(QPointF(x0 + 145, y0 + 20), f"T {to_fixed(pos['t'], 1)}°")
        p.drawText(QPointF(x0 + 145, y0 + 32), f"R {to_fixed(pos['r'], 1)}°")


class SampleStageDashboard(_ToolWindow):
    def __init__(self, ctl, parent=None):
        super().__init__(parent)
        self.ctl = ctl
        self.status: Optional[dict] = None
        self.stage_position = {"x": 0.0, "y": 0.0, "z": 0.0, "t": 0.0, "r": 0.0}
        self.target = dict(self.stage_position)
        self.initializing = False
        self.move_pending = False
        self.error: Optional[str] = None
        self._edited = False
        self._anim: Optional[tuple] = None
        self.resize(1000, 680)
        lay = QVBoxLayout(self)
        head = QHBoxLayout()
        self.title = label("", "title")
        head.addWidget(self.title)
        self.inputs = {}
        for axis, unit in (("x", "X µm"), ("y", "Y µm"), ("z", "Z µm"), ("t", "T°"), ("r", "R°")):
            col = QVBoxLayout()
            col.addWidget(label(unit, "dim"))
            inp = NumberStepper(0, step=1 if axis in "xyz" else 0.1, width=90)
            inp.valueChanged.connect(lambda s, a=axis: self._edit(a, s))
            col.addWidget(inp)
            self.inputs[axis] = inp
            head.addLayout(col)
        self.move_btn = button("", "primary")
        self.move_btn.clicked.connect(self.move_stage)
        head.addWidget(self.move_btn, 0, Qt.AlignmentFlag.AlignBottom)
        head.addStretch(1)
        self.min_btn = button("−", "ghost")
        self.min_btn.clicked.connect(self.minimize)
        head.addWidget(self.min_btn, 0, Qt.AlignmentFlag.AlignTop)
        lay.addLayout(head)
        self.canvas = _StageCanvas(self)
        lay.addWidget(self.canvas, 1)
        sl = QHBoxLayout()
        self.x_slider = QSlider(Qt.Orientation.Horizontal)
        self.x_slider.valueChanged.connect(lambda v: self._edit("x", str(v)))
        self.y_slider = QSlider(Qt.Orientation.Horizontal)
        self.y_slider.valueChanged.connect(lambda v: self._edit("y", str(v)))
        self.x_lbl, self.y_lbl = label("", "dim"), label("", "dim")
        sl.addWidget(self.x_lbl)
        sl.addWidget(self.x_slider, 1)
        sl.addWidget(self.y_lbl)
        sl.addWidget(self.y_slider, 1)
        lay.addLayout(sl)
        self.motion = label("", "dim", wrap=True)
        lay.addWidget(self.motion)
        self.readout = label("", "mono")
        lay.addWidget(self.readout)
        self.err = label("", "danger", wrap=True)
        lay.addWidget(self.err)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh_status)
        self._anim_timer = QTimer(self)
        self._anim_timer.timeout.connect(self._anim_step)
        self._fetching = False
        self.retranslate()

    def limits(self) -> dict:
        lim = (self.status or {}).get("limits") or {}
        out = {}
        for a, dflt in DEFAULT_LIMITS.items():
            v = lim.get(a)
            out[a] = (v["minimum"], v["maximum"]) if isinstance(v, dict) else dflt
        return out

    def _step(self, axis: str) -> float:
        axes = (self.status or {}).get("axes") or {}
        a = axes.get(axis) or {}
        if axis in "xyz":
            return a.get("resolution_micrometers") or 1
        return a.get("resolution") or 0.1

    def retranslate(self):
        self.setWindowTitle(t("sampleStage.title"))
        self.title.setText(t("sampleStage.title"))
        self.min_btn.setToolTip(t("sampleStage.minimize"))
        self.x_lbl.setText(t("sampleStage.axis.x"))
        self.y_lbl.setText(t("sampleStage.axis.y"))
        self.render_state()

    def open_dashboard(self):
        self.show()
        self.raise_()
        self.minimized_changed.emit(False)
        self.initializing = True
        self.refresh_status()
        self._timer.start(1000)

    def _emit_activity(self):
        self.activity_changed.emit(self.isVisible() and (self.initializing or self.move_pending
                                                         or (self.status or {}).get("moving") is True))

    def _normalize(self, status: dict, fallback: dict) -> dict:
        pos = status.get("position") or {}
        status = dict(status)
        status["position"] = {a: float(pos.get(a) if pos.get(a) is not None else fallback[a]) for a in "xyztr"}
        return status

    def refresh_status(self):
        if self._fetching:
            return
        self._fetching = True

        def call():
            r = self.ctl.backend.request("GET", "/api/stage", timeout=5)
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}")
            return r.json()

        def ok(data):
            self._fetching = False
            st = self._normalize(data, self.stage_position)
            self.status = st
            if self._anim is None:
                self.stage_position = dict(st["position"])
            if not self._edited:
                self.target = dict(st["position"])
            self.error = st.get("last_error")
            self.initializing = False
            self.render_state()

        def err(exc):
            self._fetching = False
            self.error = str(exc)
            self.initializing = False
            self.render_state()
        run_bg(call, on_ok=ok, on_err=err)

    def _edit(self, axis: str, text: str):
        if getattr(self, "_rendering", False):
            return
        n = js_number(text)
        if not math.isfinite(n):
            return
        self._edited = True
        self.target[axis] = n
        self.canvas.update()

    def move_stage(self):
        self.error = None
        self.move_pending = True
        requested = dict(self.target)
        previous = dict(self.stage_position)
        self._animate(requested)
        self.render_state()

        def call():
            r = self.ctl.backend.request("POST", "/api/stage/move", json_body=requested, timeout=30)
            try:
                body = r.json()
            except ValueError:
                body = {}
            if r.status_code >= 400:
                raise RuntimeError(body.get("detail") or f"HTTP {r.status_code}")
            return body

        def ok(body):
            self.move_pending = False
            st = self._normalize(body, requested)
            self.status = st
            if any(st["position"][a] != requested[a] for a in "xyztr"):
                self._animate(st["position"])
            self.target = dict(st["position"])
            self._edited = False
            self.render_state()

        def err(exc):
            self.move_pending = False
            self._animate(previous)
            self.error = str(exc)
            self.render_state()
        run_bg(call, on_ok=ok, on_err=err)

    def _animate(self, target: dict):
        self._anim = (dict(self.stage_position), dict(target), time.monotonic())
        self._anim_timer.start(16)

    def _anim_step(self):
        if self._anim is None:
            self._anim_timer.stop()
            return
        start, target, t0 = self._anim
        el = min(1.0, (time.monotonic() - t0) / 0.5)
        eased = 1 - (1 - el) ** 3
        self.stage_position = {a: start[a] + (target[a] - start[a]) * eased for a in "xyztr"}
        if el >= 1:
            self._anim = None
            self._anim_timer.stop()
        self.canvas.update()
        self._update_readout()

    def _update_readout(self):
        p = self.stage_position
        self.readout.setText(f"X {display_um(p['x'])} µm · Y {display_um(p['y'])} µm · Z {display_um(p['z'])} µm · "
                             f"T {to_fixed(p['t'], 2)}° · R {to_fixed(p['r'], 2)}°")

    def render_state(self):
        self._rendering = True
        try:
            lim = self.limits()
            st = self.status or {}
            continuous = ((st.get("axes") or {}).get("r") or {}).get("continuous", True)
            for a, inp in self.inputs.items():
                inp.step = self._step(a)
                if a == "r" and continuous:
                    inp.minimum = inp.maximum = None
                else:
                    inp.minimum, inp.maximum = lim[a]
                if not inp.edit.hasFocus():
                    inp.force_value(display_um(self.target[a]) if a in "xyz" else js_fmt(self.target[a]))
            for sl, a in ((self.x_slider, "x"), (self.y_slider, "y")):
                sl.blockSignals(True)
                sl.setRange(int(lim[a][0]), int(lim[a][1]))
                sl.setValue(int(round(self.target[a])))
                sl.blockSignals(False)
            moving = st.get("moving") is True
            self.move_btn.setText(t("sampleStage.moving") if moving else t("sampleStage.move"))
            self.move_btn.setEnabled(st.get("connected") is True and not moving)
            self.motion.setText(
                f"Sample stage · 5 AXIS   X {display_um(lim['x'][0])}…{display_um(lim['x'][1])} µm · "
                f"{js_fmt(self._step('x'))} µm   Y {display_um(lim['y'][0])}…{display_um(lim['y'][1])} µm · "
                f"{js_fmt(self._step('y'))} µm   Z {display_um(lim['z'][0])}…{display_um(lim['z'][1])} µm   "
                f"T {js_fmt(lim['t'][0])}°…{js_fmt(lim['t'][1])}°   "
                f"R {'continuous' if continuous else f'{js_fmt(lim[chr(114)][0])}°…{js_fmt(lim[chr(114)][1])}°'}")
            self.err.setText(self.error or "")
            self.err.setVisible(bool(self.error))
            self._update_readout()
            self.canvas.update()
        finally:
            self._rendering = False
        self._emit_activity()


def js_fmt(v) -> str:
    from ..core.jsmath import js_string
    return js_string(v)
