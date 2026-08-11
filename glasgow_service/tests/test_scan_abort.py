import asyncio
from pathlib import Path
from types import SimpleNamespace

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
