"""A failed launch must release the Glasgow USB interface.

GlasgowDevice() claims interface 0.  If the launch fails afterwards and the
device is not closed, the process keeps the claim and every later launch in
the same process fails with LIBUSB_ERROR_BUSY.
"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from GlasgowDataIO.IobeamControl.IobeamLauncher import IobeamLauncher

MODULE = "GlasgowDataIO.IobeamControl.IobeamLauncher"


class FakeDevice:
    instances = []

    def __init__(self, _serial=None):
        self.revision = "C3"
        self.close = Mock()
        self.download_target = AsyncMock(return_value=False)
        self._status = AsyncMock(return_value=0xff)
        FakeDevice.instances.append(self)


class FakeTarget:
    def __init__(self, **_kwargs):
        self.multiplexer = SimpleNamespace(pipe_count=1)

    def build_plan(self):
        return SimpleNamespace(bitstream_id=b"\x00" * 16, buildDir="/tmp")


class LauncherReleasesDeviceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeDevice.instances.clear()
        self.launcher = IobeamLauncher(SimpleNamespace(LogName="LauncherTest"))
        self.applet = SimpleNamespace(build=Mock(), mux_interface=0)
        self.args = SimpleNamespace(buffer_size=1024)

    async def launch(self, **device_overrides):
        def make(serial=None):
            device = FakeDevice(serial)
            for name, value in device_overrides.items():
                setattr(device, name, value)
            return device

        with patch(f"{MODULE}.GlasgowDevice", side_effect=make), \
             patch(f"{MODULE}.GlasgowHardwareTarget", FakeTarget), \
             patch(f"{MODULE}.DirectDemultiplexer") as demux, \
             patch(f"{MODULE}.asyncio.sleep", new_callable=AsyncMock):
            demux.return_value.claim_interface = AsyncMock(return_value="iface")
            return await self.launcher._launch_applet(self.applet, self.args)

    async def test_success_keeps_the_device_open(self):
        iface, programmed = await self.launch()
        self.assertEqual(iface, "iface")
        self.assertFalse(programmed)
        FakeDevice.instances[0].close.assert_not_called()

    async def test_failed_bitstream_download_releases_the_device(self):
        with self.assertRaisesRegex(OSError, "download failed"):
            await self.launch(download_target=AsyncMock(side_effect=OSError("download failed")))
        FakeDevice.instances[0].close.assert_called_once()

    async def test_fpga_not_ready_releases_the_device_once(self):
        with self.assertRaisesRegex(RuntimeError, "FPGA is not ready"):
            await self.launch(_status=AsyncMock(return_value=0))
        FakeDevice.instances[0].close.assert_called_once()

    async def test_failed_build_releases_the_device(self):
        self.applet.build.side_effect = ValueError("bad pins")
        with self.assertRaisesRegex(ValueError, "bad pins"):
            await self.launch()
        FakeDevice.instances[0].close.assert_called_once()

    async def test_cancellation_releases_the_device(self):
        import asyncio
        with self.assertRaises(asyncio.CancelledError):
            await self.launch(download_target=AsyncMock(side_effect=asyncio.CancelledError()))
        FakeDevice.instances[0].close.assert_called_once()

    async def test_a_close_error_does_not_hide_the_launch_error(self):
        def broken_close():
            raise OSError("close failed")
        with self.assertRaisesRegex(OSError, "download failed"):
            await self.launch(download_target=AsyncMock(side_effect=OSError("download failed")),
                              close=Mock(side_effect=broken_close))


if __name__ == "__main__":
    unittest.main()
