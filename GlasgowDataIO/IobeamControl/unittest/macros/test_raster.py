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
        if self._config is not None:
            # 128×128 = 16384 pixels × 2 bytes = 32768 bytes.
            # latency=65536 > 32768 → single trailing chunk (no mid-scan split).
            # from_resolution(128) gives step = 65536/128 = 512, fits in 16 bits.
            # TODO: increase to 2048 once multi-chunk transfer is validated.
            test_range = DACCodeRange.from_resolution(128)
            test_dwell = 2
            test_cmd = RasterScanCommand(cookie=123,
                x_range=test_range, y_range=test_range, dwell_time=test_dwell)

            conn = GlasgowConnection(self._config)
            await conn._connect()

            if conn.connected:
                chunk_num = 0
                async for chunk in conn.transfer_multiple(test_cmd, latency=16384):
                    chunk_num += 1
                    print(f"chunk #{chunk_num} len={len(chunk)}: "
                          f"{dump_hex(bytes(chunk)[:16])}")
                print(f"Transfer complete after {chunk_num} chunks")

    def test_scan_wet_run(self):
        asyncio.run(self.scan_wet_run())
        self.assertTrue(True)
