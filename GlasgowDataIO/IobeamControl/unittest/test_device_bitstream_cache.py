import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import (
    GlasgowDevice, GlasgowDeviceError, ST_FPGA_RDY, REQ_FPGA_CFG, REQ_REGISTER,
)
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.build_plan import GlasgowBuildPlan


class BuildPlanToolchainEnvironmentTestCase(unittest.TestCase):
    def test_selected_toolchain_overrides_bare_build_plan_commands(self):
        inner = SimpleNamespace(
            files={
                "build": "#!/bin/sh\nprintf '%s' \"$NEXTPNR_ICE40\" > top.bin\n",
                "build.bat": '@echo off\n>top.bin <nul set /p "=%NEXTPNR_ICE40%"\nexit /b 0\n',
            },
            script="build",
            env_vars={"NEXTPNR_ICE40": "nextpnr-ice40"},
        )
        toolchain = SimpleNamespace(
            identifier=b"packaged-toolchain",
            env_vars={"NEXTPNR_ICE40": "/packaged/bin/yowasp-nextpnr-ice40"},
        )
        plan = GlasgowBuildPlan(inner, toolchain)
        with tempfile.TemporaryDirectory() as directory:
            bitstream, _output = plan.execute(Path(directory), debug=True)
        self.assertEqual(bitstream, b"/packaged/bin/yowasp-nextpnr-ice40")


class DownloadTargetCacheTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_windows_configuration_uses_checked_synchronous_write(self):
        device = object.__new__(GlasgowDevice)
        device.usb_handle = SimpleNamespace(controlWrite=Mock(return_value=5))
        device._do_transfer = AsyncMock()
        with patch("sys.platform", "win32"):
            await device.control_write(0x40, REQ_FPGA_CFG, 0, 2, b"image")
        device.usb_handle.controlWrite.assert_called_once_with(
            0x40, REQ_FPGA_CFG, 0, 2, b"image", timeout=10000)
        device._do_transfer.assert_not_awaited()

    async def test_windows_configuration_rejects_short_write(self):
        device = object.__new__(GlasgowDevice)
        device.usb_handle = SimpleNamespace(controlWrite=Mock(return_value=4))
        with patch("sys.platform", "win32"):
            with self.assertRaisesRegex(GlasgowDeviceError, "expected=5, transferred=4"):
                await device.control_write(0x40, REQ_FPGA_CFG, 0, 2, b"image")

    async def test_other_control_writes_keep_async_transport(self):
        device = object.__new__(GlasgowDevice)
        device._do_transfer = AsyncMock()
        with patch("sys.platform", "win32"):
            await device.control_write(0x40, REQ_REGISTER, 0, 0, b"\x00")
        device._do_transfer.assert_awaited_once()

    async def test_configuration_is_finalized_before_waiting_for_ready(self):
        device = object.__new__(GlasgowDevice)
        events = []

        async def write(*args):
            events.append("write")

        async def sleep(delay):
            events.append("sleep")

        device.control_write = AsyncMock(side_effect=write)
        device.control_read = AsyncMock(return_value=b"\xa5")
        device._status = AsyncMock(return_value=ST_FPGA_RDY)
        with patch("asyncio.sleep", side_effect=sleep):
            await device.download_bitstream(b"image")
        self.assertEqual(events, ["write", "write", "sleep"])

    async def test_download_waits_for_delayed_ready_before_handshake(self):
        device = object.__new__(GlasgowDevice)
        device.control_write = AsyncMock()
        device.control_read = AsyncMock(return_value=b"\xa5")
        device._status = AsyncMock(side_effect=[0, 0, ST_FPGA_RDY])
        with patch("asyncio.sleep", new_callable=AsyncMock):
            await device.download_bitstream(b"image")
        self.assertEqual(device._status.await_count, 3)
        device.control_read.assert_awaited_once()

    async def test_download_reports_last_status_when_ready_never_arrives(self):
        device = object.__new__(GlasgowDevice)
        device.control_write = AsyncMock()
        device.control_read = AsyncMock()
        device._status = AsyncMock(return_value=0)
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaisesRegex(GlasgowDeviceError, "last status=0x00") as caught:
                await device.download_bitstream(b"image")
        self.assertEqual(device._status.await_count, 50)
        self.assertIsInstance(caught.exception.__cause__, GlasgowDeviceError)
        device.control_read.assert_not_awaited()

    async def test_matching_image_is_reused_without_build_or_download(self):
        image_id = bytes.fromhex("00112233445566778899aabbccddeeff")
        device = object.__new__(GlasgowDevice)
        device.bitstream_id = AsyncMock(return_value=image_id)
        device.download_bitstream = AsyncMock()
        plan = SimpleNamespace(
            bitstream_id=image_id,
            get_bitstream=AsyncMock(return_value=b"bitstream"),
        )

        programmed = await device.download_target(plan)

        self.assertFalse(programmed)
        plan.get_bitstream.assert_not_awaited()
        device.download_bitstream.assert_not_awaited()

    async def test_changed_image_is_built_and_downloaded(self):
        image_id = bytes.fromhex("00112233445566778899aabbccddeeff")
        bitstream = b"bitstream"
        device = object.__new__(GlasgowDevice)
        device.bitstream_id = AsyncMock(side_effect=[b"different-image", image_id])
        device.download_bitstream = AsyncMock()
        plan = SimpleNamespace(
            bitstream_id=image_id,
            get_bitstream=AsyncMock(return_value=bitstream),
        )

        programmed = await device.download_target(plan)

        self.assertTrue(programmed)
        plan.get_bitstream.assert_awaited_once_with()
        device.download_bitstream.assert_awaited_once_with(bitstream, image_id)

    async def test_adc_scan_switches_replace_image_before_verification(self):
        running = bytes(16)
        device = object.__new__(GlasgowDevice)
        events = []

        async def read_id():
            events.append(("read", running))
            return running

        async def download(bitstream, image_id):
            nonlocal running
            events.append(("download", image_id))
            running = image_id

        device.bitstream_id = read_id
        device.download_bitstream = download
        adc_id, scan_id = b"a" * 16, b"s" * 16
        for image_id in (adc_id, scan_id, adc_id, adc_id):
            previous = running
            events.clear()
            plan = SimpleNamespace(bitstream_id=image_id,
                                   get_bitstream=AsyncMock(return_value=b"image"))
            self.assertTrue(await device.download_target(plan, reload=True))
            self.assertEqual(events, [("read", previous), ("download", image_id),
                                      ("read", image_id)])

    async def test_programmed_image_id_must_match_plan(self):
        image_id = bytes.fromhex("00112233445566778899aabbccddeeff")
        device = object.__new__(GlasgowDevice)
        device.bitstream_id = AsyncMock(
            side_effect=[b"different-image", b"unexpected-image"])
        device.download_bitstream = AsyncMock()
        plan = SimpleNamespace(
            bitstream_id=image_id,
            get_bitstream=AsyncMock(return_value=b"bitstream"),
        )

        with self.assertRaisesRegex(Exception, "bitstream verification failed"):
            await device.download_target(plan)


if __name__ == "__main__":
    unittest.main()
