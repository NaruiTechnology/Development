"""Main window: the desktop equivalent of App.tsx.

Holds the App-level UI state (tabs, ROI action lock, gray-level selection
flow, vector gray-level filter, last-scan image hand-off) and lays out the
same panels as the web control page: header, left control column, image
column, optional ROI preview column, footer; plus the management report
view and the vacuum / sample-stage tool windows.
"""
from __future__ import annotations

import logging
from typing import Optional

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QFrame, QHBoxLayout, QMainWindow, QPushButton, QScrollArea, QSplitter, QStackedWidget, QVBoxLayout, QWidget,
)

from ..core.bitmap_vector import clear_bitmap_selection_cache, gray_scale_spectrum_levels_for_selection
from ..core.helpers import (
    SCAN_TYPE_COLORS, gray_scale_scope_note_for_kind, gray_scale_source_label_for_kind, normalize_gray_scale_selection,
    resolve_gray_scale_source_kind, resolve_roi_action_kind, should_show_roi_action_controls,
    should_show_roi_gray_scale_clear,
)
from ..core.state import completed_roi_image_patch, is_partial_roi_selection
from ..i18n import t
from .common import Card, HelpButton, Switch, button, icon, prefs
from .dashboards import SampleStageDashboard, VacuumDashboard
from .diagnostics import AdcTestControls, AdcTimelineCanvas, DacRampPanel
from .gray import GrayScaleConfirmDialog, GrayScaleSpectrum, VectorGrayLevelSelector
from .header import AuthDialog, Footer, Header
from .image_canvas import ImageCanvasPanel
from .mag_calibration import MagCalibrationChart, MagCalibrationControls
from .params import RasterParameters, VectorParameters, VectorScanPathField
from .report import ManagementReport
from .roi import ROICalibrationCard, ROIEditorCanvas, ROIEditorControls, ROIScanPreview
from .scan_controls import ErrorWedge, RunReport, ScanControls

log = logging.getLogger("ionbeam_native.ui")


LEFT_WIDTH_KEY = "ionbeam-native:leftPanelWidth"


