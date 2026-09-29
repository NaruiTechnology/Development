import unittest
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from GlasgowDataIO.IobeamControl.transfer.adcStream import AdcConnection, _aligned_sentinel


class AdcConnectionAsyncTest(unittest.IsolatedAsyncioTestCase):
    def connection(self, **kwargs):
        conn = AdcConnection(SimpleNamespace(LogName='AdcConnectionTest'), **kwargs)
        conn.iface = SimpleNamespace(
            read=AsyncMock(), cancel=AsyncMock(),
            device=SimpleNamespace(write_register=AsyncMock(),
                                   read_register=AsyncMock(return_value=0x1d), close=Mock()),
            adc_capture_enable_addr=1, adc_capture_status_addr=2)
        conn._started = time.monotonic()
        return conn

    async def test_short_usb_packets_and_split_end_marker(self):
        conn = self.connection(chunk_bytes=4)
        conn.iface.read.side_effect = [b'\x00', b'\x01\x12\x34\x00\x02\xff', b'\xff']
        chunks = [chunk async for chunk in conn.chunks()]
        self.assertEqual(b''.join(chunks), b'\x00\x01\x12\x34\x00\x02')
        self.assertTrue(all(len(chunk) <= 4 and len(chunk) % 2 == 0 for chunk in chunks))
        self.assertEqual(conn._bytes, 6)
        conn.iface.read.assert_called_with()

    async def test_stop_interrupts_pending_read_without_waiting_for_usb_timeout(self):
        conn = self.connection()
        reading = asyncio.Event()
        cancelled = asyncio.Event()
        async def blocked_read():
            reading.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        conn.iface.read.side_effect = blocked_read
        stop = asyncio.Event()
        async def consume():
            return [chunk async for chunk in conn.chunks(stop=stop)]
        task = asyncio.create_task(consume())
        await reading.wait()
        stop.set()
        self.assertEqual(await asyncio.wait_for(task, 1), [])
        self.assertTrue(cancelled.is_set())

    async def test_read_error_survives_cleanup_error_and_device_is_closed(self):
        conn = self.connection()
        iface = conn.iface
        iface.read.side_effect = RuntimeError('original read failure')
        iface.cancel.side_effect = TimeoutError('old background transfer')
        with self.assertRaisesRegex(RuntimeError, 'original read failure'):
            try:
                async for _ in conn.chunks():
                    pass
            finally:
                await conn.close()
        iface.device.write_register.assert_awaited_once_with(1, 0)
        iface.device.close.assert_called_once()
        self.assertIsNone(conn.iface)

    async def test_real_timeout_is_reported_with_fpga_status(self):
        conn = self.connection()
        conn.iface.read.side_effect = TimeoutError('USB stalled')
        with self.assertLogs('AdcConnectionTest', level='INFO') as logs:
            with self.assertRaises(TimeoutError):
                async for _ in conn.chunks():
                    pass
        self.assertTrue(any('ADC FPGA read-error' in line for line in logs.output))


class AdcConnectionTest(unittest.TestCase):
    def test_finds_only_uint16_aligned_sentinel(self):
        self.assertEqual(_aligned_sentinel(b"\x00\x01\xff\xff\x00\x02"), 2)
        self.assertIsNone(_aligned_sentinel(b"\x00\xff\xff\x02"))
        self.assertEqual(_aligned_sentinel(b"\xff\xff"), 0)


if __name__ == "__main__":
    unittest.main()
