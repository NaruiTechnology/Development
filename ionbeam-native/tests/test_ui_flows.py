"""End-to-end UI flows: full main window + controller + engine against the
Glasgow emulator and a mock control-plane backend (offscreen Qt)."""
import os
import sys

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PyQt6.QtWidgets")

from ui_harness import Harness  # noqa: E402

RUNNING = ("running", "stopping")


@pytest.fixture(scope="module")
def h(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("ui")
    old_cwd = os.getcwd()
    os.chdir(tmp)
    errors = []
    old_hook = sys.excepthook
    sys.excepthook = lambda *exc: errors.append(exc)
    harness = Harness(tmp)
    harness.errors = errors
    yield harness
    harness.close()
    sys.excepthook = old_hook
    os.chdir(old_cwd)


@pytest.fixture(autouse=True)
def no_slot_exceptions(h):
    h.errors.clear()
    yield
    assert not h.errors, "exception in a Qt slot: %r" % (h.errors[0],)


def _run_and_wait(h, button, timeout=60):
    ctl = h.ctl
    button.click()
    h.wait(lambda: ctl._job is not None or ctl.scan.phase in RUNNING, 15, "scan start")
    h.wait(lambda: ctl._job is None and ctl.scan.phase not in RUNNING, timeout, "scan end")
    h.pump(0.3)


def test_signed_in_and_panel_enabled(h):
    assert h.ctl.signed_in
    assert not h.ctl.panel_disabled
    assert h.ctl.equipment and h.ctl.selected_equipment_id == 1


def test_raster_preview_is_not_recorded(h):
    w = h.win
    w._activate_scan_sub("raster")
    w.scan_controls.preview.setChecked(True)
    before = len(h.backend_mock.requests)
    _run_and_wait(h, w.scan_controls.run_btn)
    assert h.ctl.scan.phase == "completed"
    posts = [r["path"] for r in h.backend_mock.requests[before:] if r["method"] == "POST"]
    assert "/api/admin/iobeam/operation/input-setup" not in posts
    assert h.engine.status()["session"]["connects"] == 1


def test_raster_recorded_with_artifacts(h):
    w = h.win
    w._activate_scan_sub("raster")
    w.scan_controls.preview.setChecked(False)
    _run_and_wait(h, w.scan_controls.run_btn)
    h.wait(lambda: any(r["path"].endswith("/output-data") for r in h.backend_mock.requests), 30, "output-data")
    setup = [r for r in h.backend_mock.requests if r["path"].endswith("/input-setup")][-1]["body"]
    out = [r for r in h.backend_mock.requests if r["path"].endswith("/output-data")][-1]["body"]
    assert setup["kind"] == "raster" and "scan_parameters" in setup
    assert out["kind"] == "raster" and out["activity_id"] >= 1 and out["chunks"] > 0
    assert "artifacts" not in out or set(out["artifacts"]) == {"csv_base64", "image_base64"}
    w.scan_controls.preview.setChecked(True)


def test_vector_scan_reuses_session(h):
    w = h.win
    w._activate_scan_sub("vector")
    connects = h.engine.status()["session"]["connects"]
    _run_and_wait(h, w.scan_controls.run_btn)
    assert h.ctl.scan.phase == "completed"
    assert h.engine.status()["session"]["connects"] == connects


def test_infinite_then_stop(h):
    w, ctl = h.win, h.ctl
    w._activate_scan_sub("raster")
    w.scan_controls.infinite_btn.click()
    h.wait(lambda: ctl._job is not None, 15, "live start")
    h.pump(2.0)
    w.scan_controls.stop_btn.click()
    h.wait(lambda: ctl._job is None and ctl.scan.phase not in RUNNING, 30, "live stop")
    assert ctl.scan.phase in ("idle", "completed")
    assert h.engine.status()["session"]["hard_closes"] == 0


def test_run_validated(h):
    w, ctl = h.win, h.ctl
    w._activate_scan_sub("raster")
    w.scan_controls.validated_btn.click()
    h.wait(lambda: ctl.scan.phase not in RUNNING and ctl.scan.lastResult, 60, "validated result")
    assert ctl.scan.lastResult.get("csv_filename", "").startswith("raster_")


def test_roi_load_last_scan_and_calibration_tabs(h):
    w = h.win
    w._activate_scan_sub("roi")
    h.pump(0.3)
    w._activate_cal_sub("dimension")
    h.pump(0.3)
    w._activate_cal_sub("mag")
    h.pump(0.3)
    assert w.right_stack.currentWidget() is w.mag_chart


def test_adc_simulation(h):
    w, ctl = h.win, h.ctl
    w._activate_top("adcTest")
    h.pump(0.2)
    w.adc_controls._sim_toggled(True)
    w.adc_controls.run_btn.click()
    h.wait(lambda: w.adc_controls.st.phase == "running", 15, "adc running")
    h.pump(1.0)
    w.adc_controls.stop()
    h.wait(lambda: not ctl.adc_active, 15, "adc stop")
    assert w.adc_controls.st.error is None
    w._activate_top("scan")


def test_report_page_and_back(h):
    w = h.win
    w.header.open_report.emit()
    h.pump(0.8)
    assert w.route == "report"
    w._navigate("control")
    h.pump(0.2)
    assert w.route == "control"


def test_release_device_hands_over_then_rescan_reopens(h):
    from glasgow_service.device_lock import DeviceLock

    w, ctl = h.win, h.ctl
    ctl.refresh_status()
    assert ctl.session_open
    assert w.header.act_release.isEnabled()
    w.header.act_release.trigger()
    h.wait(lambda: not ctl.reconnecting, 15, "release")
    assert not ctl.session_open and not h.engine.status()["device_lock_held"]
    other = DeviceLock("web glasgow_service")          # the web stack can take it now
    other.acquire()
    other.release()
    connects = h.engine.status()["session"]["connects"]
    w._activate_scan_sub("raster")
    _run_and_wait(h, w.scan_controls.run_btn)
    assert ctl.scan.phase == "completed"
    assert h.engine.status()["session"]["connects"] == connects + 1


def test_theme_and_locale_switch(h):
    ctl = h.ctl
    for theme_name, loc in (("light", "zh-CN"), ("black", "zh-TW"), ("navy", "en")):
        ctl.set_theme(theme_name)
        ctl.set_locale(loc)
        h.pump(0.2)
    assert h.win.top_btns["scan"].text() == "Scan"
