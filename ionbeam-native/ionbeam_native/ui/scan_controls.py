"""Scan controls, run report and error wedge.

Ports ScanControls.tsx (Run / Stop / Infinite / Run validated / Clear /
Repeat, region + equipment selectors, preview switch, ROI action variant
with the ROI raster / ROI gray vector wedges), ValidationPanel.tsx and
ErrorWedge.tsx.

Infinite is an engine "live" job: frames follow each other on the open
Glasgow session with no UI round trip in between (OBI's live loop). The
finite Repeat loop keeps the web's 750 ms settle gap between vector runs.
"""
from __future__ import annotations

import math
import os
import re
import time
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote

from PyQt6.QtCore import QTimer, QUrl, Qt
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QComboBox, QFileDialog, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QVBoxLayout, QWidget,
)

from ..core.bitmap_vector import (
    clear_bitmap_selection_cache, raster_request_with_bitmap_selection, vector_request_with_adaptive_gray_feedback,
    vector_request_with_bitmap_selection, vector_request_with_roi_gray_scale_action, without_partial_roi_selection,
)
from ..core.helpers import (
    SITE_OPTIONS, ScanType, display_scan_error, repeat_countdown_display, should_clear_roi_feedback_before_repeat,
    should_retain_roi_feedback_on_complete,
)
from ..core.jsmath import js_number, to_fixed, trunc
from ..i18n import fmt, t
from . import theme
from .common import (
    HelpButton, NumberStepper, PresetNumberField, Spinner, Switch, button, hline, icon, label, label_with_help, prefs,
    run_bg, set_prop,
)
from .panel import Panel
from .params import bracketed_bold

ACTION_LOOP_GAP_MS = 750


