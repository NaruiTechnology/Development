"""Webhook alerts for unattended operation."""
import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from glasgow_service.vacuum import LATCH_DEVICE_ERROR, VacuumController
from glasgow_service.vacuum_alerts import VacuumAlerts, alerts_from_environment

from .test_vacuum import make_config
from .test_vacuum_availability import (
    healthy_polls,
    inject_one_read_error,
    pump_down,
)


class Recorder:
    def __init__(self):
        self.payloads = []

    def __call__(self, payload):
        self.payloads.append(payload)

    def events(self):
        return [(p["event"], p["severity"]) for p in self.payloads]


def recording_alerts(**kwargs):
    recorder = Recorder()
    return VacuumAlerts(sender=recorder, synchronous=True, **kwargs), recorder


async def controller_with(alerts):
    controller = VacuumController(make_config(simulate=True), alerts=alerts)
    await controller.start()
    controller._task.cancel()
    try:
        await controller._task
    except asyncio.CancelledError:
        pass
    controller._task = None
    return controller


def test_alerts_are_disabled_without_a_webhook(monkeypatch):
    monkeypatch.delenv("SBC_VACUUM_ALERT_WEBHOOK", raising=False)
    alerts = alerts_from_environment()
    assert alerts.enabled is False
    alerts.emit("cascade_stopped", "critical", "nothing is sent")
    assert alerts._thread is None


def test_alert_settings_are_validated(monkeypatch):
    monkeypatch.setenv("SBC_VACUUM_ALERT_WEBHOOK", "https://hooks.example/abc")
    monkeypatch.setenv("SBC_VACUUM_ALERT_REMIND_SECONDS", "600")
    alerts = alerts_from_environment()
    assert alerts.enabled and alerts.remind_seconds == 600
    monkeypatch.setenv("SBC_VACUUM_ALERT_REMIND_SECONDS", "soon")
    with pytest.raises(ValueError, match="REMIND"):
        alerts_from_environment()
    monkeypatch.setenv("SBC_VACUUM_ALERT_REMIND_SECONDS", "-5")
    with pytest.raises(ValueError, match="REMIND"):
        alerts_from_environment()


def test_a_failing_webhook_never_raises():
    def broken(_payload):
        raise OSError("webhook unreachable")

    alerts = VacuumAlerts(sender=broken, synchronous=True)
    alerts.emit("cascade_stopped", "critical", "still fine")   # no exception


def test_transient_error_alerts_and_auto_resume_reports_recovery():
    async def scenario():
        alerts, recorder = recording_alerts()
        controller = await controller_with(alerts)
        try:
            await pump_down(controller)
            recorder.payloads.clear()
            inject_one_read_error(controller)
            await controller.poll_once()
            assert ("device_error", "critical") in recorder.events()
            assert ("cascade_stopped", "critical") in recorder.events()
            stopped = next(p for p in recorder.payloads if p["event"] == "cascade_stopped")
            assert stopped["cascade_latch"] == LATCH_DEVICE_ERROR
            assert "CRITICAL" in stopped["text"] and stopped["device_id"]

            await healthy_polls(controller, controller.AUTO_RESUME_HEALTHY_POLLS)
            assert recorder.events()[-1] == ("cascade_resumed", "info")
            assert "auto-resume" in recorder.payloads[-1]["message"]
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_operator_stop_warns_and_reminds_until_resumed():
    async def scenario():
        alerts, recorder = recording_alerts(remind_seconds=60)
        controller = await controller_with(alerts)
        try:
            await pump_down(controller)
            recorder.payloads.clear()
            await controller.stop_non_mechanical()
            assert recorder.events() == [("cascade_stopped", "warning")]

            controller._remind_if_still_latched()          # too early
            assert len(recorder.payloads) == 1
            controller._latch_since -= 61
            controller._remind_if_still_latched()
            assert recorder.events()[-1] == ("cascade_still_stopped", "warning")
            controller._remind_if_still_latched()          # not again at once
            assert len(recorder.payloads) == 2

            await controller.resume_cascade()
            assert recorder.events()[-1] == ("cascade_resumed", "info")
            controller._remind_if_still_latched()
            assert len(recorder.payloads) == 3
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_controller_stop_is_a_critical_alert():
    async def scenario():
        alerts, recorder = recording_alerts()
        controller = await controller_with(alerts)
        assert recorder.events()[-1] == ("controller_started", "info")
        await controller.close()
        assert recorder.events()[-1] == ("controller_stopped", "critical")

    asyncio.run(scenario())


def test_board_alarms_are_reported():
    from glasgow_service.emulation.rig import VacuumRig

    from .test_vacuum_io_board import board_config, jumper_gauges, poll

    async def scenario():
        alerts, recorder = recording_alerts()
        rig = VacuumRig(tool_connected=False)
        controller = VacuumController(
            board_config(Gauges=jumper_gauges()), emulator=rig, alerts=alerts)
        for di in range(1, 9):
            rig.jumper(di)
        await controller.start()
        try:
            await poll(controller, rig, count=4)
            rig.set_estop(True)
            rig.advance(0.05)
            await poll(controller, rig, count=2)
            events = recorder.events()
            assert ("alarm_raised", "critical") in events
            assert ("cascade_stopped", "critical") in events
            rig.set_estop(False)
            rig.advance(0.05)
            await poll(controller, rig, count=2)
            assert ("alarm_cleared", "info") in recorder.events()
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_webhook_receives_json_with_bearer_token():
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers["Content-Length"])
            received.append((self.headers.get("Authorization"),
                             json.loads(self.rfile.read(length))))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        alerts = VacuumAlerts(
            f"http://127.0.0.1:{server.server_address[1]}/hook", token="s3cret")
        alerts.emit("cascade_stopped", "critical", "cascade stopped (device_error)",
                    device_id="sbc-a")
        alerts.close(timeout=5)
        assert len(received) == 1
        auth, body = received[0]
        assert auth == "Bearer s3cret"
        assert body["event"] == "cascade_stopped" and body["severity"] == "critical"
        assert body["text"].startswith("[sbc-vacuum sbc-a @ ")
    finally:
        server.shutdown()
