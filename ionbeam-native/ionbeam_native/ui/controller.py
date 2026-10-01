"""Application controller: the desktop equivalent of the web app's Redux store.

Owns the scan state (``core.state.ScanState``), the signed-in account,
service defaults/status, vacuum readiness, dimension calibration, equipment
selection and the scan lifecycle (``hooks/useScanStream.ts`` semantics),
and wires the acquisition engine to the backend control plane
(activity/operation records + FTP artifacts).

Widgets subscribe to ``changed`` (a set of topic strings) and re-read what
they need; nothing here paints.
"""
from __future__ import annotations

import base64
import json
import logging
from dataclasses import replace
from datetime import datetime, timezone
from typing import Callable, Optional

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from .. import i18n
from ..backend.client import ApiError, Backend
from ..core.bitmap_vector import clear_bitmap_selection_cache
from ..core.geometry import (
    dimension_bounds_from_geometry, geometry_from_config, parse_scan_geometry_config, to_applied_geometry,
)
from ..core.helpers import ScanType, should_disable_scan_panel
from ..core.state import (
    DimensionCalibrationValues, ScanState, clamp_gray_scale_step_delta, parse_dimension_calibration,
)
from ..engine.artifacts import ArtifactWorker
from ..engine.engine import Engine, ScanJob
from ..i18n import t
from . import theme
from .common import prefs, run_bg

log = logging.getLogger("ionbeam_native.controller")

ADMIN_USER_KEY = "ionbeam:adminUser"
LAST_LOGIN_KEY = "ionbeam:lastAdminLogin"
EQUIPMENT_KEY = "ionbeam:selectedEquipmentId"
DEFAULTS_CACHE_KEY = "ionbeam:last-good-defaults"
DIM_CAL_KEY = "ionbeam.dimensionCalibration.v1"
STEP_DELTA_KEY = "ionbeam.roiGrayScaleStepDelta"
THEME_KEY = "ionbeam.theme"
LOCALE_KEY = "ionbeam.locale"
ROLE_SUPER_USER = 1


def utc_scan_timestamp(now: Optional[datetime] = None) -> str:
    """``formatScanTimestamp`` (UTC yymmdd_HHMMSS) used for recorded artifact names."""
    d = now or datetime.now(timezone.utc)
    return d.strftime("%y%m%d_%H%M%S")


def scan_artifact_filenames(kind: str, resolution: int, latency_bytes: int, vector_resolution: int,
                            timestamp: Optional[str] = None) -> tuple[str, str]:
    ts = timestamp or utc_scan_timestamp()
    if kind == "raster":
        base = f"raster_{resolution}x{resolution}_{ts}"
    else:
        base = f"vector_latency_{latency_bytes or vector_resolution or 0}_{ts}"
    return f"{base}.csv", f"{base}.png"


def ftp_configured(stream_config: dict) -> bool:
    """Same criteria as backend loadFtpSettings (Actions[0].streamData.actionData.ftp)."""
    try:
        ftp = stream_config["Actions"][0]["streamData"]["actionData"]["ftp"]
    except (KeyError, IndexError, TypeError):
        return False
    if not isinstance(ftp, dict):
        return False
    need = [str(ftp.get(k) or "").strip() for k in ("host", "username", "password", "folder")]
    return bool(ftp.get("enabled", False)) and all(need)


class RecordHandle:
    def __init__(self):
        self.activity_id: Optional[int] = None
        self.pending = True
        self.waiters: list = []

    def resolve(self, activity_id: Optional[int]) -> None:
        self.activity_id = activity_id
        self.pending = False
        for fn in self.waiters:
            fn()
        self.waiters.clear()

    def when_ready(self, fn: Callable[[], None]) -> None:
        if self.pending:
            self.waiters.append(fn)
        else:
            fn()