class RepeatControl(QWidget):
    def __init__(self, on_change: Callable[[int], None], parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        self.lbl = label()
        self.counter = label("", "title")
        self.counter.setMinimumWidth(24)
        self.counter.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.input = NumberStepper(1, step=1, minimum=1, maximum=50, width=60)
        self.input.valueChanged.connect(lambda s: on_change(self._parse(s)))
        lay.addWidget(self.lbl)
        lay.addWidget(self.counter)
        lay.addWidget(self.input)
        lay.addStretch(1)

    @staticmethod
    def _parse(text: str) -> int:
        n = js_number(text)
        return min(50, max(1, trunc(n))) if math.isfinite(n) else 1

    def set_state(self, repeat: int, display: int, disabled: bool):
        self.lbl.setText(t("scan.repeat"))
        self.setToolTip(t("scan.repeat.title"))
        self.counter.setText(str(display))
        self.input.set_value(repeat)
        self.input.setEnabled(not disabled)


class ROIRasterActionWedges(Panel):
    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.disabled_override = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.title = label("", "title")
        lay.addWidget(self.title)
        row = QHBoxLayout()
        self.res_label = label_with_help("", HelpButton("resolution"))
        self.resolution = PresetNumberField(self.res_label, minimum=1, maximum=2048)
        self.resolution.set_options([(v, None) for v in (128, 256, 512, 1024, 2048)])
        self.resolution.changed.connect(lambda v: self._update({"resolution": v}))
        self.dwell_label = label_with_help("", HelpButton("dwell"))
        self.dwell = PresetNumberField(self.dwell_label, minimum=0, maximum=65535)
        self.dwell.set_options([(v, None) for v in (0, 1, 3, 7, 15, 31, 63)])
        self.dwell.changed.connect(lambda v: self._update({"dwell": v}))
        row.addWidget(self.resolution, 1)
        row.addWidget(self.dwell, 1)
        lay.addLayout(row)
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.title.setText(f"{t('tabs.roi')} {t('tabs.raster')}")
        self.res_label.label.setText(t("raster.resolution"))
        self.dwell_label.label.setText(t("raster.dwell"))

    def refresh(self):
        r = self.ctl.scan.raster
        self.resolution.set_value(r["resolution"])
        self.dwell.set_value(r["dwell"])
        self.resolution.setEnabled(not self.disabled_override)
        self.dwell.setEnabled(not self.disabled_override)

    def _update(self, patch):
        if not self._updating:
            self.ctl.scan.update_raster(patch)
            self.ctl.notify("scan")


class ROIGrayActionVectorWedges(Panel):
    """Forces 128 / dwell>=2 / 8196 / SixteenBit / cookie 123 / pre-process while active; restores after."""

    FORCED = {"vector_resolution": 128, "latency_bytes": 8196, "output_mode": "SixteenBit", "cookie": 123,
              "pre_process": True}

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.active = False
        self.disabled_override = False
        self._snapshot: Optional[dict] = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.title = label("", "title")
        lay.addWidget(self.title)
        g = QGridLayout()
        self.res_label = label_with_help("", HelpButton("vectorResolution"))
        self.resolution = PresetNumberField(self.res_label, minimum=128, maximum=2048)
        self.resolution.set_options([(v, None) for v in (128, 256, 512, 1024, 2048)])
        self.resolution.changed.connect(lambda v: self._update({"vector_resolution": v}))
        self.dwell_label = label_with_help("", HelpButton("dwell"))
        self.dwell = PresetNumberField(self.dwell_label, minimum=1, maximum=65535, normalize=lambda v: max(2, v))
        self.dwell.set_options([(v, None) for v in (1, 2, 4, 8, 16, 32, 64)])
        self.dwell.changed.connect(lambda v: self._update({"dwell": v}))
        g.addWidget(self.resolution, 0, 0)
        g.addWidget(self.dwell, 0, 1)
        self.lat_label = label_with_help("", HelpButton("latency"))
        self.latency = NumberStepper(8196)
        self.latency.setEnabled(False)
        self.out_label = label_with_help("", HelpButton("outputMode"))
        self.output = QComboBox()
        self.output.addItems(["SixteenBit", "EightBit"])
        self.output.setEnabled(False)
        self.cookie_label = label_with_help("", HelpButton("cookie"))
        self.cookie = NumberStepper(123)
        self.cookie.setEnabled(False)
        self.pre = Switch()
        self.pre.setChecked(True)
        self.pre.setEnabled(False)
        for i, (lw, w) in enumerate(((self.lat_label, self.latency), (self.out_label, self.output),
                                     (self.cookie_label, self.cookie))):
            box = QVBoxLayout()
            box.addWidget(lw)
            box.addWidget(w)
            g.addLayout(box, 1 + i // 2, i % 2)
        pre_row = QHBoxLayout()
        pre_row.addWidget(self.pre)
        pre_row.addWidget(HelpButton("preProcess"))
        pre_row.addStretch(1)
        g.addLayout(pre_row, 2, 1, Qt.AlignmentFlag.AlignBottom)
        lay.addLayout(g)
        self.retranslate()

    def set_active(self, active: bool) -> None:
        if active == self.active:
            return
        self.active = active
        v = self.ctl.scan.vector
        if active:
            self._snapshot = {k: v[k] for k in ("vector_resolution", "dwell", "latency_bytes", "output_mode",
                                                "cookie", "pre_process")}
            self.ctl.scan.update_vector({**self.FORCED, "dwell": max(2, v["dwell"])})
        elif self._snapshot:
            self.ctl.scan.update_vector(self._snapshot)
            self._snapshot = None
        self.setVisible(active)
        self.ctl.notify("scan")

    def retranslate(self):
        self.title.setText(f"{t('tabs.roi')} {t('tabs.vector')}")
        self.res_label.label.setText(t("vector.resolution"))
        self.dwell_label.label.setText(t("vector.dwell"))
        self.lat_label.label.setText(t("vector.latencyBytes"))
        self.out_label.label.setText(t("vector.outputMode"))
        self.cookie_label.label.setText(t("vector.cookie"))
        self.pre.setText(t("vector.preProcess"))

    def refresh(self):
        v = self.ctl.scan.vector
        self.resolution.set_value(v["vector_resolution"])
        self.dwell.set_value(v["dwell"])
        self.latency.set_value(v["latency_bytes"])
        self.output.setCurrentText(v["output_mode"])
        self.cookie.set_value(v["cookie"])
        self.resolution.setEnabled(not self.disabled_override)
        self.dwell.setEnabled(not self.disabled_override)

    def _update(self, patch):
        if not self._updating:
            self.ctl.scan.update_vector(patch)
            self.ctl.notify("scan")


class ScanControls(Panel):
    TOPICS = frozenset({"scan", "panel", "equipment", "defaults", "status", "vacuum", "roi", "vector-gray",
                        "frame-complete"})

    def __init__(self, ctl, *, roi_action: bool = False, parent=None):
        super().__init__(ctl, parent)
        self.roi_action = roi_action
        self.kind = "vector" if roi_action else "raster"
        self.repeat = 1
        self.show_repeat_control = True
        self.vector_gray_selection = None
        self.vector_gray_skipped = None
        self.on_action_run_start: Optional[Callable[[], None]] = None
        self.on_repeat_change: Optional[Callable[[int], None]] = None
        self._loop_timer = QTimer(self)
        self._loop_timer.setSingleShot(True)
        self._loop_timer.timeout.connect(self._fire_next_action_run)
        self._loop_req: Optional[dict] = None
        self._loop_remaining = 0
        self._loop_iteration = 0
        self._loop_active = False
        self._loop_completion_pending = False
        self._infinite_active = False
        self._prev_phase = ctl.scan.phase
        self._selection_key = self._roi_key()
        self._region = ""

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        sel = QHBoxLayout()
        self.region_lbl = label()
        self.region = QComboBox()
        self.region.activated.connect(self._region_changed)
        self.equip_lbl = label()
        self.equipment = QComboBox()
        self.equipment.activated.connect(self._equipment_changed)
        rbox, ebox = QVBoxLayout(), QVBoxLayout()
        rbox.addWidget(self.region_lbl)
        rbox.addWidget(self.region)
        ebox.addWidget(self.equip_lbl)
        ebox.addWidget(self.equipment)
        sel.addLayout(rbox, 1)
        sel.addLayout(ebox, 1)
        lay.addLayout(sel)
        if roi_action:
            self.gray_wedges = ROIGrayActionVectorWedges(ctl)
            self.gray_wedges.hide()
            self.raster_wedges = ROIRasterActionWedges(ctl)
            lay.addWidget(self.gray_wedges)
            lay.addWidget(self.raster_wedges)
        prow = QHBoxLayout()
        self.preview = Switch()
        self.preview.toggled.connect(self._preview_toggled)
        self.preview_warn = QLabel()
        self.preview_warn.setPixmap(icon("alertTriangle", theme.current().warn).pixmap(16, 16))
        prow.addWidget(self.preview)
        prow.addWidget(self.preview_warn)
        self.busy = Spinner()
        prow.addWidget(self.busy)
        prow.addStretch(1)
        lay.addLayout(prow)
        brow = QHBoxLayout()
        brow.setSpacing(6)
        self.run_btn = button("", "primary", "play")
        self.run_btn.clicked.connect(self.on_run)
        self.stop_btn = button("", "danger", "square")
        self.stop_btn.setIcon(icon("square", theme.current().danger))
        self.stop_btn.clicked.connect(self.on_stop)
        brow.addWidget(self.run_btn)
        brow.addWidget(self.stop_btn)
        self.infinite_btn = button("", "primary", "infinity")
        self.infinite_btn.setCheckable(True)
        self.infinite_btn.clicked.connect(self.on_infinite)
        brow.addWidget(self.infinite_btn)
        brow.addStretch(1)
        self.validated_btn = button("", None, "check")
        self.validated_btn.setIcon(icon("check", theme.current().success))
        self.validated_btn.clicked.connect(self.on_run_validated)
        self.validated_help = HelpButton("runValidated")
        brow.addWidget(self.validated_btn)
        brow.addWidget(self.validated_help)
        self.clear_btn = button("", "ghost", "x")
        self.clear_btn.setIcon(icon("x", theme.current().danger))
        self.clear_btn.clicked.connect(self.on_clear)
        brow.addWidget(self.clear_btn)
        lay.addLayout(brow)
        self.repeat_ctl = RepeatControl(self._repeat_changed)
        lay.addWidget(self.repeat_ctl)
        self.error = label("", "danger", wrap=True)
        self.error.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        lay.addWidget(self.error)
        if roi_action:
            self.infinite_btn.hide()
            self.validated_btn.hide()
            self.validated_help.hide()
            self.clear_btn.hide()
        ctl.scan_event.connect(self._scan_event)
        self.retranslate()
        self.refresh()

    # ------------------------------------------------------------------ configuration from the window
    def configure(self, *, kind: str, repeat: int, show_repeat_control: bool, vector_gray_selection,
                  vector_gray_skipped) -> None:
        kind_changed = kind != self.kind
        self.kind = kind
        self.repeat = repeat
        self.show_repeat_control = show_repeat_control
        self.vector_gray_selection = vector_gray_selection
        self.vector_gray_skipped = vector_gray_skipped
        if kind_changed:
            self._clear_loops()
        self.refresh()

    # ------------------------------------------------------------------ derived state
    def _roi_key(self) -> str:
        sel = self.ctl.scan.roi.selection
        return f"{sel['x_start']}:{sel['x_end']}:{sel['y_start']}:{sel['y_end']}" if sel else ""

    @property
    def _vector_pixel_fallback_blank(self) -> bool:
        d = self.ctl.defaults or {}
        vp = d.get("vector_params")
        if isinstance(vp, dict) and isinstance(vp.get("pixelFallbackBlank"), bool):
            return vp["pixelFallbackBlank"]
        vd = d.get("vector")
        return isinstance(vd, dict) and vd.get("PixelFallbackBlank") is True

    @property
    def _is_production(self) -> bool:
        return (self.ctl.defaults or {}).get("is_production") is not False

    @property
    def _allow_bitmap_simulation(self) -> bool:
        return not self._is_production and bool(self.ctl.scan.roi.imageDataUrl)

    def _active_vector_gray(self):
        if self.kind == "vector" and self.vector_gray_selection is not None:
            return self.vector_gray_selection, self.vector_gray_skipped
        return None, None

    def _scan_gray(self):
        if self.roi_action:
            return self.ctl.scan.roiGrayScaleSelection, self.ctl.scan.roiGrayScaleSkipped
        sel, skipped = self._active_vector_gray()
        return sel, (skipped if sel is not None else None)

    @property
    def _roi_gray_filter_active(self) -> bool:
        s = self.ctl.scan
        return self.roi_action and s.roiGrayScaleSelection is not None and s.roiGrayScaleSkipped is not None

    @property
    def _vector_gray_filter_active(self) -> bool:
        sel, skipped = self._active_vector_gray()
        return self.kind == "vector" and sel is not None and skipped is not None

    @property
    def _roi_ebeam_disabled(self) -> bool:
        return self.roi_action and self.ctl.selected_beam == "ebeam"

    # ------------------------------------------------------------------ request builders
    def _build_vector_request(self) -> dict:
        s = self.ctl.scan
        sel, skipped = self._scan_gray()
        base = {**s.vector, "roi": None}
        roi = without_partial_roi_selection(s.roi)
        if self._vector_pixel_fallback_blank and sel is not None and skipped is not None:
            return vector_request_with_adaptive_gray_feedback(base, roi, gray_scale_selection=sel,
                                                              gray_scale_skipped=skipped)
        return vector_request_with_bitmap_selection(base, roi, is_production=self._is_production,
                                                    allow_bitmap_simulation=self._allow_bitmap_simulation,
                                                    gray_scale_selection=sel, gray_scale_skipped=skipped)

    def _build_raster_request(self, *, keep_roi: bool = False, with_gray: bool = True) -> dict:
        s = self.ctl.scan
        sel, skipped = self._scan_gray() if with_gray else (None, None)
        base = {**s.raster, "roi": s.roi.selection if keep_roi else None}
        roi = s.roi if keep_roi else without_partial_roi_selection(s.roi)
        return raster_request_with_bitmap_selection(base, roi, is_production=self._is_production,
                                                    allow_bitmap_simulation=self._allow_bitmap_simulation,
                                                    gray_scale_selection=sel, gray_scale_skipped=skipped)

    @staticmethod
    def _vector_scan_type(req: dict) -> str:
        return ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK if req.get("feedback_mode") == "adaptive_gray_feedback" \
            else ScanType.VECTOR

    # ------------------------------------------------------------------ loops
    def _clear_loops(self) -> None:
        self._loop_timer.stop()
        self._loop_req = None
        self._loop_remaining = 0
        self._loop_iteration = 0
        self._loop_active = False
        self._loop_completion_pending = False
        self._infinite_active = False

    def _start_action_loop(self, req: dict, scan_type: str) -> None:
        self._clear_loops()
        self._loop_req = {"req": req, "preview": self.ctl.scan.preview, "scan_type": scan_type}
        self._loop_remaining = max(0, min(50, trunc(self.repeat)))
        self._loop_iteration = self._loop_remaining
        self._loop_completion_pending = True
        self._loop_active = True

    def _fire_next_action_run(self) -> None:
        if not self._loop_active or self._loop_remaining <= 0 or not self._loop_req:
            return
        entry = self._loop_req
        if should_clear_roi_feedback_before_repeat(entry["scan_type"], self._loop_remaining):
            self.ctl.reset_vector()
            self.ctl.scan.update_roi({"scanImageDataUrl": None})
        self.ctl.engine.vector.retain_feedback_on_complete = should_retain_roi_feedback_on_complete(
            entry["scan_type"], self._loop_remaining)
        self._loop_completion_pending = True
        self.ctl.start_stream("vector", {**entry["req"], "preview": entry["preview"]}, scan_type=entry["scan_type"])

    def _scan_event(self, event: dict) -> None:
        """The web's phase-transition effect (completed -> next repeat)."""
        if event.get("event") != "done":
            return
        roi = self.ctl.scan.roi
        if roi.imageDataUrl and roi.selection:
            clear_bitmap_selection_cache()
        if self._loop_active and self._loop_completion_pending:
            self._loop_completion_pending = False
            if self._loop_remaining > 0:
                self._loop_remaining -= 1
                self._loop_iteration = self._loop_remaining
            if self._loop_remaining > 0:
                clear_bitmap_selection_cache()
                scan_type = (self._loop_req or {}).get("scan_type")
                if scan_type is not None and should_clear_roi_feedback_before_repeat(scan_type, self._loop_remaining):
                    self.ctl.reset_vector()
                    self.ctl.scan.update_roi({"scanImageDataUrl": None})
                self._loop_timer.start(ACTION_LOOP_GAP_MS)
                self.refresh()
                return
            self._clear_loops()
            self.refresh()

    # ------------------------------------------------------------------ actions
    def _controls_disabled(self) -> bool:
        return self.ctl.panel_disabled or self.ctl.scan_active or self.ctl.reconnecting

    def _with_privilege(self, fn: Callable[[], None]) -> None:
        self.ctl.refresh_scan_privilege(lambda ok: fn() if ok else None)

    def _fail(self, exc: Exception) -> None:
        self.ctl.scan.stream_errored(str(exc))
        self.ctl.notify("scan")

    def on_run(self) -> None:
        if self.ctl.panel_disabled:
            return
        self._with_privilege(self._run)

    def _run(self) -> None:
        s = self.ctl.scan
        if self.roi_action:
            if self._roi_ebeam_disabled:
                return
            try:
                sel, skipped = self._scan_gray()
                if sel is not None and skipped is not None:
                    adaptive = self._is_production and self._vector_pixel_fallback_blank
                    base = {**s.vector, "roi": s.roi.selection}
                    if adaptive:
                        req = vector_request_with_adaptive_gray_feedback(base, s.roi, gray_scale_selection=sel,
                                                                         gray_scale_skipped=skipped)
                    else:
                        req = vector_request_with_roi_gray_scale_action(base, s.roi, gray_scale_selection=sel,
                                                                        gray_scale_skipped=skipped)
                    scan_type = ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK if adaptive else \
                        ScanType.CUSTOM_GRAY_FEEDBACK_BLANK
                    if trunc(self.repeat) > 1:
                        self._start_action_loop(req, scan_type)
                        self.ctl.engine.vector.retain_feedback_on_complete = False
                    else:
                        self._clear_loops()
                        self.ctl.engine.vector.retain_feedback_on_complete = True
                    s.update_roi({"scanImageDataUrl": None})
                    if self.on_action_run_start:
                        self.on_action_run_start()
                    self.ctl.start_stream("vector", {**req, "preview": s.preview}, scan_type=scan_type)
                else:
                    req = vector_request_with_bitmap_selection(
                        {**s.vector, "roi": s.roi.selection}, s.roi, is_production=self._is_production,
                        allow_bitmap_simulation=self._allow_bitmap_simulation, gray_scale_selection=None,
                        gray_scale_skipped=None)
                    self._clear_loops()
                    s.update_roi({"scanImageDataUrl": None})
                    if self.on_action_run_start:
                        self.on_action_run_start()
                    self.ctl.start_stream("vector", {**req, "preview": s.preview}, scan_type=ScanType.VECTOR)
            except Exception as exc:  # noqa: BLE001
                self._fail(exc)
            return
        if self.kind == "raster":
            try:
                req = self._build_raster_request()
                self.ctl.start_stream("raster", {**req, "preview": s.preview}, scan_type=ScanType.RASTER)
            except Exception as exc:  # noqa: BLE001
                self._fail(exc)
        else:
            try:
                req = self._build_vector_request()
                scan_type = self._vector_scan_type(req)
                if trunc(self.repeat) > 1:
                    self._start_action_loop(req, scan_type)
                else:
                    self._clear_loops()
                self.ctl.start_stream("vector", {**req, "preview": s.preview}, scan_type=scan_type)
            except Exception as exc:  # noqa: BLE001
                self._fail(exc)
        self.refresh()

    def on_infinite(self) -> None:
        if self.kind not in ("raster", "vector") or self.ctl.panel_disabled or self._infinite_active:
            self.infinite_btn.setChecked(self._infinite_active)
            return
        self._with_privilege(self._infinite)

    def _infinite(self) -> None:
        s = self.ctl.scan
        try:
            if self.kind == "raster":
                req = {**self._build_raster_request(), "preview": s.preview}
                scan_type = ScanType.RASTER
            else:
                req = {**self._build_vector_request(), "preview": s.preview}
                scan_type = self._vector_scan_type(req)
                self._clear_loops()
            self._infinite_active = True
            self.ctl.start_stream(self.kind, req, live=True, scan_type=scan_type)
        except Exception as exc:  # noqa: BLE001
            self._infinite_active = False
            self._fail(exc)
        self.refresh()

    def on_stop(self) -> None:
        stop_available = self.ctl.scan_active or self._loop_active or self._infinite_active
        if self._roi_ebeam_disabled or not stop_available:
            return
        self._clear_loops()
        if self.ctl.stream_active:
            self.ctl.stop_stream()
        elif self.ctl.scan_active:
            # validated run in flight: abort like promise.abort() + streamReset
            self.ctl.abort_validated()
            self.ctl.scan.stream_reset()
        else:
            self.ctl.scan.stream_reset()
        if self.roi_action and not self._roi_gray_filter_active:
            self.ctl.reset_vector()
        elif self.kind == "raster":
            self.ctl.reset_raster(self.ctl.scan.raster["resolution"])
        else:
            self.ctl.reset_vector()
        self.ctl.notify("scan", "panel")

    def on_run_validated(self) -> None:
        if self.ctl.panel_disabled or self.kind == "roi":
            return
        self._with_privilege(self._validated)

    def _validated(self) -> None:
        s = self.ctl.scan
        try:
            if self.kind == "raster":
                req = self._build_raster_request(keep_roi=True, with_gray=False)
            else:
                req = self._build_vector_request()
            self.ctl.run_validated(self.kind, {**req, "preview": s.preview})
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)

    def on_clear(self) -> None:
        if self.ctl.panel_disabled:
            return
        self.ctl.scan.stream_reset()
        self.ctl.server_figure.pop(self.kind, None)
        if self.kind == "raster":
            self.ctl.reset_raster(self.ctl.scan.raster["resolution"])
        else:
            self.ctl.reset_vector()
        self.ctl.notify("scan", "panel")

    def _preview_toggled(self, checked: bool) -> None:
        if self._updating:
            return
        self.ctl.scan.preview = checked
        self.ctl.notify("scan")

    def _repeat_changed(self, value: int) -> None:
        self.repeat = value
        if self.on_repeat_change:
            self.on_repeat_change(value)
        self.refresh()

    # ------------------------------------------------------------------ equipment selectors
    def _regions(self) -> list:
        rows = self.ctl.equipment
        return [(v, key) for v, key in SITE_OPTIONS if any(r.get("site") == v for r in rows)]

    def _region_changed(self, index: int) -> None:
        value = self.region.itemData(index)
        if not value:
            return
        self._region = value
        selected = next((r for r in self.ctl.equipment if r.get("site") == value), None)
        if selected and selected.get("id"):
            self.ctl.set_selected_equipment(int(selected["id"]))
        self.refresh()

    def _equipment_changed(self, index: int) -> None:
        value = self.equipment.itemData(index)
        try:
            eid = int(value)
        except (TypeError, ValueError):
            return
        if eid > 0:
            self.ctl.set_selected_equipment(eid)

    def _sync_equipment(self, disabled: bool) -> None:
        rows = self.ctl.equipment
        current = next((r for r in rows if r.get("id") == self.ctl.selected_equipment_id), None)
        if current is not None:
            self._region = current.get("site", "")
        regions = self._regions()
        self.region.blockSignals(True)
        self.region.clear()
        if not regions:
            self.region.addItem(t("scan.region.empty"), "")
        for value, key in regions:
            self.region.addItem(t(key), value)
        idx = self.region.findData(self._region)
        if idx >= 0:
            self.region.setCurrentIndex(idx)
        self.region.blockSignals(False)
        self.region.setEnabled(not disabled and bool(regions))
        region_rows = [r for r in rows if r.get("site") == self._region]
        self.equipment.blockSignals(True)
        self.equipment.clear()
        if not region_rows:
            self.equipment.addItem(t("scan.equipment.empty"), "")
        for r in region_rows:
            self.equipment.addItem(str(r.get("name", "")), r.get("id"))
        idx = self.equipment.findData(self.ctl.selected_equipment_id)
        if idx >= 0:
            self.equipment.setCurrentIndex(idx)
        self.equipment.blockSignals(False)
        self.equipment.setEnabled(not disabled and bool(region_rows))

    # ------------------------------------------------------------------ view
    def retranslate(self):
        self.region_lbl.setText(t("scan.region.label"))
        self.region.setToolTip(t("scan.region.title"))
        self.equip_lbl.setText(t("scan.equipment.label"))
        self.equipment.setToolTip(t("scan.equipment.title"))
        self.preview.setText(t("scan.preview"))
        self.preview.setToolTip(t("scan.preview.title"))
        self.busy.setToolTip(t("scan.busy.title"))
        if self.roi_action:
            self.run_btn.setText(t("roi.actionRun"))
            self.run_btn.setToolTip(t("roi.actionRun.title"))
        else:
            self.run_btn.setText(t("scan.run"))
            self.run_btn.setToolTip(t("scan.run.title.start"))
        self.stop_btn.setText(t("scan.stop"))
        self.stop_btn.setToolTip(t("scan.stop.title"))
        self.infinite_btn.setText(t("scan.infinite"))
        self.validated_btn.setText(t("scan.runValidated"))
        self.validated_btn.setToolTip(t("scan.runValidated.title"))
        self.clear_btn.setText(t("scan.clear"))

    def refresh(self):
        s = self.ctl.scan
        # the web clears the loops when the ROI selection / kind changes and on error / idle
        key = self._roi_key()
        if key != self._selection_key:
            self._selection_key = key
            self._clear_loops()
        if s.phase != self._prev_phase:
            if s.phase in ("error", "idle"):
                self._clear_loops()
            self._prev_phase = s.phase
        if self._infinite_active and not self.ctl.stream_active and s.phase not in ("running", "stopping"):
            self._infinite_active = False
        streaming = s.phase == "running"
        closing = s.phase == "stopping"
        busy = streaming or closing
        disabled = self.ctl.panel_disabled
        controls_disabled = disabled or self.ctl.scan_active or self.ctl.reconnecting
        ebeam = self._roi_ebeam_disabled
        run_disabled = controls_disabled or ebeam or streaming or closing or (self.roi_action and self._loop_active)
        stop_available = streaming or closing or self._loop_active or self._infinite_active
        self.run_btn.setEnabled(not run_disabled and (self.kind != "roi" or self.roi_action))
        self.stop_btn.setEnabled(not ebeam and stop_available)
        self.infinite_btn.setVisible(not self.roi_action and self.kind in ("raster", "vector"))
        self.infinite_btn.setEnabled(self.kind in ("raster", "vector") and not run_disabled and not self._infinite_active)
        self.infinite_btn.setChecked(self._infinite_active)
        self.infinite_btn.setToolTip(t("scan.infinite.title.vector") if self.kind == "vector"
                                     else t("scan.infinite.title"))
        self.validated_btn.setEnabled(not run_disabled and self.kind != "roi" and not self._vector_gray_filter_active)
        self.clear_btn.setEnabled(not run_disabled)
        self.preview.blockSignals(True)
        self.preview.setChecked(s.preview)
        self.preview.blockSignals(False)
        self.preview.setEnabled(not controls_disabled and not ebeam and (self.roi_action or self.kind != "roi"))
        self.preview_warn.setVisible(s.preview)
        self.busy.setVisible(busy and (self.roi_action or self.kind == "vector"))
        display = repeat_countdown_display(self.repeat, self._loop_iteration, self._loop_active)
        show_repeat = self.show_repeat_control and (not self.roi_action or self._roi_gray_filter_active)
        self.repeat_ctl.setVisible(show_repeat)
        self.repeat_ctl.set_state(self.repeat, display, controls_disabled or ebeam)
        if self.roi_action:
            gray = self._roi_gray_filter_active
            self.gray_wedges.set_active(gray)
            self.gray_wedges.disabled_override = controls_disabled or ebeam
            self.gray_wedges.refresh()
            self.raster_wedges.setVisible(not gray)
            self.raster_wedges.disabled_override = controls_disabled or ebeam
            self.raster_wedges.refresh()
        self._sync_equipment(controls_disabled)
        err = display_scan_error(s.errorMessage, t("scan.error.deviceNotFound"))
        self.error.setText(("⚠ " + err) if err else "")
        self.error.setVisible(bool(err))


# ---------------------------------------------------------------------------- run report

OUTPUT_PREFIX_KEY = "ionbeam:downloadOutputPrefix"
DOWNLOAD_DIR_KEY = "ionbeam-native:downloadDir"


def default_download_dir() -> Path:
    return Path("C:/Scan/output") if os.name == "nt" else Path.home() / "Downloads" / "Scan" / "Output"


def filename_segment(value: str) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()))


