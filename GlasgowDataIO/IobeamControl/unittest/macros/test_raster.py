import unittest
import asyncio
from pathlib import Path

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig

JSON_PATH = r'./Development/GlasgowDataIO/Json/streamData.json'

# Size of each pixel chunk in bytes (latency parameter to transfer_multiple).
# 8192 pixels * 2 bytes = 16384 bytes per chunk at SixteenBit output.
CHUNK_BYTES = 16384


class RasterScanTest(unittest.TestCase):

    # Change this single value to bisect the working-resolution ceiling.
    # 128 / 512 / 1024 / 2048 are all valid values of DACCodeRange.from_resolution.
    RESOLUTION = 512

    def setUp(self):
        self.sim_data = ("0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10, "
                         "0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10")
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
        else:
            self._config = None

    # ------------------------------------------------------------------ #
    # Mock / simulation test (no hardware).                              #
    # ------------------------------------------------------------------ #
    async def scan(self):
        test_range = DACCodeRange.from_resolution(2048)
        test_dwell = 2
        test_cmd = RasterScanCommand(
            cookie=123,
            x_range=test_range,
            y_range=test_range,
            dwell_time=test_dwell,
        )
        conn = MockConnection()
        await conn._connect()
        async for chunk in conn.transfer_multiple(test_cmd, latency=65536):
            print(f"chunk: {dump_hex(chunk)}")

    def test_scan(self):
        asyncio.run(self.scan())
        self.assertTrue(True)

    # ------------------------------------------------------------------ #
    # Wet-run test: real Glasgow hardware.                               #
    # Scans RESOLUTION × RESOLUTION at dwell=2, frame_blank=False,       #
    # receiving chunks of CHUNK_BYTES bytes each.                        #
    # ------------------------------------------------------------------ #
    async def scan_wet_run(self):
        self.chunks = []
        self.chunks_received = 0

        if self._config is None:
            print("[test] no config, skipping")
            return

        test_range = DACCodeRange.from_resolution(self.RESOLUTION)
        test_dwell = 2

        test_cmd = RasterScanCommand(
            cookie=123,
            x_range=test_range,
            y_range=test_range,
            dwell_time=test_dwell,
            frame_blank=False,
        )

        print(f"[test] === {self.RESOLUTION}x{self.RESOLUTION}, dwell={test_dwell}, "
              f"latency={CHUNK_BYTES}, frame_blank=False ===", flush=True)

        conn = GlasgowConnection(self._config)
        await conn._connect()
        if not conn.connected:
            print("[test] connection failed")
            return

        try:
            async for chunk in conn.transfer_multiple(test_cmd, latency=CHUNK_BYTES):
                self.chunks.append(chunk)
                self.chunks_received += 1
                # Sparse preview so the log doesn't drown at large resolutions:
                # first 3 chunks, then every 128th, plus the last.
                total_expected = (self.RESOLUTION * self.RESOLUTION * 2) // CHUNK_BYTES
                if (self.chunks_received <= 3
                        or self.chunks_received % 128 == 0
                        or self.chunks_received == total_expected):
                    preview = (dump_hex(bytes(chunk)[:16])
                               if chunk is not None else "<None>")
                    length = len(chunk) if chunk is not None else 0
                    print(f"[test] chunk #{self.chunks_received} "
                          f"len={length}: {preview}", flush=True)
        except Exception as e:
            print(f"[test] EXCEPTION during transfer_multiple after "
                  f"{self.chunks_received} chunks: {type(e).__name__}: {e}",
                  flush=True)
            raise

        print(f"[test] transfer complete after {self.chunks_received} chunks",
              flush=True)

    def test_scan_wet_run(self):
        asyncio.run(self.scan_wet_run())

        # Computed from the single RESOLUTION knob above so no drift is possible.
        pixels = self.RESOLUTION * self.RESOLUTION
        expected_chunks = (pixels * 2) // CHUNK_BYTES

        self.assertEqual(
            self.chunks_received, expected_chunks,
            f"expected {expected_chunks} chunks, got {self.chunks_received}",
        )

        # Every chunk should be full-sized.
        for i, chunk in enumerate(self.chunks):
            self.assertEqual(
                len(chunk) * 2, CHUNK_BYTES,
                f"chunk {i} wrong size: {len(chunk) * 2} bytes",
            )

        # Chunk 2 must not begin with all zeros (padding-leak regression guard).
        # Only meaningful if the scan produced at least 2 chunks.
        if len(self.chunks) >= 2:
            self.assertNotEqual(
                bytes(self.chunks[1])[:16], b"\x00" * 16,
                "chunk 2 begins with padding zeros (padding leaked into real data)",
            )