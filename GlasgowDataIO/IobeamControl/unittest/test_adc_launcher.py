import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from GlasgowDataIO.IobeamControl.AdcLauncher import AdcLauncher


class AdcLauncherTest(unittest.IsolatedAsyncioTestCase):
    async def launch(self, status):
        config = SimpleNamespace(LogName='AdcLauncherTest', Glasgow={})
        launcher = AdcLauncher(config)
        events = []
        async def write(addr, value):
            events.append(('write', addr, value))
        device = SimpleNamespace(write_register=AsyncMock(side_effect=write),
                                 read_register=AsyncMock(return_value=status), close=Mock())
        iface = SimpleNamespace(device=device, cancel=AsyncMock())
        applet = SimpleNamespace(addr_capture_enable=1, addr_capture_status=2)
        async def activate(*args, prepare, **kwargs):
            await prepare(device)
            events.append(('activated',))
            return iface, True
        self.iface = iface
        self.events = events
        with patch('GlasgowDataIO.IobeamControl.AdcLauncher.util.GetStateConfigByName',
                   return_value={'actionData': {}}), \
             patch('GlasgowDataIO.IobeamControl.AdcLauncher.AdcDataStreamApplet', return_value=applet), \
             patch.object(launcher, '_launch_applet', side_effect=activate), \
             patch('GlasgowDataIO.IobeamControl.AdcLauncher.asyncio.sleep', new_callable=AsyncMock):
            return await launcher.start()

    async def test_arm_after_activation_and_verify_running(self):
        self.assertIs(await self.launch(0x1d), self.iface)
        self.assertEqual(self.events, [('write', 1, 0), ('activated',), ('write', 1, 1)])
        self.iface.device.read_register.assert_awaited_once_with(2)

    async def test_failed_start_disables_and_releases_device(self):
        with self.assertRaisesRegex(RuntimeError, 'did not start'):
            await self.launch(0)
        self.assertEqual(self.events[-1], ('write', 1, 0))
        self.iface.cancel.assert_awaited_once()
        self.iface.device.close.assert_called_once()

    async def test_very_short_capture_may_already_be_complete(self):
        self.assertIs(await self.launch(0x1e), self.iface)
