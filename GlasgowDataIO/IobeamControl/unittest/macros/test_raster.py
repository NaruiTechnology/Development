import csv, math
import unittest
import asyncio
from pathlib import Path

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange, BeamType
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.scan_params import RasterParams

JSON_PATH = r'./Development/GlasgowDataIO/Json/streamData_unit_test.json'


class RasterScanTest(unittest.TestCase):
    """Wet-run raster scan test, parameterized through RasterParams.

    Previously this test pulled config keys individually
    (rasterScanConfig.get('pixels', CHUNK_BYTES), etc.) and applied
    fallback constants at the top of the file (CHUNK_BYTES, FRAME_BLANK,
    RESOLUTION). All of that is gone — RasterParams.from_json + defaults
    is the single path. Override individual fields in setUp by editing
    PARAM_OVERRIDES below.
    """

    # Override individual params here without touching streamData.json.
    # An empty dict means "use exactly what streamData.json says";
    # anything in here wins over the JSON.
    PARAM_OVERRIDES: dict = {}

    def setUp(self):
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
            raster_block = (
                util.GetStateConfigByName(self._config, 'streamData')
                [Consts.ACTION_DATA].get('rasterScan')
            )
        else:
            self._config = None
            raster_block = None

        # Single source of truth: JSON → RasterParams → override.
        self.params: RasterParams = RasterParams.from_json(raster_block).override(
            **self.PARAM_OVERRIDES,
        )
        try:
            self.beam_type = BeamType[self.params.beam_type]
        except KeyError:
            self.beam_type = BeamType.Ion

    # ------------------------------------------------------------------ #
    # Mock / simulation test (no hardware).                              #
    # ------------------------------------------------------------------ #
    async def scan(self):
        # Mock scan uses a fixed resolution because MockConnection doesn't
        # exercise the streamData.json path. The point is to drive the
        # state machine, not validate config wiring.
        test_range = DACCodeRange.from_resolution(2048)
        test_cmd = RasterScanCommand(
            cookie=self.params.cookie,
            x_range=test_range,
            y_range=test_range,
            dwell_time=self.params.dwell,
            beam_type=self.beam_type,
            external_control=self.params.external_control,
        )
        conn = MockConnection()
        await conn._connect()
        async for chunk in conn.transfer_multiple(test_cmd, latency=65536):
            print(f"chunk: {dump_hex(chunk)}")

    def test_scan(self):
        asyncio.run(self.scan())
        self.assertTrue(True)

    # ------------------------------------------------------------------ #
    # Wet-run test: real Glasgow hardware. Every macro input is read     #
    # from `self.params` — no more "what does CHUNK_BYTES mean again?".  #
    # ------------------------------------------------------------------ #
    async def scan_wet_run(self):
        self.chunks = []
        self.chunks_received = 0

        if self._config is None:
            self.skipTest("no config")

        test_range = DACCodeRange.from_resolution(self.params.resolution)

        test_cmd = RasterScanCommand(
            cookie=self.params.cookie,
            x_range=test_range,
            y_range=test_range,
            dwell_time=self.params.dwell,
            beam_type=self.beam_type,
            external_control=self.params.external_control,
            frame_blank=self.params.frame_blank,
            # Macro-tuning params flow through too — if streamData.json
            # ever sets max_pipeline / padding_*, this test picks them up
            # automatically.
            max_pipeline=self.params.max_pipeline,
            padding_min_pixels=self.params.padding_min_pixels,
            padding_ratio_denominator=self.params.padding_ratio_denominator,
            padding_dwell=self.params.padding_dwell,
        )

        print(f"[test] === {self.params.resolution}x{self.params.resolution}, "
              f"dwell={self.params.dwell}, latency={self.params.latency_bytes}, "
              f"frame_blank={self.params.frame_blank} ===", flush=True)

        conn = GlasgowConnection(self._config)
        await conn._connect()
        if not conn.connected:
            print("[test] connection failed")
            return

        try:
            async for chunk in conn.transfer_multiple(
                    test_cmd, latency=self.params.latency_bytes):
                self.chunks.append(chunk)
                self.chunks_received += 1
                # Sparse preview so the log doesn't drown at large resolutions:
                # first 3 chunks, then every 128th, plus the last.
                total_expected = (
                    (self.params.resolution * self.params.resolution * 2)
                    // self.params.latency_bytes
                )
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

        pixels_per_chunk = math.ceil(self.params.latency_bytes / self.params.dwell)
        total_pixels     = self.params.resolution * self.params.resolution
        expected_chunks  = math.ceil(total_pixels / pixels_per_chunk)

        self.assertEqual(
            self.chunks_received, expected_chunks,
            f"dwell={self.params.dwell}: expected {expected_chunks} chunks, "
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
        if not self._config or not getattr(self._config, "DumpData", False):
            return

        if self.chunks:
            downloads_dir = Path.home() / "Downloads"
            downloads_dir.mkdir(parents=True, exist_ok=True)
            res = self.params.resolution
            csv_path = downloads_dir / f"raster_{res}x{res}.csv"

            # Flatten every chunk into one sequence of 16-bit pixel values,
            # then slice into RESOLUTION-pixel rows. Each chunk is already a
            # sequence of uint16 values (len(chunk) == latency_bytes // 2), so
            # extend() works directly.
            all_pixels = []
            for chunk in self.chunks:
                all_pixels.extend(chunk)

            with csv_path.open("w", newline="") as f:
                writer = csv.writer(f, delimiter=" ")
                for row_idx in range(res):
                    start = row_idx * res
                    row = all_pixels[start:start + res]
                    if not row:
                        break  # short scan — stop writing empty rows
                    writer.writerow(row)

            print(f"[test] wrote CSV: {csv_path} "
                  f"({len(all_pixels)} pixels from {len(self.chunks)} chunks)",
                  flush=True)
