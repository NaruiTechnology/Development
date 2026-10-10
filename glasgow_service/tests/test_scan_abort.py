import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from glasgow_service.models import AdcTestRequest, DeviceState
from glasgow_service.service import DeviceService


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"


def test_abort_signals_active_command_without_closing_transport():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        await service._lock.acquire()
        try:
            command = SimpleNamespace(abort=asyncio.Event())
            service._activate_command(command)
            assert service.abort_active_scan() is True
            assert command.abort.is_set()
            assert service._conn is None
            service._deactivate_command(command)
        finally:
            service._lock.release()

    asyncio.run(scenario())


def test_abort_during_connection_is_applied_when_command_becomes_active():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        await service._lock.acquire()
        try:
            assert service.abort_active_scan() is True
            command = SimpleNamespace(abort=asyncio.Event())
            service._activate_command(command)
            assert command.abort.is_set()
            service._deactivate_command(command)
        finally:
            service._lock.release()

    asyncio.run(scenario())


def test_adc_stream_closes_scan_transport_and_releases_adc_connection():
    instances = []

    class FakeAdcConnection:
        def __init__(self, *_args, **_kwargs):
            self.closed = False
            instances.append(self)

        async def connect(self):
            pass

        async def chunks(self, *, stop=None):
            yield b"\x00\x01\x00\x02"

        async def close(self):
            self.closed = True

    class FakeScanConnection:
        def __init__(self):
            self.closed = False

        async def _hard_close(self):
            self.closed = True

    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        scan = FakeScanConnection()
        service._conn = scan
        with patch("glasgow_service.service.AdcConnection", FakeAdcConnection):
            chunks = [chunk async for chunk in service.adc_stream(AdcTestRequest())]
        assert chunks == [b"\x00\x01\x00\x02"]
        assert scan.closed
        assert service._conn is None
        assert service._adc_conn is None
        assert instances[0].closed

    asyncio.run(scenario())


def test_client_closing_adc_stream_is_clean_cancellation():
    instances = []

    class FakeAdcConnection:
        def __init__(self, *_args, **_kwargs):
            self.closed = False
            instances.append(self)

        async def connect(self):
            pass

        async def chunks(self, *, stop=None):
            yield b"\x00\x01\x00\x02"

        async def close(self):
            self.closed = True

    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        with patch("glasgow_service.service.AdcConnection", FakeAdcConnection):
            stream = service.adc_stream(AdcTestRequest())
            assert await anext(stream) == b"\x00\x01\x00\x02"
            await stream.aclose()

        assert instances[0].closed
        assert service._status.state is DeviceState.IDLE
        assert service._status.last_error is None
        assert service._status.scans_completed == 0
        assert service._status.chunks_in_flight == 0

    asyncio.run(scenario())