class AppController(QObject):
    changed = pyqtSignal(object)          # set[str] of topics
    scan_event = pyqtSignal(dict)         # lifecycle events for widgets that need them

    def __init__(self, engine: Engine, backend: Backend, artifacts: ArtifactWorker, stream_config: dict):
        super().__init__()
        self.engine = engine
        self.backend = backend
        self.artifacts = artifacts
        self.stream_config = stream_config
        self.p = prefs()
        self.scan = ScanState()
        self.scan.roiGrayScaleStepDelta = clamp_gray_scale_step_delta(self.p.get(STEP_DELTA_KEY, 10))
        # status slice
        self.defaults: Optional[dict] = self.p.get_json(DEFAULTS_CACHE_KEY)
        self.service_status: Optional[dict] = None
        self.status_error: Optional[str] = None
        self.vacuum_enabled = False
        self.vacuum_ready = False
        self.hv_power = False
        self.hv_pending = False
        self.hv_error: Optional[str] = None
        self.reconnecting = False
        # auth
        self.signed_in_user: Optional[dict] = self.p.get_json(ADMIN_USER_KEY)
        backend._token = lambda: (self.signed_in_user or {}).get("session_token", "") or ""
        # dimension calibration slice
        loaded = parse_dimension_calibration(self.p.get_json(DIM_CAL_KEY))
        self.dim_cal: DimensionCalibrationValues = loaded or DimensionCalibrationValues()
        self.dim_cal_persisted = loaded is not None
        # equipment
        self.equipment: list = []
        self.selected_equipment_id: Optional[int] = self._stored_equipment_id()
        # misc app state (App.tsx locals shared by several widgets)
        self.last_scan_kind = "raster"
        self.active_scan_type: Optional[str] = None
        self.adc_active = False
        self.adc_phase = "idle"
        self.level_memory: dict = {}
        self.last_live_image: Optional[tuple] = None      # (kind, png bytes)
        self.merged_figure: dict = {"raster": None, "vector": None}
        self.server_figure: dict = {}                     # kind -> png bytes of last validated/server render
        self.last_stream_kind: Optional[str] = None
        self._job: Optional[ScanJob] = None
        self._record: Optional[RecordHandle] = None
        self._auto_reconnect_attempted = False
        self._closure_stop = False
        self._frame_seen = {"raster": -1, "vector": -1}
        # timers
        self._status_timer = QTimer(self)
        self._status_timer.timeout.connect(self.refresh_status)
        self._vacuum_timer = QTimer(self)
        self._vacuum_timer.timeout.connect(self.refresh_vacuum)
        self._frame_timer = QTimer(self)
        self._frame_timer.timeout.connect(self._poll_frames)
        self._frame_timer.start(33)

    # ------------------------------------------------------------------ plumbing

    def notify(self, *topics: str) -> None:
        self.changed.emit(set(topics))

    def start(self) -> None:
        self.load_defaults()
        self.refresh_status()
        self._status_timer.start(4000)
        self.check_current_account()
        self.load_equipment()
        self.restore_dimension_calibration()
        self.load_scan_geometry()
        self.engine.open_session().add_done_callback(lambda f: None)

    # ------------------------------------------------------------------ status / defaults

    @property
    def is_production(self) -> bool:
        return bool((self.defaults or {}).get("is_production") is True)

    @property
    def adc_test_enabled(self) -> bool:
        return (self.defaults or {}).get("adc_test") is not False

    @property
    def selected_beam(self) -> Optional[str]:
        return (self.defaults or {}).get("selected_beam")

    @property
    def version(self) -> str:
        return str((self.defaults or {}).get("version") or "")

    def load_defaults(self) -> None:
        try:
            defaults = self.engine.defaults()
        except Exception as exc:
            log.warning("defaults: %s", exc)
            return
        self.defaults = defaults
        self.p.set_json(DEFAULTS_CACHE_KEY, defaults)
        self.scan.apply_server_defaults(defaults)
        self.notify("defaults", "scan")

    def refresh_status(self) -> None:
        try:
            status = self.engine.status()
            if self.adc_active:
                status["state"] = status.get("state", "idle")
            self.service_status = status
            self.status_error = None
        except Exception as exc:
            self.status_error = str(exc)
        # vacuum_enabled comes from the backend (its vacuum config)
        def fetch():
            return self.backend.get_json("/api/status", "status", timeout=3)

        def ok(data):
            enabled = bool(isinstance(data, dict) and data.get("vacuum_enabled") is True)
            if enabled != self.vacuum_enabled:
                self.vacuum_enabled = enabled
                self._vacuum_timer.start(1000) if enabled else self._vacuum_timer.stop()
                if not enabled:
                    self.vacuum_ready = False
                    self.hv_power = False
                self.notify("vacuum")
        run_bg(fetch, on_ok=ok, on_err=lambda e: None)
        # metadata refresh like fetchDefaultsMetadata (is_production / version)
        try:
            meta = self.engine.defaults()
            if self.defaults is None or any(self.defaults.get(k) != meta.get(k)
                                            for k in ("is_production", "simulation", "version")):
                self.defaults = {**(self.defaults or {}), **{k: meta.get(k) for k in
                                                              ("is_production", "simulation", "version")}}
                self.p.set_json(DEFAULTS_CACHE_KEY, self.defaults)
                self.notify("defaults")
        except Exception:
            pass
        self.notify("status")

    def refresh_vacuum(self) -> None:
        if not self.vacuum_enabled:
            return

        def fetch():
            return self.backend.get_json("/api/vacuum", "vacuum status", timeout=3)

        def ok(status):
            ready = bool(status.get("isVacuumSystemReady") is True)
            power = bool(status.get("high_voltage_power") is True)
            if ready != self.vacuum_ready or power != self.hv_power:
                self.vacuum_ready, self.hv_power = ready, power
                self.notify("vacuum", "panel")

        def err(_e):
            if self.vacuum_ready:
                self.vacuum_ready = False
                self.notify("vacuum", "panel")
        run_bg(fetch, on_ok=ok, on_err=err)

    def toggle_high_voltage(self) -> None:
        if not self.vacuum_ready or self.hv_pending:
            return
        self.hv_pending = True
        self.hv_error = None
        self.notify("vacuum")
        target = not self.hv_power

        def call():
            r = self.backend.request("POST", "/api/vacuum/high-voltage/power", json_body={"power": target})
            if r.status_code >= 400:
                if r.status_code == 401:
                    raise ApiError("__expired__", 401)
                raise ApiError(self.backend.error_detail(r), r.status_code)
            return self.backend.read_json(r, "high-voltage power")

        def ok(status):
            self.hv_pending = False
            self.vacuum_ready = status.get("isVacuumSystemReady") is True
            self.hv_power = status.get("high_voltage_power") is True
            self.notify("vacuum", "panel")

        def err(exc):
            self.hv_pending = False
            if isinstance(exc, ApiError) and exc.status == 401:
                self.expire_session()
                self.hv_error = t("auth.sessionExpired")
            else:
                self.hv_error = str(exc)
            self.notify("vacuum")
        run_bg(call, on_ok=ok, on_err=err)

    def reconnect_device(self) -> None:
        """Header "reconnect": re-open the Glasgow session (web: restart services)."""
        if self.reconnecting:
            return
        self.reconnecting = True
        self.notify("status")
        fut = self.engine.reconnect()

        def done(_f):
            def ui():
                self.reconnecting = False
                self.refresh_status()
            self.engine.post(ui)
        fut.add_done_callback(done)

    @property
    def session_open(self) -> bool:
        return bool((self.service_status or {}).get("session_open"))

    def release_device(self) -> None:
        """Close the persistent session and drop the cross-process device lock so
        the web stack's glasgow_service can scan. The next scan here re-opens it."""
        if self.scan_active or self.adc_active or self.reconnecting:
            return
        self.reconnecting = True
        self.notify("status")
        fut = self.engine.release_device()

        def done(f):
            def ui():
                self.reconnecting = False
                if f.exception() is not None:
                    self.status_error = str(f.exception())
                log.info("Glasgow released (web stack may use it now)")
                self.refresh_status()
            self.engine.post(ui)
        fut.add_done_callback(done)

    # ------------------------------------------------------------------ panel lock

    @property
    def scan_active(self) -> bool:
        return self.scan.phase in ("running", "stopping")

    @property
    def signed_in(self) -> bool:
        return bool(self.signed_in_user)

    @property
    def panel_disabled(self) -> bool:
        return should_disable_scan_panel(self.scan_active or self.adc_active, self.signed_in,
                                         self.vacuum_enabled, self.vacuum_ready)

    # ------------------------------------------------------------------ auth

    def set_signed_in(self, user: Optional[dict]) -> None:
        self.signed_in_user = user
        if user:
            self.p.set_json(ADMIN_USER_KEY, user)
            self.p.set(LAST_LOGIN_KEY, user.get("login_name", ""))
        else:
            self.p.remove(ADMIN_USER_KEY)
        self.notify("auth", "panel")

    def expire_session(self) -> None:
        if self.signed_in_user:
            self.p.set(LAST_LOGIN_KEY, self.signed_in_user.get("login_name", ""))
        self.set_signed_in(None)

    def check_current_account(self) -> None:
        user = self.signed_in_user
        if not user:
            return
        if not user.get("session_token"):
            self.set_signed_in(None)
            return

        def fetch():
            return self.backend.get_json("/api/admin/iobeam/auth/current-account", "current account")

        def ok(data):
            if not isinstance(data, dict) or self.signed_in_user is not user:
                return
            current = str(data.get("login") or "").lower()
            if (not data.get("registered") or data.get("session_expired") is True
                    or current != str(user.get("login_name", "")).lower()):
                self.expire_session()
                return
            if data.get("user"):
                refreshed = {**data["user"], "session_token": user.get("session_token")}
                if json.dumps(refreshed, sort_keys=True) != json.dumps(user, sort_keys=True):
                    self.set_signed_in(refreshed)
        run_bg(fetch, on_ok=ok, on_err=lambda e: None)   # keep the session if the check is unavailable

    def refresh_scan_privilege(self, on_result: Callable[[bool], None]) -> None:
        """``refreshScanPrivilege``: current-account role >= SuperUser, active, not expired."""
        def fetch():
            r = self.backend.request("GET", "/api/admin/iobeam/auth/current-account")
            try:
                data = r.json()
            except ValueError:
                data = None
            if r.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
                raise ApiError((data or {}).get("error") if isinstance(data, dict) and data.get("error")
                               else f"current account: HTTP {r.status_code}")
            return data

        def ok(data):
            u = data.get("user") or {}
            try:
                role = float(u.get("role") or 0)
            except (TypeError, ValueError):
                role = 0
            if (not data.get("registered") or data.get("session_expired") or not u.get("is_active")
                    or role < ROLE_SUPER_USER):
                self.scan.stream_errored(t("scan.permission.required"))
                self.notify("scan")
                on_result(False)
                return
            on_result(True)

        def err(exc):
            self.scan.stream_errored(str(exc))
            self.notify("scan")
            on_result(False)
        run_bg(fetch, on_ok=ok, on_err=err)

    # ------------------------------------------------------------------ equipment

    def _stored_equipment_id(self) -> Optional[int]:
        try:
            value = int(self.p.get(EQUIPMENT_KEY, 0) or 0)
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    def set_selected_equipment(self, equipment_id: Optional[int]) -> None:
        if equipment_id and equipment_id > 0:
            self.selected_equipment_id = equipment_id
            self.p.set(EQUIPMENT_KEY, str(equipment_id))
        self.notify("equipment")

    def load_equipment(self) -> None:
        def fetch():
            r = self.backend.request("GET", "/api/admin/iobeam/equipment")
            data = r.json() if r.content else None
            if r.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
                raise ApiError(f"equipment: HTTP {r.status_code}")
            return data.get("equipment") if isinstance(data.get("equipment"), list) else []

        def ok(rows):
            self.equipment = rows
            stored = self._stored_equipment_id()
            selected = next((r for r in rows if r.get("id") == stored), rows[0] if rows else None)
            if selected and selected.get("id"):
                self.set_selected_equipment(int(selected["id"]))
            self.notify("equipment")

        def err(_e):
            self.equipment = []
            self.notify("equipment")
        run_bg(fetch, on_ok=ok, on_err=err)

    # ------------------------------------------------------------------ dimension calibration / geometry

    def restore_dimension_calibration(self) -> None:
        if self.dim_cal_persisted:
            clear_bitmap_selection_cache()
            self.scan.apply_persisted_dimension_calibration(self.dim_cal)
            self.notify("scan", "roi")
        equipment_id = self.selected_equipment_id
        if equipment_id is None:
            return

        def fetch():
            r = self.backend.request("GET", f"/api/admin/iobeam/dimension-calibration/{equipment_id}")
            if r.status_code >= 400:
                return None
            data = self.backend.read_json(r, "dimension calibration fetch")
            return data.get("calibration") if data.get("ok") else None

        def ok(remote):
            parsed = parse_dimension_calibration(remote)
            if parsed is None:
                return
            clear_bitmap_selection_cache()
            self.save_dimension_calibration(parsed, remote_sync=False)
            self.scan.apply_persisted_dimension_calibration(parsed)
            self.notify("scan", "roi")
        run_bg(fetch, on_ok=ok, on_err=lambda e: None)

    def save_dimension_calibration(self, values: DimensionCalibrationValues, *, remote_sync: bool = True) -> None:
        self.dim_cal = values
        self.dim_cal_persisted = True
        self.p.set_json(DIM_CAL_KEY, values.to_json())
        equipment_id = self.selected_equipment_id
        if remote_sync and equipment_id is not None:
            body = values.to_json()
            run_bg(lambda: self.backend.request("PUT", f"/api/admin/iobeam/dimension-calibration/{equipment_id}",
                                                json_body=body), on_err=lambda e: None)
        self.notify("dimcal")

    def load_scan_geometry(self) -> None:
        def fetch():
            r = self.backend.request("GET", "/api/admin/scan-geometry")
            data = self.backend.read_json(r, "scan geometry")
            if r.status_code >= 400 or data.get("ok") is False:
                raise ApiError(data.get("error") or f"scan geometry: HTTP {r.status_code}")
            return parse_scan_geometry_config(data.get("scan_geometry"))

        def ok(config):
            if not config or not config.get("enabled"):
                return
            geometry = geometry_from_config(config)
            clear_bitmap_selection_cache()
            self.scan.set_scan_geometry(to_applied_geometry(geometry, config.get("profile_revision")))
            merged = replace(self.dim_cal, **dimension_bounds_from_geometry(geometry))
            self.scan.apply_persisted_dimension_calibration(merged)
            self.notify("scan", "roi")
        run_bg(fetch, on_ok=ok, on_err=lambda e: log.warning("[scan-geometry] not loaded: %s", e))

    def persist_step_delta(self, value: int) -> None:
        self.p.set(STEP_DELTA_KEY, str(clamp_gray_scale_step_delta(value)))

    # ------------------------------------------------------------------ frames

    def _poll_frames(self) -> None:
        changed = []
        r = self.engine.raster
        v = self.engine.vector
        if r.revision != self._frame_seen["raster"]:
            self._frame_seen["raster"] = r.revision
            changed.append("frame:raster")
        if v.revision != self._frame_seen["vector"]:
            self._frame_seen["vector"] = v.revision
            changed.append("frame:vector")
        if self.scan_active and self._job is not None:
            frame = r if self._job.kind == "raster" else v
            if frame.nbytes != self.scan.bytesReceived or frame.chunks != self.scan.chunksReceived:
                self.scan.bytesReceived = frame.nbytes
                self.scan.chunksReceived = frame.chunks
                changed.append("progress")
        if changed:
            self.notify(*changed)

    def reset_raster(self, resolution: Optional[int] = None) -> None:
        self.engine.raster.reset(int(resolution or self.scan.raster["resolution"]))
        self.last_live_image = None if (self.last_live_image and self.last_live_image[0] == "raster") \
            else self.last_live_image
        self.notify("frame:raster")

    def reset_vector(self) -> None:
        self.engine.vector.reset()
        self.notify("frame:vector")

    # ------------------------------------------------------------------ scan lifecycle

    def _line_shift(self) -> float:
        raw = ((self.defaults or {}).get("vector") or {}).get("lineShiftPerXRow")
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return 0.0
        return value if value == value and abs(value) != float("inf") else 0.0

    def start_stream(self, kind: str, req: dict, *, preserve_frame: bool = False, live: bool = False,
                     scan_type: Optional[str] = None) -> None:
        """``startRaster`` / ``startVector`` (+ Infinite as an engine live job)."""
        if self._job is not None:
            self.engine.stop()
        self._closure_stop = False
        self._auto_reconnect_attempted = False
        self.last_stream_kind = kind
        self.active_scan_type = scan_type or (ScanType.RASTER if kind == "raster" else ScanType.VECTOR)
        self.server_figure.pop(kind, None)
        self.scan.stream_started()
        req = dict(req)
        self._launch(kind, req, preserve_frame=preserve_frame, live=live)
        self.notify("scan", "panel")

    def _launch(self, kind: str, req: dict, *, preserve_frame: bool, live: bool) -> None:
        preview = bool(req.get("preview"))
        needs_artifacts = (not preview) and kind in ("raster", "vector") and ftp_configured(self.stream_config)
        job = ScanJob(kind, req, live=live, preserve_frame=preserve_frame,
                      line_shift_per_x_row=self._line_shift() if kind == "vector" else 0.0)
        self._job = job

        def frame_start(index: int) -> None:           # engine thread
            self.engine.post(lambda: self._on_frame_start(job, index))

        def frame_done(index: int, result: dict) -> None:  # engine thread (before the next frame starts)
            if needs_artifacts and self.engine.svc.has_last():
                result["snapshot"] = self.engine.svc.last_snapshot()

        job.on_frame_start = frame_start
        job.on_frame_done = frame_done
        try:
            self.engine.start_stream(job, on_started=self.refresh_status,
                                     on_frame=lambda i, r: self._on_frame(job, i, r),
                                     on_finished=lambda o: self._on_finished(job, o))
        except RuntimeError as exc:
            self._job = None
            self.scan.stream_errored(str(exc))
            self.notify("scan", "panel")

    def _on_frame_start(self, job: ScanJob, index: int) -> None:
        if job is not self._job:
            return
        if job.kind in ("raster", "vector") and not job.request.get("preview") and self.signed_in:
            self._record = self._record_start(job.kind, job.request)
        else:
            self._record = None
        if index > 0:
            self.scan.bytesReceived = 0
            self.scan.chunksReceived = 0
        self.notify("scan")

    def _on_frame(self, job: ScanJob, index: int, result: dict) -> None:
        if job is not self._job:
            return
        kind = job.kind
        chunks = int(result.get("chunks") or 0)
        csv_name, png_name = scan_artifact_filenames(
            kind, int(job.request.get("resolution") or 0), int(job.request.get("latency_bytes") or 0),
            int(job.request.get("vector_resolution") or 0))
        record = self._record
        self._record = None
        if kind in ("raster", "vector"):
            self._record_finish(record, kind, job.request, {"event": "done", "chunks": chunks}, chunks,
                                result.get("snapshot"),
                                on_names=lambda c, i, k=kind: self._set_output_names(k, c, i))
        if job.live:
            # Infinite: the frame is complete, the session keeps streaming.
            self.scan.lastOutput = {"kind": kind, "csv_filename": csv_name, "image_filename": png_name}
            self.scan_event.emit({"event": "frame", "kind": kind, "index": index, "perf": result.get("perf")})
            self.notify("scan", "frame-complete")
            return
        self.scan.stream_completed(chunks=chunks, kind=kind, csv_filename=csv_name, image_filename=png_name)
        self.last_scan_kind = kind if kind in ("raster", "vector") else self.last_scan_kind
        self.scan_event.emit({"event": "done", "kind": kind, "perf": result.get("perf")})
        self.notify("scan", "panel", "frame-complete")

    def _set_output_names(self, kind: str, csv_name: Optional[str], image_name: Optional[str]) -> None:
        if csv_name and image_name and self.scan.lastOutput and self.scan.lastOutput.get("kind") == kind:
            self.scan.lastOutput = {"kind": kind, "csv_filename": csv_name, "image_filename": image_name}
            self.notify("scan")

    def _on_finished(self, job: ScanJob, outcome: dict) -> None:
        if job is not self._job:
            return
        self._job = None
        event = outcome.get("event")
        if event == "stopped" or self._closure_stop:
            self.scan.stream_reset()
            self.active_scan_type = None
        elif event == "error":
            message = outcome.get("message") or outcome.get("detail") or "stream error"
            if outcome.get("recoverable") and not self._auto_reconnect_attempted and not self._closure_stop:
                # useScanStream: one automatic reconnect + restart on transport failures.
                self._auto_reconnect_attempted = True
                fut = self.engine.reconnect()

                def after(_f, kind=job.kind, req=job.request, live=job.live):
                    def ui():
                        if self._closure_stop:
                            self.scan.stream_reset()
                            self.notify("scan", "panel")
                            return
                        QTimer.singleShot(250, lambda: self._launch(kind, req, preserve_frame=False, live=live))
                    self.engine.post(ui)
                fut.add_done_callback(after)
                return
            self.scan.stream_errored(message)
            self.active_scan_type = None
        elif event == "done" and job.live:
            self.scan.stream_completed(chunks=int(outcome.get("chunks") or 0))
            self.active_scan_type = None
        else:
            self.active_scan_type = None if self.scan.phase not in ("running", "stopping") else self.active_scan_type
        self.scan_event.emit({"event": "finished", "outcome": outcome, "kind": job.kind})
        self.notify("scan", "panel")
        self.refresh_status()

    def stop_stream(self) -> None:
        """``stop``: POST /scan/abort equivalent; the stream ends as "stopped" -> idle."""
        if self._job is None:
            if self.scan.phase in ("running", "stopping"):
                self.scan.stream_reset()
                self.notify("scan", "panel")
            return
        self._closure_stop = True
        self.scan.stream_stopping()
        self.engine.stop()
        self.notify("scan")

    @property
    def stream_active(self) -> bool:
        return self._job is not None

    # ------------------------------------------------------------------ validated runs

    def run_validated(self, kind: str, req: dict) -> None:
        self.scan.validated_pending()
        self.last_stream_kind = None
        self.notify("scan", "panel")
        record = self._record_start(kind, req) if (not req.get("preview") and self.signed_in) else None
        fut = self.engine.run_validated(kind, req)
        needs_artifacts = (not req.get("preview")) and ftp_configured(self.stream_config)

        def done(f):
            try:
                result = f.result()
                snapshot = self.engine.svc.last_snapshot() if self.engine.svc.has_last() else None
                error = None
            except Exception as exc:  # noqa: BLE001
                result, snapshot, error = None, None, exc

            def ui():
                if error is not None:
                    from ..engine.engine import stream_error_message
                    aborted = self._closure_stop
                    self._closure_stop = False
                    self.scan.validated_rejected(stream_error_message(error), aborted=aborted)
                    self.active_scan_type = None
                    self.notify("scan", "panel")
                    return
                csv_name, png_name = scan_artifact_filenames(
                    kind, int((result or {}).get("resolution") or req.get("resolution") or 0),
                    int((result or {}).get("latency_bytes") or req.get("latency_bytes") or 0),
                    int((result or {}).get("vector_resolution") or req.get("vector_resolution") or 0))
                res = {**(result or {}), "csv_filename": csv_name, "image_filename": png_name}
                self.scan.validated_fulfilled(kind, res)
                self.last_scan_kind = kind
                self.active_scan_type = None
                self._record_finish(record, kind, req, res, int(res.get("chunks") or 0),
                                    snapshot if needs_artifacts else None,
                                    on_names=lambda c, i: self._set_validated_names(kind, c, i))
                self.render_server_figure(kind, snapshot)
                self.notify("scan", "panel", "frame-complete")
            self.engine.post(ui)
        fut.add_done_callback(done)

    def _set_validated_names(self, kind: str, csv_name, image_name) -> None:
        if self.scan.lastResult and csv_name and image_name:
            self.scan.lastResult = {**self.scan.lastResult, "csv_filename": csv_name, "image_filename": image_name}
            self.scan.lastOutput = {"kind": kind, "csv_filename": csv_name, "image_filename": image_name}
            self.notify("scan")

    def abort_validated(self) -> None:
        self._closure_stop = True
        self.engine.abort_validated()

    def render_server_figure(self, kind: str, snapshot: Optional[dict], render_mode: Optional[str] = None) -> None:
        """``/api/scan/last/figure?view=texture`` rendered by the artifact worker."""
        if not snapshot:
            return
        mode = render_mode or self.scan.vectorRenderMode
        fut = self.artifacts.render(snapshot, csv=False, png=True, render_mode=mode, view="texture")
        self.server_figure[kind] = "busy"
        self.notify("server-figure")

        def done(f):
            try:
                png = f.result()["png"]
                err = None
            except Exception as exc:  # noqa: BLE001
                png, err = None, str(exc)
            self.engine.post(lambda: self._server_figure_ready(kind, png, err))
        fut.add_done_callback(done)

    def _server_figure_ready(self, kind: str, png: Optional[bytes], err: Optional[str]) -> None:
        self.server_figure[kind] = png if png else ("error", err)
        self.notify("server-figure")

    # ------------------------------------------------------------------ recording (wsProxy / proxyScanRun semantics)

    def _record_start(self, kind: str, req: dict) -> RecordHandle:
        handle = RecordHandle()
        body = {"kind": kind, "start_xy": req.get("start_xy", 0), "end_xy": req.get("end_xy", 0),
                "dwell": req.get("dwell", 16), "scale_unit": req.get("scale_unit"), "ev": req.get("ev", 0),
                "scan_parameters": req}

        def call():
            data = self.backend.post_json("/api/admin/iobeam/operation/input-setup", body, "operation input setup")
            try:
                activity = int(data.get("activity_id"))
            except (TypeError, ValueError):
                return None
            return activity if activity > 0 else None

        def err(exc):
            log.warning("[operation-data] failed to record %s scan start: %s", kind, exc)
            handle.resolve(None)
        run_bg(call, on_ok=handle.resolve, on_err=err)
        return handle

    def _record_finish(self, handle: Optional[RecordHandle], kind: str, req: dict, scan_result: dict, chunks: int,
                       snapshot: Optional[dict], on_names: Optional[Callable] = None) -> None:
        if handle is None:
            return

        def go():
            activity = handle.activity_id
            if not activity:
                return
            if snapshot is not None:
                fut = self.artifacts.render(snapshot, csv=True, png=True,
                                            render_mode="decimated", view="figure")

                def rendered(f):
                    try:
                        art = f.result()
                        artifacts = {"csv_base64": base64.b64encode(art["csv"]).decode("ascii"),
                                     "image_base64": base64.b64encode(art["png"]).decode("ascii")}
                    except Exception as exc:  # noqa: BLE001
                        log.warning("[ftp-upload] artifact render failed: %s", exc)
                        artifacts = None
                    self.engine.post(lambda: post(artifacts))
                fut.add_done_callback(rendered)
            else:
                post(None)

        def post(artifacts):
            body = {"activity_id": handle.activity_id, "kind": kind, "chunks": chunks,
                    "resolution": req.get("resolution") or 0, "latency_bytes": req.get("latency_bytes") or 0,
                    "vector_resolution": req.get("vector_resolution") or 0, "scan_result": scan_result}
            if artifacts:
                body["artifacts"] = artifacts

            def call():
                return self.backend.post_json("/api/admin/iobeam/operation/output-data", body,
                                              "operation output data", timeout=60)

            def ok(data):
                if on_names and isinstance(data, dict):
                    on_names(data.get("csv_filename"), data.get("image_filename"))
            run_bg(call, on_ok=ok,
                   on_err=lambda e: log.warning("[operation-data] failed to record %s scan output: %s", kind, e))
        handle.when_ready(go)

    # ------------------------------------------------------------------ preferences

    def set_theme(self, name: str) -> None:
        theme.apply(name)
        self.p.set(THEME_KEY, theme.current_name())
        self.notify("theme")

    def set_locale(self, code: str) -> None:
        i18n.set_locale(code)
        self.p.set(LOCALE_KEY, i18n.locale())
        self.notify("locale")

    # ------------------------------------------------------------------ shutdown

    def shutdown(self) -> None:
        self._status_timer.stop()
        self._vacuum_timer.stop()
        self._frame_timer.stop()
