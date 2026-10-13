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
