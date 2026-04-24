import csv, math
import unittest
import asyncio
from pathlib import Path

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util

JSON_PATH = r'./Development/GlasgowDataIO/Json/streamData.json'

# Size of each pixel chunk in bytes (latency parameter to transfer_multiple).
# 8192 pixels * 2 bytes = 16384 bytes per chunk at SixteenBit output.
CHUNK_BYTES = 16384
FRAME_BLANK = False
RESOLUTION = 512

class RasterScanTest(unittest.TestCase):

    # Change this single value to bisect the working-resolution ceiling.
    # 128 / 512 / 1024 / 2048 are all valid values of DACCodeRange.from_resolution.
    

    def setUp(self):
        self.sim_data = ("0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10, "
                         "0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10")
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
        else:
            self._config = None
        self._rasterScanConfig = util.GetStateConfigByName(self._config, 'streamData')[Consts.ACTION_DATA].get('rasterScan')
        self.chunk_bytes  = self._rasterScanConfig.get('pixels', CHUNK_BYTES) * 2
        self.fram_blank = self._rasterScanConfig.get('frameBlank', FRAME_BLANK)
        self.resolution  = self._rasterScanConfig.get('resolution', RESOLUTION)
        self.test_dwell = self._rasterScanConfig.get('dwell', 2)
        
    # ------------------------------------------------------------------ #
    # Mock / simulation test (no hardware).                              #
    # ------------------------------------------------------------------ #
    async def scan(self):
        test_range = DACCodeRange.from_resolution(2048)
        test_cmd = RasterScanCommand(
            cookie=123,
            x_range=test_range,
            y_range=test_range,
            dwell_time=self.test_dwell,
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

        test_range = DACCodeRange.from_resolution(self.resolution)

        test_cmd = RasterScanCommand(
            cookie=123,
            x_range=test_range,
            y_range=test_range,
            dwell_time=self.test_dwell,
            frame_blank=self.fram_blank,
        )

        print(f"[test] === {self.resolution}x{self.resolution}, dwell={self.test_dwell}, "
              f"latency={CHUNK_BYTES}, frame_blank={self.fram_blank} ===", flush=True)

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
                total_expected = (self.resolution * self.resolution * 2) // CHUNK_BYTES
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
        self._exportDataToCsvFile()

        latency_bytes   = self.chunk_bytes            # what you pass to transfer_multiple
        pixels_per_chunk = math.ceil(latency_bytes / self.test_dwell)
        total_pixels     = self.resolution * self.resolution
        expected_chunks  = math.ceil(total_pixels / pixels_per_chunk)

        self.assertEqual(
            self.chunks_received, expected_chunks,
            f"dwell={self.test_dwell}: expected {expected_chunks} chunks, "
            f"got {self.chunks_received}",
        )

        # All but the last chunk should be full-sized.
        full_bytes = pixels_per_chunk * 2
        for i, chunk in enumerate(self.chunks[:-1]):
            self.assertEqual(
                len(chunk) * 2, full_bytes,
                f"chunk {i} wrong size: {len(chunk) * 2} bytes (expected {full_bytes})",
            )
        # Last chunk may be a short tail — just assert it's non-empty and ≤ full.
        if self.chunks:
            tail = len(self.chunks[-1]) * 2
            self.assertTrue(0 < tail <= full_bytes,
                f"tail chunk wrong size: {tail} bytes")

    def _exportDataToCsvFile(self):
        if self.chunks:
            downloads_dir = Path.home() / "Downloads"
            downloads_dir.mkdir(parents=True, exist_ok=True)
            csv_path = downloads_dir / f"raster_{self.resolution}x{self.resolution}.csv"

            # Flatten every chunk into one sequence of 16-bit pixel values,
            # then slice into RESOLUTION-pixel rows. Each chunk is already a
            # sequence of uint16 values (len(chunk) == CHUNK_BYTES // 2), so
            # extend() works directly.
            all_pixels = []
            for chunk in self.chunks:
                all_pixels.extend(chunk)

            with csv_path.open("w", newline="") as f:
                writer = csv.writer(f, delimiter=" ")
                for row_idx in range(self.resolution):
                    start = row_idx * self.resolution
                    row = all_pixels[start:start + self.resolution]
                    if not row:
                        break  # short scan — stop writing empty rows
                    writer.writerow(row)

            print(f"[test] wrote CSV: {csv_path} "
                  f"({len(all_pixels)} pixels from {len(self.chunks)} chunks)",
                  flush=True)