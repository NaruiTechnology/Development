import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.build_plan import GlasgowBuildPlan


class BuildPlanToolchainEnvironmentTestCase(unittest.TestCase):
    def test_selected_toolchain_overrides_bare_build_plan_commands(self):
        inner = SimpleNamespace(
            files={
                "build": "#!/bin/sh\nprintf '%s' \"$NEXTPNR_ICE40\" > top.bin\n",
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