class MainWindow(QMainWindow):
    def __init__(self, ctl):
        super().__init__()
        self.ctl = ctl
        s = ctl.scan
        roi = s.roi
        # ---- App.tsx local state -------------------------------------------------
        self.route = "control"
        self.active_top = "calibrate" if (s.kind == "mag" or roi.calibration_enabled or ctl.dim_cal_persisted) else "scan"
        self.scan_sub = {"raster": "raster", "vector": "vector"}.get(s.kind, "roi")
        self.cal_sub = "mag" if s.kind == "mag" else "dimension"
        self.repeat = 1
        self.roi_action_locked = False
        self.roi_action_canvas_visible = False
        self.pending_sel = s.roiGrayScaleSelection
        self.pending_anchor: Optional[int] = None
        self.pending_skipped = s.roiGrayScaleSkipped
        self.gray_levels: list = []
        self.step_delta = s.roiGrayScaleStepDelta
        self.confirm_target = "roi"
        self.commit_count = 0
        self.vector_gray_enabled = False
        self.vector_gray_range = (0, 255)
        self.vector_gray_skipped: Optional[bool] = None
        self.vector_range_commit = 0
        self.suppressed_scan_image: Optional[bytes] = None
        self._prev_image = roi.imageDataUrl
        self._prev_sel_key = self._sel_key()
        self._prev_committed = s.roiGrayScaleSelection
        self._prev_phase = s.phase
        self._spectrum_key = None
        self._texture_request = None
        self.vacuum_minimized = True
        self.vacuum_busy = False
        self.stage_minimized = True
        self.stage_busy = False
        self._auth_auto_opened = False
        self._vacuum_auto_opened = False

        self.setWindowTitle(t("app.documentTitle"))
        root = QWidget()
        root.setObjectName("AppRoot")
        self.setCentralWidget(root)
        lay = QVBoxLayout(root)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.header = Header(ctl)
        self.header.open_report.connect(lambda: self._navigate("report"))
        self.header.open_scan.connect(lambda: self._navigate("control"))
        self.header.open_auth.connect(self.open_auth)
        self.header.open_vacuum.connect(self._open_vacuum)
        self.header.open_stage.connect(self._open_stage)
        lay.addWidget(self.header)
        self.pages = QStackedWidget()
        lay.addWidget(self.pages, 1)
        self.footer = Footer(ctl)
        lay.addWidget(self.footer)
        self.control_page = self._build_control_page()
        self.pages.addWidget(self.control_page)
        self.report_page: Optional[ManagementReport] = None
        self.vacuum = VacuumDashboard(ctl, self)
        self.vacuum.minimized_changed.connect(self._vacuum_minimized)
        self.vacuum.activity_changed.connect(self._vacuum_activity)
        self.stage = SampleStageDashboard(ctl, self)
        self.stage.minimized_changed.connect(self._stage_minimized)
        self.stage.activity_changed.connect(lambda a: self._set_header(stage_busy=a))
        ctl.changed.connect(self._on_changed)
        ctl.scan_event.connect(self._on_scan_event)
        self.resize(1600, 980)
        self._apply_kind_for_tabs(initial=True)
        self.refresh_all()
        QTimer.singleShot(300, self._maybe_auto_auth)

    # ------------------------------------------------------------------ layout
    def _build_control_page(self) -> QWidget:
        ctl = self.ctl
        page = QWidget()
        outer = QHBoxLayout(page)
        outer.setContentsMargins(12, 12, 12, 12)
        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        outer.addWidget(self.splitter)
        # ---------------- left column
        left_scroll = QScrollArea()
        left_scroll.setWidgetResizable(True)
        left_scroll.setMinimumWidth(360)
        left_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        left_scroll.setFrameShape(QFrame.Shape.NoFrame)
        left = QWidget()
        left_scroll.setWidget(left)
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 6, 0)
        ll.setSpacing(12)
        self.scan_card = Card()
        tabs = QHBoxLayout()
        tabs.setSpacing(0)
        self.top_btns = {}
        for key, ic in (("scan", "scan"), ("calibrate", "calibrate"), ("adcTest", "adcTest")):
            b = QPushButton()
            b.setCheckable(True)
            b.setProperty("kind", "tab")
            b.setIcon(icon(ic, size=22))
            b.clicked.connect(lambda _c, k=key: self._activate_top(k))
            self.top_btns[key] = b
            tabs.addWidget(b)
        tabs.addStretch(1)
        self.scan_card.body.addLayout(tabs)
        sub = QHBoxLayout()
        sub.setSpacing(0)
        self.sub_btns = {}
        for key, ic in (("roi", "target"), ("raster", "grid"), ("vector", "route"), ("dimension", "ruler"),
                        ("mag", "magCal")):
            b = QPushButton()
            b.setCheckable(True)
            b.setProperty("kind", "tab")
            b.setIcon(icon(ic, size=20))
            b.clicked.connect(lambda _c, k=key: self._activate_sub(k))
            self.sub_btns[key] = b
            sub.addWidget(b)
        sub.addStretch(1)
        self.scan_card.body.addLayout(sub)
        self.left_stack = QStackedWidget()
        self.raster_params = RasterParameters(ctl)
        self.vector_params = VectorParameters(ctl)
        # ROI page
        roi_page = QWidget()
        rl = QVBoxLayout(roi_page)
        rl.setContentsMargins(0, 0, 0, 0)
        self.roi_controls = ROIEditorControls(ctl)
        self.roi_controls.on_load_last_scan = self.load_last_scan
        self.roi_controls.on_clear_image = self._on_clear_image
        rl.addWidget(self.roi_controls)
        self.roi_scan_path = VectorScanPathField(ctl)
        rl.addWidget(self.roi_scan_path)
        self.roi_action_controls = ScanControls(ctl, roi_action=True)
        self.roi_action_controls.on_action_run_start = self._on_action_run_start
        self.roi_action_controls.on_repeat_change = self._set_repeat
        rl.addWidget(self.roi_action_controls)
        self.roi_cal_card = ROICalibrationCard(ctl)
        self.roi_cal_card.on_load_last_scan = self.load_last_scan
        rl.addWidget(self.roi_cal_card)
        rl.addStretch(1)
        # dimension page
        dim_page = QWidget()
        dl = QVBoxLayout(dim_page)
        dl.setContentsMargins(0, 0, 0, 0)
        self.dim_controls = ROIEditorControls(ctl)
        self.dim_controls.on_load_last_scan = self.load_last_scan
        self.dim_controls.on_clear_image = self._on_clear_image
        dl.addWidget(self.dim_controls)
        self.dim_cal_card = ROICalibrationCard(ctl)
        self.dim_cal_card.on_load_last_scan = self.load_last_scan
        dl.addWidget(self.dim_cal_card)
        dl.addStretch(1)
        self.mag_controls = MagCalibrationControls(ctl)
        self.adc_controls = AdcTestControls(ctl)
        self.left_pages = {"raster": self.raster_params, "vector": self.vector_params, "roi": roi_page,
                           "dimension": dim_page, "mag": self.mag_controls, "adcTest": self.adc_controls}
        for w in self.left_pages.values():
            self.left_stack.addWidget(w)
        self.scan_card.body.addWidget(self.left_stack)
        ll.addWidget(self.scan_card)
        self.controls_card = Card("")
        self.scan_controls = ScanControls(ctl)
        self.scan_controls.on_repeat_change = self._set_repeat
        self.controls_card.body.addWidget(self.scan_controls)
        ll.addWidget(self.controls_card)
        self.dac_card = Card("", collapsible=True, collapsed=True)
        self.dac_card.header_tools.addWidget(HelpButton("dacCheck"))
        self.dac_card.body.addWidget(DacRampPanel(ctl))
        ll.addWidget(self.dac_card)
        self.report_card = Card("")
        self.run_report = RunReport(ctl)
        self.report_card.body.addWidget(self.run_report)
        ll.addWidget(self.report_card)
        self.error_wedge = ErrorWedge(ctl)
        ll.addWidget(self.error_wedge)
        ll.addStretch(1)
        self.splitter.addWidget(left_scroll)
        self._left_scroll, self._left_body = left_scroll, left
        # ---------------- image column
        self.image_card = Card("")
        hdr = self.image_card.header_tools
        self.grid_switch = Switch()
        self.grid_switch.toggled.connect(self._grid_toggled)
        hdr.addWidget(self.grid_switch)
        self.path_switch = Switch()
        self.path_switch.toggled.connect(self._path_toggled)
        hdr.addWidget(self.path_switch)
        self.vgray_switch = Switch()
        self.vgray_switch.toggled.connect(self._vector_gray_toggled)
        self.vgray_help = HelpButton("vectorGrayLevelFilter")
        hdr.addWidget(self.vgray_switch)
        hdr.addWidget(self.vgray_help)
        tool_row = QHBoxLayout()
        self.vgray_selector = VectorGrayLevelSelector()
        self.vgray_selector.range_changed.connect(self._vector_gray_range)
        self.vgray_selector.commit.connect(self._vector_gray_select)
        tool_row.addWidget(self.vgray_selector, 1)
        self.spectrum = GrayScaleSpectrum()
        self.spectrum.select.connect(self._gray_select)
        self.spectrum.step_delta_changed.connect(self._step_delta_changed)
        tool_row.addWidget(self.spectrum, 1)
        self.gray_clear = button("", "ghost")
        self.gray_clear.clicked.connect(self.clear_roi_gray_values)
        tool_row.addWidget(self.gray_clear)
        self.image_card.body.addLayout(tool_row)
        self.right_stack = QStackedWidget()
        self.raster_canvas = ImageCanvasPanel(ctl, "raster")
        self.vector_canvas = ImageCanvasPanel(ctl, "vector")
        for c in (self.raster_canvas, self.vector_canvas):
            c.rendered_image.connect(self._rendered_image)
            c.merged_figure.connect(self._merged_figure)
        self.roi_canvas = ROIEditorCanvas(ctl)
        self.mag_chart = MagCalibrationChart(ctl)
        self.adc_timeline = AdcTimelineCanvas(ctl)
        self.right_pages = {"raster": self.raster_canvas, "vector": self.vector_canvas, "roi": self.roi_canvas,
                            "mag": self.mag_chart, "adc": self.adc_timeline}
        for w in self.right_pages.values():
            self.right_stack.addWidget(w)
        self.image_card.body.addWidget(self.right_stack, 1)
        self.splitter.addWidget(self.image_card)
        # ---------------- ROI preview column
        self.preview_card = Card("")
        self.roi_preview = ROIScanPreview(ctl)
        self.preview_card.body.addWidget(self.roi_preview)
        self.preview_card.body.addStretch(1)
        self.preview_card.setFixedWidth(250)
        self.splitter.addWidget(self.preview_card)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        try:
            left_w = max(360, min(1200, int(prefs().get(LEFT_WIDTH_KEY, 640) or 640)))
        except (TypeError, ValueError):
            left_w = 640
        self.splitter.setSizes([left_w, 1000, 250])
        self.splitter.splitterMoved.connect(lambda *_: prefs().set(LEFT_WIDTH_KEY, str(self.splitter.sizes()[0])))
        return page

    # ------------------------------------------------------------------ derived state
    def _sel_key(self) -> str:
        sel = self.ctl.scan.roi.selection
        return f"{sel['x_start']}:{sel['x_end']}:{sel['y_start']}:{sel['y_end']}" if sel else ""

    @property
    def kind(self) -> str:
        return self.ctl.scan.kind

    @property
    def has_partial(self) -> bool:
        return is_partial_roi_selection(self.ctl.scan.roi)

    @property
    def last_scan_kind(self) -> str:
        return self.ctl.last_scan_kind

    def _has_prior_scan_image(self) -> bool:
        s = self.ctl.scan
        lk = self.last_scan_kind
        e = self.ctl.engine
        return ((lk == "raster" and e.raster.cursor > 0) or (lk == "vector" and e.vector.cursor > 0)
                or (s.lastResult or {}).get("kind") == lk or s.roi.scanImageDataUrl is not None)

    def _server_texture(self) -> Optional[bytes]:
        """``/api/scan/last/figure?view=texture`` for the last scan (rendered out of process, cached)."""
        lk = self.last_scan_kind
        cached = self.ctl.server_figure.get(lk)
        if isinstance(cached, (bytes, bytearray)):
            return cached
        svc = self.ctl.engine.svc
        if cached is None and svc.has_last() and self._texture_request != id(svc._last):
            self._texture_request = id(svc._last)
            self.ctl.render_server_figure(lk, svc.last_snapshot())
        return None

    def roi_scan_image(self) -> Optional[bytes]:
        """``roiScanImageUrl``."""
        if self.kind != "roi" or not self._has_prior_scan_image():
            return None
        live = self.ctl.last_live_image
        if live and live[0] == self.last_scan_kind:
            return live[1]
        return self._server_texture()

    def active_roi_scan_image(self) -> Optional[bytes]:
        cached = self.ctl.scan.roi.scanImageDataUrl if (self.kind == "roi" and self.has_partial) else None
        return cached if cached is not None and cached is not self.suppressed_scan_image else None

    @property
    def roi_action_gray_filter_active(self) -> bool:
        s = self.ctl.scan
        return s.roiGrayScaleSelection is not None and s.roiGrayScaleSkipped is not None

    def _show_gray_spectrum(self) -> bool:
        roi = self.ctl.scan.roi
        return (self.kind == "roi" and self.has_partial
                and bool(roi.scanImageDataUrl or roi.imageDataUrl or self.active_roi_scan_image()))

    # ------------------------------------------------------------------ tabs (App.tsx selectKind & friends)
    def _reset_roi_action_context(self, *, clear_selection=False, preserve_scan_image=False,
                                  preserve_gray_selection=False):
        s = self.ctl.scan
        clear_bitmap_selection_cache()
        if not preserve_scan_image:
            s.clear_roi_scan_image()
        if clear_selection:
            s.clear_roi_selection()
        if not preserve_gray_selection:
            s.set_roi_gray_scale_selection(None, None)
            self.pending_sel = None
            self.pending_anchor = None
            self.pending_skipped = None
        self.gray_levels = []
        self._spectrum_key = None
        self.commit_count = 0
        self.roi_action_locked = False
        self.roi_action_canvas_visible = False

    def select_kind(self, nxt: str):
        s = self.ctl.scan
        if nxt == s.kind or self.ctl.scan_active:
            return
        next_scan = nxt if nxt in ("raster", "vector") else None
        cur_scan = s.kind if s.kind in ("raster", "vector") else None
        self._reset_roi_action_context(preserve_scan_image=True, preserve_gray_selection=True)
        if next_scan and (cur_scan is None or cur_scan != next_scan):
            s.stream_reset()
            if next_scan == "raster":
                self.ctl.reset_raster(s.raster["resolution"])
            else:
                self.ctl.reset_vector()
        s.kind = nxt
        if nxt in ("raster", "vector"):
            self.ctl.last_scan_kind = nxt

    def _activate_sub(self, key: str):
        if key in ("roi", "raster", "vector"):
            self._activate_scan_sub(key)
        else:
            self._activate_cal_sub(key)

    def _activate_scan_sub(self, tab: str):
        self.active_top = "scan"
        self.scan_sub = tab
        self._set_repeat(1)
        self.ctl.scan.update_roi({"calibration_enabled": False})
        self.select_kind("roi" if tab == "roi" else tab)
        self.ctl.notify("scan", "roi", "panel", "tabs")

    def _activate_cal_sub(self, tab: str):
        s = self.ctl.scan
        self.active_top = "calibrate"
        self.cal_sub = tab
        if tab == "dimension":
            if s.kind != "roi":
                self.select_kind("roi")
            if self.ctl.dim_cal_persisted:
                s.apply_persisted_dimension_calibration(self.ctl.dim_cal)
            else:
                s.begin_dimension_calibration(self.ctl.dim_cal)
        else:
            s.update_roi({"calibration_enabled": False})
            self.select_kind("mag")
        self.ctl.notify("scan", "roi", "panel", "tabs")

    def _activate_top(self, key: str):
        if key == "scan":
            self.active_top = "scan"
            self._activate_scan_sub(self.scan_sub)
        elif key == "calibrate":
            self.active_top = "calibrate"
            self._activate_cal_sub(self.cal_sub)
        else:
            if self.ctl.scan_active:
                return
            self.active_top = "adcTest"
            self.ctl.notify("tabs")

    def _apply_kind_for_tabs(self, initial=False):
        pass

    # ------------------------------------------------------------------ gray level flows
    def _gray_select(self, g: int):
        s = self.ctl.scan
        self.confirm_target = "roi"
        if self.pending_skipped is None:
            self.pending_skipped = s.roiGrayScaleSkipped if s.roiGrayScaleSkipped is not None else False
        if self.commit_count == 0:
            self.pending_anchor = g
            self.pending_sel = (g, g)
            self.commit_count = 1
            self.refresh_all()
            return
        nxt = normalize_gray_scale_selection([self.pending_anchor, g]) if (
            self.pending_anchor is not None and self.pending_sel is not None) else (g, g)
        self.pending_anchor = None
        self.pending_sel = nxt or (g, g)
        self.commit_count = 0
        self.refresh_all()
        self._open_confirm()

    def _step_delta_changed(self, v: int):
        self.step_delta = max(1, min(255, v))
        self.ctl.persist_step_delta(self.step_delta)
        self.refresh_all()

    def _open_confirm(self):
        if self.pending_sel is None or self.pending_anchor is not None:
            return

        def set_skip(v):
            self.pending_skipped = v
        dlg = GrayScaleConfirmDialog(self.pending_sel, self.pending_skipped, set_skip, self)
        if dlg.exec():
            self._confirm_accept()
        else:
            self.commit_count = 0
            self.vector_range_commit = 0
        self.refresh_all()

    def _confirm_accept(self):
        s = self.ctl.scan
        if self.pending_sel is None or self.pending_anchor is not None:
            return
        s.update_vector({"dwell": 2})
        if self.confirm_target == "vector":
            self.vector_gray_skipped = True
        else:
            if s.roi.scanImageDataUrl is not None and s.roi.imageKind == "lastScan":
                s.update_roi({"imageName": "No image selected", "imageDataUrl": None, "imageKind": "none",
                              "imageBounds": None})
            s.clear_roi_scan_image()
            self.ctl.reset_vector()
            self.roi_action_canvas_visible = False
            self.roi_canvas.reset_gray_selection()
            s.set_roi_gray_scale_selection(self.pending_sel, self.pending_skipped)
        self.ctl.notify("scan", "roi", "gray")

    def clear_roi_gray_values(self):
        self.ctl.scan.set_roi_gray_scale_selection(None, None)
        self.pending_sel = None
        self.pending_anchor = None
        self.pending_skipped = None
        self.commit_count = 0
        self.roi_action_locked = False
        self.roi_action_canvas_visible = False
        self.ctl.notify("scan", "roi", "gray")

    def _apply_vector_gray_toggle(self, checked: bool):
        self.vector_gray_enabled = checked
        if checked:
            self.vector_gray_range = (0, 255)
            self.vector_gray_skipped = True
            self.ctl.scan.update_vector({"vector_resolution": 128, "pattern": "default", "points": None})
        else:
            self.vector_gray_range = (0, 255)
            self.vector_gray_skipped = None

    def _vector_gray_toggled(self, checked: bool):
        if self._refreshing:
            return
        self.vector_range_commit = 0
        self._apply_vector_gray_toggle(checked)
        self.ctl.notify("scan", "vector-gray")

    def _vector_gray_range(self, lo: int, hi: int):
        self.vector_gray_range = normalize_gray_scale_selection([lo, hi]) or (0, 255)
        self.ctl.notify("vector-gray")

    def _vector_gray_select(self):
        if not self.vector_gray_enabled:
            return
        self.confirm_target = "vector"
        self.pending_sel = self.vector_gray_range
        self.pending_anchor = None
        self.pending_skipped = True
        if self.vector_range_commit == 0:
            self.vector_range_commit = 1
            return
        self.vector_range_commit = 0
        self._open_confirm()

    # ------------------------------------------------------------------ ROI hand-offs
    def load_last_scan(self):
        img = self.roi_scan_image()
        if not img:
            return
        self.suppressed_scan_image = None
        self.roi_canvas.clear_suppression()
        self._reset_roi_action_context(clear_selection=True)
        self.ctl.scan.update_roi({"imageName": t("roi.imageName.lastScan"), "imageDataUrl": img,
                                  "imageKind": "lastScan", "imageBounds": None})
        self.ctl.notify("roi", "scan")

    def _on_clear_image(self):
        bg = self.roi_scan_image()
        if bg:
            self.roi_canvas.suppress_background(bg)

    def _on_action_run_start(self):
        self.roi_action_locked = True
        self.roi_action_canvas_visible = True
        self.ctl.notify("panel", "tabs")

    def _set_repeat(self, n: int):
        self.repeat = n
        self.scan_controls.repeat = n
        self.roi_action_controls.repeat = n

    def _rendered_image(self, scan_kind: str, png):
        s = self.ctl.scan
        if (self.kind == "roi" and scan_kind == "vector" and self.roi_action_canvas_visible
                and not self.roi_action_gray_filter_active):
            if png:
                s.update_roi(completed_roi_image_patch(s.roi, png, t("roi.imageName.lastScan")))
                self.ctl.reset_vector()
                self.roi_action_locked = False
                self.roi_action_canvas_visible = False
                self.ctl.last_live_image = None
                self.ctl.merged_figure = {"raster": None, "vector": None}
                self.ctl.notify("roi", "scan", "panel", "tabs")
            return
        cur = self.ctl.last_live_image
        if not png:
            if cur and cur[0] == scan_kind:
                self.ctl.last_live_image = None
        else:
            self.ctl.last_live_image = (scan_kind, png)
        self.ctl.notify("last-scan")

    def _merged_figure(self, scan_kind: str, png):
        if self.ctl.merged_figure.get(scan_kind) is not png:
            self.ctl.merged_figure[scan_kind] = png
            self.ctl.notify("merged")

    # ------------------------------------------------------------------ view switching / dashboards
    def _navigate(self, route: str):
        self.route = route
        if route == "report":
            if self.report_page is not None:
                self.pages.removeWidget(self.report_page)
                self.report_page.deleteLater()
            self.report_page = ManagementReport(self.ctl, lambda: self._navigate("control"))
            self.pages.addWidget(self.report_page)
            self.pages.setCurrentWidget(self.report_page)
        else:
            self.pages.setCurrentWidget(self.control_page)
        self.header.active_view = "report" if route == "report" else "control"
        self.ctl.notify("view")

    def _open_vacuum(self):
        self.vacuum_minimized = False
        self.vacuum.open_dashboard()
        self._set_header()

    def _vacuum_minimized(self, m: bool):
        self.vacuum_minimized = m
        self._set_header()

    def _vacuum_activity(self, active: bool):
        self.vacuum_busy = active
        if active and self.vacuum.isHidden():
            self._open_vacuum()
        self._set_header()

    def _open_stage(self):
        self.stage_minimized = False
        self.stage.open_dashboard()
        self._set_header()

    def _stage_minimized(self, m: bool):
        self.stage_minimized = m
        self._set_header()

    def _set_header(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)
        h = self.header
        h.vacuum_minimized, h.vacuum_busy = self.vacuum_minimized, self.vacuum_busy
        h.stage_minimized, h.stage_busy = self.stage_minimized, self.stage_busy
        self.ctl.notify("dashboards")

    def open_auth(self):
        if self.ctl.scan_active or self.ctl.adc_active:
            return
        AuthDialog(self.ctl, self).exec()

    def _maybe_auto_auth(self):
        if not self.ctl.signed_in and not self._auth_auto_opened and not self.ctl.scan_active:
            self._auth_auto_opened = True
            self.open_auth()

    # ------------------------------------------------------------------ toggles
    def _grid_toggled(self, c: bool):
        if self._refreshing:
            return
        key = {"roi": "show_grid", "raster": "raster_show_grid", "vector": "vector_show_grid"}.get(self.kind)
        if key:
            self.ctl.scan.update_roi({key: c})
            self.ctl.notify("roi")

    def _path_toggled(self, c: bool):
        if self._refreshing:
            return
        self.ctl.scan.update_roi({"vector_show_scan_path": c})
        self.ctl.notify("roi")

    # ------------------------------------------------------------------ change handling
    _refreshing = False

    def _on_scan_event(self, ev: dict):
        pass

    def _on_changed(self, topics):
        topics = set(topics)
        s = self.ctl.scan
        if "locale" in topics:
            self.setWindowTitle(t("app.documentTitle"))
        if "vacuum" in topics and self.ctl.vacuum_enabled and not self._vacuum_auto_opened:
            self._vacuum_auto_opened = True
            QTimer.singleShot(0, self._open_vacuum)
        if "vacuum" in topics and not self.ctl.vacuum_enabled and not self.vacuum.isHidden():
            self.vacuum.minimize()
            self.vacuum.stop_polling()
        # App.tsx effects ---------------------------------------------------
        key = self._sel_key()
        if key != self._prev_sel_key:
            self._prev_sel_key = key
            if s.roi.scanImageDataUrl:
                s.update_roi({"imageName": t("roi.imageName.lastScan"), "imageDataUrl": s.roi.scanImageDataUrl,
                              "imageKind": "lastScan", "scanImageDataUrl": None})
                self._reset_roi_action_context(preserve_scan_image=True)
            else:
                self._reset_roi_action_context()
        if s.phase != self._prev_phase:
            self._prev_phase = s.phase
            if s.phase not in ("running", "stopping"):
                self.ctl.active_scan_type = None
        if not s.roi.selection or s.phase in ("completed", "error", "idle"):
            self.roi_action_locked = False
        if not s.roi.selection or s.phase in ("idle", "error"):
            self.roi_action_canvas_visible = False
        if s.roiGrayScaleSelection != self._prev_committed:
            self._prev_committed = s.roiGrayScaleSelection
            self.pending_sel = s.roiGrayScaleSelection
            self.pending_anchor = None
        # image cleared -> suppress last-scan background
        if self._prev_image is not None and s.roi.imageDataUrl is None:
            bg = self.roi_scan_image()
            if bg:
                self.suppressed_scan_image = bg
        elif self.suppressed_scan_image is not None and (s.roi.imageKind == "file" or not self.roi_scan_image()):
            self.suppressed_scan_image = None
        self._prev_image = s.roi.imageDataUrl
        if self.kind == "roi" and not self._show_gray_spectrum():
            self.pending_sel = self.pending_sel if self.pending_sel == s.roiGrayScaleSelection else None
            self.gray_levels = []
            self._spectrum_key = None
            self.commit_count = 0
        # promote the last-scan image into the ROI canvas (App.tsx effect)
        active = self.active_roi_scan_image()
        if (self.kind == "roi" and active and s.phase not in ("running", "stopping") and s.roi.imageKind not in
                ("file", "lastScan") and s.roi.scanImageDataUrl is None and active is not self.suppressed_scan_image):
            s.update_roi({"imageName": t("roi.imageName.lastScan"), "imageDataUrl": active, "imageKind": "lastScan"})
        if self.vector_gray_enabled and s.vector["latency_bytes"] < 8196:
            s.update_vector({"latency_bytes": 8196})
        self.refresh_all()

    def _update_spectrum_levels(self):
        if not self._show_gray_spectrum():
            return
        s = self.ctl.scan
        roi = s.roi
        img = roi.imageDataUrl or self.active_roi_scan_image()
        key = (hash(img) if img else None, roi.selection and tuple(roi.selection.values()), roi.x_origin, roi.x_end,
               roi.y_origin, roi.y_end, roi.viewport_x_start, roi.viewport_x_end, roi.viewport_y_start,
               roi.viewport_y_end)
        if key == self._spectrum_key:
            return
        self._spectrum_key = key
        import copy
        spec_roi = roi if roi.imageDataUrl else copy.copy(roi)
        if not roi.imageDataUrl and img:
            spec_roi.imageDataUrl = img
        try:
            self.gray_levels = gray_scale_spectrum_levels_for_selection(spec_roi)
        except Exception as exc:  # noqa: BLE001
            log.warning("gray spectrum: %s", exc)
            self.gray_levels = []
        if self.step_delta < 2:
            self.step_delta = 10

    def refresh_all(self):
        if self._refreshing:
            return
        self._refreshing = True
        try:
            self._refresh()
            # never let the splitter squeeze the parameter column below its content
            sb = self._left_scroll.verticalScrollBar().sizeHint().width()
            need = self._left_body.minimumSizeHint().width() + sb + 2
            if self._left_scroll.minimumWidth() != need:
                self._left_scroll.setMinimumWidth(max(360, need))
        finally:
            self._refreshing = False

    def _refresh(self):
        ctl = self.ctl
        s = ctl.scan
        roi = s.roi
        kind = self.kind
        disabled = ctl.panel_disabled
        # top / sub tabs
        self.top_btns["scan"].setText(t("tabs.scan"))
        self.top_btns["calibrate"].setText(t("tabs.calibrate"))
        self.top_btns["adcTest"].setText(t("tabs.adcTest"))
        if not ctl.adc_test_enabled and self.active_top == "adcTest":
            self.active_top = "scan"
        self.top_btns["adcTest"].setVisible(ctl.adc_test_enabled)
        for k, b in self.top_btns.items():
            b.setChecked(k == self.active_top)
        self.top_btns["scan"].setEnabled(not disabled)
        self.top_btns["calibrate"].setEnabled(not disabled)
        self.top_btns["adcTest"].setEnabled(not ctl.scan_active)
        labels = {"roi": "tabs.roi", "raster": "tabs.raster", "vector": "tabs.vector", "dimension": "tabs.dimensionCal",
                  "mag": "tabs.mag"}
        rv_disabled = disabled or self.roi_action_locked
        for k, b in self.sub_btns.items():
            b.setText(t(labels[k]))
            in_scan = k in ("roi", "raster", "vector")
            b.setVisible((self.active_top == "scan" and in_scan) or (self.active_top == "calibrate" and not in_scan))
            b.setChecked(k == (self.scan_sub if in_scan else self.cal_sub))
            b.setEnabled(not (rv_disabled if k in ("raster", "vector") else disabled))
        # scan panel accent while a scan runs
        color = SCAN_TYPE_COLORS.get(ctl.active_scan_type) if ctl.active_scan_type else None
        self.scan_card.set_active(bool(color), color)
        self.controls_card.set_active(bool(color), color)
        # left page
        page = "adcTest" if self.active_top == "adcTest" else (
            self.scan_sub if self.active_top == "scan" else self.cal_sub)
        self.left_stack.setCurrentWidget(self.left_pages[page])
        partial = self.has_partial
        roi_scan_img = self.roi_scan_image()
        for c in (self.roi_controls, self.dim_controls):
            c.allow_clear_region_while_disabled = self.roi_action_locked
            c.last_scan_available = roi_scan_img is not None
            c.refresh()
        self.roi_scan_path.setVisible(partial)
        show_action = should_show_roi_action_controls(kind, partial)
        self.roi_action_controls.setVisible(show_action and kind == "roi")
        gray_filter = self.roi_action_gray_filter_active
        vgray = self.vector_gray_range if self.vector_gray_enabled else None
        vskip = self.vector_gray_skipped if self.vector_gray_enabled else None
        self.roi_action_controls.configure(kind="vector", repeat=self.repeat, show_repeat_control=gray_filter,
                                           vector_gray_selection=vgray, vector_gray_skipped=vskip)
        show_cal = kind == "roi" and roi.calibration_enabled
        for card in (self.roi_cal_card, self.dim_cal_card):
            card.setVisible(show_cal)
            card.last_scan_available = roi_scan_img is not None
            card.refresh()
        action_kind = "vector" if kind == "roi" else (resolve_roi_action_kind(kind, self.last_scan_kind)
                                                      or self.last_scan_kind)
        lower = self.active_top != "adcTest" and show_action and kind != "roi"
        self.controls_card.setVisible(lower)
        self.controls_card.set_title(t("card.controls"))
        self.scan_controls.configure(kind=action_kind, repeat=self.repeat,
                                     show_repeat_control=action_kind == "vector" and self.vector_gray_enabled,
                                     vector_gray_selection=vgray, vector_gray_skipped=vskip)
        self.dac_card.setVisible(lower and kind == "vector")
        self.dac_card.set_title(t("card.dacCheck"))
        self.report_card.setVisible(lower)
        self.report_card.set_title(t("card.runReport"))
        self.run_report.kind_override = action_kind if action_kind in ("raster", "vector") else None
        self.run_report.merged_png = ctl.merged_figure.get("vector" if action_kind == "vector" else "raster")
        self.run_report.refresh()
        self.error_wedge.setVisible(lower and self.error_wedge.isVisibleTo(self.error_wedge.parentWidget()) or lower)
        self.error_wedge.refresh()
        if not lower:
            self.error_wedge.hide()
        self.vector_params.set_gray_filter_active(self.vector_gray_enabled)
        # image column --------------------------------------------------------
        title_key = ("card.adcTimeline" if self.active_top == "adcTest" else
                     "card.vectorPattern" if (kind == "roi" and self.roi_action_canvas_visible and not gray_filter) else
                     {"raster": "card.rasterImage", "vector": "card.vectorPattern", "mag": "card.magCalibration"}.get(
                         kind, "card.calibration" if roi.calibration_enabled else "card.selectROI"))
        self.image_card.set_title(t(title_key))
        not_adc = self.active_top != "adcTest"
        grid_key = {"roi": "show_grid", "raster": "raster_show_grid", "vector": "vector_show_grid"}.get(kind)
        self.grid_switch.setVisible(not_adc and grid_key is not None)
        self.grid_switch.setText(t("roi.showGrid"))
        if grid_key:
            self.grid_switch.setChecked(getattr(roi, grid_key))
        self.grid_switch.setEnabled(not disabled)
        show_path = kind == "vector" or (kind == "roi" and partial)
        self.path_switch.setVisible(not_adc and show_path)
        self.path_switch.setText(t("vector.displayScanPath"))
        self.path_switch.setChecked(roi.vector_show_scan_path)
        self.path_switch.setEnabled(not disabled)
        self.vgray_switch.setVisible(not_adc and kind == "vector")
        self.vgray_help.setVisible(not_adc and kind == "vector")
        self.vgray_switch.setText(t("vector.grayLevels"))
        self.vgray_switch.setChecked(self.vector_gray_enabled)
        self.vgray_switch.setEnabled(not disabled)
        self.vgray_selector.setVisible(not_adc and kind == "vector" and self.vector_gray_enabled)
        self.vgray_selector.set_state(self.vector_gray_range, disabled)
        show_spec = (not_adc and kind != "vector" and self._show_gray_spectrum()
                     and not (kind == "roi" and self.roi_action_canvas_visible and not gray_filter))
        self.spectrum.setVisible(show_spec)
        if show_spec:
            self._update_spectrum_levels()
            src_kind = resolve_gray_scale_source_kind(True, roi.imageDataUrl, self.active_roi_scan_image(),
                                                      self.last_scan_kind)
            shown = self.pending_sel if self.pending_sel is not None else s.roiGrayScaleSelection
            self.spectrum.set_state(selected=shown, anchor=self.pending_anchor, levels=self.gray_levels,
                                    step_delta=self.step_delta,
                                    source_label=gray_scale_source_label_for_kind(src_kind, t),
                                    scope_note=gray_scale_scope_note_for_kind(src_kind, ctl.is_production, t))
        show_clear = (not_adc and should_show_roi_gray_scale_clear(kind, s.roiGrayScaleSelection is not None)
                      and not (self.roi_action_canvas_visible and not gray_filter))
        self.gray_clear.setVisible(show_clear)
        self.gray_clear.setText(t("scan.clear"))
        self.gray_clear.setEnabled(not disabled)
        # right page
        if self.active_top == "adcTest":
            self.right_stack.setCurrentWidget(self.adc_timeline)
        elif kind == "roi":
            if self.roi_action_canvas_visible and not gray_filter and roi.scanImageDataUrl is None:
                self.right_stack.setCurrentWidget(self.vector_canvas)
                self.vector_canvas.set_vector_gray(None, None) if self.vector_canvas.vector_gray_selection else None
            else:
                self.right_stack.setCurrentWidget(self.roi_canvas)
                shown = self.pending_sel if self.pending_sel is not None else s.roiGrayScaleSelection
                shown_skip = self.pending_skipped if self.pending_skipped is not None else s.roiGrayScaleSkipped
                self.roi_canvas.configure(background=self.active_roi_scan_image(), gray_selection=shown,
                                          gray_skipped=shown_skip,
                                          live_vector_preview=self.roi_action_canvas_visible and gray_filter,
                                          hide_selection_overlay=self.roi_action_canvas_visible and not gray_filter)
        elif kind == "mag":
            self.right_stack.setCurrentWidget(self.mag_chart)
        elif kind == "raster":
            self.right_stack.setCurrentWidget(self.raster_canvas)
        else:
            self.right_stack.setCurrentWidget(self.vector_canvas)
            if (self.vector_canvas.vector_gray_selection, self.vector_canvas.vector_gray_skipped) != (vgray, vskip):
                self.vector_canvas.set_vector_gray(vgray, vskip)
        # ROI preview column
        show_preview = (kind == "roi" and partial and not roi.calibration_enabled and self.active_top != "adcTest")
        self.preview_card.setVisible(show_preview and self.route == "control")
        self.preview_card.set_title(t("card.roiPreview"))
        if show_preview:
            self.roi_preview.set_background(self.active_roi_scan_image())
        from .common import HelpButton as _HB
        _HB.set_locked(ctl.scan_active)
