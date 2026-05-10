import csv
import unittest
import asyncio
import time
import logging
from pathlib import Path

from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util

logger = logging.getLogger()

JSON_PATH = r'./Development/GlasgowDataIO/Json/streamData.json'


class VectorScanTest(unittest.TestCase):

    # Change this single value to bisect the working-latency ceiling.
    # 65536 currently deadlocks on hardware (host bulk_write to device OUT
    # endpoint times out at 10 s because MAX_PIPELINE=32 chunks × LATENCY
    # saturates the FPGA's OUT FIFO faster than it can drain).
    # Try 4096 / 8192 / 16384 / 32768 to find where it starts failing.
    LATENCY = 8196

    def setUp(self):
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
        else:
            self._config = None
        self._vectorScanConfig = util.GetStateConfigByName(self._config, 'streamData')[Consts.ACTION_DATA].get('vectorScan')
        LATENCY = self._vectorScanConfig.get('latency')

    # ------------------------------------------------------------------ #
    # Mock / simulation test (no hardware).                              #
    # ------------------------------------------------------------------ #
    async def scan(self):
        test_cmd = VectorScanCommand(cookie=123)

        start_process = time.perf_counter()
        test_cmd._pre_process_chunks(latency=self.LATENCY)
        end_process = time.perf_counter()

        conn = MockConnection()
        await conn._connect()

        start_send = time.perf_counter()
        async for chunk in conn.transfer_multiple(test_cmd, latency=self.LATENCY):
            print(f"chunk: {dump_hex(chunk)}")
        end_send = time.perf_counter()

        print(f"process time: {end_process - start_process:04f}, "
              f"send time: {end_send - start_send:04f}")

    def test_scan(self):
        asyncio.run(self.scan())
        self.assertTrue(True)

    # ------------------------------------------------------------------ #
    # Wet-run test: real Glasgow hardware.                               #
    # Pre-processes the command stream at latency=LATENCY, then streams  #
    # it to the device, accumulating chunks for assertions below.        #
    # ------------------------------------------------------------------ #
    async def scan_wet_run(self):
        self.chunks = []
        self.chunks_received = 0
        self.process_time = 0.0
        self.send_time = 0.0

        if self._config is None:
            print("[test] no config, skipping")
            return

        test_cmd = VectorScanCommand(cookie=123)

        print(f"[test] === VectorScan, latency={self.LATENCY} ===", flush=True)

        # Pre-processing is host-side CPU work, independent of the USB
        # transfer itself, so time it separately.
        start_process = time.perf_counter()
        test_cmd._pre_process_chunks(latency=self.LATENCY)
        end_process = time.perf_counter()
        self.process_time = end_process - start_process
        print(f"[test] pre-process time: {self.process_time:04f}s", flush=True)

        conn = GlasgowConnection(self._config)
        await conn._connect()
        if not conn.connected:
            print("[test] connection failed")
            return

        start_send = time.perf_counter()
        try:
            async for chunk in conn.transfer_multiple(test_cmd, latency=self.LATENCY):
                self.chunks.append(chunk)
                self.chunks_received += 1
                # Sparse preview so the log doesn't drown on large streams:
                # first 3 chunks, then every 128th.
                if (self.chunks_received <= 3
                        or self.chunks_received % 128 == 0):
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
        end_send = time.perf_counter()
        self.send_time = end_send - start_send

        print(f"[test] transfer complete after {self.chunks_received} chunks",
              flush=True)
        print(f"[test] process time: {self.process_time:04f}s, "
              f"send time: {self.send_time:04f}s", flush=True)

    def test_scan_wet_run(self):
        asyncio.run(self.scan_wet_run())

        # Dump received chunks to ~/Downloads/vector_latency<LATENCY>.csv for
        # offline inspection. Run before the assertions so we still get the
        # file even if the scan failed one of the checks below.
        # Skipped if the scan was aborted early (no config / no connection).
        # Layout: one chunk per line, space-separated values — each line is
        # one USB transfer, which is the unit LATENCY bisects over.
        if self.chunks:
            self._exportDataToCsvFile()

        # Unlike raster, a vector scan's chunk count is determined by the
        # pre-processed command stream rather than a fixed resolution, so we
        # can't assert an exact count — but we must receive at least one.
        self.assertGreater(
            self.chunks_received, 0,
            f"expected at least one chunk, got {self.chunks_received}",
        )

        # Every chunk should be non-empty.
        for i, chunk in enumerate(self.chunks):
            self.assertGreater(
                len(chunk), 0,
                f"chunk {i} is empty",
            )

        # Sanity check: at least one chunk somewhere in the stream contains
        # non-zero data. This catches catastrophic failures (FPGA never
        # wakes up, IN path dead, simulator BRAM not initialized) without
        # the false positives the old "chunk 2 != zeros" guard produced.
        #
        # Why the old check was wrong:
        #   With default_iter() the scan starts at host (x=0, y=0..) and
        #   FakeAdcSimulator decimates the top 6 bits of the 14-bit DAC
        #   X for image addressing — so host x in 0..255 all reads
        #   image column 0. For every pattern in imageSource.pattern_image
        #   except a custom-loaded photo with a bright left edge, image
        #   column 0 is dominated by zeros (`ramp`: 0; `bars`: 0;
        #   `bullseye`: 0 at corners). That makes the first ~64 chunks
        #   legitimately all-zero, and the old assertion fired on real
        #   data, not on a padding leak.
        #
        # If we ever want a *real* padding-leak guard we'd have to inspect
        # the *tail* of the stream (where drain padding could plausibly
        # reach the host) against a known iterator that lands on a
        # non-zero image cell.
        self.assertTrue(
            any(any(v != 0 for v in chunk) for chunk in self.chunks),
            "every chunk is all zeros — scan returned no real data",
        )

    def _exportDataToCsvFile(self):
        if not self._config.DumpData:
            return
        
        downloads_dir = Path.home() / "Downloads"
        downloads_dir.mkdir(parents=True, exist_ok=True)
        csv_path = downloads_dir / f"vector_latency{self.LATENCY}.csv"

        total_values = 0
        with csv_path.open("w", newline="") as f:
            writer = csv.writer(f, delimiter=" ")
            for chunk in self.chunks:
                writer.writerow(chunk)
                total_values += len(chunk)

        print(f"[test] wrote CSV: {csv_path} "
                  f"({total_values} values from {len(self.chunks)} chunks)",
                  flush=True)