def short_timestamp_suffix() -> str:
    return time.strftime("%y%m%d_%H%M%S")


def default_download_filename(kind: str, file_type: str, resolution, latency_bytes, prefix: str) -> str:
    seg = filename_segment(prefix)
    inserted = f"_{seg}" if seg else ""
    ts = short_timestamp_suffix()
    if kind == "raster":
        r = resolution or 0
        return f"raster_{r}x{r}{inserted}_{ts}.{file_type}"
    return f"vector_latency_{latency_bytes or 0}{inserted}_{ts}.{file_type}"


def fmt_sec(s: float) -> str:
    if s < 1e-3:
        return f"{to_fixed(s * 1e6, 0)} µs"
    if s < 1:
        return f"{to_fixed(s * 1e3, 1)} ms"
    return f"{to_fixed(s, 3)} s"


def frame_csv_bytes(frame, edge: int) -> bytes:
    """``rasterCsvBlob`` / ``vectorCsvBlob``: one row per image row, space separated, CRLF."""
    import io
    import numpy as np
    rows = min(edge, frame.size // edge) if edge else 0
    if rows <= 0:
        return b""
    arr = np.asarray(frame[: rows * edge]).reshape(rows, edge)
    buf = io.BytesIO()
    np.savetxt(buf, arr, fmt="%d", delimiter=" ", newline="\r\n")
    return buf.getvalue()


class RunReport(Panel):
    """ValidationPanel.tsx."""

    TOPICS = frozenset({"scan", "panel", "frame-complete", "merged"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.kind_override: Optional[str] = None
        self.merged_png: Optional[bytes] = None
        self.auto_download = False
        self.download_dir: Optional[Path] = None
        stored = prefs().get(DOWNLOAD_DIR_KEY)
        if stored:
            self.download_dir = Path(stored)
        self.output_prefix = prefs().get(OUTPUT_PREFIX_KEY, "") or ""
        self._csv_state = self._fig_state = "idle"
        self._csv_err = self._fig_err = self._auto_err = None
        self._db_state = "checking"
        self._db_err = None
        self._last_auto_key = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        self.meta = QLabel()
        self.meta.setWordWrap(True)
        self.meta.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(self.meta)
        self.note = label("", "muted", wrap=True)
        self.note.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(self.note)
        self.prefix_lbl = label()
        lay.addWidget(self.prefix_lbl)
        self.prefix = QLineEdit(self.output_prefix)
        self.prefix.textEdited.connect(self._prefix_changed)
        lay.addWidget(self.prefix)
        self.prefix_help = label("", "muted", wrap=True)
        lay.addWidget(self.prefix_help)
        frow = QHBoxLayout()
        self.folder_btn = button("", "ghost", "download")
        self.folder_btn.clicked.connect(self._select_folder)
        self.folder_lbl = label("", "muted")
        self.auto_sw = Switch()
        self.auto_sw.toggled.connect(self._auto_toggled)
        frow.addWidget(self.folder_btn)
        frow.addWidget(self.folder_lbl, 1)
        frow.addWidget(self.auto_sw)
        lay.addLayout(frow)
        self.status_lbl = label("", "warn", wrap=True)
        lay.addWidget(self.status_lbl)
        drow = QHBoxLayout()
        self.csv_btn = button("", None, "download")
        self.csv_btn.clicked.connect(self.download_csv)
        self.fig_btn = button("", None, "image")
        self.fig_btn.clicked.connect(self.download_figure)
        drow.addWidget(self.csv_btn)
        drow.addWidget(self.fig_btn)
        drow.addStretch(1)
        self.download_row = QWidget()
        self.download_row.setLayout(drow)
        lay.addWidget(self.download_row)
        self.dl_err = label("", "danger", wrap=True)
        lay.addWidget(self.dl_err)
        self.error_box = label("", "danger", wrap=True)
        self.error_box.setProperty("role", "danger")
        self.error_box.setStyleSheet('font-family: "JetBrains Mono", monospace; font-size: 12px;')
        self.error_box.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        lay.addWidget(self.error_box)
        self.checks_title = QHBoxLayout()
        self.v_title = label("", "title")
        self.v_pill = QLabel()
        self.v_pill.setObjectName("Pill")
        self.checks_title.addWidget(self.v_title)
        self.checks_title.addStretch(1)
        self.checks_title.addWidget(self.v_pill)
        self.checks_box = QWidget()
        cb = QVBoxLayout(self.checks_box)
        cb.setContentsMargins(0, 0, 0, 0)
        cb.addWidget(hline())
        cb.addLayout(self.checks_title)
        self.checks = QLabel()
        self.checks.setWordWrap(True)
        self.checks.setTextFormat(Qt.TextFormat.RichText)
        self.checks.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        cb.addWidget(self.checks)
        lay.addWidget(self.checks_box)
        self.retranslate()
        self._check_db()
        self.refresh()

    # ------------------------------------------------------------------ data
    @property
    def scan_kind(self) -> str:
        return self.kind_override or ("vector" if self.ctl.scan.kind == "vector" else "raster")

    def _have_stream_data(self) -> bool:
        k = self.ctl.scan.kind
        return (k == "raster" and self.ctl.engine.raster.cursor > 0) or \
               (k == "vector" and self.ctl.engine.vector.cursor > 0)

    def _have_validated(self) -> bool:
        return bool((self.ctl.scan.lastResult or {}).get("has_data"))

    def _have_any(self) -> bool:
        return self._have_validated() or (self._have_stream_data() and self.ctl.scan.phase == "completed")

    def _check_db(self) -> None:
        def fetch():
            r = self.ctl.backend.request("GET", "/api/admin/iobeam/db/status")
            data = self.ctl.backend.read_json(r, "db status")
            return r.status_code, data

        def ok(res):
            code, data = res
            if code < 400 and data.get("enabled"):
                self._db_state = "ready"
            else:
                self._db_state = "disabled"
                self._db_err = data.get("error") or f"HTTP {code}"
            self.refresh()

        def err(exc):
            self._db_state = "disabled"
            self._db_err = str(exc)
            self.refresh()
        run_bg(fetch, on_ok=ok, on_err=err)

    def _names(self, file_type: str) -> str:
        s = self.ctl.scan
        res = (s.lastResult or {}).get("resolution") or self.ctl.engine.raster.resolution
        return default_download_filename(self.scan_kind, file_type, res, s.vector["latency_bytes"],
                                         self.output_prefix)

    def _csv_job(self) -> Callable[[], bytes]:
        """Blocking producer of the CSV bytes (runs on a worker thread)."""
        if self._have_validated():
            snapshot = self.ctl.engine.svc.last_snapshot()
            fut = self.ctl.artifacts.render(snapshot, csv=True, png=False)
            return lambda: fut.result()["csv"]
        if self.ctl.scan.kind == "raster":
            r = self.ctl.engine.raster
            frame, edge = r.frame.copy(), r.resolution
        else:
            v = self.ctl.engine.vector
            frame, edge = v.image.copy(), v.edge
        return lambda: frame_csv_bytes(frame, edge)

    def _figure_future(self):
        """Merged figure, else the service figure (rendered out of process)."""
        if self.merged_png:
            return None
        snapshot = self.ctl.engine.svc.last_snapshot() if self.ctl.engine.svc.has_last() else None
        if snapshot is None:
            raise RuntimeError("no scan data cached")
        mode = self.ctl.scan.vectorRenderMode if self.ctl.scan.kind == "vector" else "decimated"
        return self.ctl.artifacts.render(snapshot, csv=False, png=True, render_mode=mode, view="figure")

    def _save(self, data: bytes, filename: str) -> Path:
        folder = self.download_dir or default_download_dir()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / filename
        path.write_bytes(data)
        return path

    def download_csv(self, _checked=False, *, then: Optional[Callable] = None) -> None:
        if self.ctl.panel_disabled:
            return
        self._csv_state, self._csv_err = "fetching", None
        self.refresh()
        name = self._names("csv")
        try:
            job = self._csv_job()
        except Exception as exc:  # noqa: BLE001
            self._csv_state, self._csv_err = "error", str(exc)
            self.refresh()
            return

        def ok(path):
            self._csv_state = "idle"
            self.refresh()
            if then:
                then()

        def err(exc):
            self._csv_state, self._csv_err = "error", str(exc)
            if then:
                self._auto_err = str(exc)
            self.refresh()
        run_bg(lambda: self._save(job(), name), on_ok=ok, on_err=err)

    def download_figure(self, _checked=False) -> None:
        if self.ctl.panel_disabled:
            return
        self._fig_state, self._fig_err = "fetching", None
        self.refresh()
        name = self._names("png")
        try:
            fut = self._figure_future()
        except Exception as exc:  # noqa: BLE001
            self._fig_state, self._fig_err = "error", str(exc)
            self.refresh()
            return
        if fut is None:
            run_bg(self._save, self.merged_png, name, on_ok=lambda _p: self._fig_done(None),
                   on_err=lambda e: self._fig_done(str(e)))
            return

        def rendered(f):
            try:
                png = f.result()["png"]
                self._save(png, name)
                err = None
            except Exception as exc:  # noqa: BLE001
                err = f"figure render failed: {exc}"
            self.ctl.engine.post(lambda: self._fig_done(err))
        fut.add_done_callback(rendered)

    def _fig_done(self, err: Optional[str]) -> None:
        self._fig_state = "error" if err else "idle"
        self._fig_err = err
        if err and self.auto_download:
            self._auto_err = err
        self.refresh()

    def _prefix_changed(self, text: str) -> None:
        self.output_prefix = text
        prefs().set(OUTPUT_PREFIX_KEY, text)

    def _select_folder(self) -> None:
        if self.ctl.panel_disabled:
            return
        start = str(self.download_dir or default_download_dir())
        path = QFileDialog.getExistingDirectory(self, t("validation.selectFolder"), start)
        if path:
            self.download_dir = Path(path)
            prefs().set(DOWNLOAD_DIR_KEY, path)
            self._auto_err = None
            self.refresh()

    def _auto_toggled(self, checked: bool) -> None:
        if self._updating:
            return
        self.auto_download = checked
        self._auto_err = None
        self.refresh()

    def _maybe_auto_download(self) -> None:
        if self.ctl.panel_disabled or not self.auto_download or self.ctl.scan.phase != "completed" \
                or not self._have_any():
            return
        r = self.ctl.scan.lastResult or {}
        key = (self.scan_kind, r.get("chunks", "stream"), r.get("bytes", "stream"), self.ctl.engine.raster.cursor,
               self.ctl.engine.vector.cursor, self.ctl.scan.vectorRenderMode, self.output_prefix,
               self.ctl.engine.raster.revision, self.ctl.engine.vector.revision)
        if key == self._last_auto_key:
            return
        self._last_auto_key = key
        self._auto_err = None
        self._fig_state = "fetching"
        self.download_csv(then=self.download_figure)

    # ------------------------------------------------------------------ view
    def retranslate(self):
        self.prefix_lbl.setText(t("validation.outputPrefix"))
        self.prefix.setPlaceholderText(t("validation.outputPrefix.placeholder"))
        self.prefix_help.setText(t("validation.outputPrefix.help"))
        self.folder_btn.setText(t("validation.selectFolder"))
        self.auto_sw.setText(t("validation.autoDownload"))
        self.csv_btn.setToolTip(t("validation.downloadCsv.title"))
        self.fig_btn.setToolTip(t("validation.downloadFigure.title"))
        self.v_title.setText(t("validation.title"))

    def refresh(self):
        s = self.ctl.scan
        self.folder_lbl.setText(str(self.download_dir or default_download_dir()))
        disabled = self.ctl.panel_disabled
        for w in (self.prefix, self.folder_btn, self.auto_sw):
            w.setEnabled(not disabled)
        self.auto_sw.blockSignals(True)
        self.auto_sw.setChecked(self.auto_download)
        self.auto_sw.blockSignals(False)
        status = []
        if self._auto_err:
            status.append(t("validation.autoDownload.error", detail=self._auto_err))
        if self._db_state == "disabled" and self._db_err:
            status.append(t("validation.flowToDb.disabled", detail=self._db_err))
        self.status_lbl.setText("\n".join(status))
        self.status_lbl.setVisible(bool(status))
        result = s.lastResult
        have_any = self._have_any()
        error = s.errorMessage
        self.error_box.setText(error or "")
        self.error_box.setVisible(bool(error))
        # meta row
        if result and not error:
            parts = [f"{t('validation.meta.kind')} <b>{t('tabs.vector' if result.get('kind') == 'vector' else 'tabs.raster')}</b>",
                     f"{t('validation.meta.chunks')} <b>{fmt(result.get('chunks', 0))}</b>"
                     + (f" <span style='color:{theme.current().text_muted}'>/ {fmt(result['expected_chunks'])}</span>"
                        if result.get("expected_chunks") is not None else ""),
                     f"{t('validation.meta.bytes')} <b>{fmt(result.get('bytes', 0))}</b>"]
            if result.get("pixels_per_chunk") is not None:
                parts.append(f"{t('validation.meta.pixelsPerChunk')} <b>{fmt(result['pixels_per_chunk'])}</b>")
            if result.get("send_time_s") is not None:
                parts.append(f"{t('validation.meta.send')} <b>{fmt_sec(result['send_time_s'])}</b>")
            if result.get("process_time_s") is not None:
                parts.append(f"{t('validation.meta.process')} <b>{fmt_sec(result['process_time_s'])}</b>")
            self.meta.setText(" &nbsp;·&nbsp; ".join(parts))
            self.meta.show()
        else:
            self.meta.hide()
        perf = getattr(self.ctl.engine, "last_perf", None)
        if error:
            self.note.hide()
        elif not result and not have_any:
            self.note.setText(bracketed_bold(t("validation.empty")))
            self.note.show()
        elif not result and self._have_stream_data():
            text = bracketed_bold(t("validation.streamCompleted"))
            if perf is not None:
                d = perf.as_dict()
                text += (f"<br><span style='font-size:11px'>wall {d['wall_ms']} ms · beam {d['beam_ms']} ms · "
                         f"duty {d['duty']} · first sample {d['first_sample_ms']} ms</span>")
            self.note.setText(text)
            self.note.show()
        else:
            self.note.hide()
        show_downloads = not error and (result or have_any) and not self.auto_download
        self.download_row.setVisible(bool(show_downloads))
        self.csv_btn.setEnabled(not disabled and have_any and self._csv_state != "fetching")
        self.fig_btn.setEnabled(not disabled and have_any and self._fig_state != "fetching")
        self.csv_btn.setText(t("validation.downloadCsv.fetching") if self._csv_state == "fetching"
                             else t("validation.downloadCsv"))
        self.fig_btn.setText(t("validation.downloadFigure.rendering") if self._fig_state == "fetching"
                             else t("validation.downloadFigure"))
        errs = []
        if self._csv_err:
            errs.append(t("validation.csvError", detail=self._csv_err))
        if self._fig_err:
            errs.append(t("validation.figureError", detail=self._fig_err))
        self.dl_err.setText("\n".join(errs))
        self.dl_err.setVisible(bool(errs))
        v = (result or {}).get("validation") if not error else None
        self.checks_box.setVisible(bool(v))
        if v:
            tk = theme.current()
            self.v_pill.setText(t("validation.allPassed") if v.get("passed") else t("validation.failures"))
            set_prop(self.v_pill, "tone", "ok" if v.get("passed") else "error")
            rows = []
            for c in v.get("checks", []):
                ok = c.get("passed")
                tag = (f"<span style='color:{tk.success}'>{t('validation.check.pass')}</span>" if ok else
                       f"<span style='color:{tk.danger}'>{t('validation.check.fail')}</span>")
                rows.append(f"{tag} &nbsp;{_esc(c.get('name', ''))} &nbsp;"
                            f"<span style='color:{tk.text_muted}'>{_esc(c.get('detail', ''))}</span>")
            self.checks.setText("<br>".join(rows))
        self._maybe_auto_download()


def _esc(text) -> str:
    import html
    return html.escape(str(text))


# ---------------------------------------------------------------------------- error wedge

class ErrorWedge(Panel):
    TOPICS = frozenset({"scan", "status", "auth", "panel"})

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.setObjectName("ErrorWedge")
        from PyQt6.QtWidgets import QFrame
        frame = QFrame()
        frame.setObjectName("ErrorWedge")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)
        lay = QHBoxLayout(frame)
        lay.setContentsMargins(10, 8, 10, 8)
        self.lbl = label("", "danger")
        self.lbl.setStyleSheet("font-weight: 700;")
        lay.addWidget(self.lbl, 0, Qt.AlignmentFlag.AlignTop)
        col = QVBoxLayout()
        self.msg = label("", wrap=True)
        self.msg.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.req_msg = label("", "muted", wrap=True)
        col.addWidget(self.msg)
        col.addWidget(self.req_msg)
        lay.addLayout(col, 1)
        self.mail_btn = button("", "ghost", "mail")
        self.mail_btn.setIcon(icon("mail", theme.current().accent))
        self.mail_btn.clicked.connect(self._request_role)
        lay.addWidget(self.mail_btn, 0, Qt.AlignmentFlag.AlignTop)
        self._request_message: Optional[str] = None
        self.retranslate()
        self.refresh()

    def retranslate(self):
        self.lbl.setText(t("error.label"))
        self.mail_btn.setToolTip(t("scan.roleRequest.title"))

    def _message(self) -> Optional[str]:
        svc = self.ctl.service_status or {}
        service_error = (svc.get("last_error") or t("validation.deviceError")) if svc.get("state") == "error" else None
        return self.ctl.scan.errorMessage or self.ctl.status_error or service_error

    def refresh(self):
        message = self._message()
        self.setVisible(bool(message))
        self.msg.setText(message or "")
        self.req_msg.setText(self._request_message or "")
        self.req_msg.setVisible(bool(self._request_message))
        self.mail_btn.setVisible(message == t("scan.permission.required"))

    def _request_role(self):
        self._request_message = None

        def fetch():
            r = self.ctl.backend.request("GET", "/api/admin/iobeam/config")
            if r.status_code >= 400:
                return []
            try:
                root = (r.json() or {}).get("data")
            except ValueError:
                return []
            if not isinstance(root, dict):
                return []
            auditors = root.get("auditors") if isinstance(root.get("auditors"), list) else (
                [root["auditor"]] if isinstance(root.get("auditor"), dict) else [])
            out = []
            for row in auditors:
                if not isinstance(row, dict):
                    continue
                if isinstance(row.get("is_active"), bool) and not row["is_active"]:
                    continue
                email = str(row.get("email") or "").strip()
                if email and email not in out:
                    out.append(email)
            return out

        def ok(recipients):
            if not recipients:
                self._request_message = t("scan.roleRequest.failed").replace("{error}",
                                                                             t("scan.roleRequest.noRecipients"))
                self.refresh()
                return
            user = self.ctl.signed_in_user
            name = (f"{user.get('first_name', '')} {user.get('last_name', '')}".strip() or user.get("login_name"))\
                if user else "(not signed in)"
            body = (t("scan.roleRequest.body")
                    .replace("{login}", (user or {}).get("login_name") or "(not signed in)")
                    .replace("{name}", name)
                    .replace("{email}", (user or {}).get("email") or "(not set)")
                    .replace("{site}", (user or {}).get("site") or "(not set)")
                    .replace("{currentRole}", str((user or {}).get("role", 0)))
                    .replace("{requestedRole}", "SuperUser"))
            url = f"mailto:{','.join(recipients)}?subject={quote(t('scan.roleRequest.subject'))}&body={quote(body)}"
            QDesktopServices.openUrl(QUrl(url))
            self._request_message = t("scan.roleRequest.opened")
            self.refresh()

        def err(exc):
            self._request_message = t("scan.roleRequest.failed").replace("{error}", str(exc))
            self.refresh()
        run_bg(fetch, on_ok=ok, on_err=err)
