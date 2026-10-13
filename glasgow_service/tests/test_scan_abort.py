import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from glasgow_service.models import AdcTestRequest, DeviceState
from glasgow_service.service import DeviceBusy, DeviceService


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


def test_busy_reports_which_scan_holds_the_device():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        async with service._acquire("vector", transport="websocket"):
            try:
                async with service._acquire("vector", transport="websocket"):
                    raise AssertionError("overlapping scan must not start")
            except DeviceBusy as exc:
                detail = str(exc)
            assert "vector scan (websocket)" in detail
            assert "still running" in detail
            assert "Stop was requested" not in detail

    asyncio.run(scenario())


def test_new_scan_waits_for_a_stopped_scan_to_release_the_device():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        order = []
        release_first = asyncio.Event()

        async def first():
            async with service._acquire("vector", transport="websocket"):
                order.append("first-start")
                await release_first.wait()
            order.append("first-end")

        async def second():
            async with service._acquire("vector", transport="websocket"):
                order.append("second-start")

        first_task = asyncio.create_task(first())
        await asyncio.sleep(0)
        assert service.abort_active_scan() is True
        second_task = asyncio.create_task(second())
        await asyncio.sleep(0.05)
        assert order == ["first-start"]          # waiting, not rejected
        release_first.set()
        await asyncio.wait_for(asyncio.gather(first_task, second_task), 5)
        assert order == ["first-start", "first-end", "second-start"]

    asyncio.run(scenario())


def test_new_scan_is_still_rejected_while_an_unstopped_scan_runs():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        async with service._acquire("vector"):
            try:
                async with service._acquire("vector"):
                    raise AssertionError("overlapping scan must not start")
            except DeviceBusy:
                pass
            else:
                raise AssertionError("expected DeviceBusy")

    asyncio.run(scenario())


def test_abort_with_owner_only_stops_that_owners_scan():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        async with service._acquire("vector"):
            stranger = asyncio.create_task(asyncio.sleep(0))
            assert service.abort_active_scan(owner=stranger) is False
            assert service._scan_aborted is False
            assert service.abort_active_scan(owner=asyncio.current_task()) is True
            await stranger

    asyncio.run(scenario())


def test_stopped_scan_is_logged_as_cancelled():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        with patch("glasgow_service.service.logger") as log:
            async with service._acquire("vector", transport="websocket"):
                service.abort_active_scan()
        end = [c for c in log.info.call_args_list
               if c.args and str(c.args[0]).startswith("scan end")]
        assert end, "scan end must be logged"
        args = end[-1].args
        assert args[2] is True        # ok
        assert args[3] is True        # cancelled
        assert service._scan_aborted is False
        assert service._active_scan is None

    asyncio.run(scenario())
