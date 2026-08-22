import asyncio
import unittest
from unittest import mock

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowStream


class _FakeLower:
    def __init__(self, read_result=None, delay=0):
        self._in_buffer = bytearray()
        self.read_result = read_result
        self.delay = delay

    async def read(self, _length):
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.read_result


class USBStreamTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_bulk_in_pipeline_has_no_submission_age_deadline(self):
        device = object.__new__(GlasgowDevice)
        device._do_transfer = mock.AsyncMock(return_value=b"scan-data")

        result = await device.bulk_read(0x86, 8192)

        self.assertEqual(result, b"scan-data")
        self.assertIsNone(device._do_transfer.await_args.kwargs["timeout_s"])

    async def test_stream_read_uses_a_renewable_inactivity_timeout(self):
        stream = GlasgowStream(_FakeLower(delay=0.05), None)

        with mock.patch(
            "GlasgowDataIO.IobeamControl.transfer.glasgowStream._transfer_timeout_s",
            return_value=0.001,
        ):
            with self.assertRaises(asyncio.TimeoutError):
                await stream.read(8192)

    async def test_stream_read_returns_active_scan_data(self):
        stream = GlasgowStream(_FakeLower(read_result=b"chunk"), None)

        with mock.patch(
            "GlasgowDataIO.IobeamControl.transfer.glasgowStream._transfer_timeout_s",
            return_value=0.1,
        ):
            self.assertEqual(await stream.read(8192), b"chunk")


if __name__ == "__main__":
    unittest.main()
