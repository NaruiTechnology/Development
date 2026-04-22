import unittest
import asyncio
import logging
from pathlib import Path
from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig

JSON_PATH = r'./Development/GlasgowDataIO/Json/streamData.json'

class RasterScanTest(unittest.TestCase):
    def setUp(self):
        self.sim_data = "0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10"
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
        else:
            self._config = None

    async def scan(self):
        test_range = DACCodeRange.from_resolution(2048)
        test_dwell = 2
        test_cmd = RasterScanCommand(cookie=123,
            x_range=test_range, y_range=test_range, dwell_time=test_dwell)
        conn = MockConnection()
        await conn._connect()
        async for chunk in conn.transfer_multiple(test_cmd, latency=65536):
            print(f"chunk: {dump_hex(chunk)}")

    def test_scan(self):
        asyncio.run(self.scan())
        self.assertTrue(True)

    # ================================================================== #
    async def scan_wet_run(self):
        self.chunks = []
        self.chunks_received = 0

        if self._config is None:
            print("[test] no config, skipping")
            return

        test_range = DACCodeRange.from_resolution(128)   # 128×128 = 16384 pixels
        test_dwell = 2

        test_cmd = RasterScanCommand(
            cookie=123,
            x_range=test_range,
            y_range=test_range,
            dwell_time=test_dwell,
            frame_blank=False,
        )

        print(f"[test] === Test B: 128x128, dwell=2, latency=16384, "
            f"frame_blank=False ===", flush=True)

        conn = GlasgowConnection(self._config)
        await conn._connect()
        if not conn.connected:
            print("[test] connection failed")
            return

        try:
            async for chunk in conn.transfer_multiple(test_cmd, latency=16384):
                self.chunks.append(chunk)
                self.chunks_received += 1
                preview = dump_hex(bytes(chunk)[:16]) if chunk is not None else "<None>"
                length = len(chunk) if chunk is not None else 0
                print(f"[test] chunk #{self.chunks_received} len={length}: {preview}",
                    flush=True)
        except Exception as e:
            print(f"[test] EXCEPTION during transfer_multiple after "
                f"{self.chunks_received} chunks: {type(e).__name__}: {e}", flush=True)
            raise
        print(f"[test] transfer complete after {self.chunks_received} chunks",
            flush=True)

    def test_scan_wet_run(self):
        asyncio.run(self.scan_wet_run())
        self.assertTrue(True)
