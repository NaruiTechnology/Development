"""The scan service must release the Glasgow USB interface after an error.

A connection dropped after a USB error used to be forgotten without being
closed, so the process kept interface 0 claimed and every later scan failed
with LIBUSB_ERROR_BUSY until the service was restarted.
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from glasgow_service.models import DeviceState, ServiceStatus
from glasgow_service.service import DeviceNotReady, DeviceService


class USBErrorBusy(Exception):
    """Named like python-libusb1's exception, which the service matches by name."""


class GlasgowDeviceError(Exception):
    pass


class FakeConnection:
    """Tracks which USB claims are open in this process."""

    claimed = 0
    created = []

    def __init__(self, _config):
        self.connected = False
        self.closed = False
        FakeConnection.created.append(self)

    async def _connect(self):
        if FakeConnection.claimed:
            raise USBErrorBusy("LIBUSB_ERROR_BUSY [-6]")
        FakeConnection.claimed += 1
        self.connected = True

    async def _hard_close(self):
        if self.connected and not self.closed:
            FakeConnection.claimed -= 1
        self.closed = True
        self.connected = False


@pytest.fixture(autouse=True)
def reset_fake():
    FakeConnection.claimed = 0
    FakeConnection.created = []


def make_service():
    svc = object.__new__(DeviceService)
    svc._lock = asyncio.Lock()
    svc._status = ServiceStatus(state=DeviceState.IDLE)
    svc._conn = None
    svc._config = SimpleNamespace()
    svc._claim_device = lambda: None
    return svc


def test_usb_error_then_next_scan_reconnects_instead_of_busy():
    async def run():
        svc = make_service()
        with patch("glasgow_service.service.GlasgowConnection", FakeConnection):
            first = await svc._ensure_conn()
            # A scan fails with a USB error: the connection is dropped.
            svc._drop_conn_on_error(GlasgowDeviceError("device disconnected"))
            assert svc._conn is None and first.closed is False
            # The next scan must release the old claim before opening a new one.
            second = await svc._ensure_conn()
            assert first.closed is True
            assert second.connected is True
            assert FakeConnection.claimed == 1

    asyncio.run(run())


def test_non_usb_errors_keep_the_connection():
    async def run():
        svc = make_service()
        with patch("glasgow_service.service.GlasgowConnection", FakeConnection):
            conn = await svc._ensure_conn()
            svc._drop_conn_on_error(ValueError("bad request"))
            assert svc._conn is conn
            assert await svc._ensure_conn() is conn
            assert len(FakeConnection.created) == 1

    asyncio.run(run())


def test_failed_connect_is_closed():
    async def run():
        svc = make_service()

        class HalfOpen(FakeConnection):
            async def _connect(self):
                await super()._connect()
                raise GlasgowDeviceError("device disconnected")

        with patch("glasgow_service.service.GlasgowConnection", HalfOpen):
            with pytest.raises(DeviceNotReady):
                await svc._ensure_conn()
        assert FakeConnection.created[0].closed is True
        assert FakeConnection.claimed == 0
        with patch("glasgow_service.service.GlasgowConnection", FakeConnection):
            assert (await svc._ensure_conn()).connected is True

    asyncio.run(run())


def test_reconnect_and_stop_release_a_stale_connection():
    async def run():
        svc = make_service()
        svc._adc_conn = None

        class Lock:
            def release(self):
                pass

        svc.__dict__["_device_lock_obj"] = Lock()
        with patch("glasgow_service.service.GlasgowConnection", FakeConnection):
            conn = await svc._ensure_conn()
            svc._drop_conn_on_error(GlasgowDeviceError("device disconnected"))
            await svc.reconnect()
            assert conn.closed is True and FakeConnection.claimed == 0

            conn = await svc._ensure_conn()
            svc._drop_conn_on_error(GlasgowDeviceError("device disconnected"))
            await svc.stop()
            assert conn.closed is True and FakeConnection.claimed == 0

    asyncio.run(run())


def test_old_behaviour_would_have_been_busy():
    """Guard the fake itself: a second claim without closing is BUSY."""
    async def run():
        first = FakeConnection(None)
        await first._connect()
        with pytest.raises(USBErrorBusy):
            await FakeConnection(None)._connect()

    asyncio.run(run())
