"""The WebSocket scan endpoint must stop its own scan when the client leaves,
and a busy rejection must say who holds the device."""
import asyncio
import time

from fastapi.testclient import TestClient

from glasgow_service import api
from glasgow_service.service import DeviceBusy


class _FakeService:
    def __init__(self):
        self.abort_owners = []
        self.closed = asyncio.Event()

    def abort_active_scan(self, owner=None):
        self.abort_owners.append(owner)
        return True

    def vector_scan(self, _req):
        svc = self

        async def gen():
            try:
                await asyncio.sleep(30)     # connection set-up: no frames sent
                yield b"\x00\x00"
            finally:
                svc.closed.set()
        return gen()


def test_client_disconnect_during_setup_stops_the_scan(monkeypatch):
    fake = _FakeService()
    monkeypatch.setattr(api, "svc", fake)
    monkeypatch.setattr(api, "VectorRequest", lambda **p: p)
    client = TestClient(api.app)   # no lifespan: the service is faked
    with client.websocket_connect("/scan/vector/stream") as ws:
        ws.send_json({})
        time.sleep(0.2)
    deadline = time.monotonic() + 5
    while not fake.abort_owners and time.monotonic() < deadline:
        time.sleep(0.05)
    assert len(fake.abort_owners) == 1
    assert fake.abort_owners[0] is not None


def test_busy_frame_carries_detail(monkeypatch):
    class Busy(_FakeService):
        def vector_scan(self, _req):
            async def gen():
                raise DeviceBusy("device busy: a vector scan (websocket) started 3.0 s ago is still running")
                yield b""
            return gen()

    monkeypatch.setattr(api, "svc", Busy())
    monkeypatch.setattr(api, "VectorRequest", lambda **p: p)
    client = TestClient(api.app)
    with client.websocket_connect("/scan/vector/stream") as ws:
        ws.send_json({})
        frame = ws.receive_json()
    assert frame["code"] == "busy"
    assert "started 3.0 s ago" in frame["detail"]


def test_gray_rule_ack_and_rejection_keep_the_websocket_scan_alive(monkeypatch):
    class GrayService(_FakeService):
        def __init__(self):
            super().__init__()
            self.updates = []

        def update_live_scan_geometry(self, kind, geometry, *, owner=None):
            if geometry["gray_rule"].get("target_gray_level") == 999:
                raise ValueError("invalid target")
            self.updates.append((kind, geometry, owner))

    fake = GrayService()
    monkeypatch.setattr(api, "svc", fake)
    monkeypatch.setattr(api, "VectorRequest", lambda **p: p)
    client = TestClient(api.app)
    with client.websocket_connect("/scan/vector/stream") as ws:
        ws.send_json({})
        rule = {"target_gray_level": 50, "gray_level_range": [0, 50], "gray_level_skipped": False}
        ws.send_json({"event": "update_geometry", "id": 1, "geometry": {"gray_rule": rule}})
        assert ws.receive_json() == {"event": "geometry_updated", "id": 1}
        ws.send_json({"event": "update_geometry", "id": 2, "geometry": {"gray_rule": {**rule, "target_gray_level": 999}}})
        assert ws.receive_json()["event"] == "geometry_update_error"
        ws.send_json({"event": "update_geometry", "id": 3, "geometry": {"gray_rule": {**rule, "target_gray_level": None}}})
        assert ws.receive_json() == {"event": "geometry_updated", "id": 3}
        assert len(fake.updates) == 2
        assert fake.updates[0][2] is fake.updates[1][2]
        assert not fake.abort_owners


def test_real_simulated_websocket_applies_target_and_clear_without_reconnect(monkeypatch):
    import json
    from pathlib import Path
    from glasgow_service.service import DeviceService
    config = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"
    service = DeviceService(str(config))
    service._hardware_free = lambda _req: True
    monkeypatch.setattr(api, "svc", service)
    client = TestClient(api.app)

    def receive_until_ack(ws, expected):
        for _ in range(40):
            message = ws.receive()
            if message.get("text"):
                event = json.loads(message["text"])
                assert event.get("event") != "error", event
                if event.get("event") == "geometry_updated":
                    assert event["id"] == expected
                    return
        raise AssertionError("gray-rule update was not acknowledged")

    with client.websocket_connect("/scan/vector/stream") as ws:
        ws.send_json({"vector_resolution": 128, "dwell": 2, "latency_bytes": 65536,
                      "continuous": True, "preview": False,
                      "simulation": {"enabled": True, "chunkIntervalMs": 5},
                      "simulation_bitmap": {"width": 2, "height": 2, "pixels": [120] * 4}})
        first = int.from_bytes(ws.receive_bytes()[:2], "big")
        command = service._active_command
        ws.send_json({"event": "update_geometry", "id": 1, "geometry": {"gray_rule": {
            "target_gray_level": 100, "gray_level_range": [0, 100], "gray_level_skipped": False}}})
        receive_until_ack(ws, 1)
        values = [int.from_bytes(ws.receive_bytes()[:2], "big") for _ in range(4)]
        assert min(values) < first
        ws.send_json({"event": "update_geometry", "id": 2, "geometry": {"gray_rule": {
            "target_gray_level": None, "gray_level_range": None, "gray_level_skipped": None}}})
        receive_until_ack(ws, 2)
        values = [int.from_bytes(ws.receive_bytes()[:2], "big") for _ in range(4)]
        assert values[-1] == values[-2]
        unfiltered = values[-1]
        ws.send_json({"event": "update_geometry", "id": 3, "geometry": {"gray_rule": {
            "target_gray_level": None, "gray_level_range": [0, 0], "gray_level_skipped": False}}})
        receive_until_ack(ws, 3)
        values = [int.from_bytes(ws.receive_bytes()[:2], "big") for _ in range(4)]
        assert values[-1] == 0, "confirmed Spot range applies on the same live socket"
        ws.send_json({"event": "update_geometry", "id": 4, "geometry": {"gray_rule": {
            "target_gray_level": None, "gray_level_range": None, "gray_level_skipped": None}}})
        receive_until_ack(ws, 4)
        values = [int.from_bytes(ws.receive_bytes()[:2], "big") for _ in range(4)]
        assert values[-1] == unfiltered, "turning off the range restores unfiltered samples"
        assert service._active_command is command and not command.abort.is_set()
